// D33 without the network: the form filler on local pages shaped like the real ones
// (Lever-style labels, a captcha-protected form, a two-page Google-Forms-style form),
// answer validation, the apply-step fallbacks, and sending reviewed drafts.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { applyJob } from '../../src/apply/apply.js';
import {
  formEligible,
  FormFiller,
  standardAnswer,
  validAnswer,
  type FormField,
} from '../../src/apply/forms.js';
import type { Prepared } from '../../src/apply/prepare.js';
import { sendReviewedDrafts } from '../../src/apply/send.js';
import { parseConfig, type Config } from '../../src/config.js';
import { migrate, openDb, type Db } from '../../src/db/index.js';
import type { JobRow } from '../../src/db/jobs.js';
import type { GmailWriter } from '../../src/gmail/client.js';
import type { Llm, LlmRequest } from '../../src/llm/types.js';
import { loadProfile } from '../../src/profile/load.js';

const raw = parse(readFileSync('config/config.example.yaml', 'utf8')) as Record<
  string,
  Record<string, unknown>
>;
raw['digest'] = { ...raw['digest'], to: 'me@example.com' };
const cfg: Config = parseConfig(raw);
const profile = loadProfile('profile/master_profile.example.yaml');
const log = pino({ level: 'silent' });
let dir: string;
let cv: string;

const docs = () => ({
  dir,
  cvPath: cv,
  coverText: 'Dear team,\n\nI am applying.',
  whyThisRole: 'Linux and AWS.',
});
const job = { id: 1, title: 'DevOps Engineer', company: 'Acme', source: 'LinkedIn' };
const dataUrl = (html: string) => `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;

/** Answers by question text, as the model would; records what it was asked. */
function fakeLlm(
  byQuestion: Record<string, { value?: string; option?: string }>,
  asked: string[] = [],
): Llm {
  return {
    call: <T>(req: LlmRequest<T>) => {
      const form = JSON.parse(/<form>\n([\s\S]*)\n<\/form>/.exec(req.prompt)?.[1] ?? '[]') as {
        id: string;
        question: string;
        options?: { id: string; label: string }[];
      }[];
      const answers = form.map((f) => {
        asked.push(f.question);
        const k = Object.keys(byQuestion).find((q) => f.question.toLowerCase().includes(q));
        const a = k ? byQuestion[k] : undefined;
        const opt = a?.option
          ? f.options?.find((o) => o.label.toLowerCase().includes(a.option ?? ''))
          : undefined;
        return { id: f.id, value: a?.value ?? null, options: opt ? [opt.id] : [], source: 'test' };
      });
      return Promise.resolve(req.schema.parse({ answers }));
    },
  };
}

const LEVER_LIKE = (
  extra = '',
  onSubmit = "document.body.innerHTML = '<h2>Thank you for applying!</h2>'",
) => `
<html><body><form id="f" onsubmit="event.preventDefault(); window.__submitted = { cv: document.querySelector('[name=resume]').files.length, relocate: document.querySelector('[name=reloc]:checked')?.value, notice: document.querySelector('[name=notice]').value, consent: document.querySelector('[name=consent]').checked, extra: document.querySelector('[name=comments]').value }; ${onSubmit}">
 <ul>
  <li class="application-question"><label><div class="application-label">Resume/CV *</div><input type="file" name="resume" required></label></li>
  <li class="application-question"><label><div class="application-label">Full name</div><input type="text" name="name" required></label></li>
  <li class="application-question"><label><div class="application-label">Email</div><input type="email" name="email" required></label></li>
  <li class="application-question"><label><div class="application-label">Phone</div><input type="text" name="phone"></label></li>
  <li class="application-question"><label><div class="application-label">LinkedIn URL</div><input type="text" name="urls[LinkedIn]"></label></li>
  <li class="application-question"><div class="application-label"><div class="text">Are you willing to relocate?</div></div>
    <label><input type="radio" name="reloc" value="yes" required>Yes</label><label><input type="radio" name="reloc" value="no">No</label></li>
  <li class="application-question"><label><div class="application-label">Notice period *</div>
    <select name="notice" required><option value="">Select…</option><option value="now">Immediately</option><option value="1m">1 month</option></select></label></li>
  <li class="application-question"><label><input type="checkbox" name="consent" required> I agree to the privacy policy</label></li>
  ${extra}
  <li class="application-question"><label><div class="application-label">Additional information</div><textarea name="comments"></textarea></label></li>
 </ul>
 <button type="submit">Submit application</button>
