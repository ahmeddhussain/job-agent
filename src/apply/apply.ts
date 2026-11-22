// Stage 5.7, apply (PLAN 9, D8, D31). Runs only on a Prepared application that passed the
// one-page, ATS and truth checks. Email jobs: L4 guard, then a Gmail draft (default) or,
// in send mode and only when every send guard passes, a send. Form and WhatsApp jobs: a
// package folder with everything needed to apply in a minute (the agent never submits
// forms and never sends WhatsApp messages).
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { updateJobStatus, type JobRow } from '../db/jobs.js';
import type { GmailWriter } from '../gmail/client.js';
import type { Profile } from '../profile/load.js';
import { draftApplication } from './email.js';
import { applicationGuard } from './guard.js';
import type { Prepared } from './prepare.js';

export interface ApplyDeps {
  db: Db;
  cfg: Config;
  profile: Profile;
  /** null in dry runs: nothing is written to Gmail. */
  gmail: GmailWriter | null;
  dryRun: boolean;
  now: () => Date;
}

export interface ApplyResult {
  status: 'ready' | 'applied' | 'needs_review' | 'skipped';
  mode: 'draft' | 'send' | 'package' | null;
  detail: string;
}

const NOTES: Record<string, string> = {
  linkedin_offsite:
    'LinkedIn lists this as "Apply on company website": open the LinkedIn link, click Apply, and use the files below.',
  linkedin_easy_apply: 'Easy Apply on LinkedIn: upload the CV below and paste the cover letter.',
  form: 'The link is the application form itself.',
  blocked_host:
    'Apply on the job board (it does not allow automated access, so nothing was fetched).',
};

/** Send mode guards (D8): all must pass, otherwise the application stays a draft. */
function sendAllowed(d: ApplyDeps, job: JobRow): string | null {
  const a = d.cfg.apply;
  if (a.mode !== 'send') return 'mode is draft';
  if ((job.fit_score ?? 0) < a.auto_send_min_score) return 'fit below auto_send_min_score';
  if ((job.priority ?? 3) > a.auto_send_max_priority)
    return 'priority above auto_send_max_priority';
  if (job.flags !== '[]') return 'job has flags';
  const today = d.now().toISOString().slice(0, 10);
  const sent = d.db
    .prepare(`SELECT count(*) FROM applications WHERE mode = 'send' AND sent_at >= ?`)
    .pluck()
    .get(today) as number;
  if (sent >= a.daily_send_cap) return 'daily_send_cap reached';
  return null;
}

