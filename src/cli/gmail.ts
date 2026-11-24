// CLI actions for P5: gmail:auth, gmail:check, collect alerts, gmail:test-draft, sync, digest.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../config.js';
import { collectAlerts } from '../collect/alerts.js';
import { draftApplication } from '../apply/email.js';
import { migrate, openDb } from '../db/index.js';
import { authorize, gmailAuthClient, SCOPES, tokenAgeDays } from '../gmail/auth.js';
import { draftUrl, GmailFacade } from '../gmail/client.js';
import { syncGmail } from '../gmail/sync.js';
import { buildDigest, sendDigest } from '../pipeline/digest.js';
import { extractJobs } from '../pipeline/extract.js';
import { loadProfile } from '../profile/load.js';
import { loadDotEnv } from '../util/env.js';
import { logger } from '../util/logger.js';
import { ClaudeCli } from '../llm/claude-cli.js';
import type { Io } from './program.js';

const facade = (cfg: Config) => new GmailFacade(gmailAuthClient(cfg));

export async function gmailAuthCommand(cfg: Config, io: Io): Promise<void> {
  await authorize(cfg, io.out);
  if (!cfg.gmail.enabled)
    io.out('Authorized. Now switch it on in your profile config.yaml:  gmail: { enabled: true }');
}

export async function gmailCheckCommand(cfg: Config, io: Io): Promise<void> {
  if (!cfg.gmail.enabled) {
    io.out('Gmail is off (gmail.enabled: false): email jobs become packages you send yourself');
    return;
  }
  const auth = gmailAuthClient(cfg);
  const g = new GmailFacade(auth);
  const me = await g.myAddress();
  const info = await auth.getTokenInfo((await auth.getAccessToken()).token ?? '');
  const alerts = await g.search(`label:"${cfg.alerts.gmail_label}"`, 500);
  io.out(`account: ${me}`);
  const age = tokenAgeDays(cfg);
  if (age !== null) {
    io.out(
      `authorized ${age.toFixed(1)} days ago${age > 6 ? '  <- if the app is in Testing mode, Google expires it at 7 days: run gmail:auth now' : ''}`,
    );
  }
  io.out(
    `scopes: ${SCOPES.every((s) => info.scopes.includes(s)) ? 'gmail.readonly + gmail.compose (ok)' : `MISSING (${info.scopes.join(' ')})`}`,
  );
  io.out(
    `label "${cfg.alerts.gmail_label}": ${String(alerts.length)} emails${alerts.length >= 500 ? '+' : ''}`,
  );
  const profile = loadProfile(cfg.paths.profile);
  if (profile.candidate.email.toLowerCase() !== me) {
    io.out(`WARNING: profile email ${profile.candidate.email} differs from the authorized account`);
  }
}

export async function collectAlertsCommand(
  cfg: Config,
  opts: { since?: string; dryRun?: boolean; extract?: boolean },
  io: Io,
): Promise<void> {
  const db = openDb(cfg.paths.db);
  migrate(db);
  try {
    const res = await collectAlerts({
      gmail: facade(cfg),
      db,
      cfg,
      now: new Date(),
      log: logger,
      ...(opts.since ? { since: new Date(opts.since) } : {}),
      ...(opts.dryRun ? { dryRun: true } : {}),
    });
    io.out(
      `alert emails: ${String(res.found)} found, ${opts.dryRun ? 'dry run: nothing stored' : `${String(res.inserted)} new stored`}`,
    );
    for (const sub of res.skipped) io.out(`  skipped (not a job list): ${sub}`);
    for (const it of res.items)
      io.out(
        `  ${it.posted_at.slice(0, 16)}  ${it.from}  |  ${it.subject}  (${String(it.text.length)} chars)`,
      );
    if (opts.extract) {
      // Gate check: show what extraction makes of each alert (model calls, nothing stored).
      const env = loadDotEnv(cfg.paths.env);
      const llm = new ClaudeCli({
        binary: cfg.llm.cli.binary,
        pinnedVersion: cfg.llm.cli.pinned_version,
        timeoutMs: cfg.llm.timeout_seconds * 1000,
        maxRetries: cfg.llm.max_retries,
        dotenv: env.values,
        isolatedHome: cfg.llm.cli.home,
        workDir: cfg.llm.cli.workdir,
        log: logger,
      });
      await llm.preflight(cfg.llm.extract_model);
      for (const it of res.items) {
        const jobs = await extractJobs(llm, cfg.llm.extract_model, {
          text: it.text,
          posted_at: it.posted_at,
          source: 'alert_email',
          source_name: it.from,
        });
        io.out(`\n${it.subject}: ${String(jobs.length)} jobs`);
        for (const j of jobs) {
          io.out(
            `  - ${j.title}${j.company ? ` · ${j.company}` : ''}${j.location ? ` · ${j.location}` : ''} · ${j.apply_channel}${j.apply_url ? ` ${j.apply_url}` : ''}${j.flags.length ? ` [${j.flags.join(',')}]` : ''}`,
          );
        }
      }
    }
  } finally {
    db.close();
  }
}

/** P5 gate: one real draft to Ahmed himself: the fixture's cover letter as the body, the CV attached. */
export async function testDraftCommand(cfg: Config, fixture: string, io: Io): Promise<void> {
  const dir = join(cfg.apply.output_dir, 'fixtures', fixture);
  if (!existsSync(dir))
    throw new Error(`${dir} not found: run  npm run agent -- tailor:fixtures ${fixture} --replay`);
  const cv = readdirSync(dir).find((f) => /(-CV|_CV_.*)\.pdf$/.test(f));
  if (!cv) throw new Error(`CV PDF missing in ${dir}`);
  const email = readFileSync(join(dir, 'email.txt'), 'utf8');
  const subject = /^Subject: (.*)$/m.exec(email)?.[1] ?? 'Application';
  const body = email.slice(email.indexOf('\n\n') + 2);
  const profile = loadProfile(cfg.paths.profile);
  const g = facade(cfg);
  const me = await g.myAddress();
  const d = await draftApplication(g, profile, {
    to: me, // the gate draft goes to Ahmed himself, never to the fixture's fake company
    subject: `[TEST] ${subject}`,
    body,
    cvPath: join(dir, cv),
  });
  io.out(`draft created to ${me}: ${draftUrl(d.messageId)}`);
  io.out(`attachment: ${cv} (the cover letter is the email body)`);
}

export async function syncCommand(cfg: Config, io: Io): Promise<void> {
  const db = openDb(cfg.paths.db);
  migrate(db);
  try {
    const r = await syncGmail(db, facade(cfg), new Date());
    io.out(`sync: ${String(r.sent)} drafts sent since last sync, ${String(r.replies)} new replies`);
  } finally {
    db.close();
  }
}

export async function digestCommand(
  cfg: Config,
  opts: { send?: boolean; hours?: string },
  io: Io,
): Promise<void> {
  const db = openDb(cfg.paths.db);
  migrate(db);
  try {
    const now = new Date();
    const since = new Date(now.getTime() - Number(opts.hours ?? 24) * 3_600_000).toISOString();
    const d = buildDigest(db, since, now.toISOString().slice(0, 10));
    io.out(`Subject: ${d.subject}\n\n${d.text}`);
    if (opts.send) {
      await sendDigest(facade(cfg), cfg, d);
      io.out(`sent to ${cfg.digest.to ?? 'your address'}`);
    }
  } finally {
    db.close();
  }
}
