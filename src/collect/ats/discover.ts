// Dynamic companies (D30): a job link or a company name becomes a polled ATS board
// without anyone editing companies.yaml. A board is only added on evidence:
// - the job's own link points at the board (jobs.lever.co/acme/…), or the company's
//   careers page embeds it; or
// - a board guessed from the company name lists this same job title (a guessed slug
//   alone could be another company with the same name).
import type { Logger } from 'pino';
import type { Config } from '../../config.js';
import type { Db } from '../../db/index.js';
import { HttpError, type PoliteHttp } from '../../util/http.js';
import { canonicalTitle, diceSimilarity, normalizeCompany } from '../../util/text.js';
import { ADAPTERS, type AtsKind, type AtsPosting } from './adapters.js';
import type { CompanyEntry } from './collect.js';
import { detectIn } from './detect.js';

export interface DiscoverDeps {
  http: PoliteHttp;
  /**
   * For guessing boards from a name: short timeout, no retries. Lever answers an unknown
   * board's 404 after ~24 s (measured 2026-11-22), which would stall every run.
   */
  probeHttp?: PoliteHttp;
  db: Db;
  cfg: Config;
  now: Date;
  log: Logger;
}

export interface BoardHit {
  companyId: number;
  entry: CompanyEntry;
  posting: AtsPosting | null;
}

const PROBE_ORDER: AtsKind[] = ['greenhouse', 'lever', 'ashby', 'workable', 'smartrecruiters'];
const NAME_NOISE =
  /\b(inc|llc|ltd|limited|plc|co|corp|corporation|company|group|holding|holdings|s\.?a\.?e|sae|egypt|eg|mena|the)\b\.?/g;

