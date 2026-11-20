// Stage 5.6: one Sonnet call per job → validated selection. On validator errors the
// model gets one retry with the errors; anything still failing falls back to the
// untouched profile text. A cover letter can't be "untouched", so if it still fails
// the job goes to review. An unvalidated CV is never produced (PLAN 8.1 rule 4).
import type { Config } from '../config.js';
import type { Llm } from '../llm/types.js';
import { loadPrompt, fence } from '../pipeline/extract.js';
import type { Angle } from '../pipeline/titles.js';
import { profileForPrompt, type Profile } from '../profile/load.js';
import { TailorOutputSchema, type TailorOutput } from './schema.js';
import { describe, validateTailor, type JobContext } from './validate.js';
import type { Vocabulary } from './vocab.js';

export interface TailorJob extends JobContext {
  location: string | null;
  requirements: string[];
  nice_to_have: string[];
  subject_hint: string | null;
  matched: string[];
  missing: string[];
}

export interface TailorResult {
  output: TailorOutput;
  /** Bullets replaced by their source text, fields replaced by profile text. */
  fallbacks: string[];
  attempts: number;
  /** The cover letter or email could not be validated: the job needs review. */
  needsReview: string[];
}

function tailorSystem(profile: Profile, angle: Angle): string {
  const cl = profile.cover_letter.angles[angle];
  return loadPrompt('tailor', {
    angle,
    headline: profile.headlines[angle],
    summary: profile.summaries[angle].trim(),
    pitch: cl.pitch,
    evidence: cl.evidence.join(', '),
    motivation: cl.motivation.trim(),
    profile: profileForPrompt(profile),
    courses: profile.courses.map((c) => `- ${c.id}: ${c.name}`).join('\n'),
  });
}

function jobBlock(job: TailorJob, extra: string[] = []): string {
  return [
    'Tailor the CV, cover letter and email for this job.',
    '<job>',
    fence(JSON.stringify(job, null, 2)),
    '</job>',
    ...extra,
  ].join('\n');
}

/** Replaces whatever still fails with untouched profile text (bullets, headline, summary). */
function applyFallbacks(
  out: TailorOutput,
  profile: Profile,
  angle: Angle,
  failedBullets: Set<string>,
  failedFields: Set<string>,
): { output: TailorOutput; fallbacks: string[] } {
  const fallbacks: string[] = [];
  const source = new Map(
    [...profile.experience, ...profile.projects].flatMap((e) =>
      e.bullets.map((b) => [b.id, b] as const),
    ),
  );
  const fix = (picks: TailorOutput['projects']) =>
    picks.map((p) => ({
      ...p,
      bullets: p.bullets.map((b) => {
        if (!failedBullets.has(b.id)) return b;
        fallbacks.push(`bullet ${b.id}`);
        const src = source.get(b.id);
        return src ? { id: b.id, text: src.text, ...(src.label ? { label: src.label } : {}) } : b;
      }),
    }));
  const output: TailorOutput = {
    ...out,
    experience: fix(out.experience),
    projects: fix(out.projects),
  };
  if (failedFields.has('headline')) {
    output.headline = profile.headlines[angle];
    fallbacks.push('headline');
  }
  if (failedFields.has('summary')) {
    output.summary = profile.summaries[angle].trim();
    fallbacks.push('summary');
  }
  return { output, fallbacks };
}

export async function tailorJob(
  llm: Llm,
  cfg: Config,
  profile: Profile,
  vocab: Vocabulary,
  angle: Angle,
  job: TailorJob,
  key?: string,
): Promise<TailorResult> {
  const system = tailorSystem(profile, angle);
  const ask = (prompt: string, k?: string) =>
    llm.call({
      purpose: 'tailor',
      model: cfg.llm.tailor_model,
      system,
      prompt,
      schema: TailorOutputSchema,
      timeoutMs: cfg.llm.tailor_timeout_seconds * 1000,
      ...(k ? { key: k } : {}),
    });

  let out = await ask(jobBlock(job), key ? `${key}.1` : undefined);
  let v = validateTailor(out, profile, vocab, job);
  let attempts = 1;
  if (!v.ok) {
    attempts = 2;
    const errors = describe(v);
    out = await ask(
      jobBlock(job, [
        '',
        'Your previous answer broke these rules. Fix every one; copy a bullet exactly when unsure:',
        ...errors.map((e) => `- ${e}`),
      ]),
      key ? `${key}.2` : undefined,
    );
    v = validateTailor(out, profile, vocab, job);
  }

  const selectionBroken = (v.fields.get('selection') ?? []).length > 0;
  if (selectionBroken) {
    throw new Error(
      `tailor: invalid ids after retry: ${(v.fields.get('selection') ?? []).join('; ')}`,
    );
  }
  const { output, fallbacks } = applyFallbacks(
    out,
    profile,
    angle,
    new Set(v.bullets.keys()),
    new Set(v.fields.keys()),
  );
  const needsReview = (['cover_letter', 'email_body', 'why_this_role'] as const)
    .filter((f) => v.fields.has(f))
    .flatMap((f) => (v.fields.get(f) ?? []).map((m) => `${f}: ${m}`));

  // Final guarantee: what leaves this function passes the validator, except the
  // fields routed to review.
  const final = validateTailor(output, profile, vocab, job);
  const leftover = describe(final).filter(
    (e) =>
      !e.startsWith('cover_letter') &&
      !e.startsWith('email_body') &&
      !e.startsWith('why_this_role'),
  );
  if (leftover.length > 0)
    throw new Error(`tailor: still invalid after fallback: ${leftover.join('; ')}`);
  return { output, fallbacks, attempts, needsReview };
}
