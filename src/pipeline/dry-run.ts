// `agent run --dry-run --fixtures`: the P2 gate. Runs the fixtures through normalize →
// dedupe L0-L2 → extract → dedupe L3 → score, in an in-memory database, and compares
// the result with each fixture's expectations. Nothing touches Gmail or the real DB.
import type { Logger } from 'pino';
import type { Config } from '../config.js';
import { insertJob } from '../db/jobs.js';
import { migrate, openDb, type Db } from '../db/index.js';
import type { Fixture } from '../dev/fixtures.js';
import { UsageLimitError, type Llm, type LlmCallRecord } from '../llm/types.js';
import type { Profile } from '../profile/load.js';
import { canonicalTitle } from '../util/text.js';
import { canonicalizeUrl } from '../util/url.js';
import {
  findJobDuplicate,
  findRawDuplicate,
  insertRawItem,
  prepareRawItem,
  type RawDuplicate,
} from './dedupe.js';
import { extractJobs, type CheckedJob } from './extract.js';
import { scoreJob, type Decision } from './score.js';
import type { TitleMatcher } from './titles.js';

export interface JobOutcome {
  jobId: number;
  job: CheckedJob;
  decision: Decision;
  duplicateOf: number | null;
}

export interface FixtureOutcome {
  fixture: Fixture;
  raw: RawDuplicate | null;
  rawId: number;
  jobs: JobOutcome[];
  notReached?: boolean;
}

export interface FixtureRun {
  outcomes: FixtureOutcome[];
  status: 'success' | 'partial';
  stopReason: string | null;
  calls: LlmCallRecord[];
  db: Db;
}

export interface FixtureRunOptions {
  cfg: Config;
  profile: Profile;
  matcher: TitleMatcher;
  llm: Llm;
  fixtures: Fixture[];
  runDate: string;
  log: Logger;
  calls?: LlmCallRecord[];
}

export async function runFixtures(o: FixtureRunOptions): Promise<FixtureRun> {
  const db = openDb(':memory:');
  migrate(db);
  const calls = o.calls ?? [];
  const runId = Number(
    db
      .prepare(`INSERT INTO runs (started_at, status, mode) VALUES (?, 'running', 'dry_run')`)
      .run(new Date().toISOString()).lastInsertRowid,
  );
  const ctx = {
    cfg: o.cfg,
    profile: o.profile,
    matcher: o.matcher,
    llm: o.llm,
    runDate: o.runDate,
  };
  const outcomes: FixtureOutcome[] = [];
  let stopReason: string | null = null;

  for (const f of o.fixtures) {
    const item = prepareRawItem({ ...f, run_id: runId });
    const { id: rawId } = insertRawItem(db, item, f.posted_at);
    const outcome: FixtureOutcome = { fixture: f, raw: null, rawId, jobs: [] };
    outcomes.push(outcome);
    if (stopReason) {
      outcome.notReached = true;
      continue;
    }
    outcome.raw = findRawDuplicate(db, { ...item, id: rawId, text: f.text }, o.cfg.dedupe);
    if (outcome.raw) continue;

    try {
      const jobs = await extractJobs(
        o.llm,
        o.cfg.llm.extract_model,
        { text: f.text, posted_at: f.posted_at, source: f.source, source_name: f.source_name },
        `${f.id}.extract`,
      );
      for (const [i, job] of jobs.entries()) {
        const dup = findJobDuplicate(db, { ...job, created_at: f.posted_at }, o.cfg.dedupe);
        const decision: Decision = dup
          ? {
              status: 'skipped',
              skip_reason: 'duplicate',
              flags: job.flags,
              priority: null,
              angle: null,
              fit: null,
              scores: null,
              tailor: false,
            }
          : await scoreJob(ctx, job, f.text, `${f.id}.${String(i)}.score`);
        const jobId = insertJob(db, rawId, job, decision, dup?.duplicateOf ?? null, f.posted_at);
        outcome.jobs.push({ jobId, job, decision, duplicateOf: dup?.duplicateOf ?? null });
      }
    } catch (err) {
      if (err instanceof UsageLimitError) {
        stopReason = `usage limit reached: ${err.message}`;
        outcome.notReached = true;
        o.log.warn({ fixture: f.id }, 'usage limit reached; stopping model calls for this run');
        continue;
      }
      throw err;
    }
  }

  const status = stopReason ? 'partial' : 'success';
  db.prepare(`UPDATE runs SET finished_at = ?, status = ?, stats = ? WHERE id = ?`).run(
    new Date().toISOString(),
    status,
    JSON.stringify({ fixtures: o.fixtures.length, calls: calls.length }),
    runId,
  );
  return { outcomes, status, stopReason, calls, db };
}

