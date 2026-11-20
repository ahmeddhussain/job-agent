// Stage 5.5: tier → hard filters → scam flags → fit score (Haiku) → decision.
// Cheap rules run first so the model is only asked about jobs that could be applied to.
import type { Config } from '../config.js';
import { FitResultSchema, type FitResult } from '../llm/schemas.js';
import type { Llm } from '../llm/types.js';
import { factIndex, profileForPrompt, type Profile } from '../profile/load.js';
import type { CheckedJob } from './extract.js';
import { loadPrompt, fence } from './extract.js';
import type { Angle, TitleMatcher } from './titles.js';

export type JobStatus = 'new' | 'skipped' | 'needs_review';

export interface Decision {
  status: JobStatus;
  skip_reason: string | null;
  flags: string[];
  priority: 1 | 2 | 3 | null;
  angle: Angle | null;
  fit: FitResult | null;
  /** Final score = skills (model) and experience (code), weighted (D21). */
  scores: { skills: number; experience: number; final: number } | null;
  /** True when the job goes to the tailor queue (status new and above threshold). */
  tailor: boolean;
}

// Concrete scam patterns, checked in code on the raw post (PLAN 5.5 step 5).
const SCAM_RULES: [string, RegExp][] = [
  [
    'fee',
    /\b(training|registration|application|placement)\s+fees?\b|\bpay\s+(a\s+)?\d+|\bdeposit\b|رسوم|اشتراك/i,
  ],
  [
    'earnings_promise',
    /\b(earn|make)\s+\$?\d+[\d,]*\s*(\$|usd|egp|le)?\s*(\/|per|a)\s*(day|week|hour)\b|\$\d+\s*\/\s*day/i,
  ],
  ['telegram_only', /telegram\s+only|only\s+(on|via)\s+telegram|تليجرام\s+فقط/i],
  ['crypto_forex', /\b(crypto|bitcoin|forex|binary options|trading signals)\b/i],
  [
    'id_or_bank_upfront',
    /\b(national\s+id|bank\s+(account|details)|visa\s+card\s+number)\b|صورة\s+البطاقة/i,
  ],
];

export function scamSignals(text: string): string[] {
  return SCAM_RULES.filter(([, re]) => re.test(text)).map(([name]) => name);
}

export interface ScoreContext {
  cfg: Config;
  profile: Profile;
  matcher: TitleMatcher;
  llm: Llm;
  /** YYYY-MM-DD the run is evaluated on (deadlines). */
  runDate: string;
}

function locationOk(job: CheckedJob, cfg: Config): boolean {
  if (job.work_mode === 'remote' && cfg.filters.allow_remote) return true;
  if (!job.country) return true; // not stated: don't lose the job over it
  const c = job.country.toLowerCase();
  return cfg.filters.countries.some((x) => c.includes(x.toLowerCase()));
}

/** Hard filters that need no model: returns a skip reason or null. No seniority-word rules (D21). */
export function hardFilter(
  job: CheckedJob,
  ctx: Pick<ScoreContext, 'cfg' | 'matcher' | 'runDate'>,
): { reason: string | null; priority: 1 | 2 | 3 | null; angle: Angle | null } {
  const d = ctx.matcher.classify(job.title);
  if (d.tier === null) return { reason: d.excluded, priority: null, angle: null };
  const base = { priority: d.tier, angle: d.angle };
  if (job.years_min !== null && job.years_min > ctx.cfg.filters.max_years_required) {
    return { reason: 'over_experience', ...base };
  }
  if (job.deadline !== null && job.deadline < ctx.runDate)
    return { reason: 'deadline_passed', ...base };
  if (!locationOk(job, ctx.cfg)) return { reason: 'location', ...base };
  return { reason: null, ...base };
}

/**
 * Experience score, 0-100, from what the post asks for: fresh/junior/intern posts and
 * 0 years score highest, then 1, 2, 3 years; not stated sits in between (D21).
 */
