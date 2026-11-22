// `agent send-drafts` (D33): after Ahmed has reviewed the drafts in Gmail, one command
// sends every one still waiting. Gmail sends the draft as it is now, so his edits are
// kept; a draft he deleted is skipped. The list is shown and confirmed once first.
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { updateJobStatus } from '../db/jobs.js';
import type { GmailWriter } from '../gmail/client.js';

export interface WaitingDraft {
  jobId: number;
  draftId: string;
  to: string | null;
  title: string;
  company: string | null;
}

export function waitingDrafts(db: Db): WaitingDraft[] {
  return db
    .prepare(
      `SELECT a.job_id AS jobId, a.gmail_draft_id AS draftId, a.to_email AS "to", j.title, j.company
       FROM applications a JOIN jobs j ON j.id = a.job_id
       WHERE a.channel = 'email' AND a.gmail_draft_id IS NOT NULL AND a.sent_at IS NULL
         AND j.status = 'ready'
       ORDER BY j.priority, j.fit_score DESC`,
    )
    .all() as WaitingDraft[];
}

export async function sendReviewedDrafts(d: {
  db: Db;
  gmail: GmailWriter;
  cfg: Config;
  out: (line: string) => void;
  confirm: (drafts: WaitingDraft[]) => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
}): Promise<{ sent: number; missing: number }> {
  const all = waitingDrafts(d.db);
  const live: WaitingDraft[] = [];
  let missing = 0;
  for (const w of all) {
    if (await d.gmail.draftExists(w.draftId)) live.push(w);
    else missing++; // deleted, or already sent by hand (the next sync marks those)
  }
  if (live.length === 0) {
    d.out(`no drafts waiting${missing ? ` (${String(missing)} no longer in Gmail Drafts)` : ''}`);
    return { sent: 0, missing };
  }
  if (!(await d.confirm(live))) {
    d.out('nothing sent');
    return { sent: 0, missing };
  }
  const sleep = d.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  let sent = 0;
  for (const [i, w] of live.entries()) {
    if (i > 0) await sleep(d.cfg.apply.send_all_interval_seconds * 1000);
    try {
      const r = await d.gmail.sendDraft(w.draftId);
      const at = new Date().toISOString();
      d.db.transaction(() => {
        d.db
          .prepare(
            'UPDATE applications SET sent_at = ?, gmail_message_id = ?, gmail_thread_id = ? WHERE job_id = ?',
          )
          .run(at, r.messageId, r.threadId, w.jobId);
        updateJobStatus(d.db, w.jobId, 'applied', 'ahmed', at);
      })();
      sent++;
      d.out(
        `sent ${String(i + 1)}/${String(live.length)}: ${w.title}${w.company ? ` · ${w.company}` : ''} → ${w.to ?? ''}`,
      );
    } catch (err) {
      d.out(
        `FAILED ${w.title}: ${err instanceof Error ? err.message : String(err)} (left as a draft)`,
      );
    }
  }
  return { sent, missing };
}
