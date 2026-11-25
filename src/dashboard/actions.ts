// What the dashboard can do beyond status edits (D39-D41): "Not a fit" with reasons and the
// rule suggestions learned from them, bulk actions, follow-up drafts, interview prep, and
// the source scoreboard. Each is a plain function over the database, tested on its own.
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { getJob, rowToCheckedJob, updateJobStatus, type Status } from '../db/jobs.js';
import type { GmailWriter } from '../gmail/client.js';
import { buildMime } from '../gmail/mime.js';
import { InterviewPrepSchema, type InterviewPrep } from '../llm/schemas.js';
import type { Llm } from '../llm/types.js';
import { fence, loadPrompt } from '../pipeline/extract.js';
import { evidenceIds, SENIOR_TITLE } from '../pipeline/score.js';
import { profileForPrompt, type Profile } from '../profile/load.js';
import { signature } from '../apply/email.js';
import { readSettings, updateSettings } from '../settings.js';
import { normalizeCompany, normalizeTitle } from '../util/text.js';

export const DISCARD_REASONS = [
  'wrong_field',
  'too_senior',
  'company',
  'location',
  'already_applied',
  'other',
] as const;
export type DiscardReason = (typeof DISCARD_REASONS)[number];

/** "Not a fit": skipped with Ahmed's reason; the agent's own unsent draft is deleted. */
export async function discardJob(
  db: Db,
  gmail: GmailWriter | null,
  jobId: number,
  reason: DiscardReason,
  note: string | null,
): Promise<{ draftDeleted: boolean; draftNote: string | null }> {
  const job = getJob(db, jobId);
  if (!job) throw new Error('job not found');
  if (['applied', 'interview', 'offer', 'rejected'].includes(job.status))
    throw new Error(`already ${job.status}: change its status instead`);
  const at = new Date().toISOString();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO discards (job_id, reason, note, at) VALUES (?, ?, ?, ?)
       ON CONFLICT (job_id) DO UPDATE SET reason = excluded.reason, note = excluded.note, at = excluded.at`,
    ).run(jobId, reason, note, at);
    updateJobStatus(db, jobId, 'skipped', 'ahmed', at, `discarded: ${reason}`);
  })();
  const app = db
    .prepare('SELECT gmail_draft_id, sent_at FROM applications WHERE job_id = ?')
    .get(jobId) as { gmail_draft_id: string | null; sent_at: string | null } | undefined;
  if (!app?.gmail_draft_id || app.sent_at) return { draftDeleted: false, draftNote: null };
  if (!gmail)
    return { draftDeleted: false, draftNote: 'Gmail unavailable: delete the draft in Gmail' };
  try {
    if (await gmail.draftExists(app.gmail_draft_id)) await gmail.deleteOwnDraft(app.gmail_draft_id);
    db.prepare('UPDATE applications SET gmail_draft_id = NULL WHERE job_id = ?').run(jobId);
    return { draftDeleted: true, draftNote: null };
  } catch (err) {
    return { draftDeleted: false, draftNote: `draft not deleted: ${String(err).slice(0, 120)}` };
  }
}

export interface Suggestion {
  key: string;
  kind: 'exclude_title' | 'block_company' | 'skip_senior' | 'threshold';
  value: string;
  why: string;
}

const STOP = new Set([
  'and', 'or', 'the', 'of', 'for', 'in', 'at', 'to', 'a', 'an', 'senior', 'junior', 'mid', 'level',
  'engineer', 'specialist', 'manager', 'lead', 'i', 'ii', 'iii', 'remote', 'egypt', 'cairo', 'with',
]);

/**
 * Rules learned from discards, each shown once until applied or dismissed:
 * - a title word in 2+ "wrong field" discards and in no job prepared or applied to;
 * - a company discarded twice (any reason) or once for "company".
 */
export function suggestions(db: Db, cfg: Config): Suggestion[] {
  const dismissed = new Set(
    (db.prepare('SELECT key FROM dismissed_suggestions').pluck().all() as string[]),
  );
  const settings = readSettings(cfg);
  const out: Suggestion[] = [];
  const rows = db
    .prepare(
      `SELECT d.reason, j.title, j.company FROM discards d JOIN jobs j ON j.id = d.job_id`,
    )
    .all() as { reason: DiscardReason; title: string; company: string | null }[];
  const kept = (
    db
      .prepare(
        `SELECT title FROM jobs WHERE status IN ('ready', 'applied', 'interview', 'offer', 'rejected', 'new')`,
      )
      .pluck()
      .all() as string[]
  ).map((t) => normalizeTitle(t));

  const words = new Map<string, number>();
  for (const r of rows.filter((x) => x.reason === 'wrong_field'))
    for (const w of new Set(normalizeTitle(r.title).split(/[^a-z0-9+#.]+/)))
      if (w.length >= 2 && !STOP.has(w)) words.set(w, (words.get(w) ?? 0) + 1);
  for (const [w, n] of words) {
    const key = `exclude_title:${w}`;
    const already = settings.excluded_titles.some((p) => new RegExp(p, 'i').test(w));
    if (n >= 2 && !already && !dismissed.has(key) && !kept.some((t) => new RegExp(`\\b${w}\\b`).test(t)))
      out.push({
        key,
        kind: 'exclude_title',
        value: w,
        why: `You discarded ${String(n)} "${w}" jobs as the wrong field, and prepared none.`,
      });
  }
  const companies = new Map<string, { name: string; n: number; company: boolean }>();
  for (const r of rows) {
    const c = normalizeCompany(r.company);
    if (!c || !r.company) continue;
    // "Too senior", "already applied" and "location" are about the job, not the company.
    if (['too_senior', 'already_applied', 'location'].includes(r.reason)) continue;
    const e = companies.get(c) ?? { name: r.company, n: 0, company: false };
    e.n++;
    e.company ||= r.reason === 'company';
    companies.set(c, e);
  }
  for (const [c, e] of companies) {
    const key = `block_company:${c}`;
    const blocked = settings.blocked_companies.some((b) => normalizeCompany(b) === c);
    if ((e.n >= 2 || e.company) && !blocked && !dismissed.has(key))
      out.push({
        key,
        kind: 'block_company',
        value: e.name,
        why: e.company
          ? `You discarded a ${e.name} job because of the company.`
          : `You discarded ${String(e.n)} jobs from ${e.name}.`,
      });
  }

  // What Ahmed turned down without applying (Rejected or skipped by him, nothing sent) and
  // what he applied to: the agent's two strongest signals (D42).
  const turnedDown = db
    .prepare(
      // A job that was ever marked applied is not "turned down": a company may have
      // rejected him (audit 2026-11-23: 20 jobs went applied → rejected).
      `SELECT DISTINCT j.title FROM jobs j JOIN status_history h ON h.job_id = j.id
       LEFT JOIN applications a ON a.job_id = j.id
       WHERE h.by = 'ahmed' AND h.to_status IN ('rejected', 'skipped') AND a.sent_at IS NULL
         AND j.status IN ('rejected', 'skipped')
         AND NOT EXISTS (SELECT 1 FROM status_history x WHERE x.job_id = j.id AND x.to_status = 'applied')
       UNION
       SELECT j.title FROM discards d JOIN jobs j ON j.id = d.job_id`,
    )
    .pluck()
    .all() as string[];
  const appliedTo = db
    .prepare(
      `SELECT j.title, j.fit_score, j.priority FROM jobs j
       WHERE j.status IN ('applied', 'interview', 'offer') AND j.duplicate_of IS NULL`,
    )
    .all() as { title: string; fit_score: number | null; priority: number | null }[];

  const seniorDown = turnedDown.filter((t) => SENIOR_TITLE.test(t)).length;
  const seniorApplied = appliedTo.filter((a) => SENIOR_TITLE.test(a.title)).length;
  if (
    !settings.skip_senior_titles &&
    seniorDown >= 3 &&
    seniorApplied === 0 &&
    !dismissed.has('skip_senior')
  )
    out.push({
      key: 'skip_senior',
      kind: 'skip_senior',
      value: 'on',
      why: `You turned down ${String(seniorDown)} Senior/Lead/Manager jobs and applied to none. Skip those titles unless the post asks for 2 years or fewer?`,
    });

  for (const [tier, key] of [
    [1, 'p1'],
    [2, 'p2'],
    [3, 'p3'],
  ] as const) {
    const below = appliedTo.filter(
      (a) => a.priority === tier && a.fit_score !== null && a.fit_score < settings.thresholds[key],
    );
    if (below.length < 2) continue;
    const value = Math.max(30, Math.min(...below.map((a) => a.fit_score ?? 0)) - 2);
    const k = `threshold:${key}:${String(value)}`;
    if (!dismissed.has(k))
      out.push({
        key: k,
        kind: 'threshold',
        value: `${key}=${String(value)}`,
        why: `You applied to ${String(below.length)} P${String(tier)} jobs the agent scored below its threshold (${String(settings.thresholds[key])}). Lower it to ${String(value)} so similar jobs are prepared?`,
      });
  }
  return out;
}

export function applySuggestion(configPath: string, cfg: Config, s: Suggestion): Config {
  const cur = readSettings(cfg);
  if (s.kind === 'skip_senior')
    return updateSettings(configPath, cfg.paths.titles, { skip_senior_titles: true });
  if (s.kind === 'threshold') {
    const [tier, v] = s.value.split('=') as ['p1' | 'p2' | 'p3', string];
    return updateSettings(configPath, cfg.paths.titles, {
      thresholds: { ...cur.thresholds, [tier]: Number(v) },
    });
  }
  return s.kind === 'exclude_title'
    ? updateSettings(configPath, cfg.paths.titles, {
        excluded_titles: [...cur.excluded_titles, `\\b${s.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`],
      })
    : updateSettings(configPath, cfg.paths.titles, {
        blocked_companies: [...cur.blocked_companies, s.value],
      });
}

export function dismissSuggestion(db: Db, key: string): void {
  db.prepare(
    'INSERT INTO dismissed_suggestions (key, at) VALUES (?, ?) ON CONFLICT (key) DO NOTHING',
  ).run(key, new Date().toISOString());
}

export type BulkAction = 'prepare' | 'skip' | 'applied' | 'discard' | 'delete' | 'restore';

/**
 * Deletes a skipped job from the dashboard (D54). The row stays, hidden: it is what keeps the
 * next run from collecting the same job again.
 */
export function deleteSkipped(db: Db, id: number): void {
  const status = db.prepare('SELECT status FROM jobs WHERE id = ?').pluck().get(id);
  if (status === undefined) throw new Error('job not found');
  if (status !== 'skipped') throw new Error('only skipped jobs can be deleted');
  db.prepare('UPDATE jobs SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL').run(
    new Date().toISOString(),
    id,
  );
}

export function restoreDeleted(db: Db, id: number): void {
  const r = db.prepare('UPDATE jobs SET deleted_at = NULL WHERE id = ?').run(id);
  if (r.changes === 0) throw new Error('job not found');
}

export async function bulk(
  db: Db,
  gmail: GmailWriter | null,
  ids: number[],
  action: BulkAction,
  reason: DiscardReason = 'other',
): Promise<{ done: number; failed: string[] }> {
  const failed: string[] = [];
  let done = 0;
  const to: Record<Exclude<BulkAction, 'discard' | 'delete' | 'restore'>, Status> = {
    prepare: 'new',
    skip: 'skipped',
    applied: 'applied',
  };
  for (const id of ids) {
    try {
      if (action === 'discard') await discardJob(db, gmail, id, reason, null);
      else if (action === 'delete') deleteSkipped(db, id);
      else if (action === 'restore') restoreDeleted(db, id);
      else updateJobStatus(db, id, to[action], 'ahmed', new Date().toISOString());
      done++;
    } catch (err) {
      failed.push(`${String(id)}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { done, failed };
}

// ------------------------------------------------------------------ follow-ups (D40)

export interface FollowupDue {
  job_id: number;
  title: string;
  company: string | null;
  to: string;
  sent_at: string;
  days: number;
}

export function followupsDue(db: Db, cfg: Config, now = new Date()): FollowupDue[] {
  const before = new Date(now.getTime() - cfg.followup.after_days * 86_400_000).toISOString();
  return (
    db
      .prepare(
        `SELECT j.id AS job_id, j.title, j.company, a.to_email AS "to", a.sent_at
         FROM applications a JOIN jobs j ON j.id = a.job_id
         WHERE a.channel = 'email' AND a.mode <> 'external' AND a.sent_at IS NOT NULL AND a.sent_at <= ?
           AND a.followup_at IS NULL AND j.has_reply = 0 AND j.status = 'applied'
         ORDER BY a.sent_at`,
      )
      .all(before) as Omit<FollowupDue, 'days'>[]
  ).map((r) => ({ ...r, days: Math.floor((now.getTime() - Date.parse(r.sent_at)) / 86_400_000) }));
}

/** A short, true follow-up drafted in the original thread; Ahmed sends it himself. */
export async function draftFollowup(
  db: Db,
  gmail: GmailWriter,
  profile: Profile,
  jobId: number,
): Promise<{ draftId: string }> {
  const a = db
    .prepare(
      `SELECT a.to_email, a.subject, a.sent_at, a.gmail_thread_id, j.title, j.company
       FROM applications a JOIN jobs j ON j.id = a.job_id WHERE a.job_id = ? AND a.channel = 'email'`,
    )
    .get(jobId) as
    | {
        to_email: string;
        subject: string | null;
        sent_at: string | null;
        gmail_thread_id: string | null;
        title: string;
        company: string | null;
      }
    | undefined;
  if (!a?.sent_at) throw new Error('no sent email application for this job');
  const day = new Date(a.sent_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' });
  const text = [
    'Dear Hiring Team,',
    '',
    `I applied for the ${a.title} role${a.company ? ` at ${a.company}` : ''} on ${day} and wanted to follow up. I am still very interested in the position and would be glad to share anything else you need, or to talk at a time that suits you.`,
    '',
    'Thank you for your time.',
    '',
    'Best regards,',
    signature(profile),
  ].join('\n');
  const subject = a.subject ? (a.subject.startsWith('Re:') ? a.subject : `Re: ${a.subject}`) : `Follow-up: ${a.title}`;
  const d = await gmail.createDraft(
    buildMime({
      fromName: `${profile.candidate.first_name} ${profile.candidate.last_name}`,
      fromEmail: profile.candidate.email,
      to: a.to_email,
      subject,
      text,
    }),
    a.gmail_thread_id ?? undefined,
  );
  db.prepare('UPDATE applications SET followup_draft_id = ?, followup_at = ? WHERE job_id = ?').run(
    d.draftId,
    new Date().toISOString(),
    jobId,
  );
  return { draftId: d.messageId };
}

// ------------------------------------------------------------------ interview prep (D41)

export async function interviewPrep(
  db: Db,
  llm: Llm,
  cfg: Config,
  profile: Profile,
  jobId: number,
): Promise<InterviewPrep> {
  const row = getJob(db, jobId);
  if (!row) throw new Error('job not found');
  const job = rowToCheckedJob(row);
  const raw = await llm.call({
    purpose: 'interview',
    model: cfg.llm.tailor_model,
    system: loadPrompt('interview', { profile: profileForPrompt(profile) }),
    prompt: [
      'Prepare the candidate for this interview.',
      '<job>',
      fence(
        JSON.stringify({
          title: job.title,
          company: job.company,
          location: job.location,
          requirements: job.requirements,
          nice_to_have: job.nice_to_have,
        }),
      ),
      '</job>',
    ].join('\n'),
    schema: InterviewPrepSchema,
    jobId,
    timeoutMs: cfg.llm.tailor_timeout_seconds * 1000,
  });
  // Evidence must be real profile ids (the same truth check as scoring).
  const known = evidenceIds(profile);
  const prep: InterviewPrep = {
    ...raw,
    questions: raw.questions.map((q) => ({ ...q, evidence: q.evidence.filter((e) => known.has(e)) })),
  };
  db.prepare('UPDATE jobs SET interview_prep = ? WHERE id = ?').run(JSON.stringify(prep), jobId);
  return prep;
}

// ------------------------------------------------------------------ source scoreboard

export interface SourceRow {
  source: string;
  name: string;
  jobs: number;
  matched: number;
  prepared: number;
  applied: number;
  replies: number;
}

/** Which source (group, channel, search title, alert sender, board) leads to applications. */
export function sourceScoreboard(db: Db): SourceRow[] {
  const rows = db
    .prepare(
      `SELECT r.source, r.source_name, j.status, j.has_reply
       FROM jobs j JOIN raw_items r ON r.id = j.raw_item_id
       WHERE j.duplicate_of IS NULL AND r.source <> 'application_mail'`,
    )
    .all() as { source: string; source_name: string | null; status: string; has_reply: number }[];
  const label = (s: string, n: string | null) => {
    if (s === 'alert_email') {
      for (const [re, l] of [
        [/linkedin/i, 'LinkedIn alerts'],
        [/indeed/i, 'Indeed alerts'],
        [/wuzzuf/i, 'Wuzzuf alerts'],
        [/bayt/i, 'Bayt alerts'],
      ] as const)
        if (re.test(n ?? '')) return l;
      return 'Other alerts';
    }
    return n ?? s;
  };
  const m = new Map<string, SourceRow>();
  for (const r of rows) {
    const name = label(r.source, r.source_name);
    const k = `${r.source}|${name}`;
    const e = m.get(k) ?? { source: r.source, name, jobs: 0, matched: 0, prepared: 0, applied: 0, replies: 0 };
    e.jobs++;
    if (r.status !== 'skipped') e.matched++;
    if (['ready', 'applied', 'interview', 'offer', 'rejected'].includes(r.status)) e.prepared++;
    if (['applied', 'interview', 'offer', 'rejected'].includes(r.status)) e.applied++;
    if (r.has_reply || ['interview', 'offer'].includes(r.status)) e.replies++;
    m.set(k, e);
  }
  return [...m.values()].sort((a, b) => b.applied - a.applied || b.prepared - a.prepared || b.jobs - a.jobs);
}
