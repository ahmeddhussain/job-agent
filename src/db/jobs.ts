// Writes for the jobs table and its audit trail.
import type { Db } from './index.js';
import { canonicalTitle, normalizeCompany } from '../util/text.js';
import { jobFingerprint } from '../pipeline/dedupe.js';
import type { CheckedJob } from '../pipeline/extract.js';
import type { Decision } from '../pipeline/score.js';

export function insertJob(
  db: Db,
  rawItemId: number,
  job: CheckedJob,
  decision: Decision,
  duplicateOf: number | null,
  at: string,
): number {
  const status = duplicateOf !== null ? 'skipped' : decision.status;
  const id = Number(
    db
      .prepare(
        `INSERT INTO jobs (raw_item_id, title, title_norm, company, company_norm, location, work_mode,
           seniority, years_min, requirements, nice_to_have, apply_channel, apply_email, apply_url, apply_phone,
           subject_hint, deadline, language, fingerprint, duplicate_of, priority, fit_score, fit_reasons,
           flags, status, skip_reason, created_at, updated_at)
         VALUES (@raw, @title, @title_norm, @company, @company_norm, @location, @work_mode, @seniority,
           @years_min, @requirements, @nice, @channel, @email, @url, @phone, @subject, @deadline, @language,
           @fingerprint, @dup, @priority, @fit, @reasons, @flags, @status, @skip, @at, @at)`,
      )
      .run({
        raw: rawItemId,
        title: job.title,
        title_norm: canonicalTitle(job.title),
        company: job.company,
        company_norm: normalizeCompany(job.company),
        location: job.location,
        work_mode: job.work_mode,
        seniority: job.seniority,
        years_min: job.years_min,
        requirements: JSON.stringify(job.requirements),
        nice: JSON.stringify(job.nice_to_have),
        channel: job.apply_channel,
        email: job.apply_email,
        url: job.apply_url,
        phone: job.apply_phone,
        subject: job.subject_hint,
        deadline: job.deadline,
        language: job.language,
        fingerprint: jobFingerprint(job),
        dup: duplicateOf,
        priority: decision.priority,
        fit: decision.scores?.final ?? null,
        reasons: decision.fit
          ? JSON.stringify({
              scores: decision.scores,
              matched: decision.fit.matched,
              missing: decision.fit.missing,
              summary: decision.fit.summary,
            })
          : null,
        flags: JSON.stringify(decision.flags),
        status,
        skip: duplicateOf !== null ? 'duplicate' : decision.skip_reason,
        at,
      }).lastInsertRowid,
  );
  db.prepare(
    `INSERT INTO status_history (job_id, from_status, to_status, by, at) VALUES (?, NULL, ?, 'agent', ?)`,
  ).run(id, status, at);
  return id;
}

export type Status =
  'new' | 'skipped' | 'needs_review' | 'ready' | 'applied' | 'interview' | 'offer' | 'rejected';

/** Changes a job's status and records who did it (status_history). No-op when unchanged. */
export function updateJobStatus(
  db: Db,
  jobId: number,
  to: Status,
  by: 'agent' | 'sync' | 'ahmed',
  at: string,
  reason?: string | null,
): void {
  const from = db.prepare('SELECT status FROM jobs WHERE id = ?').pluck().get(jobId) as
    string | undefined;
  if (from === undefined) throw new Error(`job ${String(jobId)} not found`);
  if (from === to && reason === undefined) return;
  // reason: undefined keeps the stored skip_reason, null clears it, a string replaces it.
  if (reason === undefined)
    db.prepare('UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?').run(to, at, jobId);
  else
    db.prepare('UPDATE jobs SET status = ?, skip_reason = ?, updated_at = ? WHERE id = ?').run(
      to,
      reason,
      at,
      jobId,
    );
  if (from !== to) {
    db.prepare(
      `INSERT INTO status_history (job_id, from_status, to_status, by, at) VALUES (?, ?, ?, ?, ?)`,
    ).run(jobId, from, to, by, at);
  }
}

export interface JobRow {
  id: number;
  raw_item_id: number;
  title: string;
  company: string | null;
  location: string | null;
  work_mode: CheckedJob['work_mode'];
  seniority: CheckedJob['seniority'];
  years_min: number | null;
  requirements: string;
  nice_to_have: string;
  apply_channel: CheckedJob['apply_channel'];
  apply_email: string | null;
  apply_url: string | null;
  apply_phone: string | null;
  apply_url_direct: string | null;
  apply_note: string | null;
  subject_hint: string | null;
  deadline: string | null;
  language: CheckedJob['language'] | null;
  priority: 1 | 2 | 3 | null;
  fit_score: number | null;
  fit_reasons: string | null;
  flags: string;
  status: Status;
  skip_reason: string | null;
  created_at: string;
}

export function getJob(db: Db, id: number): JobRow | undefined {
  return db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined;
}

const arr = (s: string | null): string[] => {
  try {
    const v = JSON.parse(s ?? '[]') as unknown;
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
};

/** A stored job back in the shape the score stage takes (for `reprocess --from score`). */
export function rowToCheckedJob(r: JobRow): CheckedJob {
  return {
    title: r.title,
    company: r.company,
    location: r.location,
    country: null,
    work_mode: r.work_mode,
    seniority: r.seniority,
    years_min: r.years_min,
    requirements: arr(r.requirements),
    nice_to_have: arr(r.nice_to_have),
    apply_channel: r.apply_channel,
    apply_email: r.apply_email,
    apply_url: r.apply_url,
    apply_phone: r.apply_phone,
    subject_hint: r.subject_hint,
    deadline: r.deadline,
    language: r.language ?? 'en',
    eligibility: [],
    scam_signals: [],
    flags: arr(r.flags),
  };
}