</form></body></html>`;

let filler: FormFiller;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'forms-'));
  cv = join(dir, 'cv.pdf');
  writeFileSync(cv, '%PDF-1.4 test');
});
afterAll(async () => {
  await filler.close();
  rmSync(dir, { recursive: true, force: true });
});

const ANSWERS = {
  relocate: { option: 'yes' },
  notice: { option: 'immediately' },
  privacy: { option: 'agree' },
};

describe('form filler (headless Chrome, local pages)', () => {
  it('fills a Lever-style form from the profile, uploads the CV, submits, sees the confirmation', async () => {
    filler = new FormFiller({ cfg, profile, llm: fakeLlm(ANSWERS), log });
    const r = await filler.run(job, dataUrl(LEVER_LIKE()), docs(), { submit: true });
    const sent = (await r.page.evaluate('window.__submitted')) as Record<string, unknown>;
    await r.page.close();
    expect(r.outcome, r.reason ?? '').toBe('submitted');
    expect(sent).toEqual({
      cv: 1,
      relocate: 'yes',
      notice: 'now',
      consent: true,
      extra: 'Dear team,\n\nI am applying.',
    });
    expect(r.filled.map((f) => f.label)).toEqual(
      expect.arrayContaining(['Full name', 'Email', 'Are you willing to relocate?']),
    );
    expect(r.screenshots.some((s) => s.endsWith('form-after-submit.png'))).toBe(true);
  }, 60_000);

  it('never submits when a required question has no truthful answer', async () => {
    const extra = `<li class="application-question"><label><div class="application-label">Current salary *</div><input type="text" name="salary" required></label></li>`;
    const r = await filler.run(job, dataUrl(LEVER_LIKE(extra)), docs(), { submit: true });
    const sent = await r.page.evaluate('window.__submitted ?? null');
    await r.page.close();
    expect(sent).toBeNull();
    expect(r.outcome).toBe('manual');
    expect(r.reason).toMatch(/Current salary/);
  }, 60_000);

  it('a captcha-protected form that does not confirm goes to "apply yourself"', async () => {
    const extra = `<li><div class="h-captcha" data-sitekey="x"></div></li>`;
    const r = await filler.run(
      job,
      dataUrl(LEVER_LIKE(extra, '/* the site waits for a captcha */')),
      docs(),
      {
        submit: true,
      },
    );
    await r.page.close();
    expect(r.captcha).toBe(true);
    expect(r.outcome).toBe('manual');
    expect(r.reason).toMatch(/captcha/);
  }, 60_000);

  it('fill-only (dry run) fills but does not submit', async () => {
    const r = await filler.run(job, dataUrl(LEVER_LIKE()), docs(), { submit: false });
    const sent = await r.page.evaluate('window.__submitted ?? null');
    await r.page.close();
    expect(sent).toBeNull();
    expect(r.outcome).toBe('filled');
  }, 60_000);

  it('walks a two-page Google-Forms-style form with role=radio options', async () => {
    const html = `<html><body><div id="p1">
      <div role="listitem"><div role="heading">Full name *</div><input type="text" aria-label="Full name" required></div>
      <div role="button" onclick="document.getElementById('p1').style.display='none';document.getElementById('p2').style.display='block'">Next</div></div>
      <div id="p2" style="display:none">
      <div role="listitem"><div role="heading">Willing to work on site in Cairo? *</div>
        <div role="radiogroup" aria-required="true"><div role="radio" aria-label="Yes" aria-checked="false" onclick="this.setAttribute('aria-checked','true');window.__onsite='yes'">Yes</div>
        <div role="radio" aria-label="No" aria-checked="false" onclick="this.setAttribute('aria-checked','true');window.__onsite='no'">No</div></div></div>
      <div role="button" onclick="document.body.innerHTML='Your response has been recorded.'">Submit</div></div></body></html>`;
    const f2 = new FormFiller({
      cfg,
      profile,
      llm: fakeLlm({ 'on site': { option: 'yes' } }),
      log,
    });
    const r = await f2.run(job, dataUrl(html), docs(), { submit: true });
    const onsite = await r.page.evaluate('window.__onsite');
    await f2.close();
    expect(onsite).toBe('yes');
    expect(r.outcome, r.reason ?? '').toBe('submitted');
  }, 60_000);

  it('blocks requests to private addresses from the form page', async () => {
    const html = `<html><body><img src="https://127.0.0.1/x.png" onerror="window.__blocked=true"><form><input name="name" aria-label="Full name"></form></body></html>`;
    const r = await filler.run(job, dataUrl(html), docs(), { submit: false });
    await new Promise((res) => setTimeout(res, 300));
    expect(await r.page.evaluate('window.__blocked === true')).toBe(true);
    await r.page.close();
  }, 60_000);
});

describe('answers', () => {
  const field = (over: Partial<FormField>): FormField => ({
    id: 'f1',
    kind: 'text',
    inputType: 'text',
    name: '',
    label: '',
    required: true,
    ...over,
  });
  it('standard fields come from the profile, never from the model', () => {
    expect(standardAnswer(field({ label: 'First Name*' }), profile, docs())?.value).toBe(
      profile.candidate.first_name,
    );
    expect(
      standardAnswer(field({ label: 'Email', inputType: 'email' }), profile, docs())?.value,
    ).toBe(profile.candidate.email);
    expect(standardAnswer(field({ kind: 'file', label: 'Resume' }), profile, docs())?.value).toBe(
      cv,
    );
    expect(
      standardAnswer(field({ kind: 'file', label: 'Cover letter' }), profile, docs()),
    ).toBeNull();
    expect(standardAnswer(field({ label: 'Company name' }), profile, docs())).toBeNull();
  });
  it('drops options the field does not have and extra radio choices', () => {
    const f = field({
      kind: 'radio',
      options: [
        { id: 'a', label: 'Yes' },
        { id: 'b', label: 'No' },
      ],
    });
    expect(validAnswer(f, { value: null, options: ['zzz'], source: '' })).toBeNull();
    expect(validAnswer(f, { value: null, options: ['a', 'b'], source: '' })?.options).toEqual([
      'a',
    ]);
    expect(validAnswer(field({}), { value: '  ', options: [], source: '' })).toBeNull();
  });
  it('never tries boards that need an account, or plain http', () => {
    expect(formEligible('https://jobs.lever.co/acme/1/apply', cfg)).toBe(true);
    expect(formEligible('https://forms.gle/abc', cfg)).toBe(true);
    expect(formEligible('https://linkedin.com/jobs/view/1', cfg)).toBe(false);
    expect(formEligible('https://wuzzuf.net/jobs/p/x', cfg)).toBe(false);
    expect(formEligible('http://acme.example/apply', cfg)).toBe(false);
  });
});

// ------------------------------------------------------------------ apply step + send all

function seedDb(): Db {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare(
    `INSERT INTO raw_items (source, source_ref, source_name, posted_at, collected_at, text, content_hash)
     VALUES ('alert_email', 'm', 'LinkedIn <jobs-noreply@linkedin.com>', 'now', 'now', 't', 'h')`,
  ).run();
  for (const [ch, email, url] of [
    ['form', null, 'https://jobs.lever.co/acme/1/apply'],
    ['email', 'hr@acme.example', null],
    ['email', 'jobs@beta.example', null],
  ])
    db.prepare(
      `INSERT INTO jobs (raw_item_id, title, title_norm, company, apply_channel, apply_email, apply_url,
         fingerprint, priority, fit_score, flags, status, created_at, updated_at)
       VALUES (1, 'DevOps Engineer', 'devops engineer', 'Acme', ?, ?, ?, 'f', 1, 80, '[]', 'new', 'now', 'now')`,
    ).run(ch, email, url);
  return db;
}

const prepared = (): Prepared =>
  ({
    dir,
    cvPath: cv,
    cvMdPath: cv,
    coverPath: cv,
    coverText: 'Dear team',
    subject: 's',
    body: 'b',
    ats: { pass: true },
    whyThisRole: 'w',
    ok: true,
    problems: [],
  }) as unknown as Prepared;

describe('apply step with forms', () => {
  it('a submitted form → applied; a captcha → ready with the reason for the dashboard', async () => {
    for (const [outcome, status, mode] of [
      ['submitted', 'applied', 'submitted'],
      ['manual', 'ready', 'manual'],
    ] as const) {
      const db = seedDb();
      const forms = {
        run: () =>
          Promise.resolve({
            outcome,
            reason: outcome === 'manual' ? 'the site showed a captcha or did not confirm' : null,
            url: 'u',
            finalUrl: 'u',
            captcha: outcome === 'manual',
            filled: [],
            unanswered: [],
            screenshots: [],
            at: 'now',
            page: { close: () => Promise.resolve() },
          }),
      } as unknown as FormFiller;
      const job = db.prepare('SELECT * FROM jobs WHERE id = 1').get() as JobRow;
      const r = await applyJob(
        { db, cfg, profile, gmail: null, dryRun: false, now: () => new Date(), forms },
        job,
        prepared(),
      );
      expect(r.status).toBe(status);
      const a = db
        .prepare('SELECT mode, manual_reason FROM applications WHERE job_id = 1')
        .get() as { mode: string; manual_reason: string | null };
      expect(a.mode).toBe(mode);
      if (outcome === 'manual') expect(a.manual_reason).toMatch(/captcha/);
      db.close();
    }
  });
});

describe('send all reviewed drafts', () => {
  function gmail(existing: Set<string>, sent: string[]): GmailWriter {
    return {
      myAddress: () => Promise.resolve('me@example.com'),
      search: () => Promise.resolve([]),
      getMessage: () => Promise.reject(new Error('unused')),
      createDraft: () => Promise.reject(new Error('unused')),
      deleteOwnDraft: () => Promise.resolve(),
      draftExists: (id) => Promise.resolve(existing.has(id)),
      threadMessages: () => Promise.resolve([]),
      sendRaw: () => Promise.reject(new Error('unused')),
      sendDraft: (id) => {
        sent.push(id);
        return Promise.resolve({ messageId: `m-${id}`, threadId: `t-${id}` });
      },
    };
  }
  function withDrafts(): Db {
    const db = seedDb();
    for (const [job, draft] of [
      [2, 'd2'],
      [3, 'd3'],
    ] as const) {
      db.prepare(
        `INSERT INTO applications (job_id, channel, to_email, gmail_draft_id, mode, created_at) VALUES (?, 'email', 'x', ?, 'draft', 'now')`,
      ).run(job, draft);
      db.prepare(`UPDATE jobs SET status = 'ready' WHERE id = ?`).run(job);
    }
    return db;
  }

  it('asks once, sends what is still in Drafts, skips deleted ones, marks applied', async () => {
    const db = withDrafts();
    const sent: string[] = [];
    let asked = 0;
    const r = await sendReviewedDrafts({
      db,
      gmail: gmail(new Set(['d2']), sent),
      cfg,
      out: () => undefined,
      confirm: (list) => {
        asked++;
        expect(list.map((w) => w.draftId)).toEqual(['d2']);
        return Promise.resolve(true);
      },
      sleep: () => Promise.resolve(),
    });
    expect(asked).toBe(1);
    expect(r).toEqual({ sent: 1, missing: 1 });
    expect(sent).toEqual(['d2']);
    expect(db.prepare('SELECT status FROM jobs WHERE id = 2').pluck().get()).toBe('applied');
    expect(db.prepare('SELECT status FROM jobs WHERE id = 3').pluck().get()).toBe('ready');
  });

  it('sends nothing when not confirmed', async () => {
    const sent: string[] = [];
    await sendReviewedDrafts({
      db: withDrafts(),
      gmail: gmail(new Set(['d2', 'd3']), sent),
      cfg,
      out: () => undefined,
      confirm: () => Promise.resolve(false),
    });
    expect(sent).toEqual([]);
  });
});
