// Form questions the profile couldn't answer (D35). Each one is recorded once, shown in
// the run output, the digest and the dashboard's Profile section, and answered there
// once: the answer goes into profile.application_answers, so every later form gets it.
// Forms that stopped only on answered questions are retried on the next run.
import type { Db } from '../db/index.js';

export const normQuestion = (q: string): string =>
  q
    .toLowerCase()
    .replace(/\(could not fill:.*$/, '')
    .replace(/[*:?]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** A readable application_answers key: "Current Salary*" → current_salary. */
export function answerKey(question: string): string {
  const k = normQuestion(question)
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 50)
    .replace(/_+$/, '');
  return k || 'answer';
}

/** Records what a form asked and the profile couldn't answer; returns the new questions. */
export function recordQuestions(db: Db, labels: string[], jobId: number, at: string): string[] {
  const fresh: string[] = [];
  for (const label of labels) {
    if (/could not fill/.test(label)) continue; // a filling problem, not a missing answer
    const norm = normQuestion(label);
    if (!norm) continue;
    const r = db
      .prepare(
        `INSERT INTO form_questions (question, question_norm, first_seen, last_seen, last_job_id)
         VALUES (@q, @n, @at, @at, @job)
         ON CONFLICT (question_norm) DO UPDATE SET times = times + 1, last_seen = @at, last_job_id = @job`,
      )
      .run({ q: label.replace(/\*+\s*$/, '').trim(), n: norm, at, job: jobId });
    if (
      r.changes === 1 &&
      db.prepare('SELECT times FROM form_questions WHERE question_norm = ?').pluck().get(norm) === 1
    )
      fresh.push(label);
  }
  return fresh;
}

export interface PendingQuestion {
  id: number;
  question: string;
  times: number;
  first_seen: string;
  last_seen: string;
  last_job_id: number | null;
  suggested_key: string;
}

export function pendingQuestions(db: Db): PendingQuestion[] {
  return (
    db
      .prepare(
        `SELECT id, question, times, first_seen, last_seen, last_job_id FROM form_questions
         WHERE answer_key IS NULL ORDER BY times DESC, last_seen DESC`,
      )
      .all() as Omit<PendingQuestion, 'suggested_key'>[]
  ).map((q) => ({ ...q, suggested_key: answerKey(q.question) }));
}

/** True when every question in `labels` now has an answer (so the form is worth retrying). */
export function allAnswered(db: Db, labels: string[]): boolean {
  const q = db.prepare('SELECT answer_key FROM form_questions WHERE question_norm = ?').pluck();
  return labels.every((l) => q.get(normQuestion(l)) != null);
}
