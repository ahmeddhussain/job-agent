// `agent assist`, `agent send-drafts`, `agent skipped` (D33): the parts where Ahmed is
// the last step. assist opens each "apply yourself" job in a visible Chrome window with
// its own persistent profile (data/browser-profile: sign in to LinkedIn there once):
// company forms come pre-filled (CV attached, answers typed) for him to check and
// submit; LinkedIn Easy Apply and other board pages open on the job with the cover
// letter on the clipboard. Nothing is clicked on his behalf in those windows.
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import type { Config } from '../config.js';
import { formEligible, FormFiller } from '../apply/forms.js';
import { sendReviewedDrafts } from '../apply/send.js';
import { migrate, openDb } from '../db/index.js';
import { updateJobStatus } from '../db/jobs.js';
import { gmailAuthClient } from '../gmail/auth.js';
import { GmailFacade } from '../gmail/client.js';
import { loadProfile } from '../profile/load.js';
import { sourceLabel } from '../run/orchestrator.js';
import { acquireLock } from '../util/lock.js';
import { logger } from '../util/logger.js';
import type { Io } from './program.js';
import { claude } from './run.js';

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim().toLowerCase();
  } finally {
    rl.close();
  }
}

/** Puts text on the desktop clipboard (Wayland or X11), if a clipboard tool exists. */
function toClipboard(text: string): boolean {
  for (const [cmd, args] of [
    ['wl-copy', []],
    ['xclip', ['-selection', 'clipboard']],
    ['xsel', ['--clipboard', '--input']],
  ] as const) {
    const r = spawnSync(cmd, [...args], { input: text, timeout: 3000 });
    if (r.status === 0) return true;
  }
  return false;
}

interface ManualRow {
  id: number;
  raw_item_id: number;
  title: string;
  company: string | null;
  apply_url: string | null;
  apply_url_direct: string | null;
  package_dir: string | null;
  cv_pdf: string | null;
  cover_text: string | null;
  why_this_role: string | null;
  manual_reason: string | null;
}

export async function assistCommand(cfg: Config, opts: { job?: number }, io: Io): Promise<void> {
  const release = acquireLock(cfg.run.lock_file, 'agent run');
  const db = openDb(cfg.paths.db);
  migrate(db);
  mkdirSync(cfg.forms.browser_profile, { recursive: true, mode: 0o700 });
  const filler = new FormFiller({
    cfg,
    profile: loadProfile(cfg.paths.profile),
    llm: claude(cfg, []),
    log: logger,
    headless: false,
    userDataDir: cfg.forms.browser_profile,
  });
  try {
    const rows = (
      db
        .prepare(
          `SELECT j.id, j.raw_item_id, j.title, j.company, j.apply_url, j.apply_url_direct,
             a.package_dir, a.cv_pdf, a.cover_text, a.why_this_role, a.manual_reason
           FROM jobs j JOIN applications a ON a.job_id = j.id
           WHERE j.status = 'ready' AND a.mode IN ('manual', 'package')
           ORDER BY j.priority, j.fit_score DESC`,
        )
        .all() as ManualRow[]
    ).filter((r) => opts.job === undefined || r.id === opts.job);
    if (rows.length === 0) {
      io.out('nothing to apply to by hand');
      return;
    }
    io.out(`${String(rows.length)} applications to finish. In each window: check, then submit.`);
    for (const [i, r] of rows.entries()) {
      const url = r.apply_url_direct ?? r.apply_url;
      io.out(
        `\n[${String(i + 1)}/${String(rows.length)}] job ${String(r.id)}: ${r.title}${r.company ? ` · ${r.company}` : ''}`,
      );
      io.out(`  why by hand: ${r.manual_reason ?? 'apply on the site'}`);
      io.out(`  CV: ${r.cv_pdf ?? '-'}`);
      if (!url) {
        io.out('  no link: see the package (apply.md)');
        continue;
      }
      const copied = r.cover_text ? toClipboard(r.cover_text) : false;
      io.out(
        `  cover letter ${copied ? 'copied to the clipboard' : `in ${r.package_dir ?? '-'}/cover_letter.txt`}`,
      );
      let page;
      try {
        if (formEligible(url, cfg) && r.package_dir && r.cv_pdf) {
          const res = await filler.run(
            {
              id: r.id,
              title: r.title,
              company: r.company,
              source: sourceLabel(db, r.raw_item_id),
            },
            url,
            {
              dir: r.package_dir,
              cvPath: r.cv_pdf,
              coverText: r.cover_text ?? '',
              whyThisRole: r.why_this_role ?? '',
            },
            { submit: false },
          );
          page = res.page;
          io.out(
            `  pre-filled ${String(res.filled.length)} fields${res.unanswered.length ? `; fill in: ${res.unanswered.join('; ')}` : ''}`,
          );
        } else {
          page = await filler.page();
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
          io.out('  opened the job page (Easy Apply / job board): apply there with the CV above');
        }
        await page.bringToFront();
      } catch (err) {
        io.out(`  could not open it here (${String(err).slice(0, 120)}); open it yourself: ${url}`);
      }
      const a = await ask('  [Enter] I applied   [s] skip   [q] quit > ');
      await page?.close().catch(() => undefined);
      if (a === 'q') break;
      if (a === 's') continue;
      const at = new Date().toISOString();
      db.prepare('UPDATE applications SET sent_at = ? WHERE job_id = ?').run(at, r.id);
      updateJobStatus(db, r.id, 'applied', 'ahmed', at);
      io.out('  marked applied');
    }
  } finally {
    await filler.close();
    db.close();
    release();
  }
}

