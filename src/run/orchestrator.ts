// `agent run` (PLAN 5, P7, D31): one run record around every stage, in order:
//   preflight → Gmail sync → collect (each source isolated) → process the stored queue
//   (dedupe L1/L2 → extract → L3 → enrich → score) → tailor queue (best first) → apply
//   → digest.
// Collection and processing are decoupled: collectors store raw items and advance their
// watermarks; processing takes every raw item not yet processed. So a run that stops at
// the usage limit (R18) loses nothing: the next run continues where this one stopped.
import { join } from 'node:path';
import type { Logger } from 'pino';
import { applyJob, retryAnsweredForms } from '../apply/apply.js';
import { pendingQuestions } from '../apply/questions.js';
import type { FormFiller } from '../apply/forms.js';
import { prepareApplication } from '../apply/prepare.js';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { insertJob, rowToCheckedJob, updateJobStatus, type JobRow } from '../db/jobs.js';
import type { GmailReader, GmailWriter } from '../gmail/client.js';
import { syncGmail } from '../gmail/sync.js';
import type { FitResult } from '../llm/schemas.js';
import { LlmError, UsageLimitError, type Llm, type LlmCallRecord } from '../llm/types.js';
import { buildDigest, type Digest } from '../pipeline/digest.js';
import { findJobDuplicate, findRawDuplicate } from '../pipeline/dedupe.js';
import { enrichJob, type Enrichment } from '../pipeline/enrich.js';
import { extractJobs, type CheckedJob } from '../pipeline/extract.js';
import { fitScore, hardFilter, scoreJob, type Decision } from '../pipeline/score.js';
import { normalizeTitle } from '../util/text.js';
import type { TitleMatcher } from '../pipeline/titles.js';
import type { Profile } from '../profile/load.js';
import type { Renderer } from '../render/renderer.js';
import { vocabularyFor } from '../tailor/vocab.js';
import type { PoliteHttp } from '../util/http.js';

export interface SourceRun {
  name: string;
  /** Stores raw items (and advances the source's watermark); returns a one-line summary. */
  collect: (runId: number) => Promise<{ inserted: number; detail: string }>;
}

export interface RunDeps {
  cfg: Config;
  profile: Profile;
  db: Db;
  llm: Llm;
  /** Subscription check (D17); throws when the CLI would bill an API key. */
  preflight: (() => Promise<string>) | null;
  gmailRead: GmailReader | null;
  /** null in dry runs: no drafts, no sync writes, no digest email. */
  gmailWrite: GmailWriter | null;
  sources: SourceRun[];
  http: PoliteHttp;
  probeHttp?: PoliteHttp;
  linkedinHttp: PoliteHttp;
  matcher: TitleMatcher;
  openRenderer: () => Promise<Renderer>;
  now: () => Date;
  log: Logger;
  out: (line: string) => void;
  dryRun: boolean;
  outputRoot: string;
  /** Filled by the model client's onCall hook; persisted to llm_calls at the end. */
  calls: LlmCallRecord[];
  sendDigest: ((d: Digest) => Promise<void>) | null;
  /** Web-form submitter (D33); null = form jobs become "apply yourself" packages. */
  forms?: FormFiller | null;
}

export interface RunReport {
  runId: number;
  status: 'success' | 'partial' | 'failed';
  stopReason: string | null;
  error: string | null;
  stats: RunStats;
  digest: Digest;
}

export function emptyStats(): RunStats {
  return {
    sources: [],
    items: { processed: 0, duplicates: 0, failed: 0, left: 0 },
    jobs: {},
    applications: { drafts: 0, packages: 0, submitted: 0, sent: 0, review: 0, left: 0 },
    companies_discovered: 0,
    llm: { calls: 0, failed: 0, output_tokens: 0 },
  };
}

export interface RunStats {
  sources: { name: string; ok: boolean; inserted: number; detail: string }[];
  items: { processed: number; duplicates: number; failed: number; left: number };
  jobs: Record<string, number>;
  applications: {
    drafts: number;
    packages: number;
    submitted: number;
    sent: number;
    review: number;
    left: number;
  };
  companies_discovered: number;
  llm: { calls: number; failed: number; output_tokens: number };
}

