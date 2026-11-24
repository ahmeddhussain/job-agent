// CLI actions for P7: `agent run` (live or --dry-run), `agent add` (a post by hand) and
// `agent reprocess <job> --from score|tailor`.
import { copyFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { ConfigError, type Config } from '../config.js';
import { REVIEW_MARKER } from '../profiles.js';
import { collectAlerts } from '../collect/alerts.js';
import { collectAts, loadCompanies } from '../collect/ats/collect.js';
import { companiesToPoll } from '../collect/ats/discover.js';
import { collectLinkedinSearch } from '../collect/linkedin.js';
import { migrate, openDb, type Db } from '../db/index.js';
import { getJob, rowToCheckedJob, updateJobStatus } from '../db/jobs.js';
import { gmailAuthClient } from '../gmail/auth.js';
import { GmailFacade } from '../gmail/client.js';
import { ClaudeCli } from '../llm/claude-cli.js';
import type { LlmCallRecord } from '../llm/types.js';
import { sendDigest } from '../pipeline/digest.js';
import { insertRawItem, prepareRawItem } from '../pipeline/dedupe.js';
import { scoreJob } from '../pipeline/score.js';
import { FormFiller } from '../apply/forms.js';
import { TitleMatcher } from '../pipeline/titles.js';
import { loadProfile } from '../profile/load.js';
import { Renderer } from '../render/renderer.js';
import {
  emptyStats,
  runAgent,
  tailorQueue,
  type RunDeps,
  type SourceRun,
} from '../run/orchestrator.js';
import { loadDotEnv } from '../util/env.js';
import { sha256 } from '../util/hash.js';
import { PoliteHttp } from '../util/http.js';
import { acquireLock } from '../util/lock.js';
import { logger } from '../util/logger.js';
import type { Io } from './program.js';
import { collectWhatsAppForRun } from './whatsapp.js';

/** One paced client for every LinkedIn request in a run (search and job pages share the limit). */
export function linkedinClient(cfg: Config): PoliteHttp {
  return new PoliteHttp({
    userAgent: cfg.ats.user_agent,
    minIntervalMs:
      Math.max(cfg.alerts.linkedin_min_interval_seconds, cfg.search.linkedin.min_interval_seconds) *
      1000,
  });
}

export interface RunFlags {
  dryRun?: boolean;
  source?: string;
  since?: string;
  collect?: boolean;
}

export function claude(cfg: Config, calls: LlmCallRecord[]): ClaudeCli {
  const env = loadDotEnv(cfg.paths.env);
  for (const w of env.warnings) logger.warn(w);
  return new ClaudeCli({
    binary: cfg.llm.cli.binary,
    pinnedVersion: cfg.llm.cli.pinned_version,
    timeoutMs: cfg.llm.timeout_seconds * 1000,
    maxRetries: cfg.llm.max_retries,
    dotenv: env.values,
    isolatedHome: cfg.llm.cli.home,
    workDir: cfg.llm.cli.workdir,
    log: logger,
    onCall: (r) => calls.push(r),
  });
}

/** Gmail if enabled, authorized and reachable, else null with the reason (the run continues). */
async function gmailOrNull(cfg: Config): Promise<{ g: GmailFacade | null; why: string | null }> {
  if (!cfg.gmail.enabled)
    return { g: null, why: 'not connected (gmail.enabled: false): email jobs become packages' };
  try {
    const g = new GmailFacade(gmailAuthClient(cfg));
    await g.myAddress();
    return { g, why: null };
  } catch (err) {
    return { g: null, why: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Dry runs work on a copy of the database (data/dry-run.db), so they can be repeated
 * without marking anything as processed or applied in the real one.
 */
function openRunDb(cfg: Config, dryRun: boolean): { db: Db; path: string } {
  if (!dryRun) {
    const db = openDb(cfg.paths.db);
    migrate(db);
    return { db, path: cfg.paths.db };
  }
  const real = openDb(cfg.paths.db);
  migrate(real);
  real.pragma('wal_checkpoint(TRUNCATE)');
  real.close();
  const copy = join(dirname(cfg.paths.db), 'dry-run.db');
  for (const ext of ['', '-wal', '-shm']) rmSync(`${copy}${ext}`, { force: true });
  copyFileSync(cfg.paths.db, copy);
  return { db: openDb(copy), path: copy };
}

function depsFor(
  cfg: Config,
  db: Db,
  io: Io,
  extra: Pick<
    RunDeps,
    'gmailRead' | 'gmailWrite' | 'sources' | 'dryRun' | 'sendDigest' | 'forms'
  > & {
    linkedinHttp?: PoliteHttp;
    calls: LlmCallRecord[];
    llm: ClaudeCli;
    outputRoot: string;
  },
): RunDeps {
  return {
    cfg,
    profile: loadProfile(cfg.paths.profile),
    db,
    llm: extra.llm,
    preflight: async () => {
      const pf = await extra.llm.preflight(cfg.llm.extract_model);
      return `claude ${pf.version}, apiKeySource=${pf.apiKeySource} (subscription)`;
    },
    gmailRead: extra.gmailRead,
    gmailWrite: extra.gmailWrite,
    sources: extra.sources,
    http: new PoliteHttp({
      userAgent: cfg.ats.user_agent,
      minIntervalMs: cfg.enrich.min_interval_seconds * 1000,
    }),
    probeHttp: new PoliteHttp({
      userAgent: cfg.ats.user_agent,
      minIntervalMs: cfg.enrich.min_interval_seconds * 1000,
      timeoutMs: 8000,
      attempts: 1,
    }),
    linkedinHttp: extra.linkedinHttp ?? linkedinClient(cfg),
    matcher: TitleMatcher.fromFile(cfg.paths.titles),
    openRenderer: () => Renderer.open(),
    now: () => new Date(),
    log: logger,
    out: io.out,
    dryRun: extra.dryRun,
    outputRoot: extra.outputRoot,
    calls: extra.calls,
    sendDigest: extra.sendDigest,
    forms: extra.forms ?? null,
  };
}

/** A profile drafted by `agent init` is used only after its owner has checked it (D45). */
export function assertReviewed(): void {
  if (existsSync(REVIEW_MARKER))
    throw new ConfigError(
      `this profile has not been reviewed yet: read ${resolve(REVIEW_MARKER)}, check profile.yaml and titles.yaml, then run ./agent.sh reviewed`,
    );
}

export async function runCommand(cfg: Config, flags: RunFlags, io: Io): Promise<number> {
  assertReviewed();
  const release = acquireLock(cfg.run.lock_file, 'agent run');
  const dryRun = flags.dryRun === true;
  const { db, path } = openRunDb(cfg, dryRun);
  try {
    io.out(`${dryRun ? 'DRY RUN' : 'LIVE RUN'} · database ${path} · apply.mode=${cfg.apply.mode}`);
    const since = flags.since ? new Date(flags.since) : undefined;
    if (since && Number.isNaN(since.getTime()))
      throw new Error(`--since: not a date: ${flags.since ?? ''}`);
    const gm = await gmailOrNull(cfg);
    if (!gm.g) io.out(`Gmail ${cfg.gmail.enabled ? 'unavailable' : 'off'}: ${gm.why ?? ''}`);
    const want = (s: string) => flags.collect !== false && (!flags.source || flags.source === s);

    const sources: SourceRun[] = [];
    if (want('whatsapp') && cfg.whatsapp.enabled && cfg.whatsapp.groups.length > 0)
      sources.push({
        name: 'whatsapp',
        required: cfg.whatsapp.required,
        collect: (runId) => collectWhatsAppForRun(cfg, db, runId, since),
      });
    const linkedinHttp = linkedinClient(cfg);
    if (want('linkedin') && cfg.search.linkedin.enabled && cfg.search.linkedin.titles.length > 0)
      sources.push({
        name: 'linkedin',
        collect: async (runId) => {
          const r = await collectLinkedinSearch({
            http: linkedinHttp,
            db,
            cfg,
            matcher: TitleMatcher.fromFile(cfg.paths.titles),
            now: new Date(),
            log: logger,
            runId,
          });
          const incomplete = r.results.filter((x) => !x.complete).map((x) => x.title);
          return {
            inserted: r.inserted,
            detail: `${String(r.results.length)} searches, ${String(r.results.reduce((a, x) => a + x.found, 0))} jobs listed, ${String(r.inserted)} new matching titles${r.refused ? `; LinkedIn refused ${String(r.refused)} pages` : ''}${incomplete.length ? ` (continued next run: ${incomplete.join(', ')})` : ''}`,
          };
        },
      });
    if (want('alerts') && cfg.alerts.enabled && cfg.gmail.enabled)
      sources.push({
        name: 'alerts',
        collect: async (runId) => {
          if (!gm.g) throw new Error(`Gmail unavailable: ${gm.why ?? ''}`);
          const r = await collectAlerts({
            gmail: gm.g,
            db,
            cfg,
            now: new Date(),
            log: logger,
            runId,
            ...(since ? { since } : {}),
          });
          return {
            inserted: r.inserted,
            detail: `${String(r.found)} alert emails, ${String(r.inserted)} new${r.skipped.length ? `, ${String(r.skipped.length)} not job lists` : ''}`,
          };
        },
      });
    if (want('ats') && cfg.ats.enabled)
      sources.push({
        name: 'ats',
        collect: async (runId) => {
          const results = await collectAts({
            http: new PoliteHttp({
              userAgent: cfg.ats.user_agent,
              minIntervalMs: cfg.ats.min_interval_seconds * 1000,
            }),
            db,
            cfg,
            companies: companiesToPoll(db, loadCompanies(cfg.ats.companies_file)),
            matcher: TitleMatcher.fromFile(cfg.paths.titles),
            now: new Date(),
            log: logger,
            runId,
          });
          const inserted = results.reduce((a, r) => a + r.inserted, 0);
          const failed = results.filter((r) => r.error);
          return {
            inserted,
            detail: `${String(results.length)} boards, ${String(inserted)} new postings${failed.length ? `; failed: ${failed.map((r) => r.company).join(', ')}` : ''}`,
          };
        },
      });

    const calls: LlmCallRecord[] = [];
    const llm = claude(cfg, calls);
    const g = gm.g;
    // A fresh headless profile per run: no saved sign-ins are ever exposed to form pages.
    const forms = new FormFiller({
      cfg,
      profile: loadProfile(cfg.paths.profile),
      llm,
      log: logger,
    });
    const report = await runAgent(
      depsFor(cfg, db, io, {
        llm,
        calls,
        gmailRead: g,
        gmailWrite: dryRun ? null : g,
        sources,
        dryRun,
        outputRoot: dryRun ? join(cfg.apply.output_dir, 'dry-run') : cfg.apply.output_dir,
        sendDigest: !dryRun && g ? (dg) => sendDigest(g, cfg, dg) : null,
        forms,
        linkedinHttp,
      }),
    ).finally(() => forms.close());
    if (dryRun || !g)
      io.out(`\n--- digest ---\nSubject: ${report.digest.subject}\n\n${report.digest.text}`);
    io.out(
      `run ${String(report.runId)}: ${report.status.toUpperCase()}${report.stopReason ? ` (${report.stopReason})` : ''}${report.error ? ` (${report.error})` : ''}`,
    );
    return report.status === 'failed' ? 1 : 0;
  } finally {
    db.close();
    release();
  }
}

/** `agent add [file]`: a job post pasted by hand (an old post, a forwarded email) into the queue. */
export function addCommand(
  cfg: Config,
  file: string | undefined,
  opts: { name?: string; posted?: string },
  io: Io,
): void {
  const text = readFileSync(file ?? 0, 'utf8').trim();
  if (text.length < 40)
    throw new Error('the post is too short to be a job post (under 40 characters)');
  const posted = opts.posted ? new Date(opts.posted) : new Date();
  if (Number.isNaN(posted.getTime())) throw new Error(`--posted: not a date: ${opts.posted ?? ''}`);
  const db = openDb(cfg.paths.db);
  migrate(db);
  try {
    const r = insertRawItem(
      db,
      prepareRawItem({
        source: 'manual',
        source_ref: `manual:${sha256(text).slice(0, 16)}`,
        source_name: opts.name ?? 'added by hand',
        posted_at: posted.toISOString(),
        text,
      }),
      new Date().toISOString(),
    );
    io.out(
      r.inserted
        ? `stored as item ${String(r.id)}; it is read on the next run (agent run --no-collect reads only stored items)`
        : `already stored (item ${String(r.id)})`,
    );
  } finally {
    db.close();
  }
}

/** `agent reprocess <job> --from score|tailor`: redo one job after a profile or prompt change. */
export async function reprocessCommand(
  cfg: Config,
  jobId: number,
  from: 'score' | 'tailor',
  io: Io,
): Promise<number> {
  const release = acquireLock(cfg.run.lock_file, 'agent run');
  const db = openDb(cfg.paths.db);
  migrate(db);
  try {
    const job = getJob(db, jobId);
    if (!job) throw new Error(`job ${String(jobId)} not found`);
    if (['applied', 'interview', 'offer', 'rejected'].includes(job.status))
      throw new Error(`job ${String(jobId)} is ${job.status}: not reprocessed`);
    const app = db
      .prepare('SELECT gmail_draft_id FROM applications WHERE job_id = ?')
      .get(jobId) as { gmail_draft_id: string | null } | undefined;
    if (app?.gmail_draft_id)
      io.out(
        'note: the old Gmail draft stays in Drafts (the agent has no delete permission): delete it there.',
      );
    db.prepare('DELETE FROM applications WHERE job_id = ?').run(jobId);

    const calls: LlmCallRecord[] = [];
    const llm = claude(cfg, calls);
    const gm = await gmailOrNull(cfg);
    const d = depsFor(cfg, db, io, {
      llm,
      calls,
      gmailRead: gm.g,
      gmailWrite: gm.g,
      sources: [],
      dryRun: false,
      outputRoot: cfg.apply.output_dir,
      sendDigest: null,
      forms: new FormFiller({ cfg, profile: loadProfile(cfg.paths.profile), llm, log: logger }),
    });
    io.out(`preflight: ${await (d.preflight as () => Promise<string>)()}`);
    const now = new Date().toISOString();

    if (from === 'score') {
      const raw = db
        .prepare('SELECT text FROM raw_items WHERE id = ?')
        .pluck()
        .get(job.raw_item_id) as string | null;
      const decision = await scoreJob(
        { cfg, profile: d.profile, matcher: d.matcher, llm, runDate: now.slice(0, 10) },
        rowToCheckedJob(job),
        raw ?? '',
      );
      db.prepare(
        `UPDATE jobs SET priority = ?, fit_score = ?, fit_reasons = ?, flags = ?, updated_at = ? WHERE id = ?`,
      ).run(
        decision.priority,
        decision.scores?.final ?? null,
        decision.fit
          ? JSON.stringify({
              scores: decision.scores,
              matched: decision.fit.matched,
              missing: decision.fit.missing,
              summary: decision.fit.summary,
            })
          : null,
        JSON.stringify(decision.flags),
        now,
        jobId,
      );
      updateJobStatus(db, jobId, decision.status, 'agent', now, decision.skip_reason);
      io.out(
        `rescored: ${decision.status}${decision.skip_reason ? ` (${decision.skip_reason})` : ''}${decision.scores ? ` fit ${String(decision.scores.final)}` : ''}`,
      );
      if (decision.status !== 'new') return 0;
    } else {
      updateJobStatus(db, jobId, 'new', 'ahmed', now, null);
    }
    const stats = emptyStats();
    try {
      await tailorQueue(
        d,
        stats,
        (err) => {
          throw err;
        },
        jobId,
      );
    } finally {
      await d.forms?.close();
    }
    return 0;
  } finally {
    db.close();
    release();
  }
}

/** `agent collect linkedin [--dry-run]`: the search alone, for checking titles and refusals. */
export async function collectLinkedinCommand(
  cfg: Config,
  opts: { dryRun?: boolean },
  io: Io,
): Promise<void> {
  const db = openDb(cfg.paths.db);
  migrate(db);
  try {
    const r = await collectLinkedinSearch({
      http: linkedinClient(cfg),
      db,
      cfg,
      matcher: TitleMatcher.fromFile(cfg.paths.titles),
      now: new Date(),
      log: logger,
      ...(opts.dryRun ? { dryRun: true } : {}),
    });
    for (const x of r.results)
      io.out(
        `${x.title} (${x.location}): ${String(x.found)} listed in ${String(x.pages)} pages, ${String(x.kept)} matching titles, ${String(x.inserted)} new${x.complete ? '' : '  [incomplete: LinkedIn refused a page]'}`,
      );
    io.out(
      `${opts.dryRun ? 'dry run: nothing stored' : `stored ${String(r.inserted)} new jobs`}; ${String(r.refused)} pages refused`,
    );
  } finally {
    db.close();
  }
}
