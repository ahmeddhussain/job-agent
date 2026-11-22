// sync:gmail (PLAN 5.8): runs before each collection. A draft that no longer exists and
// whose thread now has a SENT message means Ahmed sent it → applied. A newer message in
// an applied thread that isn't from him → has_reply (status changes stay his).
import type { Db } from '../db/index.js';
import type { GmailWriter } from './client.js';

export async function syncGmail(
  db: Db,
  gmail: GmailWriter,
  now: Date,
): Promise<{ sent: number; replies: number }> {
  const me = await gmail.myAddress();
  let sent = 0;
  let replies = 0;

  const pending = db
    .prepare(
      `SELECT a.id, a.job_id, a.gmail_draft_id, a.gmail_thread_id FROM applications a
       WHERE a.gmail_draft_id IS NOT NULL AND a.sent_at IS NULL`,
    )
    .all() as {
    id: number;
    job_id: number;
    gmail_draft_id: string;
    gmail_thread_id: string | null;
  }[];
  for (const a of pending) {
    if (await gmail.draftExists(a.gmail_draft_id)) continue;
    if (!a.gmail_thread_id) continue;
    const msgs = await gmail.threadMessages(a.gmail_thread_id);
    const sentMsg = msgs.find((m) => m.labelIds.includes('SENT'));
    if (!sentMsg) continue; // deleted, not sent
    db.transaction(() => {
      db.prepare('UPDATE applications SET sent_at = ?, gmail_message_id = ? WHERE id = ?').run(
        sentMsg.internalDate,
        sentMsg.id,
        a.id,
      );
      const from = db.prepare('SELECT status FROM jobs WHERE id = ?').pluck().get(a.job_id) as
        string | undefined;
      db.prepare("UPDATE jobs SET status = 'applied', updated_at = ? WHERE id = ?").run(
        now.toISOString(),
        a.job_id,
      );
      db.prepare(
        `INSERT INTO status_history (job_id, from_status, to_status, by, at) VALUES (?, ?, 'applied', 'sync', ?)`,
      ).run(a.job_id, from ?? null, now.toISOString());
    })();
    sent++;
  }

  const applied = db
    .prepare(
      `SELECT a.job_id, a.gmail_thread_id, a.sent_at FROM applications a JOIN jobs j ON j.id = a.job_id
       WHERE a.sent_at IS NOT NULL AND a.gmail_thread_id IS NOT NULL AND j.has_reply = 0`,
    )
    .all() as { job_id: number; gmail_thread_id: string; sent_at: string }[];
  for (const a of applied) {
    const msgs = await gmail.threadMessages(a.gmail_thread_id);
    const reply = msgs.find(
      (m) => m.internalDate > a.sent_at && !m.from.toLowerCase().includes(me),
    );
    if (reply) {
      db.prepare('UPDATE jobs SET has_reply = 1, updated_at = ? WHERE id = ?').run(
        now.toISOString(),
        a.job_id,
      );
      replies++;
    }
  }
  return { sent, replies };
}