export function experienceScore(job: CheckedJob, cfg: Config): number {
  const t = cfg.scoring.experience_scores;
  if (job.seniority === 'junior' || job.seniority === 'intern') return t['0'];
  if (job.years_min === null) return t.unknown;
  const y = Math.min(Math.max(job.years_min, 0), 3);
  return t[String(y) as '0' | '1' | '2' | '3'];
}

export function combineScores(skills: number, experience: number, cfg: Config): number {
  const w = cfg.scoring.weights;
  return Math.round(skills * w.skills + experience * w.experience);
}

/** Known ids the model may cite as evidence: facts, entries and skills. */
function evidenceIds(p: Profile): Set<string> {
  return new Set([
    ...factIndex(p).keys(),
    ...[...p.experience, ...p.projects].map((e) => e.id),
    ...Object.values(p.skills)
      .flat()
      .map((s) => s.id),
  ]);
}

export async function fitScore(
  ctx: ScoreContext,
  job: CheckedJob,
  key?: string,
): Promise<{ fit: FitResult; dropped: number }> {
  const view = {
    title: job.title,
    company: job.company,
    location: job.location,
    country: job.country,
    work_mode: job.work_mode,
    requirements: job.requirements,
    nice_to_have: job.nice_to_have,
    eligibility: job.eligibility,
  };
  const raw = await ctx.llm.call({
    purpose: 'score',
    model: ctx.cfg.llm.score_model,
    system: loadPrompt('score', {
      profile: profileForPrompt(ctx.profile),
      max_years: String(ctx.cfg.filters.max_years_required),
    }),
    prompt: ['Score this job.', '<job>', fence(JSON.stringify(view, null, 2)), '</job>'].join('\n'),
    schema: FitResultSchema,
    ...(key ? { key } : {}),
  });
  // Evidence must be real profile ids; anything else is dropped (the truth check, in code).
  const known = evidenceIds(ctx.profile);
  let dropped = 0;
  const matched = raw.matched
    .map((m) => {
      const evidence = m.evidence.filter((e) => known.has(e));
      dropped += m.evidence.length - evidence.length;
      return { ...m, evidence };
    })
    .filter((m) => m.evidence.length > 0);
  return { fit: { ...raw, matched }, dropped };
}

export async function scoreJob(
  ctx: ScoreContext,
  job: CheckedJob,
  rawText: string,
  key?: string,
): Promise<Decision> {
  const flags = [...job.flags];
  const hf = hardFilter(job, ctx);
  const base = { priority: hf.priority, angle: hf.angle, fit: null, scores: null, tailor: false };
  if (hf.reason) return { ...base, status: 'skipped', skip_reason: hf.reason, flags };

  const scam = scamSignals(rawText);
  if (scam.length > 0 || flags.includes('suspicious')) {
    if (!flags.includes('suspicious')) flags.push('suspicious');
    flags.push(...scam.map((s) => `scam:${s}`));
    return { ...base, status: 'needs_review', skip_reason: 'suspicious', flags };
  }

  const { fit, dropped } = await fitScore(ctx, job, key);
  if (dropped > 0) flags.push('fit_evidence_dropped');
  const experience = experienceScore(job, ctx.cfg);
  const scores = {
    skills: fit.fit_score,
    experience,
    final: combineScores(fit.fit_score, experience, ctx.cfg),
  };
  const withFit = { ...base, fit, scores };

  if (fit.eligibility_issues.length > 0) {
    flags.push('eligibility');
    return { ...withFit, status: 'needs_review', skip_reason: 'eligibility', flags };
  }
  const tier = hf.priority ?? 3;
  const threshold = ctx.cfg.scoring.thresholds[`p${tier}`];
  if (scores.final < threshold)
    return { ...withFit, status: 'skipped', skip_reason: 'low_fit', flags };

  const hasTarget =
    (job.apply_channel === 'email' && job.apply_email !== null) ||
    (job.apply_channel === 'form' && job.apply_url !== null) ||
    (job.apply_channel === 'whatsapp_dm' && job.apply_phone !== null);
  if (!hasTarget) {
    return { ...withFit, status: 'needs_review', skip_reason: 'no_apply_target', flags };
  }
  return { ...withFit, status: 'new', skip_reason: null, flags, tailor: true };
}
