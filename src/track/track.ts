// Application tracking from Gmail (D53), in live runs only: adds jobs the user applied to
// without the agent, and moves tracked jobs on when a company answers. Reads mail, never
// changes it. Every change keeps the email's own sentence and can be undone.
import type { Logger } from 'pino';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { updateJobStatus, type Status } from '../db/jobs.js';
import type { GmailReader, MailSummary } from '../gmail/client.js';
import { LlmError, type Llm } from '../llm/types.js';
import { jobFingerprint } from '../pipeline/dedupe.js';
import { canonicalTitle, normalizeCompany } from '../util/text.js';
import { sha256 } from '../util/hash.js';
import {
  addressOf,
  knownSenders,
  mailQueries,
  NONE,
  parseNotice,
  readMails,
  worthReading,
  type MailFacts,
  type MailKind,
} from './mail.js';
import { matchJob, UNNAMED } from './match.js';

export interface TrackResult {
  read: number;
  added: number;
  updated: number;
  /** One line per change, for the run's output and the digest. */
  lines: string[];
  /** False when mail is left for the next run. */
  complete: boolean;
}

const KEY = 'application_mail';
const NEWS: ReadonlySet<MailKind> = new Set([
  'assessment',
  'interview',
  'offer',
  'rejected',
  'other',
]);

export interface TrackDeps {
  db: Db;
  cfg: Config;
  gmail: GmailReader;
  llm: Llm;
  now: Date;
  runId: number;
  log: Logger;
  out: (line: string) => void;
  /** Between two reads (Gmail's per-minute quota); 0 in tests. */
  paceMs?: number;
}

export async function trackApplications(d: TrackDeps): Promise<TrackResult> {
  const { db, cfg } = d;
  const t = cfg.tracking;
  const last = db
    .prepare('SELECT last_success_at FROM source_state WHERE source = ?')
    .pluck()
    .get(KEY);
  const first = new Date(d.now.getTime() - t.first_run_days * 86_400_000);
  // A day's overlap: mail can be indexed late, and an email already handled is never reread.
  const since = typeof last === 'string' ? new Date(Date.parse(last) - 86_400_000) : first;
  const me = await d.gmail.myAddress();

  const addresses = db
    .prepare(
      `SELECT DISTINCT lower(a.to_email) FROM applications a
       WHERE a.to_email IS NOT NULL AND a.sent_at >= ?`,
    )
    .pluck()
    .all(first.toISOString()) as string[];
  const ids = new Set<string>();
  for (const q of mailQueries(since, knownSenders(addresses)))
    for (const id of await d.gmail.search(q, 2000)) ids.add(id);
  const handled = new Set([
    ...(db.prepare('SELECT message_id FROM application_mail').pluck().all() as string[]),
    ...(db
      .prepare('SELECT gmail_message_id FROM applications WHERE gmail_message_id IS NOT NULL')
      .pluck()
      .all() as string[]),
  ]);
  // Gmail lists the newest first: the oldest are handled first, so answers follow applications.
  const todo = [...ids].filter((id) => !handled.has(id)).reverse();
  const batchIds = todo.slice(0, t.max_emails_per_run);
  const result: TrackResult = {
    read: 0,
    added: 0,
    updated: 0,
    lines: [],
    complete: batchIds.length === todo.length,
  };
  if (batchIds.length > 20)
    d.out(
      `application mail: ${String(batchIds.length)} emails to look at (about ${String(Math.ceil(batchIds.length / 60))} min)`,
    );

  const mails: MailSummary[] = [];
  for (const id of batchIds) {
    mails.push(await d.gmail.getMessage(id));
    if (d.paceMs) await new Promise((r) => setTimeout(r, d.paceMs));
  }
  mails.sort((a, b) => a.internalDate.localeCompare(b.internalDate));

  // CVs sent in this same batch make their recipients known senders too.
  const known = new Set(
    knownSenders([
      ...addresses,
      ...mails.filter((m) => m.labelIds.includes('SENT')).map((m) => m.to),
    ]),
  );
  const facts = new Map<string, MailFacts>();
  const forModel: MailSummary[] = [];
  for (const m of mails) {
    // A later sent mail in a thread already tracked is the conversation, not an application.
    const tracked =
      m.labelIds.includes('SENT') &&
      db
        .prepare(
          `SELECT 1 FROM applications WHERE gmail_thread_id = @t
           UNION SELECT 1 FROM application_mail WHERE thread_id = @t AND job_id IS NOT NULL`,
        )
        .get({ t: m.threadId }) !== undefined;
    const notice = parseNotice(m);
    if (tracked || !worthReading(m, me, known, t.skip_from)) facts.set(m.id, NONE);
    else if (notice) facts.set(m.id, notice);
    else forModel.push(m);
  }
  let failed = 0;
  let stop: unknown = null;
  for (let i = 0; i < forModel.length; i += t.batch) {
    const part = forModel.slice(i, i + t.batch);
    try {
      const res = await readMails(
        d.llm,
        cfg.llm.extract_model,
        part,
        t.body_chars,
        cfg.llm.tailor_timeout_seconds * 1000,
      );
      part.forEach((m, k) => facts.set(m.id, res[k] ?? NONE));
    } catch (err) {
      if (!(err instanceof LlmError)) {
        stop = err; // the usage limit: what is known so far is kept
        break;
      }
      failed += part.length;
      d.log.warn({ err: err.message }, 'application mail: a batch was not read');
    }
    if ((i / t.batch) % 10 === 9)
      d.out(
        `  ${String(Math.min(i + t.batch, forModel.length))}/${String(forModel.length)} emails read`,
      );
  }
  if (failed || stop) result.complete = false;

  // In order of time. After a stop, nothing later than the first unread email is applied, so
  // an answer is never handled before the application it answers.
  for (const m of mails) {
    const f = facts.get(m.id);
    if (!f) {
      if (stop) break;
      continue;
    }
    result.read++;
    applyMail(d, m, f, result);
  }
  if (stop)
    throw stop instanceof Error ? stop : new Error('application mail: the model client failed');
  if (result.complete)
    db.prepare(
      `INSERT INTO source_state (source, last_success_at) VALUES (?, ?)
       ON CONFLICT (source) DO UPDATE SET last_success_at = excluded.last_success_at`,
    ).run(KEY, d.now.toISOString());
  return result;
}

