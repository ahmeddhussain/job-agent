// "Open pre-filled" from the dashboard (D43): the same assisted browser as `agent assist`
// (visible Chrome, persistent profile data/browser-profile where Ahmed is signed in to
// LinkedIn), one job at a time. Company forms are filled, never submitted; other pages
// (Easy Apply, job boards) open on the job with the cover letter on the clipboard. Ahmed
// submits, then presses "Mark applied" in the dashboard.
import { mkdirSync } from 'node:fs';
import type { Page } from 'puppeteer';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { formEligible, FormFiller } from '../apply/forms.js';
import type { Llm } from '../llm/types.js';
import { loadProfile } from '../profile/load.js';
import { sourceLabel } from '../run/orchestrator.js';
import { toClipboard } from '../util/clipboard.js';
import { logger } from '../util/logger.js';

export interface AssistResult {
  job_id: number;
  url: string;
  mode: 'form' | 'page';
  filled: number;
  unanswered: string[];
  copied: boolean;
  cv: string | null;
}

export class AssistSession {
  private filler: FormFiller | null = null;
  private page: Page | null = null;

  constructor(
    private readonly cfg: () => Config,
    private readonly db: Db,
    private readonly llm: () => Llm,
  ) {}

  async open(jobId: number): Promise<AssistResult> {
    if (!process.env['DISPLAY'] && !process.env['WAYLAND_DISPLAY'])
      throw new Error('no desktop here: start the dashboard with ./agent.sh dashboard on the VM desktop');
    const r = this.db
      .prepare(
        `SELECT j.id, j.raw_item_id, j.title, j.company, j.apply_url, j.apply_url_direct,
           a.package_dir, a.cv_pdf, a.cover_text, a.why_this_role
         FROM jobs j JOIN applications a ON a.job_id = j.id WHERE j.id = ?`,
      )
      .get(jobId) as
      | {
          id: number;
          raw_item_id: number;
          title: string;
          company: string | null;
          apply_url: string | null;
          apply_url_direct: string | null;
          package_dir: string | null;
          cv_pdf: string | null;
          cover_text: string | null;
          why_this_role: string | null;
        }
      | undefined;
    if (!r) throw new Error('no prepared application for this job');
    const url = r.apply_url_direct ?? r.apply_url;
    if (!url) throw new Error('this job has no link: see its package');
    const cfg = this.cfg();
    if (!this.filler) {
      mkdirSync(cfg.forms.browser_profile, { recursive: true, mode: 0o700 });
      this.filler = new FormFiller({
        cfg,
        profile: loadProfile(cfg.paths.profile),
        llm: this.llm(),
        log: logger,
        headless: false,
        userDataDir: cfg.forms.browser_profile,
      });
    }
    await this.page?.close().catch(() => undefined);
    this.page = null;
    const copied = r.cover_text ? toClipboard(r.cover_text) : false;
    if (formEligible(url, cfg) && r.package_dir && r.cv_pdf) {
      const res = await this.filler.run(
        { id: r.id, title: r.title, company: r.company, source: sourceLabel(this.db, r.raw_item_id) },
        url,
        {
          dir: r.package_dir,
          cvPath: r.cv_pdf,
          coverText: r.cover_text ?? '',
          whyThisRole: r.why_this_role ?? '',
        },
        { submit: false },
      );
      this.page = res.page;
      await this.page.bringToFront();
      return { job_id: r.id, url, mode: 'form', filled: res.filled.length, unanswered: res.unanswered, copied, cv: r.cv_pdf };
    }
    this.page = await this.filler.page();
    await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await this.page.bringToFront();
    return { job_id: r.id, url, mode: 'page', filled: 0, unanswered: [], copied, cv: r.cv_pdf };
  }

  async close(): Promise<void> {
    await this.filler?.close();
    this.filler = null;
    this.page = null;
  }
}
