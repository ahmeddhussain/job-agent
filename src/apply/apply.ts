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
import { formEligible, saveFormReport, type FormFiller, type FormReport } from './forms.js';
import { allAnswered, recordQuestions } from './questions.js';
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
  /** Web-form submitter (D33); null = packages only. */
  forms?: FormFiller | null;
  /** Where the job was found, for "how did you hear about us". */
  sourceOf?: (job: JobRow) => string;
}

export interface ApplyResult {
  status: 'ready' | 'applied' | 'needs_review' | 'skipped';
  mode: 'draft' | 'send' | 'package' | 'submitted' | 'manual' | null;
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

/** A mailto: link with the prepared email (the CV still has to be attached by hand). */
export function mailtoLink(to: string, subject: string, body: string): string {
  return `mailto:${encodeURIComponent(to).replace(/%40/g, '@')}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

/** Without Gmail (D45): the email is written out for the user to send from any mail app. */
function emailPackageText(job: JobRow, p: Prepared, to: string): string {
  return [
    `# ${job.title}${job.company ? ` · ${job.company}` : ''}`,
    '',
    `**Send an email to:** ${to}`,
    `**Write it in your mail app:** ${mailtoLink(to, p.subject, p.body)}`,
    `**Attach the CV:** ${p.cvPath}`,
    `**Why this role (for the interview):** ${p.whyThisRole}`,
    '',
    `## Subject`,
    '',
    p.subject,
    '',
    '## Email',
    '',
    p.body.trim(),
    '',
  ].join('\n');
}

