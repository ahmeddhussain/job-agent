// Web-form applications (D33). For a form job the agent opens the application page in a
// separate headless Chrome (JavaScript on, a fresh profile, downloads off, private
// addresses blocked), fills it from the profile, uploads the checked CV, and submits.
// It counts an application as submitted only when the company's confirmation appears.
// Anything it can't finish (a captcha challenge, a sign-in wall, a required question the
// profile can't answer truthfully, no confirmation) becomes a "do it yourself" job with
// the link, the CV and the letter ready; nothing is guessed.
// It never logs in anywhere and never solves or bypasses a captcha.
import { lookup } from 'node:dns/promises';
import { writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { join } from 'node:path';
import type { Logger } from 'pino';
import puppeteer, { type Browser, type Page } from 'puppeteer';
import type { Config } from '../config.js';
import { FormAnswersSchema } from '../llm/schemas.js';
import type { Llm } from '../llm/types.js';
import { fence, loadPrompt } from '../pipeline/extract.js';
import { profileForPrompt, type Profile } from '../profile/load.js';
import { isPrivateAddress } from '../util/http.js';

export interface FieldOption {
  id: string;
  label: string;
}

export interface FormField {
  id: string;
  kind: 'text' | 'textarea' | 'select' | 'file' | 'radio' | 'checkbox';
  inputType: string;
  name: string;
  label: string;
  required: boolean;
  options?: FieldOption[];
  combobox?: boolean;
}

export interface PageScan {
  fields: FormField[];
  captcha: boolean;
  signIn: boolean;
  url: string;
  title: string;
  submit: string | null;
  next: string | null;
  apply: string | null;
}

export interface Answer {
  value: string | null;
  options: string[];
  source: string;
}

export type FormOutcome = 'submitted' | 'filled' | 'manual';

export interface FormReport {
  url: string;
  finalUrl: string;
  outcome: FormOutcome;
  reason: string | null;
  captcha: boolean;
  filled: { label: string; value: string; source: string }[];
  unanswered: string[];
  screenshots: string[];
  at: string;
}

export interface FormJob {
  id: number;
  title: string;
  company: string | null;
  /** Where the job was found (for "how did you hear about us"). */
  source: string;
}

export interface FormDocs {
  dir: string;
  cvPath: string;
  coverText: string;
  whyThisRole: string;
}

// In-page scan, as a string: tsx/esbuild would add helper calls to a compiled function
// that don't exist inside the page. Marks every field with data-ja="<id>".
const SCAN = String.raw`(() => {
  const txt = (el) => ((el && el.textContent) || '').replace(/\s+/g, ' ').trim();
  const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const labelFor = (el) => {
    if (el.id) { const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (l && txt(l)) return txt(l); }
    const lb = el.getAttribute('aria-labelledby');
    if (lb) { const t = lb.split(/\s+/).map((i) => txt(document.getElementById(i))).join(' ').trim(); if (t) return t; }
    const box = el.closest('[role=listitem], .application-question, fieldset, .field, .form-group, [class*="question"], [class*="Field"], [class*="field"], li, label');
    if (box) { const h = box.querySelector('[role=heading], legend, .application-label, label, .text, h3, h4, p'); if (h && txt(h)) return txt(h);
      if (box.tagName === 'LABEL' && txt(box)) return txt(box); }
    return el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.name || '';
  };
  const fields = []; const groups = new Map(); let n = 0;
  for (const el of document.querySelectorAll('input, select, textarea, [role=radio], [role=checkbox]')) {
    const tag = el.tagName;
    const type = tag === 'INPUT' ? (el.type || 'text') : tag === 'SELECT' ? 'select' : tag === 'TEXTAREA' ? 'textarea' : el.getAttribute('role');
    if (['hidden', 'submit', 'button', 'reset', 'image', 'search', 'password'].includes(type)) continue;
    if (/captcha/i.test((el.name || '') + (el.id || ''))) continue;
    if (type !== 'file' && type !== 'radio' && type !== 'checkbox' && !visible(el)) continue;
    if ((type === 'radio' || type === 'checkbox') && tag === 'INPUT' && !visible(el) && !(el.closest('label') && visible(el.closest('label')))) continue;
    const id = 'f' + (n++); el.setAttribute('data-ja', id);
    const label = labelFor(el);
    const required = !!el.required || el.getAttribute('aria-required') === 'true' || /\*\s*$/.test(label);
    if (type === 'radio' || type === 'checkbox') {
      const opt = tag === 'INPUT'
        ? (txt(el.closest('label')) || (el.id && txt(document.querySelector('label[for="' + CSS.escape(el.id) + '"]'))) || el.value)
        : (el.getAttribute('aria-label') || el.getAttribute('data-value') || txt(el));
      const box = el.closest('[role=radiogroup], [role=group], fieldset, .application-question, [role=listitem], li');
      if (box && !box.getAttribute('data-ja-g')) box.setAttribute('data-ja-g', 'g' + n);
      const key = (el.name || '') + '|' + (box ? box.getAttribute('data-ja-g') : id);
      let g = groups.get(key);
      if (!g) {
        let q = '';
        if (box) { const h = box.querySelector('[role=heading], legend, .application-label, .text, h3, h4'); q = txt(h); }
        g = { id: 'q' + groups.size, kind: type === 'radio' ? 'radio' : 'checkbox', inputType: type, name: el.name || '', label: q || label, required: false, options: [] };
        groups.set(key, g); fields.push(g);
      }
      g.required = g.required || required;
      g.options.push({ id, label: opt });
      continue;
    }
    fields.push({ id, kind: type === 'select' ? 'select' : type === 'textarea' ? 'textarea' : type === 'file' ? 'file' : 'text',
      inputType: type, name: el.name || '', label, required,
      options: type === 'select' ? [...el.options].filter((o) => o.value !== '').map((o) => ({ id: o.value, label: txt(o) })) : undefined,
      combobox: el.getAttribute('role') === 'combobox' || el.getAttribute('aria-autocomplete') === 'list' });
  }
  const buttons = [...document.querySelectorAll('button, input[type=submit], [role=button]')].filter(visible);
  const btn = (re) => { const b = buttons.find((x) => re.test((txt(x) || x.value || '').trim())); if (!b) return null; b.setAttribute('data-ja-btn', 'b' + (n++)); return b.getAttribute('data-ja-btn'); };
  const captcha = !!document.querySelector('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="turnstile"], script[src*="recaptcha"], script[src*="hcaptcha"], script[src*="turnstile"], .g-recaptcha, .h-captcha, .cf-turnstile');
  const signIn = /accounts\.google\.com|\/login|\/signin|\/sign-in/i.test(location.href) || /sign in to continue|sign in to google/i.test(document.body ? document.body.innerText.slice(0, 3000) : '');
  return { fields, captcha, signIn, url: location.href, title: document.title,
    submit: btn(/^(submit( application)?|send|apply( now)?|إرسال|تقديم|ارسال)$/i),
    next: btn(/^(next|continue|التالي)$/i),
    apply: fields.length === 0 ? btn(/apply( for this job| now)?|تقدم/i) : null };
})()`;

const SUCCESS =
  /thank you|thanks for applying|application (has been |was )?(received|submitted|sent)|we('|’)ve received|successfully (submitted|applied)|your response has been recorded|تم (إرسال|استلام|تسجيل)|شكرا/i;

const norm = (s: string) => s.toLowerCase().replace(/[*:]+/g, ' ').replace(/\s+/g, ' ').trim();

/** Deterministic answers for the standard fields; everything else goes to the model. */
export function standardAnswer(f: FormField, p: Profile, d: FormDocs): Answer | null {
  const c = p.candidate;
  const l = norm(`${f.label} ${f.name}`);
  const a = (value: string, source: string): Answer => ({ value, options: [], source });
  if (f.kind === 'file') {
    if (/cover/.test(l)) return null;
    return { value: d.cvPath, options: [], source: 'cv' };
  }
  if (f.kind !== 'text' && f.kind !== 'textarea') return null;
  if (/first\s*name|given name|الاسم الأول/.test(l)) return a(c.first_name, 'candidate.first_name');
  if (/last\s*name|family name|surname|اسم العائلة/.test(l))
    return a(c.last_name, 'candidate.last_name');
  if (
    /(^|\s)(full\s*)?name(\s|$)|systemfield_name|الاسم/.test(l) &&
    !/company|employer|school|university|reference|manager/.test(l)
  )
    return a(c.full_name, 'candidate.full_name');
  if (/e-?mail|البريد/.test(l) || f.inputType === 'email') return a(c.email, 'candidate.email');
  if (/phone|mobile|whats ?app|telephone|رقم|موبايل/.test(l) || f.inputType === 'tel')
    return a(c.phone, 'candidate.phone');
  if (/linkedin/.test(l) && c.links['linkedin']) return a(c.links['linkedin'], 'links.linkedin');
  if (/github/.test(l) && c.links['github']) return a(c.links['github'], 'links.github');
  if (/portfolio|website|personal (site|page)|other url/.test(l) && c.links['portfolio'])
    return a(c.links['portfolio'], 'links.portfolio');
  if (
    f.kind === 'textarea' &&
    /cover letter|additional information|message to|comments|anything else/.test(l)
  )
    return a(d.coverText.trim(), 'cover letter');
  if (
    /^(location|city|current location|location \(city\)|where .* located)/.test(norm(f.label)) &&
    !/country/.test(l)
  )
    return a(c.location, 'candidate.location');
  return null;
}

/** Keeps only answers the field allows: real option ids, one for radio/select, bounded text. */
export function validAnswer(f: FormField, a: Answer): Answer | null {
  if (f.kind === 'select' || f.kind === 'radio' || f.kind === 'checkbox') {
    const ids = new Set((f.options ?? []).map((o) => o.id));
    const options = a.options.filter((o) => ids.has(o));
    if (options.length === 0) return null;
    return { ...a, value: null, options: f.kind === 'checkbox' ? options : options.slice(0, 1) };
  }
  const v = a.value?.trim();
  return v ? { ...a, value: v.slice(0, 3000), options: [] } : null;
}

export class FormFiller {
  private browser: Browser | null = null;
  private readonly dns = new Map<string, Promise<boolean>>();

  constructor(
    private readonly o: {
      cfg: Config;
      profile: Profile;
      llm: Llm;
      log: Logger;
      /** Assisted mode: a visible window and a persistent profile (D33). */
      headless?: boolean;
      userDataDir?: string;
    },
  ) {}

  async page(): Promise<Page> {
    if (!this.browser) {
      this.browser = await puppeteer.launch({
        headless: this.o.headless ?? true,
        defaultViewport: this.o.headless === false ? null : { width: 1280, height: 900 },
        ...(this.o.userDataDir ? { userDataDir: this.o.userDataDir } : {}),
        args: this.o.headless === false ? ['--start-maximized'] : [],
      });
    }
    const page = await this.browser.newPage();
    const cdp = await page.createCDPSession();
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'deny' }).catch(() => undefined);
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      void this.allowed(req.url()).then(
        (ok) => (ok ? req.continue() : req.abort('blockedbyclient')),
        () => req.abort('blockedbyclient'),
      );
    });
    return page;
  }

  /** https (and data/blob) only, and the host must resolve to public addresses (A8). */
  private allowed(raw: string): Promise<boolean> {
    if (raw.startsWith('data:') || raw.startsWith('blob:')) return Promise.resolve(true);
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return Promise.resolve(false);
    }
    if (url.protocol !== 'https:') return Promise.resolve(false);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    let p = this.dns.get(host);
    if (!p) {
      p = isIP(host)
        ? Promise.resolve(!isPrivateAddress(host))
        : lookup(host, { all: true }).then(
            (as) => as.length > 0 && !as.some((x) => isPrivateAddress(x.address)),
            () => false,
          );
      this.dns.set(host, p);
    }
    return p;
  }

  async close(): Promise<void> {
    await this.browser?.close();
    this.browser = null;
  }

  private async answerAll(
    fields: FormField[],
    job: FormJob,
    d: FormDocs,
  ): Promise<Map<string, Answer>> {
    const out = new Map<string, Answer>();
    const rest: FormField[] = [];
    for (const f of fields) {
      const s = standardAnswer(f, this.o.profile, d);
      if (s) out.set(f.id, s);
      else if (f.kind !== 'file') rest.push(f);
    }
    if (rest.length === 0) return out;
    const res = await this.o.llm.call({
      purpose: 'form',
      model: this.o.cfg.llm.extract_model,
      system: loadPrompt('form', {
        profile: profileForPrompt(this.o.profile),
        answers: JSON.stringify(this.o.profile.application_answers, null, 2),
      }),
      prompt: [
        `Job: ${job.title}${job.company ? ` at ${job.company}` : ''}. Found via: ${job.source}.`,
        `Why this role (for motivation questions): ${d.whyThisRole}`,
        `Cover letter:\n${d.coverText.trim()}`,
        '<form>',
        fence(
          JSON.stringify(
            rest.map((f) => ({
              id: f.id,
              kind: f.kind,
              question: f.label.slice(0, 300),
              required: f.required,
              ...(f.options
                ? { options: f.options.map((o) => ({ id: o.id, label: o.label.slice(0, 150) })) }
                : {}),
            })),
            null,
            1,
          ),
        ),
        '</form>',
      ].join('\n'),
      schema: FormAnswersSchema,
      jobId: job.id,
      key: `job${String(job.id)}.form`,
    });
    for (const a of res.answers) {
      const f = rest.find((x) => x.id === a.id);
      const v = f ? validAnswer(f, a) : null;
      if (f && v) out.set(f.id, v);
    }
    return out;
  }

  private async fill(page: Page, f: FormField, a: Answer): Promise<void> {
    if (f.kind === 'radio' || f.kind === 'checkbox') {
      for (const id of a.options) {
        await page.evaluate(
          `(() => { const e = document.querySelector('[data-ja="${id}"]'); if (e && !e.checked && e.getAttribute('aria-checked') !== 'true') e.click(); })()`,
        );
      }
      return;
    }
    const sel = `[data-ja="${f.id}"]`;
    if (f.kind === 'select') {
      await page.select(sel, a.options[0] ?? '');
      return;
    }
    const el = await page.$(sel);
    if (!el) return;
    if (f.kind === 'file') {
      // The tsconfig has no DOM types; uploadFile exists on file-input handles.
      await (el as unknown as { uploadFile: (...paths: string[]) => Promise<void> }).uploadFile(
        a.value ?? '',
      );
      return;
    }
    const value = a.value ?? '';
    await el.click({ clickCount: 3 }).catch(() => undefined);
    if (value.length > 150) {
      // Long text: set it the way React expects (native setter + input event), then a key
      // press so frameworks that listen to keyboard events see a change too.
      await page.evaluate(
        `(() => { const e = document.querySelector('${sel}'); const proto = e.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          Object.getOwnPropertyDescriptor(proto, 'value').set.call(e, ${JSON.stringify(value)});
          e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); })()`,
      );
    } else {
      await el.type(value);
    }
    if (f.combobox) {
      await new Promise((r) => setTimeout(r, 700));
      const picked = await page.evaluate(
        `(() => { const want = ${JSON.stringify(value.toLowerCase())};
          const opts = [...document.querySelectorAll('[role=option]')].filter((o) => o.getBoundingClientRect().height > 0);
          const o = opts.find((x) => x.textContent.trim().toLowerCase() === want) || opts.find((x) => x.textContent.toLowerCase().includes(want)) || opts[0];
          if (o) { o.click(); return true; } return false; })()`,
      );
      if (!picked) await page.keyboard.press('Enter');
    }
  }

  /**
   * Opens `url`, fills every field it can answer truthfully and, when `submit` is set and
   * nothing required is missing, submits and checks for the confirmation.
   */
  async run(
    job: FormJob,
    url: string,
    d: FormDocs,
    opts: { submit: boolean; page?: Page },
  ): Promise<FormReport & { page: Page }> {
    const page = opts.page ?? (await this.page());
    const report: FormReport = {
      url,
      finalUrl: url,
      outcome: 'manual',
      reason: null,
      captcha: false,
      filled: [],
      unanswered: [],
      screenshots: [],
      at: new Date().toISOString(),
    };
    const shot = async (name: string) => {
      const path = join(d.dir, name);
      await page.screenshot({ path, fullPage: true }).catch(() => undefined);
      report.screenshots.push(path);
    };
    const scan = async () => (await page.evaluate(SCAN)) as PageScan;
    const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const timeout = this.o.cfg.forms.timeout_seconds * 1000;

    await page.goto(url, { waitUntil: 'networkidle2', timeout });
    await settle(1500);
    let s = await scan();
    if (s.apply) {
      // A job page with an "Apply" button in front of the form (Workable, many careers sites).
      await page.click(`[data-ja-btn="${s.apply}"]`).catch(() => undefined);
      await page.waitForNetworkIdle({ timeout }).catch(() => undefined);
      await settle(1500);
      s = await scan();
    }
    for (let pageNo = 1; pageNo <= this.o.cfg.forms.max_pages; pageNo++) {
      report.captcha ||= s.captcha;
      if (s.signIn) {
        report.reason = 'the form needs a sign-in';
        break;
      }
      const real = s.fields.filter(
        (f) => f.kind !== 'file' || f.required || /resume|cv/i.test(f.label),
      );
      if (real.length === 0) {
        report.reason = pageNo === 1 ? 'no application form found on the page' : report.reason;
        break;
      }
      const answers = await this.answerAll(real, job, d);
      // The CV first: some forms (Ashby, Greenhouse) read it and pre-fill other fields.
      const order = [...real].sort((a, b) => Number(b.kind === 'file') - Number(a.kind === 'file'));
      for (const f of order) {
        const a = answers.get(f.id);
        if (!a) {
          if (f.required) report.unanswered.push(f.label || f.name || f.id);
          continue;
        }
        try {
          await this.fill(page, f, a);
          if (f.kind === 'file') await settle(3000);
          const shown =
            a.value ??
            a.options.map((id) => f.options?.find((o) => o.id === id)?.label ?? id).join(', ');
          report.filled.push({
            label: f.label,
            value: f.kind === 'file' ? 'CV (PDF)' : shown.slice(0, 200),
            source: a.source,
          });
        } catch (err) {
          if (f.required)
            report.unanswered.push(`${f.label} (could not fill: ${String(err).slice(0, 80)})`);
        }
      }
      if (s.next && !s.submit && report.unanswered.length === 0) {
        await page.click(`[data-ja-btn="${s.next}"]`);
        await page.waitForNetworkIdle({ timeout }).catch(() => undefined);
        await settle(1200);
        s = await scan();
        continue;
      }
      break;
    }
    await shot('form-filled.png');
    report.finalUrl = page.url();

    if (report.reason || report.unanswered.length > 0 || !s.submit) {
      report.reason ??=
        report.unanswered.length > 0
          ? `required questions the profile can't answer: ${report.unanswered.join('; ')}`
          : 'no submit button found';
      return { ...report, page };
    }
    if (!opts.submit) {
      report.outcome = 'filled';
      report.reason = 'filled, not submitted (dry run)';
      return { ...report, page };
    }

    await page.click(`[data-ja-btn="${s.submit}"]`);
    await Promise.race([
      page.waitForNavigation({ timeout: 20_000 }).catch(() => undefined),
      settle(20_000),
      page
        .waitForFunction(`${SUCCESS.toString()}.test(document.body.innerText)`, { timeout: 20_000 })
        .catch(() => undefined),
    ]);
    await settle(2000);
    const after = (await page.evaluate(
      `(() => ({ text: document.body ? document.body.innerText.slice(0, 20000) : '', url: location.href,
        challenge: [...document.querySelectorAll('iframe')].some((f) => /hcaptcha.*challenge|recaptcha\\/(api2|enterprise)\\/bframe|challenges[.]cloudflare/.test(f.src) && f.getBoundingClientRect().height > 50),
        errors: [...document.querySelectorAll('[role=alert], .error, [class*="error"], [aria-invalid=true]')].map((e) => (e.textContent || '').trim()).filter((t) => t && t.length < 200).slice(0, 5) }))()`,
    )) as { text: string; url: string; challenge: boolean; errors: string[] };
    await shot('form-after-submit.png');
    report.finalUrl = after.url;
    const movedToThanks =
      after.url !== url &&
      !after.url.startsWith('data:') &&
      /thank|confirm|success|submitted/i.test(new URL(after.url).pathname);
    if (SUCCESS.test(after.text) || movedToThanks) {
      report.outcome = 'submitted';
      report.reason = null;
    } else if (after.challenge || report.captcha) {
      report.reason = 'the site showed a captcha or did not confirm (captcha-protected form)';
    } else if (after.errors.length > 0) {
      report.reason = `the form reported: ${after.errors.join(' | ')}`;
    } else {
      report.reason = 'submitted, but no confirmation appeared';
    }
    return { ...report, page };
  }
}

/** Saves the report next to the application files (form.json). */
export function saveFormReport(dir: string, r: FormReport & { page?: unknown }): string {
  const path = join(dir, 'form.json');
  writeFileSync(
    path,
    `${JSON.stringify(r, (k, v: unknown) => (k === 'page' ? undefined : v), 2)}\n`,
  );
  return path;
}

/** Whether the agent may try this link as a form (never job boards that need an account). */
export function formEligible(url: string | null, cfg: Config): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return false;
    return !cfg.forms.never_hosts.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`));
  } catch {
    return false;
  }
}