/** Board tokens worth trying for a company name: "DXC Technology" → dxctechnology, dxc-technology, dxc. */
export function slugCandidates(company: string): string[] {
  const words = company
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(NAME_NOISE, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  if (words.length === 0) return [];
  const out = [words.join(''), words.join('-'), words[0] ?? ''];
  return [...new Set(out)].filter((s) => s.length >= 2).slice(0, 3);
}

/** The posting on a board that is this job: same id in the link, else the closest title. */
export function matchPosting(
  postings: AtsPosting[],
  title: string,
  minSimilarity: number,
  link?: string | null,
): AtsPosting | null {
  if (link) {
    const byId = postings.find((p) => link.includes(p.externalId));
    if (byId) return byId;
  }
  const want = canonicalTitle(title);
  let best: { p: AtsPosting; s: number } | null = null;
  for (const p of postings) {
    const s = diceSimilarity(want, canonicalTitle(p.title));
    if (!best || s > best.s) best = { p, s };
  }
  return best && best.s >= minSimilarity ? best.p : null;
}

/** Adds a board (or returns the existing one). Discovered boards are polled by collect:ats. */
export function upsertCompany(
  db: Db,
  c: { name: string; ats: CompanyEntry['ats']; board?: string; url?: string },
  evidence: string,
  jobId: number | null,
  now: Date,
): number {
  const find = () =>
    (c.board
      ? db
          .prepare('SELECT id FROM companies WHERE ats = ? AND board = ?')
          .pluck()
          .get(c.ats, c.board)
      : db
          .prepare('SELECT id FROM companies WHERE url = ?')
          .pluck()
          .get(c.url ?? '')) as number | undefined;
  const existing = find();
  if (existing !== undefined) return existing;
  return Number(
    db
      .prepare(
        `INSERT INTO companies (name, ats, board, url, source, evidence, discovered_job, added_at)
         VALUES (?, ?, ?, ?, 'discovered', ?, ?, ?)`,
      )
      .run(c.name, c.ats, c.board ?? null, c.url ?? null, evidence, jobId, now.toISOString())
      .lastInsertRowid,
  );
}

/** Boards from companies.yaml plus every active discovered board, without duplicates. */
export function companiesToPoll(db: Db, fromConfig: CompanyEntry[]): CompanyEntry[] {
  const rows = db
    .prepare(
      `SELECT name, ats, board, url FROM companies WHERE source = 'discovered' AND active = 1 ORDER BY id`,
    )
    .all() as {
    name: string;
    ats: CompanyEntry['ats'];
    board: string | null;
    url: string | null;
  }[];
  const key = (c: CompanyEntry) => (c.ats === 'html' ? `html:${c.url}` : `${c.ats}:${c.board}`);
  const seen = new Set(fromConfig.map(key));
  const out = [...fromConfig];
  for (const r of rows) {
    const c: CompanyEntry | null =
      r.ats === 'html'
        ? r.url
          ? { name: r.name, ats: 'html', url: r.url }
          : null
        : r.board
          ? { name: r.name, ats: r.ats, board: r.board }
          : null;
    if (c && !seen.has(key(c))) {
      seen.add(key(c));
      out.push(c);
    }
  }
  return out;
}

const listCache = new WeakMap<PoliteHttp, Map<string, Promise<AtsPosting[]>>>();

/** One list call per board per run, however many jobs point at it. */
function listBoard(
  d: DiscoverDeps,
  ats: AtsKind,
  board: string,
  company: string,
  http: PoliteHttp = d.http,
) {
  let m = listCache.get(http);
  if (!m) {
    m = new Map<string, Promise<AtsPosting[]>>();
    listCache.set(http, m);
  }
  const k = `${ats}:${board}`;
  let p = m.get(k);
  if (!p) {
    p = ADAPTERS[ats].list(http, board, company);
    m.set(k, p);
  }
  return p;
}

/** A link (or the HTML of a page) that names an ATS board → that board and this job on it. */
export async function boardFromText(
  d: DiscoverDeps,
  text: string,
  job: { title: string; company: string | null; link: string | null },
  jobId: number | null,
): Promise<BoardHit | null> {
  const found = detectIn(text);
  if (!found) return null;
  const name = job.company ?? found.board;
  const postings = await listBoard(d, found.ats, found.board, name);
  const posting = matchPosting(postings, job.title, d.cfg.enrich.min_title_similarity, job.link);
  const entry: CompanyEntry = { name, ats: found.ats, board: found.board };
  const companyId = upsertCompany(d.db, entry, `job link ${job.link ?? '(page)'}`, jobId, d.now);
  return { companyId, entry, posting };
}

/**
 * Guesses the board from the company name (cached per company for probe_cache_days).
 * Accepted only when the board lists this job's title.
 */
export async function boardFromName(
  d: DiscoverDeps,
  job: { title: string; company: string },
  jobId: number | null,
): Promise<BoardHit | null> {
  const norm = normalizeCompany(job.company);
  if (!norm) return null;
  const probe = d.db
    .prepare('SELECT checked_at, found FROM company_probes WHERE company_norm = ?')
    .get(norm) as { checked_at: string; found: number | null } | undefined;
  const fresh =
    probe &&
    d.now.getTime() - Date.parse(probe.checked_at) < d.cfg.enrich.probe_cache_days * 86_400_000;

  if (fresh && probe.found === null) return null;
  if (fresh && probe.found !== null) {
    const row = d.db
      .prepare('SELECT name, ats, board FROM companies WHERE id = ?')
      .get(probe.found) as { name: string; ats: AtsKind; board: string } | undefined;
    if (!row) return null;
    const postings = await listBoard(d, row.ats, row.board, row.name);
    const posting = matchPosting(postings, job.title, d.cfg.enrich.min_title_similarity);
    return {
      companyId: probe.found,
      entry: { name: row.name, ats: row.ats, board: row.board },
      posting,
    };
  }

  let hit: BoardHit | null = null;
  for (const slug of slugCandidates(job.company)) {
    // The five ATS hosts are different hosts, so they are asked in parallel (each host
    // still paced); the first in PROBE_ORDER that lists this title wins.
    const lists = await Promise.allSettled(
      PROBE_ORDER.map((ats) => listBoard(d, ats, slug, job.company, d.probeHttp ?? d.http)),
    );
    for (const [i, res] of lists.entries()) {
      const ats = PROBE_ORDER[i];
      if (!ats) continue;
      if (res.status === 'rejected') {
        // 404 / 400: no such board. Timeouts and anything else are logged and skipped.
        const err: unknown = res.reason;
        if (!(err instanceof HttpError && err.status !== null && err.status < 500))
          d.log.debug({ ats, slug, err: String(err) }, 'board probe failed');
        continue;
      }
      const posting = matchPosting(res.value, job.title, d.cfg.enrich.min_title_similarity);
      if (!posting) continue; // a board with this name, but not this job: maybe another company
      const entry: CompanyEntry = { name: job.company, ats, board: slug };
      const companyId = upsertCompany(
        d.db,
        entry,
        `title match "${posting.title}" on ${ats}/${slug}`,
        jobId,
        d.now,
      );
      hit = { companyId, entry, posting };
      break;
    }
    if (hit) break;
  }
  d.db
    .prepare(
      `INSERT INTO company_probes (company_norm, checked_at, found) VALUES (?, ?, ?)
       ON CONFLICT (company_norm) DO UPDATE SET checked_at = excluded.checked_at, found = excluded.found`,
    )
    .run(norm, d.now.toISOString(), hit?.companyId ?? null);
  return hit;
}