export async function sendDraftsCommand(
  cfg: Config,
  opts: { yes?: boolean },
  io: Io,
): Promise<void> {
  const db = openDb(cfg.paths.db);
  migrate(db);
  try {
    const gmail = new GmailFacade(gmailAuthClient(cfg));
    const me = await gmail.myAddress();
    if (me !== loadProfile(cfg.paths.profile).candidate.email.toLowerCase())
      throw new Error(`Gmail is authorized as ${me}, not the profile's address`);
    await sendReviewedDrafts({
      db,
      gmail,
      cfg,
      out: io.out,
      confirm: async (list) => {
        io.out(`${String(list.length)} reviewed drafts will be sent as they are now in Gmail:`);
        for (const w of list)
          io.out(`  - ${w.title}${w.company ? ` · ${w.company}` : ''} → ${w.to ?? ''}`);
        if (opts.yes) return true;
        return (await ask(`Send all ${String(list.length)}? [y/N] `)) === 'y';
      },
    });
  } finally {
    db.close();
  }
}

export function skippedCommand(
  cfg: Config,
  opts: { days?: string; reason?: string; all?: boolean },
  io: Io,
): void {
  const days = Number(opts.days ?? 7);
  const db = openDb(cfg.paths.db);
  migrate(db);
  try {
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    const rows = db
      .prepare(
        `SELECT j.id, j.title, j.company, j.skip_reason, j.fit_score, j.apply_email, j.apply_url,
           j.apply_url_direct, r.source, r.posted_at
         FROM jobs j JOIN raw_items r ON r.id = j.raw_item_id
         WHERE j.status = 'skipped' AND j.created_at >= ?
           ${opts.all ? '' : "AND j.skip_reason <> 'duplicate'"}
           ${opts.reason ? 'AND j.skip_reason = @reason' : ''}
         ORDER BY j.skip_reason, j.fit_score DESC`,
      )
      .all(...(opts.reason ? [since, { reason: opts.reason }] : [since])) as {
      id: number;
      title: string;
      company: string | null;
      skip_reason: string | null;
      fit_score: number | null;
      apply_email: string | null;
      apply_url: string | null;
      apply_url_direct: string | null;
      source: string;
      posted_at: string;
    }[];
    let reason = '';
    for (const r of rows) {
      if (r.skip_reason !== reason) {
        reason = r.skip_reason ?? '';
        io.out(`\n${reason || 'other'}:`);
      }
      io.out(
        `  ${String(r.id).padStart(5)}  ${r.posted_at.slice(0, 10)}  ${r.fit_score === null ? '  -' : String(r.fit_score).padStart(3)}  ${r.title}${r.company ? ` · ${r.company}` : ''}  ${r.apply_url_direct ?? r.apply_url ?? r.apply_email ?? ''}`,
      );
    }
    io.out(
      `\n${String(rows.length)} skipped in the last ${String(days)} days${opts.all ? '' : ' (duplicates hidden; --all shows them)'}.`,
    );
    io.out(
      'Apply to one anyway: ./agent.sh redo <id>  (or set it to "New" in the dashboard; the next run prepares it)',
    );
  } finally {
    db.close();
  }
}
