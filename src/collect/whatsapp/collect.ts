// collect:whatsapp (PLAN 5.1): reads allowlisted groups since each group's watermark and
// stores text posts as raw items. Read-only by construction: it only sees a WhatsAppReader.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Logger } from 'pino';
import type { Config } from '../../config.js';
import type { Db } from '../../db/index.js';
import { insertRawItem, prepareRawItem } from '../../pipeline/dedupe.js';
import { sha256 } from '../../util/hash.js';
import { findEmails, findUrls } from '../../util/url.js';
import type { WaChat, WaMessage, WhatsAppReader } from './readonly.js';

/** Text-bearing message types; media is never downloaded, only its caption is read (R3). */
const TEXT_TYPES = new Set(['chat', 'image', 'video', 'document']);

/** Salt for hashing other members' ids (PLAN 12): created once, owner-only, never committed. */
export function loadOrCreateSalt(path: string): string {
  if (existsSync(path)) return readFileSync(path, 'utf8').trim();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const salt = randomBytes(32).toString('hex');
  writeFileSync(path, `${salt}\n`, { mode: 0o600 });
  return salt;
}

export function hashAuthor(author: string | null, salt: string): string | null {
  return author ? sha256(`${salt}:${author}`).slice(0, 24) : null;
}

/** Cheap pre-filter before any model call (PLAN 5.1 step 5). */
export function worthKeeping(body: string, minChars: number): boolean {
  const text = body.trim();
  if (text === '') return false;
  if (text.length >= minChars) return true;
  return findEmails(text).length > 0 || findUrls(text).length > 0;
}

export function allowlisted(
  chats: WaChat[],
  allow: string[],
): { chosen: WaChat[]; missing: string[] } {
  const wanted = allow.map((a) => a.trim().toLowerCase());
  const chosen = chats.filter(
    (c) =>
      c.isGroup &&
      (wanted.includes(c.id.toLowerCase()) || wanted.includes(c.name.trim().toLowerCase())),
  );
  const missing = allow.filter(
    (a) =>
      !chosen.some(
        (c) =>
          c.id.toLowerCase() === a.trim().toLowerCase() ||
          c.name.trim().toLowerCase() === a.trim().toLowerCase(),
      ),
  );
  return { chosen, missing };
}

export interface GroupResult {
  id: string;
  name: string;
  since: string;
  fetched: number;
  inWindow: number;
  kept: number;
  inserted: number;
  limitHit: boolean;
  /** Date range of what WhatsApp returned (ISO), to tell a quiet group from a bug. */
  oldest: string | null;
  newest: string | null;
}

export interface CollectResult {
  groups: GroupResult[];
  inserted: number;
  warnings: string[];
}

export interface CollectOptions {
  wa: WhatsAppReader;
  db: Db;
  cfg: Config;
  now: Date;
  salt: string;
  log: Logger;
  /** Overrides every watermark (`--since`). */
  since?: Date;
  /** Count only: no rows, no watermark changes. */
  dryRun?: boolean;
  runId?: number | null;
}

const watermarkKey = (groupId: string) => `whatsapp:${groupId}`;

/** Messages may be a little ahead of a correct clock (their servers vs ours); hours are not. */
const CLOCK_TOLERANCE_MS = 10 * 60_000;

export class ClockSkewError extends Error {
  override name = 'ClockSkewError';
}

function windowStart(db: Db, cfg: Config, groupId: string, now: Date, override?: Date): Date {
  if (override) return override;
  const row = db
    .prepare('SELECT last_success_at FROM source_state WHERE source = ?')
    .pluck()
    .get(watermarkKey(groupId));
  if (typeof row === 'string') return new Date(Date.parse(row) - cfg.run.overlap_minutes * 60_000);
  return new Date(now.getTime() - cfg.run.first_run_lookback_hours * 3_600_000);
}

/**
 * Collects new text posts. A group's watermark advances only after its rows are
 * committed (same transaction), so a crash re-reads the window next time and dedupe
 * L0 makes the overlap free (D26).
 */
