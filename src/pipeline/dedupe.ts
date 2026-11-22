// Deduplication layers L0–L3 (PLAN section 7). L4 (application guard + Gmail Sent
// check) runs right before applying and arrives with Gmail in P5.
import type { Db } from '../db/index.js';
import { sha256 } from '../util/hash.js';
import { hammingDistance, simhash } from '../util/simhash.js';
import {
  canonicalTitle,
  diceSimilarity,
  hashKey,
  normalizeCompany,
  tokens,
  tokenSetSimilarity,
} from '../util/text.js';
import { canonicalizeUrl } from '../util/url.js';

export interface DedupeOptions {
  content_window_days: number;
  near_dup_window_days: number;
  simhash_max_distance: number;
  near_dup_similarity: number;
  title_similarity: number;
}

/** Texts shorter than this are too small for a meaningful simhash (L2 is skipped). */
const MIN_TOKENS_FOR_SIMHASH = 8;

const daysBefore = (iso: string, days: number): string =>
  new Date(Date.parse(iso) - days * 86_400_000).toISOString();

// ---------------------------------------------------------------- raw items (L0–L2)

export type RawSource = 'whatsapp' | 'alert_email' | 'ats' | 'html' | 'whatsapp_export' | 'manual';

export interface RawItemInput {
  source: RawSource;
  source_ref: string;
  source_name?: string | null;
  author?: string | null;
  posted_at: string;
  text?: string | null;
  media_path?: string | null;
  media_sha?: string | null;
  run_id?: number | null;
}

export interface PreparedRawItem extends RawItemInput {
  content_hash: string;
  simhash: string | null;
}

export function prepareRawItem(item: RawItemInput): PreparedRawItem {
  const text = item.text ?? '';
  return {
    ...item,
    content_hash: sha256(`${hashKey(text)}|${item.media_sha ?? ''}`),
    simhash: tokens(text).length >= MIN_TOKENS_FOR_SIMHASH ? simhash(text) : null,
  };
}

/** L0: `UNIQUE(source, source_ref)`. Returns the existing row's id when already seen. */
export function insertRawItem(
  db: Db,
  item: PreparedRawItem,
  collectedAt: string,
): { id: number; inserted: boolean } {
  const res = db
    .prepare(
      `INSERT INTO raw_items (source, source_ref, source_name, author, posted_at, collected_at,
         text, media_path, content_hash, simhash, run_id)
       VALUES (@source, @source_ref, @source_name, @author, @posted_at, @collected_at,
         @text, @media_path, @content_hash, @simhash, @run_id)
       ON CONFLICT (source, source_ref) DO NOTHING`,
    )
    .run({
      source: item.source,
      source_ref: item.source_ref,
      source_name: item.source_name ?? null,
      author: item.author ?? null,
      posted_at: item.posted_at,
      collected_at: collectedAt,
      text: item.text ?? null,
      media_path: item.media_path ?? null,
      content_hash: item.content_hash,
      simhash: item.simhash,
      run_id: item.run_id ?? null,
    });
  if (res.changes === 1) return { id: Number(res.lastInsertRowid), inserted: true };
  const existing = db
    .prepare('SELECT id FROM raw_items WHERE source = ? AND source_ref = ?')
    .pluck()
    .get(item.source, item.source_ref);
  return { id: Number(existing), inserted: false };
}

export type RawDuplicate =
  | { layer: 'L1'; duplicateOf: number }
  | { layer: 'L2'; duplicateOf: number; distance: number; similarity: number };

/**
 * L1 (exact normalized content) then L2 (simhash distance, confirmed by token-set
 * similarity). Only earlier rows count as originals, so results are deterministic.
 */
