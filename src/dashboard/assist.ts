// "Open to apply" from the dashboard (D43, D46): opens one job in the user's own browser, with
// the cover letter on the clipboard. The add-on (D49) fills the form or the WhatsApp message;
// the user submits or sends, then presses "Mark applied".
import { openInOwnBrowser } from '../apply/own-browser.js';
import { waNumber } from '../apply/wa-message.js';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { toClipboard } from '../util/clipboard.js';

export interface AssistResult {
  job_id: number;
  url: string;
  copied: boolean;
}

export class AssistSession {
  private last: number | null = null;
  private lastAt = 0;

  constructor(
    private readonly cfg: () => Config,
    private readonly db: Db,
  ) {}

  /** The job opened in the last `minutes`, or null: the one the add-on is clicked for. */
  recent(minutes: number): number | null {
    return Date.now() - this.lastAt < minutes * 60_000 ? this.last : null;
  }

  async open(jobId: number): Promise<AssistResult> {
    const r = this.db
      .prepare(
        `SELECT j.apply_url, j.apply_url_direct, j.apply_channel, j.apply_phone, a.cover_text
         FROM jobs j JOIN applications a ON a.job_id = j.id WHERE j.id = ?`,
      )
      .get(jobId) as
      | {
          apply_url: string | null;
          apply_url_direct: string | null;
          apply_channel: string;
          apply_phone: string | null;
          cover_text: string | null;
        }
      | undefined;
    if (!r) throw new Error('no prepared application for this job');
    const phone = r.apply_channel === 'whatsapp_dm' ? waNumber(r.apply_phone) : null;
    // Only the number: the message and CV are put in by the add-on (D51).
    const url = phone
      ? `https://web.whatsapp.com/send?phone=${phone}`
      : (r.apply_url_direct ?? r.apply_url);
    if (!url) throw new Error('this job has no link: see its package');
    if (process.platform === 'linux' && !process.env['DISPLAY'] && !process.env['WAYLAND_DISPLAY'])
      throw new Error('no desktop here: start the dashboard with ./agent.sh dashboard on the desktop');
    if (!(await openInOwnBrowser(url, this.cfg().forms.browser)))
      throw new Error(`the browser did not start (forms.browser): open it yourself: ${url}`);
    this.last = jobId;
    this.lastAt = Date.now();
    return { job_id: jobId, url, copied: r.cover_text ? toClipboard(r.cover_text) : false };
  }
}