// ------------------------------------------------------------------- gate comparison

export interface Mismatch {
  fixture: string;
  job: number | null;
  field: string;
  expected: unknown;
  actual: unknown;
}

const HARD_SKIPS = new Set(['excluded_title', 'deadline_passed', 'over_experience', 'location']);

/** Titles match when one canonical title's words are all in the other ("Frontend Developer" ⊂ "Frontend Developer React"). */
export function titlesMatch(expected: string, actual: string): boolean {
  const a = new Set(canonicalTitle(expected).split(' '));
  const b = new Set(canonicalTitle(actual).split(' '));
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  return [...small].every((t) => big.has(t));
}

export function compareWithExpected(run: FixtureRun): Mismatch[] {
  const out: Mismatch[] = [];
  const firstJobId = new Map(run.outcomes.map((o) => [o.fixture.id, o.jobs[0]?.jobId]));
  const rawIdOf = new Map(run.outcomes.map((o) => [o.fixture.id, o.rawId]));

  for (const o of run.outcomes) {
    const f = o.fixture;
    const want = f.expected;
    const add = (job: number | null, field: string, expected: unknown, actual: unknown) => {
      out.push({ fixture: f.id, job, field, expected, actual });
    };
    if (o.notReached) {
      add(null, 'reached', true, false);
      continue;
    }
    if (want.dedupe?.layer === 'L1' || want.dedupe?.layer === 'L2') {
      if (
        o.raw?.layer !== want.dedupe.layer ||
        o.raw.duplicateOf !== rawIdOf.get(want.dedupe.duplicate_of)
      ) {
        add(
          null,
          'dedupe',
          `${want.dedupe.layer} of ${want.dedupe.duplicate_of}`,
          o.raw ? `${o.raw.layer} of raw ${String(o.raw.duplicateOf)}` : 'none',
        );
      }
      continue;
    }
    if (o.raw) {
      add(null, 'dedupe', 'none', o.raw.layer);
      continue;
    }
    if (o.jobs.length !== want.jobs.length) {
      add(null, 'job_count', want.jobs.length, o.jobs.length);
    }
    want.jobs.forEach((ej, i) => {
      const aj = o.jobs[i];
      if (!aj) return;
      const j = aj.job;
      if (!titlesMatch(ej.title, j.title)) add(i, 'title', ej.title, j.title);
      if (ej.apply_channel !== j.apply_channel)
        add(i, 'apply_channel', ej.apply_channel, j.apply_channel);
      if ((ej.apply_email ?? null) !== (j.apply_email ?? null))
        add(i, 'apply_email', ej.apply_email, j.apply_email);
      if (ej.apply_url && canonicalizeUrl(ej.apply_url) !== j.apply_url)
        add(i, 'apply_url', ej.apply_url, j.apply_url);

      if (want.dedupe?.layer === 'L3' && i === 0) {
        const orig = firstJobId.get(want.dedupe.duplicate_of);
        if (aj.duplicateOf !== orig)
          add(i, 'dedupe', `L3 of ${want.dedupe.duplicate_of}`, aj.duplicateOf);
        return;
      }
      const reason = ej.excluded ?? ej.skip_reason;
      if (reason && HARD_SKIPS.has(reason)) {
        if (aj.decision.status !== 'skipped' || aj.decision.skip_reason !== reason) {
          add(
            i,
            'status',
            `skipped:${reason}`,
            `${aj.decision.status}:${String(aj.decision.skip_reason)}`,
          );
        }
      } else if (ej.flags.includes('suspicious')) {
        if (aj.decision.status !== 'needs_review')
          add(i, 'status', 'needs_review', aj.decision.status);
      } else if (aj.decision.skip_reason && HARD_SKIPS.has(aj.decision.skip_reason)) {
        add(i, 'status', 'not hard-skipped', `skipped:${aj.decision.skip_reason}`);
      }
      if (ej.tier !== null && aj.decision.priority !== ej.tier && !aj.duplicateOf) {
        add(i, 'priority', ej.tier, aj.decision.priority);
      }
    });
  }
  return out;
}
