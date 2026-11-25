// Which stored job an application email is about (D53). Sure signs first (the same thread,
// the same LinkedIn job, the address applied to), then company and title.
import type { Db } from '../db/index.js';
import type { MailSummary } from '../gmail/client.js';
import { canonicalTitle, diceSimilarity, normalizeCompany, tokens } from '../util/text.js';
import { addressOf, type MailFacts } from './mail.js';

export interface Candidate {
  id: number;
  title: string;
  company: string | null;
  status: string;
  /** When it was applied to, else when the job was found. */
  at: string;
  rejected_at: string | null;
}

export type Match =
  | { job: Candidate }
  /** Nothing stored fits: a job the agent doesn't know. */
  | { job: null; ambiguous: false }
  /** Several fit equally: never guessed. */
  | { job: null; ambiguous: true };

const TITLE_MIN = 0.7;
/** For a job not applied to yet, the title must be nearly the same. */
const TITLE_MIN_NEW = 0.85;
export const UNNAMED = 'Role not named in the email';

/** Equal names, or one name starting with the other ("Acme", "Acme - Global"). */
function companyMatch(a: string, b: string): 'equal' | 'part' | null {
  if (a === b || a.replace(/ /g, '') === b.replace(/ /g, '')) return 'equal';
  const [x, y] = [tokens(a), tokens(b)];
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length > 0 && (short[0] ?? '').length >= 4 && short.every((t, i) => t === long[i])
    ? 'part'
    : null;
}

const plain = (t: string) => canonicalTitle(t.replace(/\binformation technology\b/gi, 'IT'));
export const titleSimilarity = (a: string, b: string): number => diceSimilarity(plain(a), plain(b));
/** "Internship" for "Tech Internship": every word of the shorter title is in the other. */
const titlePart = (a: string, b: string): boolean => {
  const [x, y] = [tokens(plain(a)), tokens(plain(b))];
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length > 0 && short.every((t) => long.includes(t));
};

const SENIORITY =
  /\b(senior|sr|junior|jr|lead|principal|staff|manager|head|intern(?:ship)?|trainee|graduate)\b/g;
const seniority = (t: string) =>
  [...new Set(t.toLowerCase().match(SENIORITY) ?? [])].sort().join(' ');

const APPLIED = new Set(['applied', 'interview', 'offer', 'rejected']);

const FROM = `SELECT j.id, j.title, j.company, j.status,
    COALESCE(a.sent_at, (SELECT max(h.at) FROM status_history h WHERE h.job_id = j.id AND h.to_status = 'applied'), j.created_at) AS at,
    (SELECT max(h.at) FROM status_history h WHERE h.job_id = j.id AND h.to_status = 'rejected' AND j.status = 'rejected') AS rejected_at
  FROM jobs j LEFT JOIN applications a ON a.job_id = j.id`;

