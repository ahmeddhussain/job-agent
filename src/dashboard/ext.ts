// The Brave/Chrome add-on's side of the dashboard (D49, extension/). The user clicks the
// add-on on a company's form; it sends the empty fields' labels, this answers them from the
// profile, and the add-on types them. It never submits, and only the add-on can ask.
import { readFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { z } from 'zod';
import {
  answerFields,
  formEligible,
  standardAnswer,
  type Answer,
  type FormField,
} from '../apply/forms.js';
import { learn, learnedAnswers } from '../apply/learned.js';
import { normQuestion, recordQuestions } from '../apply/questions.js';
import { waMessage, waNumber } from '../apply/wa-message.js';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import type { Llm } from '../llm/types.js';
import { loadProfile } from '../profile/load.js';
import { letterPdf } from '../render/letter.js';
import { sourceLabel } from '../run/orchestrator.js';

/** Fixed by "key" in extension/manifest.json, so no other add-on or website can ask. */
export const EXTENSION_ORIGIN = 'chrome-extension://ofihpecmefkkmjilnpdpifcpmmjdoaha';

export const ExtJobsBody = z.strictObject({ url: z.string().max(4000) });
export const ExtAnswerBody = z.strictObject({
  job_id: z.number().int().positive(),
  url: z.string().max(4000),
  fields: z
    .array(
      z.strictObject({
        id: z.string().regex(/^[a-z]\d{1,4}$/),
        kind: z.enum(['text', 'textarea', 'select', 'file', 'radio']),
        inputType: z.string().max(30),
        name: z.string().max(200),
        label: z.string().max(400),
        required: z.boolean(),
        options: z
          .array(z.strictObject({ id: z.string().max(200), label: z.string().max(200) }))
          .max(80)
          .optional(),
      }),
    )
    .max(80),
});
export type ExtAnswerRequest = z.infer<typeof ExtAnswerBody>;

export const ExtWhatsAppBody = z.strictObject({ job_id: z.number().int().positive() });
export const ExtLearnBody = z.strictObject({
  job_id: z.number().int().positive(),
  url: z.string().max(4000),
  items: z
    .array(
      z.strictObject({
        label: z.string().max(400),
        name: z.string().max(200),
        kind: z.enum(['text', 'select', 'radio']),
        inputType: z.string().max(30),
        value: z.string().max(400),
        source: z.enum(['typed', 'kept']),
      }),
    )
    .max(80),
});

export interface ExtFile {
  name: string;
  base64: string;
}

export interface ExtAnswers {
  answers: Record<string, { value: string | null; options: string[] }>;
  /** Field id → the file to attach. */
  files: Record<string, ExtFile>;
  /** Labels of required fields left for the user. */
  left: string[];
}

interface JobRow {
  id: number;
  raw_item_id: number;
  title: string;
  company: string | null;
  apply_url: string | null;
  apply_url_direct: string | null;
  apply_channel: string;
  apply_phone: string | null;
}

/** An https page on a public host that isn't a job board, or null. */
export function companyForm(raw: string, cfg: Config): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  const local =
    !u.hostname.includes('.') ||
    /^[\d.]+$/.test(u.hostname) ||
    /\.(local|internal|localhost)$/.test(u.hostname);
  if (local || u.username || u.port || u.href.length > 2000 || !formEligible(u.href, cfg))
    return null;
  return u.href;
}

const isWhatsApp = (u: string): boolean => host(u) === 'web.whatsapp.com';

// Agreements, human checks and sign-in details are the user's own to give.
const NEVER =
  /captcha|not a robot|verify you|password|login|log in|user\s*name|\bi (agree|accept|consent)\b|terms|privacy|consent|gdpr/i;

const page = (u: string): string => {
  try {
    const x = new URL(u);
    return `${x.hostname}${x.pathname.replace(/\/+$/, '')}`;
  } catch {
    return '';
  }
};
const host = (u: string): string => page(u).split('/')[0] ?? '';

export class ExtSession {
  /** The job last filled on each host: the next step of the same form. */
  private readonly lastOn = new Map<string, number>();

