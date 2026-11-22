// collect:ats (PLAN 5.1, D5, D29): open roles from target companies' public ATS feeds and
// plain careers pages. A cheap title/location pre-filter runs before anything is stored,
// so a 500-job board never reaches the model.
import { readFileSync } from 'node:fs';
import type { Logger } from 'pino';
import { parse } from 'yaml';
import { z } from 'zod';
import type { Config } from '../../config.js';
import type { Db } from '../../db/index.js';
import { insertRawItem, prepareRawItem } from '../../pipeline/dedupe.js';
import type { TitleMatcher } from '../../pipeline/titles.js';
import { sha256 } from '../../util/hash.js';
import type { PoliteHttp } from '../../util/http.js';
import { ADAPTERS, htmlText, type AtsPosting } from './adapters.js';

const Company = z.discriminatedUnion('ats', [
  z.strictObject({
    name: z.string().min(1),
    ats: z.enum(['greenhouse', 'lever', 'ashby', 'smartrecruiters', 'workable']),
    board: z.string().regex(/^[A-Za-z0-9._-]+$/),
  }),
  z.strictObject({ name: z.string().min(1), ats: z.literal('html'), url: z.url() }),
]);
export type CompanyEntry = z.infer<typeof Company>;
const CompaniesFile = z.strictObject({ companies: z.array(Company) });

export function loadCompanies(path: string): CompanyEntry[] {
  return CompaniesFile.parse(parse(readFileSync(path, 'utf8'))).companies;
}

export type PrefilterResult = 'keep' | 'title' | 'location' | 'stale';

/** Title tier P1/P2, location in Egypt or remote (when stated), not older than max_age_days. */
export function prefilter(
  p: AtsPosting,
  cfg: Config,
  matcher: TitleMatcher,
  now: Date,
): PrefilterResult {
  const d = matcher.classify(p.title);
  if (d.tier === null || d.tier === 3) return 'title';
  if (p.location && !p.remote) {
    const loc = p.location.toLowerCase();
    if (!cfg.ats.keep_locations.some((k) => loc.includes(k.toLowerCase()))) return 'location';
  }
  if (p.postedAt && now.getTime() - Date.parse(p.postedAt) > cfg.ats.max_age_days * 86_400_000)
    return 'stale';
  return 'keep';
}

/** What extraction sees for one posting: the facts it needs, the URL it must copy. */
export function postingText(p: AtsPosting, maxChars: number): string {
  const head = [
    p.title,
    `Company: ${p.company}`,
    p.location
      ? `Location: ${p.location}${p.remote ? ' (remote)' : ''}`
      : p.remote
        ? 'Location: remote'
        : '',
    `Apply: ${p.applyUrl ?? p.url}`,
  ]
    .filter(Boolean)
    .join('\n');
  const text = `${head}\n\n${p.text}`.trim();
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n[truncated]` : text;
}

export interface CompanyResult {
  company: string;
  ats: string;
  listed: number;
  kept: number;
  inserted: number;
  dropped: Record<string, number>;
  error?: string;
}

export async function collectAts(o: {
  http: PoliteHttp;
  db: Db;
  cfg: Config;
  companies: CompanyEntry[];
  matcher: TitleMatcher;
  now: Date;
  log: Logger;
  dryRun?: boolean;
  runId?: number | null;
}): Promise<CompanyResult[]> {
  const { db, cfg } = o;
  const results: CompanyResult[] = [];
  const store = (
    items: { ref: string; name: string; posted: string; text: string; source: 'ats' | 'html' }[],
    key: string,
  ) => {
    let inserted = 0;
    db.transaction(() => {
      for (const it of items) {
        const raw = prepareRawItem({
          source: it.source,
          source_ref: it.ref,
          source_name: it.name,
          posted_at: it.posted,
          text: it.text,
          run_id: o.runId ?? null,
        });
        if (insertRawItem(db, raw, o.now.toISOString()).inserted) inserted++;
      }
      db.prepare(
        `INSERT INTO source_state (source, last_success_at) VALUES (?, ?)
         ON CONFLICT (source) DO UPDATE SET last_success_at = excluded.last_success_at`,
      ).run(key, o.now.toISOString());
    })();
    return inserted;
  };

  for (const c of o.companies) {
    const r: CompanyResult = {
      company: c.name,
      ats: c.ats,
      listed: 0,
      kept: 0,
      inserted: 0,
      dropped: {},
    };
    results.push(r);
    try {
      if (c.ats === 'html') {
        // No feed: the page text is one raw item; a new item appears only when it changes (L0/L1).
        const text = htmlText(await o.http.get(c.url, 'text/html')).slice(
          0,
          cfg.ats.html_max_chars,
        );
        r.listed = 1;
        r.kept = 1;
        if (!o.dryRun) {
          r.inserted = store(
            [
              {
                ref: `html:${c.url}#${sha256(text).slice(0, 16)}`,
                name: c.name,
                posted: o.now.toISOString(),
                text: `Careers page of ${c.name}: ${c.url}\n\n${text}`,
                source: 'html',
              },
            ],
            `ats:${c.name}`,
          );
        }
        continue;
      }
      const adapter = ADAPTERS[c.ats];
      const postings = await adapter.list(o.http, c.board, c.name);
      r.listed = postings.length;
      const kept: AtsPosting[] = [];
      for (const p of postings) {
        const why = prefilter(p, cfg, o.matcher, o.now);
        if (why === 'keep') kept.push(p);
        else r.dropped[why] = (r.dropped[why] ?? 0) + 1;
      }
      r.kept = kept.length;
      if (o.dryRun) continue;
      const already = db
        .prepare('SELECT 1 FROM raw_items WHERE source = ? AND source_ref = ?')
        .pluck();
      const items = [];
      for (const p of kept) {
        const ref = `${c.ats}:${c.board}:${p.externalId}`;
        if (already.get('ats', ref)) continue; // seen: don't fetch details again
        const full = adapter.details && !p.text ? await adapter.details(o.http, c.board, p) : p;
        items.push({
          ref,
          name: c.name,
          posted: p.postedAt ?? o.now.toISOString(),
          text: postingText(full, cfg.ats.posting_max_chars),
          source: 'ats' as const,
        });
      }
      r.inserted = store(items, `ats:${c.name}`);
    } catch (err) {
      // Error isolation (PLAN P7): one broken board doesn't stop the others.
      r.error = err instanceof Error ? err.message : String(err);
      o.log.warn({ company: c.name, err: r.error }, 'ats collection failed');
    }
  }
  return results;
}