export async function collectWhatsApp(o: CollectOptions): Promise<CollectResult> {
  const { cfg, db } = o;
  const warnings: string[] = [];
  const { chosen, missing } = allowlisted(await o.wa.getChats(), cfg.whatsapp.groups);
  for (const m of missing)
    warnings.push(`allowlisted group not found: "${m}" (check the name with: agent wa:groups)`);
  if (cfg.whatsapp.groups.length === 0)
    warnings.push('whatsapp.groups is empty: nothing to collect (run: agent wa:groups)');

  const groups: GroupResult[] = [];
  // Fetch first, check the clock, then write: a clock that is behind makes every new post
  // look like it's from the future, and the window silently drops all of them
  // (troubleshooting #15).
  const fetched = new Map<string, WaMessage[]>();
  for (const chat of chosen)
    fetched.set(chat.id, await o.wa.fetchMessages(chat.id, cfg.whatsapp.fetch_limit));
  const newest = Math.max(0, ...[...fetched.values()].flat().map((m) => m.timestamp)) * 1000;
  const skewMs = newest - o.now.getTime();
  if (skewMs > CLOCK_TOLERANCE_MS) {
    throw new ClockSkewError(
      `system clock is about ${(skewMs / 3_600_000).toFixed(1)} h behind (newest WhatsApp message is dated ${new Date(newest).toISOString()}, clock says ${o.now.toISOString()}). Nothing was collected. Fix the clock: sudo chronyc makestep`,
    );
  }
  for (const chat of chosen) {
    const since = windowStart(db, cfg, chat.id, o.now, o.since);
    const msgs: WaMessage[] = fetched.get(chat.id) ?? [];
    const inWindow = msgs.filter(
      (m) => m.timestamp * 1000 >= since.getTime() && m.timestamp * 1000 <= o.now.getTime(),
    );
    const kept = inWindow.filter(
      (m) =>
        !m.fromMe && TEXT_TYPES.has(m.type) && worthKeeping(m.body, cfg.whatsapp.min_text_chars),
    );
    const oldest = msgs.reduce((min, m) => Math.min(min, m.timestamp), Number.POSITIVE_INFINITY);
    const limitHit = msgs.length >= cfg.whatsapp.fetch_limit && oldest * 1000 >= since.getTime();
    if (limitHit) {
      warnings.push(
        `"${chat.name}": all ${String(msgs.length)} fetched messages are inside the window; raise whatsapp.fetch_limit to avoid missing older posts`,
      );
    }

    let inserted = 0;
    if (!o.dryRun) {
      const collectedAt = o.now.toISOString();
      db.transaction(() => {
        for (const m of kept) {
          const item = prepareRawItem({
            source: 'whatsapp',
            source_ref: m.id,
            source_name: chat.name,
            author: hashAuthor(m.author, o.salt),
            posted_at: new Date(m.timestamp * 1000).toISOString(),
            text: m.body,
            run_id: o.runId ?? null,
          });
          if (insertRawItem(db, item, collectedAt).inserted) inserted++;
        }
        db.prepare(
          `INSERT INTO source_state (source, last_success_at) VALUES (?, ?)
           ON CONFLICT (source) DO UPDATE SET last_success_at = excluded.last_success_at`,
        ).run(watermarkKey(chat.id), o.now.toISOString());
      })();
    }
    groups.push({
      id: chat.id,
      name: chat.name,
      since: since.toISOString(),
      fetched: msgs.length,
      inWindow: inWindow.length,
      kept: kept.length,
      inserted,
      limitHit,
      oldest: msgs.length
        ? new Date(Math.min(...msgs.map((x) => x.timestamp)) * 1000).toISOString()
        : null,
      newest: msgs.length
        ? new Date(Math.max(...msgs.map((x) => x.timestamp)) * 1000).toISOString()
        : null,
    });
    o.log.info(
      { group: chat.name, fetched: msgs.length, kept: kept.length, inserted },
      'whatsapp group collected',
    );
  }
  return { groups, inserted: groups.reduce((a, g) => a + g.inserted, 0), warnings };
}
