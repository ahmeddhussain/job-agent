// CLI actions for P6: collect ats, ats:detect.
import type { Config } from '../config.js';
import { ADAPTERS } from '../collect/ats/adapters.js';
import { collectAts, loadCompanies } from '../collect/ats/collect.js';
import { companiesToPoll } from '../collect/ats/discover.js';
import { detectAts, detectIn } from '../collect/ats/detect.js';
import { migrate, openDb } from '../db/index.js';
import { existsSync } from 'node:fs';
import { TitleMatcher } from '../pipeline/titles.js';
import { PoliteHttp } from '../util/http.js';
import { logger } from '../util/logger.js';
import type { Io } from './program.js';

export const httpFor = (cfg: Config) =>
  new PoliteHttp({
    userAgent: cfg.ats.user_agent,
    minIntervalMs: cfg.ats.min_interval_seconds * 1000,
  });

export async function collectAtsCommand(
  cfg: Config,
  opts: { dryRun?: boolean },
  io: Io,
): Promise<void> {
  const db = openDb(cfg.paths.db);
  migrate(db);
  try {
    const results = await collectAts({
      http: httpFor(cfg),
      db,
      cfg,
      companies: companiesToPoll(db, loadCompanies(cfg.ats.companies_file)),
      matcher: TitleMatcher.fromFile(cfg.paths.titles),
      now: new Date(),
      log: logger,
      ...(opts.dryRun ? { dryRun: true } : {}),
    });
    for (const r of results) {
      const dropped =
        Object.entries(r.dropped)
          .map(([k, n]) => `${k} ${String(n)}`)
          .join(', ') || 'none';
      io.out(
        r.error
          ? `${r.company} [${r.ats}]: FAILED ${r.error}`
          : `${r.company} [${r.ats}]: listed=${String(r.listed)} kept=${String(r.kept)} new=${String(r.inserted)} (dropped: ${dropped})`,
      );
    }
    const total = results.reduce((a, r) => a + r.inserted, 0);
    io.out(opts.dryRun ? 'dry run: nothing stored' : `stored ${String(total)} new postings`);
  } finally {
    db.close();
  }
}

export async function atsDetectCommand(cfg: Config, url: string, io: Io): Promise<void> {
  const http = httpFor(cfg);
  const d = await detectAts(http, url);
  // On an ATS URL the hostname is the ATS's own (ashbyhq, job-boards): suggest the board.
  const site =
    new URL(url).hostname.replace(/^(www|careers|jobs)\./, '').split('.')[0] ?? 'Company';
  const base = d.ats === 'html' || !detectIn(url) ? site : d.board;
  const name = base.charAt(0).toUpperCase() + base.slice(1);
  if (d.ats === 'html') {
    io.out(`no ATS feed found; the page will be watched for changes:`);
    io.out(`  - { name: ${name}, ats: html, url: ${url} }`);
    return;
  }
  // Prove the feed works before suggesting it.
  const jobs = await ADAPTERS[d.ats].list(http, d.board, name);
  io.out(
    `${d.ats} board "${d.board}" works: ${String(jobs.length)} open postings. Add to config/companies.yaml:`,
  );
  io.out(`  - { name: ${name}, ats: ${d.ats}, board: ${d.board} }`);
}

/** `agent companies`: what collect:ats polls, and how each discovered board was found. */
export function companiesCommand(cfg: Config, io: Io): void {
  const fromConfig = existsSync(cfg.ats.companies_file)
    ? loadCompanies(cfg.ats.companies_file)
    : [];
  for (const c of fromConfig)
    io.out(`config      ${c.name} [${c.ats}] ${c.ats === 'html' ? c.url : c.board}`);
  const db = openDb(cfg.paths.db);
  migrate(db);
  try {
    const rows = db
      .prepare(
        `SELECT name, ats, board, url, active, fail_count, evidence, added_at FROM companies
         WHERE source = 'discovered' ORDER BY added_at`,
      )
      .all() as {
      name: string;
      ats: string;
      board: string | null;
      url: string | null;
      active: number;
      fail_count: number;
      evidence: string | null;
      added_at: string;
    }[];
    for (const r of rows)
      io.out(
        `discovered  ${r.name} [${r.ats}] ${r.board ?? r.url ?? ''}${r.active ? '' : ' (OFF: failing)'} · ${r.added_at.slice(0, 10)} · ${r.evidence ?? ''}`,
      );
    io.out(`${String(fromConfig.length)} from config, ${String(rows.length)} discovered`);
  } finally {
    db.close();
  }
}
