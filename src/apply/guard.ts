// Dedupe L4, the application guard (PLAN 7): runs immediately before every draft or send.
// Protects against re-applying, including to addresses Ahmed emailed by hand before the
// agent existed (Gmail Sent check).
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import type { GmailReader } from '../gmail/client.js';
import { canonicalTitle, diceSimilarity } from '../util/text.js';

export type GuardResult =
  | { ok: true }
  | {
      ok: false;
      status: 'skipped' | 'needs_review';
      reason: 'already_applied' | 'same_recruiter' | 'contacted_before';
      detail: string;
    };

const daysAgo = (now: Date, d: number) => new Date(now.getTime() - d * 86_400_000).toISOString();

export async function applicationGuard(
  db: Db,
  gmail: GmailReader | null,
  cfg: Config,
  app: { to: string; title: string; now: Date },
): Promise<GuardResult> {
  const to = app.to.trim().toLowerCase();
  const rows = db
    .prepare(
      `SELECT a.created_at, j.title FROM applications a JOIN jobs j ON j.id = a.job_id
       WHERE lower(a.to_email) = ? AND a.created_at >= ? ORDER BY a.created_at DESC`,
    )
    .all(to, daysAgo(app.now, cfg.dedupe.cooldown_days)) as { created_at: string; title: string }[];

  for (const r of rows) {
    if (
      diceSimilarity(canonicalTitle(r.title), canonicalTitle(app.title)) >=
      cfg.dedupe.title_similarity
    ) {
      return {
        ok: false,
        status: 'skipped',
        reason: 'already_applied',
        detail: `applied to "${r.title}" at ${to} on ${r.created_at.slice(0, 10)}`,
      };
    }
  }
  const recent = rows.find((r) => r.created_at >= daysAgo(app.now, cfg.dedupe.same_recruiter_days));
  if (recent) {
    return {
      ok: false,
      status: 'needs_review',
      reason: 'same_recruiter',
      detail: `${to} already got an application for "${recent.title}"; consider one combined email`,
    };
  }
  if (gmail && cfg.dedupe.check_gmail_sent) {
    const sent = await gmail.search(
      `in:sent to:${to} newer_than:${String(cfg.dedupe.cooldown_days)}d`,
      1,
    );
    if (sent.length > 0) {
      return {
        ok: false,
        status: 'needs_review',
        reason: 'contacted_before',
        detail: `you emailed ${to} in the last ${String(cfg.dedupe.cooldown_days)} days`,
      };
    }
  }
  return { ok: true };
}
