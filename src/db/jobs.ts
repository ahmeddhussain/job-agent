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
           seniority, years_min, requirements, nice_to_have, apply_channel, apply_email, apply_url,
           subject_hint, deadline, language, fingerprint, duplicate_of, priority, fit_score, fit_reasons,
           flags, status, skip_reason, created_at, updated_at)
         VALUES (@raw, @title, @title_norm, @company, @company_norm, @location, @work_mode, @seniority,
           @years_min, @requirements, @nice, @channel, @email, @url, @subject, @deadline, @language,
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
