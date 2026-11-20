// Runs every fixture through dedupe L0–L3 in posting order, the way a run would, and
// checks each one against its expected outcome (PLAN P1 gate).
import { beforeAll, describe, expect, it } from 'vitest';
import { migrate, openDb, type Db } from '../../src/db/index.js';
import {
  findJobDuplicate,
  findRawDuplicate,
  insertRawItem,
  jobFingerprint,
  prepareRawItem,
  type DedupeOptions,
  type JobDuplicate,
  type RawDuplicate,
} from '../../src/pipeline/dedupe.js';
import { canonicalTitle, normalizeCompany } from '../../src/util/text.js';
import { loadFixtures, type ExpectedJob, type Fixture } from '../helpers/fixtures.js';

const OPTS: DedupeOptions = {
  content_window_days: 60,
  near_dup_window_days: 30,
  simhash_max_distance: 10,
  near_dup_similarity: 0.9,
  title_similarity: 0.85,
};

interface Outcome {
  fixture: Fixture;
  rawId: number;
  raw: RawDuplicate | null;
  jobs: { jobId: number; title: string; dup: JobDuplicate | null }[];
}

function insertJob(db: Db, rawId: number, j: ExpectedJob, createdAt: string, dupOf: number | null) {
  return Number(
    db
      .prepare(
        `INSERT INTO jobs (raw_item_id, title, title_norm, company, company_norm, apply_channel,
           apply_email, apply_url, fingerprint, duplicate_of, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        rawId,
        j.title,
        canonicalTitle(j.title),
        j.company,
        normalizeCompany(j.company),
        j.apply_channel,
        j.apply_email,
        j.apply_url,
        jobFingerprint(j),
        dupOf,
        dupOf === null ? 'new' : 'skipped',
        createdAt,
        createdAt,
      ).lastInsertRowid,
  );
}

describe('dedupe L0–L3 over the fixtures', () => {
  const fixtures = loadFixtures();
  const outcomes = new Map<string, Outcome>();
  const rawIdOf = new Map<string, number>();
  let db: Db;

  beforeAll(() => {
    db = openDb(':memory:');
    migrate(db);
    for (const f of fixtures) {
      const item = prepareRawItem({ ...f, text: f.text });
      const { id } = insertRawItem(db, item, f.posted_at);
      rawIdOf.set(f.id, id);
      const raw = findRawDuplicate(db, { ...item, id, text: f.text }, OPTS);
      const jobs: Outcome['jobs'] = [];
      if (raw === null) {
        // Only originals go to extraction; expected jobs stand in for P2's output here.
        for (const j of f.expected.jobs) {
          const dup = findJobDuplicate(db, { ...j, created_at: f.posted_at }, OPTS);
          jobs.push({
            jobId: insertJob(db, id, j, f.posted_at, dup?.duplicateOf ?? null),
            title: j.title,
            dup,
          });
        }
      }
      outcomes.set(f.id, { fixture: f, rawId: id, raw, jobs });
    }
  });

  it('has at least 20 fixtures (PLAN P1)', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(20);
  });

  it('L0: re-collecting the same message (run overlap) inserts nothing', () => {
    const f = fixtures[0];
    if (!f) throw new Error('no fixtures');
    const again = insertRawItem(db, prepareRawItem({ ...f }), f.posted_at);
    expect(again).toEqual({ id: rawIdOf.get(f.id), inserted: false });
  });

  it.each(fixtures.map((f) => [f.id, f] as const))('%s', (id) => {
    const o = outcomes.get(id);
    if (!o) throw new Error(`no outcome for ${id}`);
    const want = o.fixture.expected.dedupe;

    if (want?.layer === 'L1' || want?.layer === 'L2') {
      expect(o.raw?.layer).toBe(want.layer);
      expect(o.raw?.duplicateOf).toBe(rawIdOf.get(want.duplicate_of));
      return;
    }
    expect(o.raw).toBeNull();

    if (want?.layer === 'L3') {
      const original = outcomes.get(want.duplicate_of)?.jobs[0]?.jobId;
      expect(o.jobs[0]?.dup?.duplicateOf).toBe(original);
      return;
    }
    // No expectation: every job from this post is an original.
    for (const j of o.jobs) expect(j.dup, `${id}: "${j.title}"`).toBeNull();
  });

  it('a recruiter posting two different roles gets two separate jobs (not merged)', () => {
    const o = outcomes.get('13-recruiter-two-roles');
    expect(o?.jobs).toHaveLength(2);
    expect(o?.jobs.every((j) => j.dup === null)).toBe(true);
  });

  it('a different role to the same email as an earlier post is not merged', () => {
    expect(outcomes.get('21-monitoring-same-recruiter')?.jobs[0]?.dup).toBeNull();
  });

  it('a repost too different for L2 is still caught by L3, so it is never applied to twice', () => {
    const src = fixtures.find((f) => f.id === '19-sre-lever');
    const job = src?.expected.jobs[0];
    if (!src || !job) throw new Error('fixture 19 missing');
    const repost = {
      ...src,
      source_ref: 'wa-repost-1',
      posted_at: '2026-11-21T08:00:00Z',
      text: `${src.text}\nUrgent hiring!`,
    };
    const item = prepareRawItem(repost);
    const { id } = insertRawItem(db, item, repost.posted_at);
    expect(findRawDuplicate(db, { ...item, id, text: repost.text }, OPTS)).toBeNull();
    const dup = findJobDuplicate(db, { ...job, created_at: repost.posted_at }, OPTS);
    expect(dup?.duplicateOf).toBe(outcomes.get('19-sre-lever')?.jobs[0]?.jobId);
  });

  it('a multi-job post yields one job per role', () => {
    expect(outcomes.get('04-multi-job')?.jobs.map((j) => j.title)).toEqual([
      'Junior DevOps Engineer',
      'QA Automation Engineer',
      'Frontend Developer',
    ]);
  });
});