async function paceSends(d: ApplyDeps): Promise<void> {
  const last = d.db
    .prepare(`SELECT max(sent_at) FROM applications WHERE mode = 'send'`)
    .pluck()
    .get() as string | null;
  if (!last) return;
  const wait = Date.parse(last) + d.cfg.apply.min_seconds_between_sends * 1000 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

function packageText(d: ApplyDeps, job: JobRow, p: Prepared, waLink: string | null): string {
  const where = job.apply_url_direct ?? job.apply_url;
  const lines = [
    `# ${job.title}${job.company ? ` · ${job.company}` : ''}`,
    '',
    job.apply_url_direct
      ? `**Apply on the company's site:** ${job.apply_url_direct}`
      : waLink
        ? `**Apply on WhatsApp:** ${waLink} (send the cover letter below, then the CV)`
        : `**Apply here:** ${where ?? '(no link: see the original post)'}`,
    ...(job.apply_url_direct && job.apply_url ? [`Original listing: ${job.apply_url}`] : []),
    ...(job.apply_note && NOTES[job.apply_note] ? ['', NOTES[job.apply_note] ?? ''] : []),
    '',
    `**CV:** ${p.cvPath}`,
    `**Why this role (for the interview):** ${p.whyThisRole}`,
    '',
    '## Cover letter (paste box)',
    '',
    p.coverText.trim(),
    '',
    '## Screening answers',
    '',
    ...Object.entries(d.profile.application_answers).map(([q, a]) => `- **${q}:** ${a}`),
    '',
  ];
  return lines.join('\n');
}

export async function applyJob(d: ApplyDeps, job: JobRow, p: Prepared): Promise<ApplyResult> {
  const at = () => d.now().toISOString();
  const insertApp = (v: {
    channel: 'email' | 'form' | 'whatsapp_dm';
    to: string | null;
    mode: 'draft' | 'send' | 'package';
    draft?: { draftId: string; messageId: string; threadId: string } | null;
    sentAt?: string | null;
    packageDir?: string | null;
  }) => {
    d.db
      .prepare(
        `INSERT INTO applications (job_id, channel, to_email, subject, body, cv_pdf, cv_md, cover_text,
           ats_report, why_this_role, gmail_draft_id, gmail_thread_id, gmail_message_id, mode,
           created_at, sent_at, package_dir, answers)
         VALUES (@job, @channel, @to, @subject, @body, @cv, @md, @cover, @ats, @why, @draft, @thread,
           @msg, @mode, @at, @sent, @pkg, @answers)
         ON CONFLICT (job_id) DO UPDATE SET channel = excluded.channel, to_email = excluded.to_email,
           subject = excluded.subject, body = excluded.body, cv_pdf = excluded.cv_pdf,
           cv_md = excluded.cv_md, cover_text = excluded.cover_text, ats_report = excluded.ats_report,
           why_this_role = excluded.why_this_role, gmail_draft_id = excluded.gmail_draft_id,
           gmail_thread_id = excluded.gmail_thread_id, gmail_message_id = excluded.gmail_message_id,
           mode = excluded.mode, created_at = excluded.created_at, sent_at = excluded.sent_at,
           package_dir = excluded.package_dir, answers = excluded.answers`,
      )
      .run({
        job: job.id,
        channel: v.channel,
        to: v.to,
        subject: v.channel === 'email' ? p.subject : null,
        body: v.channel === 'email' ? p.body : null,
        cv: p.cvPath,
        md: p.cvMdPath,
        cover: p.coverText,
        ats: JSON.stringify(p.ats),
        why: p.whyThisRole,
        draft: v.draft?.draftId ?? null,
        thread: v.draft?.threadId ?? null,
        msg: v.draft?.messageId ?? null,
        mode: v.mode,
        at: at(),
        sent: v.sentAt ?? null,
        pkg: v.packageDir ?? null,
        answers: JSON.stringify(d.profile.application_answers),
      });
  };

  if (job.apply_channel === 'email' && job.apply_email) {
    const guard = await applicationGuard(d.db, d.gmail, d.cfg, {
      to: job.apply_email,
      title: job.title,
      now: d.now(),
    });
    if (!guard.ok) {
      updateJobStatus(d.db, job.id, guard.status, 'agent', at(), guard.reason);
      return { status: guard.status, mode: null, detail: guard.detail };
    }
    if (d.dryRun || !d.gmail) {
      insertApp({ channel: 'email', to: job.apply_email, mode: 'draft' });
      updateJobStatus(d.db, job.id, 'ready', 'agent', at(), null);
      return {
        status: 'ready',
        mode: 'draft',
        detail: `dry run: draft to ${job.apply_email} not created`,
      };
    }
    const draft = await draftApplication(d.gmail, d.profile, {
      to: job.apply_email,
      subject: p.subject,
      body: p.body,
      cvPath: p.cvPath,
    });
    const blocked = sendAllowed(d, job);
    if (blocked === null) {
      await paceSends(d);
      const sent = await d.gmail.sendDraft(draft.draftId);
      insertApp({
        channel: 'email',
        to: job.apply_email,
        mode: 'send',
        draft: { ...draft, messageId: sent.messageId, threadId: sent.threadId },
        sentAt: at(),
      });
      updateJobStatus(d.db, job.id, 'applied', 'agent', at(), null);
      return { status: 'applied', mode: 'send', detail: `sent to ${job.apply_email}` };
    }
    insertApp({ channel: 'email', to: job.apply_email, mode: 'draft', draft });
    updateJobStatus(d.db, job.id, 'ready', 'agent', at(), null);
    return { status: 'ready', mode: 'draft', detail: `draft to ${job.apply_email}` };
  }

  if (job.apply_channel === 'form' || job.apply_channel === 'whatsapp_dm') {
    const phone = job.apply_channel === 'whatsapp_dm' ? waNumber(job) : null;
    const waLink = phone ? `https://wa.me/${phone}` : null;
    writeFileSync(join(p.dir, 'apply.md'), packageText(d, job, p, waLink));
    insertApp({
      channel: job.apply_channel,
      to: null,
      mode: 'package',
      packageDir: p.dir,
    });
    updateJobStatus(d.db, job.id, 'ready', 'agent', at(), null);
    return {
      status: 'ready',
      mode: 'package',
      detail: `package: ${job.apply_url_direct ?? waLink ?? job.apply_url ?? p.dir}`,
    };
  }

  updateJobStatus(d.db, job.id, 'needs_review', 'agent', at(), 'no_apply_target');
  return { status: 'needs_review', mode: null, detail: 'no way to apply was found in the post' };
}

/** The WhatsApp number to apply to, as digits, Egyptian local numbers made international. */
function waNumber(job: JobRow): string | null {
  const digits = (job.apply_phone ?? '').replace(/\D/g, '');
  if (/^01\d{9}$/.test(digits)) return `20${digits.slice(1)}`;
  return digits.length >= 10 ? digits : null;
}