  constructor(
    private readonly cfg: () => Config,
    private readonly db: Db,
    private readonly llm: () => Llm,
    /** The job opened from the dashboard a moment ago. */
    private readonly recent: () => number | null,
    private readonly allowed: (url: string, cfg: Config) => boolean = (u, c) =>
      companyForm(u, c) !== null,
  ) {}

  private ready(): JobRow[] {
    return this.db
      .prepare(
        `SELECT j.id, j.raw_item_id, j.title, j.company, j.apply_url, j.apply_url_direct,
           j.apply_channel, j.apply_phone
         FROM jobs j JOIN applications a ON a.job_id = j.id
         WHERE j.status = 'ready' AND a.mode IN ('manual', 'package') AND a.cv_pdf IS NOT NULL
         ORDER BY j.priority, j.fit_score DESC`,
      )
      .all() as JobRow[];
  }

  /** The jobs to choose from, and the one this page is for when that is clear. */
  jobs(url: string): {
    jobs: { id: number; title: string; company: string | null }[];
    job_id: number | null;
    refused: string | null;
    whatsapp: boolean;
  } {
    if (isWhatsApp(url)) {
      const rows = this.ready().filter(
        (r) => r.apply_channel === 'whatsapp_dm' && waNumber(r.apply_phone),
      );
      const last = this.recent();
      return {
        jobs: rows.map(({ id, title, company }) => ({ id, title, company })),
        job_id: rows.some((r) => r.id === last) ? last : null,
        refused: null,
        whatsapp: true,
      };
    }
    const refused = this.allowed(url, this.cfg())
      ? null
      : 'This page is a job board or not a public https page. Use it on the company’s own form.';
    const rows = this.ready();
    const here = page(url);
    const byUrl = rows.filter((r) =>
      [r.apply_url_direct, r.apply_url].some((u) => u !== null && page(u) === here),
    );
    const ids = new Set(rows.map((r) => r.id));
    const guess = [
      byUrl.length === 1 ? byUrl[0]?.id : undefined,
      this.lastOn.get(host(url)),
      this.recent() ?? undefined,
    ].find((id) => id !== undefined && ids.has(id));
    return {
      jobs: rows.map(({ id, title, company }) => ({ id, title, company })),
      job_id: guess ?? null,
      refused,
      whatsapp: false,
    };
  }

  /** The message and CV for a WhatsApp application; the user presses Send (D51). */
  whatsapp(jobId: number): { phone: string; text: string; file: ExtFile } {
    const job = this.ready().find((r) => r.id === jobId && r.apply_channel === 'whatsapp_dm');
    const phone = job ? waNumber(job.apply_phone) : null;
    if (!job || !phone) throw new Error('not a WhatsApp job waiting for you to apply');
    const a = this.db
      .prepare('SELECT cv_pdf, cover_text FROM applications WHERE job_id = ?')
      .get(job.id) as { cv_pdf: string; cover_text: string | null };
    return {
      phone,
      text: waMessage(a.cover_text ?? ''),
      file: { name: basename(a.cv_pdf), base64: readFileSync(a.cv_pdf).toString('base64') },
    };
  }

  /** Keeps what the user typed or left on a form they went on with (D50). */
  learn(req: z.infer<typeof ExtLearnBody>): { learned: string[] } {
    if (!this.allowed(req.url, this.cfg())) throw new Error('not a company form');
    const job = this.db
      .prepare('SELECT id, company FROM jobs WHERE id = ?')
      .get(req.job_id) as { id: number; company: string | null } | undefined;
    if (!job) throw new Error('no such job');
    const profile = loadProfile(this.cfg().paths.profile);
    const docs = { dir: '', cvPath: '', coverText: '', whyThisRole: '' };
    const items = req.items.filter(
      (i) =>
        i.source === 'typed' ||
        // What the profile answers anyway isn't worth keeping twice.
        standardAnswer({ ...i, id: 'x', required: false }, profile, docs) === null,
    );
    return { learned: learn(this.db, items, job, new Date().toISOString()) };
  }