export function matchJob(db: Db, m: MailSummary, f: MailFacts, opt: { windowDays: number }): Match {
  const none: Match = { job: null, ambiguous: false };
  const get = (sql: string, ...args: unknown[]) =>
    db.prepare(`${FROM} ${sql}`).all(...args) as Candidate[];
  const ok = (c: Candidate | undefined): Match | null => (c ? { job: c } : null);

  const thread = ok(
    get(
      `WHERE a.gmail_thread_id = ? OR j.id IN (SELECT job_id FROM application_mail WHERE thread_id = ?)
       ORDER BY j.id DESC LIMIT 1`,
      m.threadId,
      m.threadId,
    )[0],
  );
  if (thread) return thread;

  if (f.applyUrl) {
    const same = get(
      `WHERE j.apply_url = ? OR j.apply_url_direct = ? ORDER BY j.duplicate_of IS NOT NULL, j.id LIMIT 1`,
      f.applyUrl,
      f.applyUrl,
    )[0];
    if (same) {
      const original = db
        .prepare('SELECT duplicate_of FROM jobs WHERE id = ?')
        .pluck()
        .get(same.id) as number | null;
      return { job: original ? (get('WHERE j.id = ?', original)[0] ?? same) : same };
    }
  }

  // The jobs an application could be for: not from long before or after the email.
  const span = opt.windowDays * 86_400_000;
  const near = (c: Candidate) =>
    APPLIED.has(c.status) || Math.abs(Date.parse(c.at) - Date.parse(m.internalDate)) <= span;
  const before = (c: Candidate) => c.rejected_at !== null && c.rejected_at < m.internalDate;
  const days = (c: Candidate) => (Date.parse(m.internalDate) - Date.parse(c.at)) / 86_400_000;
  const title = f.title;
  /** Is this stored job the one the titled email is about, and how sure. */
  const score = (c: Candidate): number => {
    if (!title || c.title === UNNAMED) return 0;
    const s = titleSimilarity(c.title, title);
    if (!APPLIED.has(c.status))
      return s >= TITLE_MIN_NEW && seniority(c.title) === seniority(title) ? s : 0;
    if (s < TITLE_MIN) return 0;
    if (f.kind !== 'applied') return s;
    // A second application: after a rejection, or to a differently named role days later.
    const sameName = plain(c.title) === plain(title) && seniority(c.title) === seniority(title);
    return before(c) || (!sameName && Math.abs(days(c)) > 2) ? 0 : s;
  };
  const pick = (list: Candidate[]): Match | null => {
    if (title) {
      const scored = list
        .map((c) => ({ c, s: score(c) }))
        .filter((x) => x.s > 0)
        .sort(
          (x, y) =>
            y.s - x.s ||
            Number(APPLIED.has(y.c.status)) - Number(APPLIED.has(x.c.status)) ||
            Number(before(x.c)) - Number(before(y.c)) ||
            y.c.at.localeCompare(x.c.at),
        );
      if (scored[0]) return { job: scored[0].c };
      const unnamed = list.filter((c) => c.title === UNNAMED && !before(c));
      if (unnamed.length === 1 && unnamed[0]) return { job: unnamed[0] };
      const part = list.filter((c) => APPLIED.has(c.status) && titlePart(c.title, title));
      return f.kind !== 'applied' && part.length === 1 && part[0] ? { job: part[0] } : null;
    }
    const applied = list.filter((c) => APPLIED.has(c.status));
    // An answer without a title may be a second notice about any of them.
    const active = f.kind === 'applied' ? applied.filter((c) => !before(c)) : applied;
    if (active.length === 1 && active[0]) return { job: active[0] };
    if (active.length === 0) return null;
    // "Thanks for applying to X" arrives right after the application itself.
    const just = active.filter((c) => f.kind === 'applied' && days(c) >= -1 && days(c) <= 2);
    if (just.length === 1 && just[0]) return { job: just[0] };
    return { job: null, ambiguous: true };
  };

  const address = addressOf(m.labelIds.includes('SENT') ? m.to : m.from);
  if (address) {
    const byAddress = get(
      `WHERE j.duplicate_of IS NULL AND (lower(a.to_email) = ? OR lower(j.apply_email) = ?)`,
      address,
      address,
    ).filter(near);
    const hit = pick(byAddress);
    if (hit) return hit;
  }

  const company = normalizeCompany(f.company);
  if (company) {
    const all = get('WHERE j.duplicate_of IS NULL AND j.company IS NOT NULL').filter(near);
    const equal = all.filter(
      (c) => companyMatch(normalizeCompany(c.company) ?? '', company) === 'equal',
    );
    const hit = pick(equal);
    if (hit) return hit;
    // A partly equal name ("Voltara", "Voltara Energy") counts only with the same title.
    if (f.title) {
      const part = pick(
        all.filter(
          (c) =>
            c.title !== UNNAMED &&
            companyMatch(normalizeCompany(c.company) ?? '', company) === 'part',
        ),
      );
      if (part) return part;
    }
  }
  // No company in the email, nor in the stored job: the same title, applied to just before.
  if (!company && f.title) {
    const same = get(
      "WHERE j.duplicate_of IS NULL AND j.company IS NULL AND j.status IN ('applied', 'interview')",
    ).filter(
      (c) =>
        titleSimilarity(c.title, f.title ?? '') >= 0.9 &&
        Math.abs(Date.parse(m.internalDate) - Date.parse(c.at)) <= 2 * 86_400_000,
    );
    if (same.length === 1 && same[0]) return { job: same[0] };
  }
  return none;
}