const BEFORE_APPLIED = new Set<Status>(['new', 'skipped', 'needs_review', 'ready']);

/** The status an email moves a job to, or null. Never backwards, never over a later choice. */
export function nextStatus(current: Status, kind: MailKind): Status | null {
  if (kind === 'none' || kind === 'other') return null;
  const want: Status =
    kind === 'interview' || kind === 'offer' || kind === 'rejected' ? kind : 'applied';
  if (BEFORE_APPLIED.has(current)) return want;
  if (current === 'applied') return want === 'applied' ? null : want;
  if (current === 'interview') return want === 'offer' || want === 'rejected' ? want : null;
  return null;
}

function applyMail(d: TrackDeps, m: MailSummary, f: MailFacts, r: TrackResult): void {
  const { db } = d;
  const now = d.now.toISOString();
  const sent = m.labelIds.includes('SENT');
  const record = db.prepare(
    `INSERT INTO application_mail (message_id, thread_id, kind, job_id, company, title, quote, sender,
       subject, at, from_status, to_status, created_job, seen_at, run_id)
     VALUES (@id, @thread, @kind, @job, @company, @title, @quote, @sender, @subject, @at, @from, @to, @created, @seen, @run)
     ON CONFLICT (message_id) DO NOTHING`,
  );
  db.transaction(() => {
    if (f.kind === 'none') {
      record.run({
        id: m.id,
        thread: null,
        kind: 'none',
        job: null,
        company: null,
        title: null,
        quote: null,
        sender: null,
        subject: null,
        at: m.internalDate,
        from: null,
        to: null,
        created: 0,
        seen: now,
        run: d.runId,
      });
      return;
    }
    const match = matchJob(db, m, f, { windowDays: d.cfg.dedupe.content_window_days });
    let jobId = match.job?.id ?? null;
    let from: Status | null = null;
    let to: Status | null = null;
    let created = 0;
    const label = (title: string, company: string | null) =>
      `${title}${company ? ` · ${company}` : ''}`;

    if (match.job) {
      const current = match.job.status as Status;
      const byUser = db
        .prepare(`SELECT max(at) FROM status_history WHERE job_id = ? AND by = 'ahmed'`)
        .pluck()
        .get(match.job.id) as string | null;
      // An invitation after a rejection this tracker read: the company changed its mind.
      const back =
        current === 'rejected' &&
        (f.kind === 'interview' || f.kind === 'offer') &&
        match.job.rejected_at !== null &&
        match.job.rejected_at < m.internalDate;
      const next = back ? (f.kind as Status) : nextStatus(current, f.kind);
      // What the user decided after this email stands. A job applied to was never "not a
      // fit", though: an application is a fact.
      const allowed =
        next !== null && (BEFORE_APPLIED.has(current) || (byUser ?? '') <= m.internalDate);
      if (next !== null && allowed) {
        from = current;
        to = next;
        move(db, match.job.id, current, next, m, sent);
        r.updated++;
        r.lines.push(
          `${to}: ${label(match.job.title, match.job.company)}${from === 'applied' || from === 'interview' ? '' : ' (applied without the agent)'}`,
        );
      } else if (f.kind === 'assessment')
        r.lines.push(`assessment: ${label(match.job.title, match.job.company)}`);
      if (NEWS.has(f.kind))
        db.prepare('UPDATE jobs SET has_reply = 1, updated_at = ? WHERE id = ?').run(
          now,
          match.job.id,
        );
      // A later email may name what the first one didn't.
      if (f.title && match.job.title === UNNAMED)
        db.prepare('UPDATE jobs SET title = ?, title_norm = ? WHERE id = ?').run(
          f.title,
          canonicalTitle(f.title),
          match.job.id,
        );
    } else if (
      !match.ambiguous &&
      f.kind !== 'other' &&
      (f.company !== null || (sent && f.title !== null))
    ) {
      const status = nextStatus('new', f.kind) ?? 'applied';
      jobId = addJob(d, m, f, status, sent);
      created = 1;
      to = status;
      r.added++;
      r.lines.push(`added (${status}): ${label(f.title ?? UNNAMED, f.company)}`);
    }
    // Answers no job fits are still news if they come from a company; "other" needs a job.
    const isNews = NEWS.has(f.kind) && (jobId !== null || f.kind !== 'other');
    const fresh =
      d.now.getTime() - Date.parse(m.internalDate) <= d.cfg.tracking.news_days * 86_400_000;
    record.run({
      id: m.id,
      thread: m.threadId,
      kind: f.kind,
      job: jobId,
      company: f.company,
      title: f.title,
      quote: f.quote,
      sender: sent ? m.to : m.from,
      subject: m.subject,
      at: m.internalDate,
      from,
      to,
      created,
      seen: isNews && fresh ? null : now,
      run: d.runId,
    });
  })();
}