  async answer(req: ExtAnswerRequest): Promise<ExtAnswers> {
    const cfg = this.cfg();
    if (!this.allowed(req.url, cfg)) throw new Error('not a company form');
    const job = this.ready().find((r) => r.id === req.job_id);
    if (!job) throw new Error('that job is not waiting for you to apply');
    const a = this.db
      .prepare('SELECT cv_pdf, cover_text, why_this_role FROM applications WHERE job_id = ?')
      .get(job.id) as { cv_pdf: string; cover_text: string | null; why_this_role: string | null };
    const profile = loadProfile(cfg.paths.profile);
    const coverText = a.cover_text ?? '';

    const files: Record<string, ExtFile> = {};
    const read = (path: string): ExtFile => ({
      name: basename(path),
      base64: readFileSync(path).toString('base64'),
    });
    const uploads = req.fields.filter((f) => f.kind === 'file');
    const cover = (f: { label: string; name: string }) =>
      /cover|motivation|خطاب/i.test(`${f.label} ${f.name}`);
    const cvField =
      uploads.find((f) => /resume|\bcv\b|curriculum|سيرة/i.test(`${f.label} ${f.name}`)) ??
      (uploads.filter((f) => !cover(f)).length === 1 ? uploads.find((f) => !cover(f)) : undefined);
    if (cvField) files[cvField.id] = read(a.cv_pdf);
    const coverField = uploads.find((f) => f !== cvField && cover(f));
    if (coverField && coverText)
      files[coverField.id] = read(await letterPdf(profile, coverText, dirname(a.cv_pdf)));

    const fields = req.fields.filter(
      (f) => f.kind !== 'file' && !NEVER.test(`${f.label} ${f.name}`),
    ) as FormField[];
    // What the user answered before comes first; the model sees it too, for other wordings.
    const learned = learnedAnswers(this.db);
    const byQuestion = new Map(learned.map((x) => [x.question_norm, x.value]));
    const found = new Map<string, Answer>();
    for (const f of fields) {
      const v = byQuestion.get(normQuestion(f.label));
      if (v === undefined) continue;
      if (!f.options) found.set(f.id, { value: v, options: [], source: 'learned' });
      else {
        const o = f.options.find((x) => x.label.trim().toLowerCase() === v.trim().toLowerCase());
        if (o) found.set(f.id, { value: null, options: [o.id], source: 'learned' });
      }
    }
    const withLearned = {
      ...profile,
      application_answers: {
        ...Object.fromEntries(learned.slice(0, 60).map((x) => [x.question, x.value])),
        ...profile.application_answers,
      },
    };
    const rest = await answerFields(
      { cfg, profile: withLearned, llm: this.llm() },
      fields.filter((f) => !found.has(f.id)),
      {
        id: job.id,
        title: job.title,
        company: job.company,
        source: sourceLabel(this.db, job.raw_item_id),
      },
      { dir: dirname(a.cv_pdf), cvPath: a.cv_pdf, coverText, whyThisRole: a.why_this_role ?? '' },
    );
    for (const [id, v] of rest) found.set(id, v);
    // A monthly figure is no answer to a yearly question (and the other way round).
    for (const f of fields) {
      const v = found.get(f.id)?.value ?? '';
      const yearly = /annual|year/i.test(f.label);
      if (/salary|compensation|pay\b/i.test(f.label))
        if (yearly ? /month/i.test(v) : /month/i.test(f.label) && /year|annual/i.test(v))
          found.delete(f.id);
    }
    const missing = fields.filter((f) => f.required && !found.has(f.id)).map((f) => f.label);
    recordQuestions(this.db, missing, job.id, new Date().toISOString());
    this.lastOn.set(host(req.url), job.id);
    // Reopen then goes straight to the company's form (never replacing a link already known).
    this.db
      .prepare(
        `UPDATE jobs SET apply_url_direct = ? WHERE id = ? AND apply_url_direct IS NULL
           AND id IN (SELECT job_id FROM applications WHERE form_report IS NULL)`,
      )
      .run(
        formEligible(job.apply_url, cfg) ? null : companyForm(req.url, cfg),
        job.id,
      );
    return {
      answers: Object.fromEntries(
        [...found].map(([id, v]) => [id, { value: v.value, options: v.options }]),
      ),
      files,
      left: [
        ...missing,
        ...uploads.filter((f) => f.required && !files[f.id]).map((f) => f.label),
        ...req.fields
          .filter((f) => f.required && f.kind !== 'file' && NEVER.test(`${f.label} ${f.name}`))
          .map((f) => f.label),
      ],
    };
  }
}