export function findRawDuplicate(
  db: Db,
  item: {
    id: number;
    content_hash: string;
    simhash: string | null;
    text: string | null;
    posted_at: string;
  },
  opt: DedupeOptions,
): RawDuplicate | null {
  const exact = db
    .prepare(
      `SELECT id FROM raw_items WHERE content_hash = ? AND id < ? AND posted_at >= ?
       ORDER BY id LIMIT 1`,
    )
    .pluck()
    .get(item.content_hash, item.id, daysBefore(item.posted_at, opt.content_window_days));
  if (exact !== undefined) return { layer: 'L1', duplicateOf: Number(exact) };

  if (item.simhash === null || !item.text) return null;
  const candidates = db
    .prepare(
      `SELECT id, simhash, text FROM raw_items
       WHERE simhash IS NOT NULL AND id < ? AND posted_at >= ? ORDER BY id`,
    )
    .all(item.id, daysBefore(item.posted_at, opt.near_dup_window_days)) as {
    id: number;
    simhash: string;
    text: string | null;
  }[];
  for (const c of candidates) {
    const distance = hammingDistance(item.simhash, c.simhash);
    if (distance > opt.simhash_max_distance) continue;
    const similarity = tokenSetSimilarity(item.text, c.text ?? '');
    if (similarity >= opt.near_dup_similarity) {
      return { layer: 'L2', duplicateOf: c.id, distance, similarity };
    }
  }
  return null;
}

// ------------------------------------------------------------------------ jobs (L3)

export interface JobIdentity {
  title: string;
  company?: string | null;
  apply_email?: string | null;
  apply_url?: string | null;
}

/** Lowercase email, else canonical URL, else null. */
export function applyTarget(job: JobIdentity): string | null {
  if (job.apply_email) return job.apply_email.trim().toLowerCase();
  if (job.apply_url) return canonicalizeUrl(job.apply_url);
  return null;
}

/** `sha256(company_norm | canonical_title | apply_target)` (PLAN 7, L3). */
export function jobFingerprint(job: JobIdentity): string {
  const company = normalizeCompany(job.company) ?? '';
  return sha256(`${company}|${canonicalTitle(job.title)}|${applyTarget(job) ?? ''}`);
}

export interface JobDuplicate {
  duplicateOf: number;
  reason: 'fingerprint' | 'same_target_similar_title' | 'same_company_similar_title';
  similarity?: number;
}

/**
 * L3. A job is the same job when, within the window and against originals only:
 *  1. the fingerprint matches exactly, or
 *  2. the apply target (email/URL) matches and canonical titles are similar, or
 *  3. a known company matches and canonical titles are similar (WhatsApp vs LinkedIn).
 * Different roles from the same recruiter differ in title, so they are NOT merged.
 */
export function findJobDuplicate(
  db: Db,
  job: JobIdentity & { id?: number; created_at: string },
  opt: DedupeOptions,
): JobDuplicate | null {
  const since = daysBefore(job.created_at, opt.content_window_days);
  const selfId = job.id ?? -1;

  const exact = db
    .prepare(
      `SELECT id FROM jobs WHERE fingerprint = ? AND duplicate_of IS NULL AND id <> ?
       AND created_at >= ? ORDER BY id LIMIT 1`,
    )
    .pluck()
    .get(jobFingerprint(job), selfId, since);
  if (exact !== undefined) return { duplicateOf: Number(exact), reason: 'fingerprint' };

  const title = canonicalTitle(job.title);
  const target = applyTarget(job);
  const company = normalizeCompany(job.company);
  const rows = db
    .prepare(
      `SELECT id, title, company_norm, apply_email, apply_url FROM jobs
       WHERE duplicate_of IS NULL AND id <> ? AND created_at >= ? ORDER BY id`,
    )
    .all(selfId, since) as {
    id: number;
    title: string;
    company_norm: string | null;
    apply_email: string | null;
    apply_url: string | null;
  }[];

  for (const r of rows) {
    const similarity = diceSimilarity(title, canonicalTitle(r.title));
    if (similarity < opt.title_similarity) continue;
    if (target !== null && target === applyTarget(r)) {
      return { duplicateOf: r.id, reason: 'same_target_similar_title', similarity };
    }
    if (company !== null && company === r.company_norm) {
      return { duplicateOf: r.id, reason: 'same_company_similar_title', similarity };
    }
  }
  return null;
}