function move(
  db: Db,
  jobId: number,
  from: Status,
  to: Status,
  m: MailSummary,
  sent: boolean,
): void {
  if (BEFORE_APPLIED.has(from)) {
    updateJobStatus(db, jobId, 'applied', 'sync', m.internalDate, null);
    db.prepare('DELETE FROM discards WHERE job_id = ?').run(jobId);
    const job = db.prepare('SELECT apply_channel FROM jobs WHERE id = ?').get(jobId) as {
      apply_channel: string;
    };
    db.prepare(
      `INSERT INTO applications (job_id, channel, to_email, subject, mode, created_at, sent_at)
       VALUES (?, ?, ?, ?, 'external', ?, ?)
       ON CONFLICT (job_id) DO UPDATE SET sent_at = COALESCE(sent_at, excluded.sent_at)`,
    ).run(
      jobId,
      sent ? 'email' : job.apply_channel === 'email' ? 'email' : 'form',
      sent ? addressOf(m.to) : null,
      sent ? m.subject : null,
      m.internalDate,
      m.internalDate,
    );
  }
  if (to !== 'applied') updateJobStatus(db, jobId, to, 'sync', m.internalDate);
  db.prepare('UPDATE jobs SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), jobId);
}

/** A job applied to without the agent. Nothing is scored or prepared for it. */
function addJob(d: TrackDeps, m: MailSummary, f: MailFacts, status: Status, sent: boolean): number {
  const { db } = d;
  const now = d.now.toISOString();
  const title = f.title ?? UNNAMED;
  const email = sent ? addressOf(m.to) : null;
  const raw = db
    .prepare(
      `INSERT INTO raw_items (source, source_ref, source_name, posted_at, collected_at, text, content_hash, run_id, processed_at)
       VALUES ('application_mail', ?, 'Applied without the agent', ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      m.id,
      m.internalDate,
      now,
      `From Gmail.\nSubject: ${m.subject}\n${sent ? `To: ${m.to}` : `From: ${m.from}`}\n\n${f.quote ?? ''}`,
      sha256(`application_mail:${m.id}`),
      d.runId,
      now,
    ).lastInsertRowid;
  const id = Number(
    db
      .prepare(
        `INSERT INTO jobs (raw_item_id, title, title_norm, company, company_norm, requirements, nice_to_have,
           apply_channel, apply_email, apply_url, fingerprint, flags, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, '[]', '[]', ?, ?, ?, ?, '[]', ?, ?, ?)`,
      )
      .run(
        raw,
        title,
        canonicalTitle(title),
        f.company,
        normalizeCompany(f.company),
        sent ? 'email' : 'form',
        email,
        f.applyUrl,
        jobFingerprint({ title, company: f.company, apply_email: email, apply_url: f.applyUrl }),
        status,
        // The application's own date: dedupe's window counts from it.
        m.internalDate,
        now,
      ).lastInsertRowid,
  );
  const hist = db.prepare(
    `INSERT INTO status_history (job_id, from_status, to_status, by, at) VALUES (?, ?, ?, 'sync', ?)`,
  );
  hist.run(id, null, 'applied', m.internalDate);
  if (status !== 'applied') hist.run(id, 'applied', status, m.internalDate);
  db.prepare(
    `INSERT INTO applications (job_id, channel, to_email, subject, mode, created_at, sent_at)
     VALUES (?, ?, ?, ?, 'external', ?, ?)`,
  ).run(
    id,
    sent ? 'email' : 'form',
    email,
    sent ? m.subject : null,
    m.internalDate,
    m.internalDate,
  );
  if (status !== 'applied') db.prepare('UPDATE jobs SET has_reply = 1 WHERE id = ?').run(id);
  return id;
}

// ------------------------------------------------------------------ for the dashboard

export interface NewsItem {
  message_id: string;
  kind: MailKind;
  job_id: number | null;
  job_title: string | null;
  job_company: string | null;
  company: string | null;
  title: string | null;
  quote: string | null;
  sender: string | null;
  subject: string | null;
  at: string;
  from_status: string | null;
  to_status: string | null;
  created_job: number;
  url: string;
}

export const mailUrl = (messageId: string): string =>
  `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(messageId)}`;

/** Answers not marked as read in the dashboard, the newest first. */
export function unseenNews(db: Db): NewsItem[] {
  return (
    db
      .prepare(
        `SELECT m.message_id, m.kind, m.job_id, j.title AS job_title, j.company AS job_company, m.company,
           m.title, m.quote, m.sender, m.subject, m.at, m.from_status, m.to_status, m.created_job
         FROM application_mail m LEFT JOIN jobs j ON j.id = m.job_id
         WHERE m.seen_at IS NULL ORDER BY m.at DESC LIMIT 100`,
      )
      .all() as Omit<NewsItem, 'url'>[]
  ).map((n) => ({ ...n, url: mailUrl(n.message_id) }));
}

export function markSeen(db: Db, ids: string[] | null): number {
  const at = new Date().toISOString();
  if (ids === null)
    return db.prepare('UPDATE application_mail SET seen_at = ? WHERE seen_at IS NULL').run(at)
      .changes;
  const st = db.prepare(
    'UPDATE application_mail SET seen_at = ? WHERE message_id = ? AND seen_at IS NULL',
  );
  return ids.reduce((n, id) => n + st.run(at, id).changes, 0);
}

/** Takes back what an email changed: the status, or the whole job it added. */
export function undoMail(db: Db, messageId: string): { status: string | null; removed: boolean } {
  const m = db
    .prepare(
      'SELECT job_id, from_status, to_status, created_job FROM application_mail WHERE message_id = ?',
    )
    .get(messageId) as
    | {
        job_id: number | null;
        from_status: Status | null;
        to_status: Status | null;
        created_job: number;
      }
    | undefined;
  if (!m) throw new Error('no such email');
  if (m.job_id === null || m.to_status === null) throw new Error('this email changed nothing');
  const jobId = m.job_id;
  const at = new Date().toISOString();
  const current = db.prepare('SELECT status FROM jobs WHERE id = ?').pluck().get(jobId) as Status;
  return db.transaction(() => {
    if (m.created_job) {
      updateJobStatus(db, jobId, 'skipped', 'ahmed', at, 'not_an_application');
      db.prepare('UPDATE jobs SET deleted_at = ? WHERE id = ?').run(at, jobId);
    } else {
      if (current !== m.to_status)
        throw new Error(`the job has moved on since (${current}): change its status instead`);
      updateJobStatus(db, jobId, m.from_status ?? 'applied', 'ahmed', at);
      if (m.from_status && BEFORE_APPLIED.has(m.from_status)) {
        db.prepare(`DELETE FROM applications WHERE job_id = ? AND mode = 'external'`).run(jobId);
        db.prepare('UPDATE applications SET sent_at = NULL WHERE job_id = ?').run(jobId);
      }
    }
    db.prepare(
      `UPDATE application_mail SET seen_at = COALESCE(seen_at, ?), from_status = NULL, to_status = NULL WHERE message_id = ?`,
    ).run(at, messageId);
    return { status: m.created_job ? null : m.from_status, removed: m.created_job === 1 };
  })();
}