interface RawRow {
  id: number;
  source: string;
  source_name: string | null;
  posted_at: string;
  text: string | null;
  content_hash: string;
  simhash: string | null;
}

class Stop extends Error {}

const slug = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/[^\w]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    .toLowerCase();

export async function runAgent(d: RunDeps): Promise<RunReport> {
  const { db, cfg } = d;
  const started = d.now();
  const runId = Number(
    db
      .prepare(`INSERT INTO runs (started_at, status, mode) VALUES (?, 'running', ?)`)
      .run(started.toISOString(), d.dryRun ? 'dry_run' : 'live').lastInsertRowid,
  );
  const stats = emptyStats();
  const companiesBefore = db
    .prepare(`SELECT count(*) FROM companies WHERE source = 'discovered'`)
    .pluck()
    .get() as number;
  // Set inside stopOn (a closure), so kept in an object TypeScript doesn't narrow.
  const halt: { reason: string | null } = { reason: null };
  let error: string | null = null;
  const stopOn = (err: unknown): never => {
    if (err instanceof UsageLimitError) {
      halt.reason = `usage limit reached: ${err.message}`;
      d.out(`STOP: ${halt.reason}. What's left continues on the next run.`);
      throw new Stop();
    }
    throw err;
  };

  try {
    // 1. Subscription guard: no model call happens unless it is the subscription.
    if (d.preflight) d.out(`preflight: ${await d.preflight()}`);

    // 2. Sent drafts → applied, replies flagged.
    if (d.gmailWrite) {
      try {
        const s = await syncGmail(db, d.gmailWrite, d.now());
        d.out(
          `sync: ${String(s.sent)} drafts sent since last run, ${String(s.replies)} new replies`,
        );
      } catch (err) {
        d.out(`sync FAILED: ${String(err)}`);
        stats.sources.push({ name: 'sync', ok: false, inserted: 0, detail: String(err) });
      }
    }

    // 3. Collect: one failing source makes the run partial; the others continue.
    for (const s of d.sources) {
      try {
        const r = await s.collect(runId);
        stats.sources.push({ name: s.name, ok: true, ...r });
        d.out(`collect ${s.name}: ${r.detail}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        stats.sources.push({ name: s.name, ok: false, inserted: 0, detail: msg });
        d.out(`collect ${s.name} FAILED: ${msg}`);
        d.log.warn({ source: s.name, err: msg }, 'source failed');
      }
    }

    // 4. Process every stored item not processed yet, oldest first.
    const queue = db
      .prepare(
        `SELECT id, source, source_name, posted_at, text, content_hash, simhash FROM raw_items
         WHERE processed_at IS NULL ORDER BY posted_at, id`,
      )
      .all() as RawRow[];
    d.out(`process: ${String(queue.length)} stored items to read`);
    const ctx = { cfg, profile: d.profile, matcher: d.matcher, llm: d.llm, runDate: '' };
    for (const [n, item] of queue.entries()) {
      ctx.runDate = d.now().toISOString().slice(0, 10);
      try {
        await processItem(d, ctx, item, stats);
      } catch (err) {
        if (err instanceof Stop) throw err;
        if (err instanceof UsageLimitError) stopOn(err);
        if (err instanceof LlmError && err.retryable) {
          d.out(`  item ${String(item.id)}: ${err.message} (retried next run)`);
          continue;
        }
        stats.items.failed++;
        const msg = err instanceof Error ? err.message : String(err);
        db.prepare('UPDATE raw_items SET processed_at = ?, process_error = ? WHERE id = ?').run(
          d.now().toISOString(),
          msg.slice(0, 500),
          item.id,
        );
        d.out(`  item ${String(item.id)} FAILED: ${msg}`);
      }
      if ((n + 1) % 10 === 0) d.out(`  ${String(n + 1)}/${String(queue.length)} items read`);
    }

    // 5. Tailor and apply, best matches first (PLAN 5.5 step 6).
    await tailorQueue(d, stats, stopOn);

    // 6. Forms that waited only for answers Ahmed has since given (D35).
    const retry = await retryAnsweredForms(
      {
        db,
        cfg,
        profile: d.profile,
        gmail: d.gmailWrite,
        dryRun: d.dryRun,
        now: d.now,
        forms: d.forms ?? null,
        sourceOf: (j) => sourceLabel(db, j.raw_item_id),
      },
      d.out,
    );
    if (retry.tried)
      d.out(
        `retried ${String(retry.tried)} forms with your new answers: ${String(retry.submitted)} submitted`,
      );
    stats.applications.submitted += retry.submitted;
  } catch (err) {
    if (!(err instanceof Stop)) {
      error = err instanceof Error ? err.message : String(err);
      d.out(`RUN FAILED: ${error}`);
      d.log.error({ err }, 'run failed');
    }
  }

  // 6. Record, count, digest.
  stats.items.left = db
    .prepare('SELECT count(*) FROM raw_items WHERE processed_at IS NULL')
    .pluck()
    .get() as number;
  stats.applications.left = db
    .prepare(`SELECT count(*) FROM jobs WHERE status = 'new'`)
    .pluck()
    .get() as number;
  for (const r of db
    .prepare(`SELECT status, count(*) n FROM jobs WHERE updated_at >= ? GROUP BY status`)
    .all(started.toISOString()) as { status: string; n: number }[])
    stats.jobs[r.status] = r.n;
  stats.companies_discovered =
    (db
      .prepare(`SELECT count(*) FROM companies WHERE source = 'discovered'`)
      .pluck()
      .get() as number) - companiesBefore;
  const insertCall = db.prepare(
    `INSERT INTO llm_calls (run_id, job_id, purpose, model, input_tokens, output_tokens,
       cache_read_tokens, ok, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  db.transaction(() => {
    for (const c of d.calls) {
      insertCall.run(
        runId,
        c.jobId,
        c.purpose,
        c.model,
        c.usage?.input_tokens ?? null,
        c.usage?.output_tokens ?? null,
        c.usage?.cache_read_tokens ?? null,
        c.ok ? 1 : 0,
        d.now().toISOString(),
      );
    }
  })();
  stats.llm = {
    calls: d.calls.length,
    failed: d.calls.filter((c) => !c.ok).length,
    output_tokens: d.calls.reduce((a, c) => a + (c.usage?.output_tokens ?? 0), 0),
  };
  const status: RunReport['status'] = error
    ? 'failed'
    : halt.reason || stats.sources.some((s) => !s.ok) || stats.items.failed > 0
      ? 'partial'
      : 'success';
  db.prepare(`UPDATE runs SET finished_at = ?, status = ?, stats = ?, error = ? WHERE id = ?`).run(
    d.now().toISOString(),
    status,
    JSON.stringify(stats),
    error ?? halt.reason,
    runId,
  );

  // Questions forms asked that the profile can't answer: answer each once (D35).
  const questions = pendingQuestions(db);
  if (questions.length) {
    d.out(
      `\nFORMS ASKED ${String(questions.length)} QUESTIONS YOUR PROFILE DOESN'T ANSWER (answer once: dashboard → Profile):`,
    );
    for (const q of questions) d.out(`  - ${q.question}  (asked ${String(q.times)}×)`);
  }
  const questionLines = questions.length
    ? [
        `Questions to answer once (dashboard → Profile, or profile application_answers):`,
        ...questions.map((q) => `- ${q.question} (asked ${String(q.times)}×)`),
        '',
      ]
    : [];
  const digest = buildDigest(db, started.toISOString(), started.toISOString().slice(0, 10), error, [
    ...questionLines,
    ...healthLines(stats, halt.reason),
  ]);
  if (d.sendDigest && cfg.digest.enabled) {
    try {
      await d.sendDigest(digest);
      d.out(`digest sent to ${cfg.digest.to}`);
    } catch (err) {
      d.out(`digest FAILED: ${String(err)}`);
    }
  }
  return { runId, status, stopReason: halt.reason, error, stats, digest };
}

function healthLines(s: RunStats, stopReason: string | null): string[] {
  return [
    'Run health:',
    ...s.sources.map((x) => `- ${x.name}: ${x.ok ? 'ok' : 'FAILED'} · ${x.detail}`),
    `- items read: ${String(s.items.processed)} (${String(s.items.duplicates)} duplicates, ${String(s.items.failed)} failed, ${String(s.items.left)} left for the next run)`,
    `- applications: ${String(s.applications.drafts)} drafts, ${String(s.applications.submitted)} forms submitted, ${String(s.applications.packages)} to apply yourself, ${String(s.applications.sent)} sent, ${String(s.applications.review)} to review, ${String(s.applications.left)} left`,
    `- companies discovered: ${String(s.companies_discovered)}`,
    `- model calls: ${String(s.llm.calls)} (${String(s.llm.failed)} failed), output tokens ${String(s.llm.output_tokens)}`,
    ...(stopReason ? [`- stopped early: ${stopReason}`] : []),
  ];
}

const DUPLICATE: Decision = {
  status: 'skipped',
  skip_reason: 'duplicate',
  flags: [],
  priority: null,
  angle: null,
  fit: null,
  scores: null,
  tailor: false,
};

async function processItem(
  d: RunDeps,
  ctx: Parameters<typeof scoreJob>[0],
  item: RawRow,
  stats: RunStats,
): Promise<void> {
  const { db, cfg } = d;
  const now = () => d.now().toISOString();
  const markDone = () =>
    db
      .prepare('UPDATE raw_items SET processed_at = ?, process_error = NULL WHERE id = ?')
      .run(now(), item.id);
  if (findRawDuplicate(db, item, cfg.dedupe)) {
    markDone();
    stats.items.duplicates++;
    stats.items.processed++;
    return;
  }
  const kb = item.content_hash.slice(0, 12);
  const jobs = await extractJobs(
    d.llm,
    cfg.llm.extract_model,
    {
      text: item.text ?? '',
      posted_at: item.posted_at,
      source: item.source,
      source_name: item.source_name,
    },
    `${kb}.extract`,
  );
  // Everything for one item is decided first and stored in one transaction, so an item
  // stopped half-way (usage limit) leaves no half-stored jobs behind.
  const pending: {
    job: CheckedJob;
    decision: Decision;
    dup: number | null;
    enr: Enrichment | null;
  }[] = [];
  const seenHere = new Set<string>();
  for (const [i, job] of jobs.entries()) {
    // The same job listed twice in one post or alert: keep the first.
    const here = `${normalizeTitle(job.title)}|${(job.company ?? '').toLowerCase()}`;
    if (seenHere.has(here)) continue;
    seenHere.add(here);
    const dup = findJobDuplicate(db, { ...job, created_at: item.posted_at }, cfg.dedupe);
    if (dup) {
      pending.push({
        job,
        decision: { ...DUPLICATE, flags: job.flags },
        dup: dup.duplicateOf,
        enr: null,
      });
      continue;
    }
    let enr: Enrichment | null = null;
    let j = job;
    if (!hardFilter(job, ctx).reason) {
      enr = await enrichJob(
        {
          http: d.http,
          ...(d.probeHttp ? { probeHttp: d.probeHttp } : {}),
          linkedinHttp: d.linkedinHttp,
          db,
          cfg,
          llm: d.llm,
          now: d.now(),
          log: d.log,
        },
        job,
        { rawSource: item.source, key: `${kb}.${String(i)}.enrich` },
      );
      j = enr.job;
      if (enr.directUrl || enr.enrichedFrom)
        d.out(
          `  enriched "${j.title}"${j.company ? ` · ${j.company}` : ''}: ${enr.directUrl ? `company site ${enr.directUrl}` : `description from ${enr.enrichedFrom ?? ''}`}`,
        );
    }
    const decision = await scoreJob(ctx, j, item.text ?? '', `${kb}.${String(i)}.score`);
    pending.push({ job: j, decision, dup: null, enr });
  }
  db.transaction(() => {
    for (const p of pending) {
      // A duplicate from a company feed (or traced to the company's form) gives the
      // original its direct link, so the original can be applied to on the company site.
      const direct =
        p.enr?.directUrl ??
        (item.source === 'ats' || item.source === 'html' ? p.job.apply_url : null);
      if (p.dup !== null && direct) {
        db.prepare(
          `UPDATE jobs SET apply_url_direct = ? WHERE id = ? AND apply_url_direct IS NULL
             AND status NOT IN ('applied', 'interview', 'offer', 'rejected')`,
        ).run(direct, p.dup);
      }
      const id = insertJob(db, item.id, p.job, p.decision, p.dup, now());
      if (p.enr) {
        db.prepare(
          `UPDATE jobs SET apply_url_direct = ?, apply_note = ?, enriched_from = ?, company_id = ? WHERE id = ?`,
        ).run(p.enr.directUrl, p.enr.note, p.enr.enrichedFrom, p.enr.companyId, id);
        if (p.enr.companyId !== null)
          db.prepare(
            'UPDATE companies SET discovered_job = ? WHERE id = ? AND discovered_job IS NULL',
          ).run(id, p.enr.companyId);
      }
      d.out(
        `  ${p.decision.status.padEnd(12)} ${p.job.title}${p.job.company ? ` · ${p.job.company}` : ''}${p.decision.scores ? ` · fit ${String(p.decision.scores.final)}` : ''}${p.decision.skip_reason ? ` (${p.decision.skip_reason})` : ''}`,
      );
    }
    markDone();
  })();
  stats.items.processed++;
}

/** Prepares and applies every job in status `new` (or only `onlyJobId`), best first. */
export async function tailorQueue(
  d: RunDeps,
  stats: RunStats,
  stopOn: (err: unknown) => never,
  onlyJobId?: number,
): Promise<void> {
  const { db, cfg } = d;
  const queue = (
    db
      .prepare(`SELECT * FROM jobs WHERE status = 'new' ORDER BY priority, fit_score DESC, id`)
      .all() as (JobRow & { fit_reasons: string | null })[]
  ).filter((j) => onlyJobId === undefined || j.id === onlyJobId);
  d.out(`tailor: ${String(queue.length)} jobs to prepare`);
  if (queue.length === 0) return;
  const vocab = vocabularyFor(d.profile);
  const renderer = await d.openRenderer();
  const date = d.now().toISOString().slice(0, 10);
  try {
    for (const job of queue) {
      const at = () => d.now().toISOString();
      const reasons = JSON.parse(job.fit_reasons ?? '{}') as {
        matched?: FitResult['matched'];
        missing?: string[];
        summary?: string;
        scores?: { skills: number };
      };
      const cls = d.matcher.classify(job.title);
      // A job Ahmed moved back to "new" from skipped may be an excluded title or have no
      // fit data yet: his choice wins; the angle comes from the title words.
      const angle = cls.tier !== null ? cls.angle : d.matcher.angle(normalizeTitle(job.title));
      let fit: FitResult;
      if (reasons.matched) {
        fit = {
          fit_score: reasons.scores?.skills ?? job.fit_score ?? 0,
          matched: reasons.matched,
          missing: reasons.missing ?? [],
          eligibility_issues: [],
          summary: reasons.summary ?? '',
        };
      } else {
        try {
          fit = (
            await fitScore(
              {
                cfg,
                profile: d.profile,
                matcher: d.matcher,
                llm: d.llm,
                runDate: at().slice(0, 10),
              },
              rowToCheckedJob(job),
              `job${String(job.id)}.score`,
            )
          ).fit;
        } catch (err) {
          if (err instanceof UsageLimitError) stopOn(err);
          throw err;
        }
      }
      const dir = join(
        d.outputRoot,
        date,
        `${String(job.id)}-${slug(`${job.company ?? 'company'}-${job.title}`)}`,
      );
      try {
        const prep = await prepareApplication(
          { llm: d.llm, cfg, profile: d.profile, vocab, renderer },
          {
            title: job.title,
            company: job.company,
            location: job.location,
            requirements: JSON.parse(job.requirements) as string[],
            nice_to_have: JSON.parse(job.nice_to_have) as string[],
            subject_hint: job.subject_hint,
          },
          fit,
          angle,
          dir,
          `job${String(job.id)}.tailor`,
        );
        // A job Ahmed queued himself ("Prepare anyway") is not sent back to review for a
        // low keyword score alone; the structural ATS checks still block (#32).
        const keywordOnly =
          !prep.ok &&
          prep.fit.pages === 1 &&
          prep.needsReview.length === 0 &&
          prep.ats.failures.length > 0 &&
          prep.ats.failures.every((f) => f.startsWith('keyword coverage'));
        const queuedByAhmed =
          db
            .prepare('SELECT by FROM status_history WHERE job_id = ? ORDER BY id DESC LIMIT 1')
            .pluck()
            .get(job.id) === 'ahmed';
        if (keywordOnly && queuedByAhmed) {
          const flags = JSON.parse(job.flags) as string[];
          if (!flags.includes('low_keyword_coverage')) flags.push('low_keyword_coverage');
          db.prepare('UPDATE jobs SET flags = ? WHERE id = ?').run(JSON.stringify(flags), job.id);
          d.out(`  note: ${job.title}: ${prep.problems.join('; ')} (you queued it: going ahead)`);
        } else if (!prep.ok) {
          updateJobStatus(
            db,
            job.id,
            'needs_review',
            'agent',
            at(),
            `documents: ${prep.problems.join('; ')}`.slice(0, 300),
          );
          stats.applications.review++;
          d.out(`  REVIEW  ${job.title}: ${prep.problems.join('; ')}`);
          continue;
        }
        const res = await applyJob(
          {
            db,
            cfg,
            profile: d.profile,
            gmail: d.gmailWrite,
            dryRun: d.dryRun,
            now: d.now,
            forms: d.forms ?? null,
            sourceOf: (j) => sourceLabel(db, j.raw_item_id),
          },
          db.prepare('SELECT * FROM jobs WHERE id = ?').get(job.id) as JobRow,
          prep,
        );
        if (res.mode === 'draft') stats.applications.drafts++;
        else if (res.mode === 'submitted') stats.applications.submitted++;
        else if (res.mode === 'package' || res.mode === 'manual') stats.applications.packages++;
        else if (res.mode === 'send') stats.applications.sent++;
        else stats.applications.review++;
        d.out(
          `  ${res.status.toUpperCase().padEnd(7)} ${job.title}${job.company ? ` · ${job.company}` : ''} · ${res.detail} · CV 1 page, ATS ${String(Math.round(prep.ats.keywordCoverage * 100))}%`,
        );
      } catch (err) {
        if (err instanceof UsageLimitError) stopOn(err);
        if (err instanceof LlmError && err.retryable) {
          d.out(`  ${job.title}: ${err.message} (retried next run)`);
          continue;
        }
        const msg = err instanceof Error ? err.message : String(err);
        updateJobStatus(db, job.id, 'needs_review', 'agent', at(), `error: ${msg}`.slice(0, 300));
        stats.applications.review++;
        d.out(`  REVIEW  ${job.title}: ${msg}`);
      }
    }
  } finally {
    await renderer.close();
  }
}

/** Where a job was found, in the words an application form's "how did you hear" offers. */
export function sourceLabel(db: Db, rawItemId: number): string {
  const r = db.prepare('SELECT source, source_name FROM raw_items WHERE id = ?').get(rawItemId) as
    { source: string; source_name: string | null } | undefined;
  if (!r) return 'job board';
  if (r.source === 'whatsapp' || r.source === 'whatsapp_export') return 'a WhatsApp jobs group';
  if (r.source === 'ats' || r.source === 'html') return "the company's careers page";
  const n = r.source_name ?? '';
  for (const [re, label] of [
    [/linkedin/i, 'LinkedIn'],
    [/indeed/i, 'Indeed'],
    [/wuzzuf/i, 'Wuzzuf'],
    [/bayt/i, 'Bayt'],
  ] as const)
    if (re.test(n)) return label;
  return 'a job board';
}
