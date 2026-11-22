// collect:alerts (D4, PLAN 5.1): job-alert emails (LinkedIn, Wuzzuf, Bayt, Indeed) under
// the Gmail label `alerts.gmail_label`. Each email becomes one raw item; extraction later
// splits it into jobs. No scraping, no LinkedIn login.
import { convert } from 'html-to-text';
import type { Logger } from 'pino';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import type { GmailReader, MailSummary } from '../gmail/client.js';
import { insertRawItem, prepareRawItem } from '../pipeline/dedupe.js';

/** Email → text, keeping link targets "(https://…)" so apply links survive extraction. */
export function alertToText(m: MailSummary, maxChars: number): string {
  const body = m.html
    ? convert(m.html, {
        wordwrap: false,
        selectors: [
          { selector: 'a', options: { hideLinkIfSameAsText: true, linkBrackets: ['(', ')'] } },
          { selector: 'img', format: 'skip' },
          { selector: 'table', format: 'block' },
        ],
      })
    : (m.text ?? '');
  const text = `Subject: ${m.subject}\nFrom: ${m.from}\n\n${body}`
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n[truncated]` : text;
}

export interface AlertsResult {
  found: number;
  inserted: number;
  items: { id: string; subject: string; from: string; text: string; posted_at: string }[];
}

export async function collectAlerts(o: {
  gmail: GmailReader;
  db: Db;
  cfg: Config;
  now: Date;
  log: Logger;
  since?: Date;
  dryRun?: boolean;
  runId?: number | null;
}): Promise<AlertsResult> {
  const { cfg, db } = o;
  const key = 'alerts';
  const row = db
    .prepare('SELECT last_success_at FROM source_state WHERE source = ?')
    .pluck()
    .get(key);
  const since =
    o.since ??
    (typeof row === 'string'
      ? new Date(Date.parse(row) - cfg.run.overlap_minutes * 60_000)
      : new Date(o.now.getTime() - cfg.run.first_run_lookback_hours * 3_600_000));
  // Gmail's after: takes epoch seconds; the label name is config data, quoted.
  const q = `label:"${cfg.alerts.gmail_label.replace(/"/g, '')}" after:${String(Math.floor(since.getTime() / 1000))}`;
  const ids = await o.gmail.search(q, 200);
  const items: AlertsResult['items'] = [];
  for (const id of ids) {
    const m = await o.gmail.getMessage(id);
    items.push({
      id,
      subject: m.subject,
      from: m.from,
      text: alertToText(m, cfg.gmail.max_alert_chars),
      posted_at: m.internalDate,
    });
  }
  let inserted = 0;
  if (!o.dryRun) {
    db.transaction(() => {
      for (const it of items) {
        const item = prepareRawItem({
          source: 'alert_email',
          source_ref: it.id,
          source_name: it.from,
          posted_at: it.posted_at,
          text: it.text,
          run_id: o.runId ?? null,
        });
        if (insertRawItem(db, item, o.now.toISOString()).inserted) inserted++;
      }
      db.prepare(
        `INSERT INTO source_state (source, last_success_at) VALUES (?, ?)
         ON CONFLICT (source) DO UPDATE SET last_success_at = excluded.last_success_at`,
      ).run(key, o.now.toISOString());
    })();
  }
  o.log.info({ query: q, found: items.length, inserted }, 'alerts collected');
  return { found: items.length, inserted, items };
}