export async function applyJob(d: ApplyDeps, job: JobRow, p: Prepared): Promise<ApplyResult> {
  const at = () => d.now().toISOString();
  const insertApp = (v: {
    channel: 'email' | 'form' | 'whatsapp_dm';
    to: string | null;
    mode: 'draft' | 'send' | 'package' | 'submitted' | 'manual';
    formReport?: string | null;
    manualReason?: string | null;
    draft?: { draftId: string; messageId: string; threadId: string } | null;
    sentAt?: string | null;
    packageDir?: string | null;
  }) => {
    d.db
      .prepare(
        `INSERT INTO applications (job_id, channel, to_email, subject, body, cv_pdf, cv_md, cover_text,
           ats_report, why_this_role, gmail_draft_id, gmail_thread_id, gmail_message_id, mode,
           created_at, sent_at, package_dir, answers, form_report, manual_reason)
         VALUES (@job, @channel, @to, @subject, @body, @cv, @md, @cover, @ats, @why, @draft, @thread,
           @msg, @mode, @at, @sent, @pkg, @answers, @form, @manual)
         ON CONFLICT (job_id) DO UPDATE SET channel = excluded.channel, to_email = excluded.to_email,
           subject = excluded.subject, body = excluded.body, cv_pdf = excluded.cv_pdf,
           cv_md = excluded.cv_md, cover_text = excluded.cover_text, ats_report = excluded.ats_report,
           why_this_role = excluded.why_this_role, gmail_draft_id = excluded.gmail_draft_id,
           gmail_thread_id = excluded.gmail_thread_id, gmail_message_id = excluded.gmail_message_id,
           mode = excluded.mode, created_at = excluded.created_at, sent_at = excluded.sent_at,
           package_dir = excluded.package_dir, answers = excluded.answers,
           form_report = excluded.form_report, manual_reason = excluded.manual_reason`,
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
        form: v.formReport ?? null,
        manual: v.manualReason ?? null,
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
    if (!d.dryRun && !d.cfg.gmail.enabled) {
      writeFileSync(join(p.dir, 'apply.md'), emailPackageText(job, p, job.apply_email));
      insertApp({
        channel: 'email',
        to: job.apply_email,
        mode: 'manual',
        packageDir: p.dir,
        manualReason: 'send this email yourself (Gmail is not connected); attach the CV',
      });
      updateJobStatus(d.db, job.id, 'ready', 'agent', at(), null);
      return {
        status: 'ready',
        mode: 'manual',
        detail: `send it yourself to ${job.apply_email} (${join(p.dir, 'apply.md')})`,
      };
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
    const formUrl = job.apply_url_direct ?? job.apply_url;
    let manualReason =
      job.apply_channel === 'whatsapp_dm'
        ? 'apply on WhatsApp (the agent never sends WhatsApp messages)'
        : (NOTES[job.apply_note ?? ''] ?? 'apply on the site');

    if (job.apply_channel === 'form' && d.forms && formEligible(formUrl, d.cfg) && formUrl) {
      try {
        const r = await d.forms.run(
          {
            id: job.id,
            title: job.title,
            company: job.company,
            source: d.sourceOf?.(job) ?? 'job board',
          },
          formUrl,
          { dir: p.dir, cvPath: p.cvPath, coverText: p.coverText, whyThisRole: p.whyThisRole },
          { submit: !d.dryRun && d.cfg.forms.auto_submit },
        );
        await r.page.close().catch(() => undefined);
        const report = { ...r, page: undefined };
        saveFormReport(p.dir, report);
        if (r.unanswered.length) recordQuestions(d.db, r.unanswered, job.id, at());
        if (r.outcome === 'submitted') {
          insertApp({
            channel: 'form',
            to: null,
            mode: 'submitted',
            packageDir: p.dir,
            sentAt: at(),
            formReport: JSON.stringify(report),
          });
          updateJobStatus(d.db, job.id, 'applied', 'agent', at(), null);
          return { status: 'applied', mode: 'submitted', detail: `form submitted: ${r.finalUrl}` };
        }
        manualReason = r.reason ?? manualReason;
        insertApp({
          channel: 'form',
          to: null,
          mode: 'manual',
          packageDir: p.dir,
          formReport: JSON.stringify(report),
          manualReason,
        });
        updateJobStatus(d.db, job.id, 'ready', 'agent', at(), null);
        return {
          status: 'ready',
          mode: 'manual',
          detail: `apply yourself (${manualReason}): ${formUrl}`,
        };
      } catch (err) {
        manualReason = `the form could not be opened or filled: ${String(err).slice(0, 160)}`;
      }
    }
    insertApp({
      channel: job.apply_channel,
      to: null,
      mode: 'manual',
      packageDir: p.dir,
      manualReason,
    });
    updateJobStatus(d.db, job.id, 'ready', 'agent', at(), null);
    return {
      status: 'ready',
      mode: 'manual',
      detail: `apply yourself (${manualReason}): ${job.apply_url_direct ?? waLink ?? job.apply_url ?? p.dir}`,
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

/**
 * Forms that stopped only on questions Ahmed has since answered (D35) are tried again,
 * with the current profile. Returns how many were submitted.
 */
export async function retryAnsweredForms(
  d: ApplyDeps,
  out: (line: string) => void,
): Promise<{ tried: number; submitted: number }> {
  if (!d.forms) return { tried: 0, submitted: 0 };
  const rows = d.db
    .prepare(
      `SELECT j.*, a.package_dir, a.cv_pdf, a.cover_text, a.why_this_role, a.form_report
       FROM jobs j JOIN applications a ON a.job_id = j.id
       WHERE j.status = 'ready' AND a.mode = 'manual' AND a.channel = 'form' AND a.form_report IS NOT NULL`,
    )
    .all() as (JobRow & {
    package_dir: string | null;
    cv_pdf: string | null;
    cover_text: string | null;
    why_this_role: string | null;
    form_report: string;
  })[];
  let tried = 0;
  let submitted = 0;
  for (const j of rows) {
    const prev = JSON.parse(j.form_report) as FormReport;
    if (prev.unanswered.length === 0 || !allAnswered(d.db, prev.unanswered)) continue;
    const url = j.apply_url_direct ?? j.apply_url;
    if (!url || !j.package_dir || !j.cv_pdf || !formEligible(url, d.cfg)) continue;
    tried++;
    try {
      const r = await d.forms.run(
        { id: j.id, title: j.title, company: j.company, source: d.sourceOf?.(j) ?? 'job board' },
        url,
        {
          dir: j.package_dir,
          cvPath: j.cv_pdf,
          coverText: j.cover_text ?? '',
          whyThisRole: j.why_this_role ?? '',
        },
        { submit: !d.dryRun && d.cfg.forms.auto_submit },
      );
      await r.page.close().catch(() => undefined);
      const report = { ...r, page: undefined };
      saveFormReport(j.package_dir, report);
      const at = d.now().toISOString();
      if (r.outcome === 'submitted') {
        d.db
          .prepare(
            `UPDATE applications SET mode = 'submitted', sent_at = ?, form_report = ?, manual_reason = NULL WHERE job_id = ?`,
          )
          .run(at, JSON.stringify(report), j.id);
        updateJobStatus(d.db, j.id, 'applied', 'agent', at, null);
        submitted++;
        out(`  SUBMITTED (retry) ${j.title}${j.company ? ` · ${j.company}` : ''}`);
      } else {
        if (r.unanswered.length) recordQuestions(d.db, r.unanswered, j.id, at);
        d.db
          .prepare('UPDATE applications SET form_report = ?, manual_reason = ? WHERE job_id = ?')
          .run(JSON.stringify(report), r.reason, j.id);
        out(`  still apply yourself: ${j.title} (${r.reason ?? ''})`);
      }
    } catch (err) {
      out(`  retry failed: ${j.title}: ${String(err).slice(0, 120)}`);
    }
  }
  return { tried, submitted };
}
