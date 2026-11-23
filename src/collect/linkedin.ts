// collect:linkedin (D38): LinkedIn's public job search, logged out, no cookies. For each
// search title and location, every job posted since that search last succeeded (at most
// 24 h), page by page. LinkedIn refuses some requests (HTTP 429, about 1 in 4 measured on
// 2026-11-23); a refused page is retried after a pause, and a search that couldn't read
// all its pages keeps its old window, so the next run fetches those jobs.
import type { Logger } from 'pino';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { insertRawItem, prepareRawItem } from '../pipeline/dedupe.js';
import type { TitleMatcher } from '../pipeline/titles.js';
import { HttpError, type PoliteHttp } from '../util/http.js';

export interface SearchCard {
  id: string;
  title: string;
  company: string | null;
  location: string | null;
  /** YYYY-MM-DD from the card's <time datetime>. */
  date: string | null;
  url: string;
}

const clean = (s: string | undefined) =>
  (s ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();

/** Job cards from one search results page (jobs-guest/jobs/api/seeMoreJobPostings/search). */
export function parseSearchCards(html: string): SearchCard[] {
  const out: SearchCard[] = [];
  for (const block of html.split(/<li[\s>]/).slice(1)) {
    const id = /urn:li:jobPosting:(\d{6,})/.exec(block)?.[1];
    const title = clean(/base-search-card__title"[^>]*>([\s\S]*?)<\/h3>/.exec(block)?.[1]);
    if (!id || !title) continue;
    out.push({
      id,
      title,
      company: clean(/base-search-card__subtitle"[^>]*>([\s\S]*?)<\/h4>/.exec(block)?.[1]) || null,
      location:
        clean(/job-search-card__location"[^>]*>([\s\S]*?)<\/span>/.exec(block)?.[1]) || null,
      date: /<time[^>]*datetime="(\d{4}-\d{2}-\d{2})"/.exec(block)?.[1] ?? null,
      url: `https://linkedin.com/jobs/view/${id}`,
    });
  }
  return out;
}

export function cardText(c: SearchCard): string {
  return [
    c.title,
    c.company ? `Company: ${c.company}` : '',
    c.location ? `Location: ${c.location}` : '',
    c.date ? `Posted: ${c.date}` : '',
    `Apply: ${c.url}`,
  ]
    .filter(Boolean)
    .join('\n');
}

/** GET with patience for 429: waits and retries; other errors are thrown at once. */
export async function getWith429Retry(
  http: PoliteHttp,
  url: string,
  retries: number,
  waitMs: number,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await http.get(url, 'text/html');
    } catch (err) {
      if (!(err instanceof HttpError && err.status === 429) || attempt >= retries) throw err;
      await sleep(waitMs * (attempt + 1));
    }
  }
}

export interface SearchResult {
  title: string;
  location: string;
  found: number;
  kept: number;
  inserted: number;
  pages: number;
  /** False when LinkedIn kept refusing a page: the window is kept for the next run. */
  complete: boolean;
}

export async function collectLinkedinSearch(o: {
  http: PoliteHttp;
  db: Db;
  cfg: Config;
  matcher: TitleMatcher;
  now: Date;
  log: Logger;
  runId?: number | null;
  dryRun?: boolean;
  sleep?: (ms: number) => Promise<void>;
}): Promise<{ results: SearchResult[]; inserted: number; refused: number }> {
  const s = o.cfg.search.linkedin;
  const results: SearchResult[] = [];
  const seen = new Set<string>();
  let refused = 0;
  for (const title of s.titles) {
    for (const location of s.locations) {
      const key = `linkedin:${title}|${location}`;
      const last = o.db
        .prepare('SELECT last_success_at FROM source_state WHERE source = ?')
        .pluck()
        .get(key) as string | undefined;
      // Only what's new since this search last succeeded (plus overlap), at most 24 h.
      const seconds = Math.min(
        86_400,
        last
          ? Math.ceil((o.now.getTime() - Date.parse(last)) / 1000) + o.cfg.run.overlap_minutes * 60
          : 86_400,
      );
      const r: SearchResult = {
        title,
        location,
        found: 0,
        kept: 0,
        inserted: 0,
        pages: 0,
        complete: true,
      };
      results.push(r);
      const items: SearchCard[] = [];
      for (let page = 0; page < s.max_pages; page++) {
        const url =
          'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?' +
          new URLSearchParams({
            keywords: title,
            location,
            f_TPR: `r${String(seconds)}`,
            start: String(page * 10),
          }).toString();
        let html: string;
        try {
          html = await getWith429Retry(
            o.http,
            url,
            s.retries,
            s.retry_wait_seconds * 1000,
            o.sleep,
          );
        } catch (err) {
          r.complete = false;
          if (err instanceof HttpError && err.status === 429) refused++;
          o.log.warn({ title, page, err: String(err) }, 'linkedin search page not read');
          break;
        }
        r.pages++;
        const cards = parseSearchCards(html);
        r.found += cards.length;
        for (const c of cards) {
          if (seen.has(c.id)) continue;
          seen.add(c.id);
          const d = o.matcher.classify(c.title);
          // Same pre-filter as company boards: priority titles only reach the model.
          if (d.tier === 1 || d.tier === 2) items.push(c);
        }
        if (cards.length < 10) break; // last page
      }
      r.kept = items.length;
      if (o.dryRun) continue;
      o.db.transaction(() => {
        for (const c of items) {
          const item = prepareRawItem({
            source: 'linkedin',
            source_ref: c.id,
            source_name: `LinkedIn search: ${title}`,
            posted_at: c.date ? new Date(`${c.date}T12:00:00Z`).toISOString() : o.now.toISOString(),
            text: cardText(c),
            run_id: o.runId ?? null,
          });
          if (insertRawItem(o.db, item, o.now.toISOString()).inserted) r.inserted++;
        }
        if (r.complete)
          o.db
            .prepare(
              `INSERT INTO source_state (source, last_success_at) VALUES (?, ?)
               ON CONFLICT (source) DO UPDATE SET last_success_at = excluded.last_success_at`,
            )
            .run(key, o.now.toISOString());
      })();
    }
  }
  return { results, inserted: results.reduce((a, r) => a + r.inserted, 0), refused };
}
