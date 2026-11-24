// Answers learned from forms the user finished (D50): short facts that mean the same on every
// form. Never learned: long texts, anything about one company or role, identity and contact
// details, secrets, agreements and sensitive personal data.
import type { Db } from '../db/index.js';
import { normQuestion } from './questions.js';

export interface LearnItem {
  label: string;
  name: string;
  kind: 'text' | 'select' | 'radio';
  inputType: string;
  value: string;
  /** typed: the user's own; kept: the add-on's answer, left as it was. */
  source: 'typed' | 'kept';
}

export interface LearnedAnswer {
  question_norm: string;
  question: string;
  value: string;
  source: 'typed' | 'kept';
  times: number;
  updated_at: string;
}

const CONTACT =
  /e-?mail|phone|mobile|telephone|whats ?app|\b(first|last|full|family|given|sur) ?name|^name$|linkedin|github|portfolio|website|url|رقم|البريد|الاسم/i;
const SECRET =
  /password|captcha|\botp\b|(verification|security|promo) code|login|user ?name|card|iban|bank|national id|passport|social security|\bssn\b|tax|الرقم القومي/i;
const SENSITIVE =
  /gender|\bsex\b|race|ethnic|disab|veteran|religio|marital|pregnan|health|orientation|birth|nationality/i;
const ONE_OFF =
  /hear about|how did you|source|refer|\bwhy\b|motivat|message|comment|cover|job (id|title|code)|position|this (role|company|job|team)|applied|worked (here|at|for|with)|relative|start date|\bdate\b|interview|signature/i;
const AGREE = /agree|consent|accept|terms|privacy|gdpr|acknowledge|certify|confirm/i;

/** Why an answer is not learned, or null when it may be. */
export function notLearnable(i: LearnItem, company: string | null): string | null {
  const l = `${i.label} ${i.name}`;
  const q = normQuestion(i.label);
  const v = i.value.trim();
  if (q.length < 3 || q.length > 200) return 'no clear question';
  if (v === '' || v.length > 120 || /[\r\n]/.test(v)) return 'not a short answer';
  if (['email', 'tel', 'password', 'url', 'date'].includes(i.inputType)) return 'contact or date';
  if (CONTACT.test(l)) return 'contact details come from the profile';
  if (SECRET.test(l) || /\d{9,}/.test(v.replace(/[\s\-+().]/g, '')))
    return 'secret or a long number';
  if (SENSITIVE.test(l)) return 'sensitive';
  if (AGREE.test(l)) return 'an agreement';
  if (ONE_OFF.test(l)) return 'about one job';
  if (company && company.length > 2 && q.includes(normQuestion(company)))
    return 'about one company';
  return null;
}

/** Stores what may be learned; returns the questions stored. The latest answer wins. */
export function learn(
  db: Db,
  items: LearnItem[],
  job: { id: number; company: string | null },
  at: string,
): string[] {
  const put = db.prepare(
    `INSERT INTO learned_answers (question_norm, question, value, source, last_job_id, updated_at)
     VALUES (@n, @q, @v, @s, @job, @at)
     ON CONFLICT (question_norm) DO UPDATE SET value = @v, source = @s, times = times + 1,
       last_job_id = @job, updated_at = @at`,
  );
  const out: string[] = [];
  db.transaction(() => {
    for (const i of items) {
      if (notLearnable(i, job.company)) continue;
      const question = i.label.replace(/^[*✱\s]+|[*✱\s]+$/g, '');
      put.run({
        n: normQuestion(i.label),
        q: question,
        v: i.value.trim(),
        s: i.source,
        job: job.id,
        at,
      });
      out.push(question);
    }
  })();
  return out;
}

export function learnedAnswers(db: Db): LearnedAnswer[] {
  return db
    .prepare(
      `SELECT question_norm, question, value, source, times, updated_at FROM learned_answers
       ORDER BY updated_at DESC, question`,
    )
    .all() as LearnedAnswer[];
}

export function forget(db: Db, questionNorm: string): boolean {
  return (
    db.prepare('DELETE FROM learned_answers WHERE question_norm = ?').run(questionNorm).changes > 0
  );
}
