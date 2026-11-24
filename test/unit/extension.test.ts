// The form-filling add-on (D49): the real extension in a real browser against a local form and
// the real dashboard server, with a fake model. Plus the server's own rules.
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import puppeteer, { type Browser } from 'puppeteer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { forget, learnedAnswers, notLearnable } from '../../src/apply/learned.js';
import { pendingQuestions } from '../../src/apply/questions.js';
import { parseConfig, type Config } from '../../src/config.js';
import { EXTENSION_ORIGIN, ExtSession } from '../../src/dashboard/ext.js';
import { buildDashboard } from '../../src/dashboard/server.js';
import { migrate, openDb, type Db } from '../../src/db/index.js';
import type { Llm, LlmRequest } from '../../src/llm/types.js';
import { loadProfile } from '../../src/profile/load.js';

const FORM = `<!doctype html><title>Apply</title><h1>Cloud Engineer</h1>
<form id="form" onsubmit="event.preventDefault(); window.submitted = true">
 <label for="fn">First name *</label><input id="fn" name="first" required>
 <label for="mid">Middle name</label><input id="mid" name="middleName">
 <label for="ln">Last name</label><input id="ln" name="last">
 <label for="em">Email</label><input id="em" type="email">
 <label for="ad">Address</label><input id="ad" value="12 Old Street">
 <label for="sal">Desired annual salary *</label><input id="sal" name="salary" required>
 <label for="np">Notice period</label><select id="np"><option value="">Select</option><option value="a">Immediately</option><option value="b">1 month</option></select>
 <label for="co">Country</label><select id="co"><option value="">-</option>${Array.from({ length: 120 }, (_, i) => `<option value="c${i}">Country ${i}</option>`).join('')}<option value="eg">Egypt</option></select>
 <fieldset><legend>Are you willing to relocate?</legend><label><input type="radio" name="reloc" value="y">Yes</label><label><input type="radio" name="reloc" value="n">No</label></fieldset>
 <fieldset><legend>I agree to the privacy policy *</legend><label><input type="radio" name="agree" value="y" required>Yes</label></fieldset>
 <label for="city">City</label><input id="city" role="combobox" aria-controls="lb"><div id="lb" role="listbox"></div>
 <label for="rs">Do you have Linux experience? *</label><div class="rs__control"><span id="rsv"></span><input id="rs" role="combobox" aria-autocomplete="list" aria-controls="rsl"></div><div id="rsl" role="listbox"></div>
 <div aria-hidden="true"><input id="twin" required tabindex="-1" aria-label="Do you have Linux experience?"></div>
 <div class="q"><div>Can you work nights?✱</div><div><label><input type="radio" name="nights" value="1">Yes</label><label><input type="radio" name="nights" value="0">No</label></div></div>
 <label for="cv">Resume *</label><input id="cv" type="file" required>
 <label for="cl">Cover letter</label><input id="cl" type="file">
 <label for="lg">Login name</label><input id="lg" name="login"><input type="password" name="pw">
 <label><input type="checkbox" id="terms"> I accept the terms</label>
 <input name="trap" style="display:none">
 <div id="host"></div>
 <button>Submit application</button>
</form>
<script>
 // Like React: only the native setter plus an input event counts as typing.
 window.seen = {};
 for (const e of document.querySelectorAll('input')) e.addEventListener('input', () => { window.seen[e.id] = e.value; });
 const root = host.attachShadow({ mode: 'open' });
 root.innerHTML = '<label for="mo">Why this role?</label><textarea id="mo"></textarea>';
 const open = () => { rsl.innerHTML = ['Yes', 'No'].filter((o) => o.toLowerCase().startsWith(rs.value.toLowerCase())).map((o) => '<div role="option">' + o + '</div>').join('');
   for (const o of rsl.children) o.addEventListener('mousedown', () => { rsv.className = 'rs__single-value'; rsv.textContent = o.textContent; rs.value = ''; rsl.innerHTML = ''; }); };
 rs.addEventListener('keydown', (e) => { if (e.key === 'ArrowDown') open(); if (e.key === 'Escape') rsl.innerHTML = ''; });
 rs.addEventListener('input', open);
 city.addEventListener('input', () => { lb.innerHTML = city.value ? '<div role="option">Cairo Governorate</div>' : '';
   lb.querySelector('div')?.addEventListener('click', () => { city.value = 'Cairo Governorate'; lb.innerHTML = ''; }); });
</script>`;

const llm: Llm = {
  call: <T>(req: LlmRequest<T>) => {
    asked.push(req.prompt);
    const form = JSON.parse(/<form>\n([\s\S]*)\n<\/form>/.exec(req.prompt)?.[1] ?? '[]') as {
      id: string;
      question: string;
      options?: { id: string; label: string }[];
    }[];
    const say: [RegExp, string][] = [
      [/salary/i, 'Around 15,000 EGP per month'],
      [/notice/i, 'Immediately'],
      [/country/i, 'Egypt'],
      [/relocate/i, 'Yes'],
      [/linux experience/i, 'Yes'],
      [/work nights/i, 'No'],
      [/why this role/i, 'Because of Linux.'],
    ];
    return Promise.resolve(
      req.schema.parse({
        answers: form.map((f) => {
          const v = say.find(([re]) => re.test(f.question))?.[1] ?? null;
          const o = f.options?.find((x) => x.label === v);
          return { id: f.id, value: f.options ? null : v, options: o ? [o.id] : [], source: 't' };
        }),
      }),
    );
  },
};
const asked: string[] = [];

let dir: string;
let db: Db;
let cfg: Config;
let app: ReturnType<typeof buildDashboard>;
let site: Server;
let formUrl: string;
let browser: Browser;
let recent: number | null = null;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ext-'));
  writeFileSync(join(dir, 'CV.pdf'), '%PDF-1.4 cv');
  const raw = parse(readFileSync('config/defaults.yaml', 'utf8')) as Record<
    string,
    Record<string, unknown>
  >;
  raw['paths'] = { ...raw['paths'], profile: resolve('test/fixtures/profile.yaml') };
  raw['dashboard'] = { ...raw['dashboard'], port: 18_931 };
  cfg = parseConfig(raw);
  db = openDb(':memory:');
  migrate(db);
  db.prepare(
    `INSERT INTO raw_items (id, source, source_ref, posted_at, collected_at, text, content_hash)
     VALUES (1, 'manual', 'm1', '2026-11-24', '2026-11-24', 't', 'h')`,
  ).run();
  for (const id of [1, 2]) {
    db.prepare(
      `INSERT INTO jobs (id, raw_item_id, title, title_norm, company, apply_channel, apply_url, fingerprint, status, created_at, updated_at)
       VALUES (?, 1, 'Cloud Engineer', 'cloud engineer', 'Acme', 'form', ?, ?, 'ready', 'now', 'now')`,
    ).run(id, `https://linkedin.com/jobs/view/${String(id)}`, `f${String(id)}`);
    db.prepare(
      `INSERT INTO applications (job_id, channel, mode, created_at, package_dir, cv_pdf, cover_text, why_this_role)
       VALUES (?, 'form', 'manual', 'now', ?, ?, 'Dear team,\n\nI am applying.', 'Linux.')`,
    ).run(id, dir, join(dir, 'CV.pdf'));
  }
  site = createServer((_q, r) => r.setHeader('Content-Type', 'text/html; charset=utf-8').end(FORM));
  await new Promise<void>((ok) => site.listen(0, '127.0.0.1', ok));
  formUrl = `http://127.0.0.1:${String((site.address() as AddressInfo).port)}/apply`;
  const ext = new ExtSession(
    () => cfg,
    db,
    () => llm,
    () => recent,
    (u) => u.startsWith('http://127.0.0.1') || !u.includes('linkedin'),
  );
  app = buildDashboard(cfg, db, { ext });
  await app.listen({ host: '127.0.0.1', port: cfg.dashboard.port });
  const at = resolve('extension');
  browser = await puppeteer.launch({
    headless: true,
    pipe: true,
    enableExtensions: [at],
  });
}, 60_000);
afterAll(async () => {
  await browser.close();
  await app.close();
  site.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('the add-on in a browser', () => {
  it('fills the empty fields, attaches both files, and touches nothing else', async () => {
    const page = await browser.newPage();
    await page.goto(formUrl);
    const target = await browser.waitForTarget((t) => t.url().endsWith('/background.js'));
    expect(target.url().startsWith(EXTENSION_ORIGIN)).toBe(true);
    const worker = await target.worker();
    if (!worker) throw new Error('no worker');
    await worker.evaluate(`chrome.storage.local.set({ port: ${String(cfg.dashboard.port)} })`);
    const status = (await worker.evaluate(`(async () => {
      const [t] = await chrome.tabs.query({ url: '${formUrl}' });
      await fill(t.id, 1);
      return status.get(t.id);
    })()`)) as { text: string; left: string[]; boxes: number; error?: boolean };
    expect(status.error, status.text).toBeUndefined();
    const got = (await page.evaluate(`({
      fn: fn.value, mid: mid.value, ln: ln.value, em: em.value, ad: ad.value, sal: sal.value,
      np: np.value, co: co.value, reloc: document.querySelector('[name=reloc]:checked')?.value ?? null,
      agree: document.querySelector('[name=agree]:checked')?.value ?? null, city: city.value, rs: rsv.textContent, twin: twin.value, nights: document.querySelector('[name=nights]:checked')?.value ?? null,
      cv: cv.files[0]?.name ?? null, cl: cl.files[0]?.name ?? null, lg: lg.value, terms: terms.checked,
      trap: document.querySelector('[name=trap]').value, mo: host.shadowRoot.getElementById('mo').value,
      submitted: !!window.submitted, seenFn: window.seen.fn })`)) as Record<string, unknown>;
    const p = loadProfile(cfg.paths.profile).candidate;
    expect(got).toEqual({
      fn: p.first_name,
      mid: '', // not the full name
      ln: p.last_name,
      em: p.email,
      ad: '12 Old Street', // the user's own value stays
      sal: '', // a monthly figure is not a yearly one
      np: 'a',
      co: 'eg',
      reloc: 'y',
      agree: null, // an agreement is the user's to give
      city: 'Cairo Governorate', // the picker's own choice
      rs: 'Yes', // a custom dropdown, from its own choices
      twin: '', // its hidden copy
      nights: '0',
      cv: 'CV.pdf',
      cl: 'Ahmed-Khater-Cover-Letter.pdf',
      lg: '',
      terms: false,
      trap: '',
      mo: 'Because of Linux.',
      submitted: false,
      seenFn: p.first_name,
    });
    expect(status.left).toContain('Desired annual salary *');
    expect(status.left.join()).toContain('privacy policy');
    expect(status.boxes).toBe(1);
    expect(asked.join()).toContain('"question": "Can you work nights?✱"');
    // Existing values, sign-in fields and agreements never reach the model.
    expect(asked.join()).not.toMatch(/Old Street|Login name|privacy policy|accept the terms/);
    // The missing answer is asked once, in the dashboard.
    expect(db.prepare('SELECT question FROM form_questions').pluck().all()).toEqual([
      'Desired annual salary',
    ]);
    // A second click changes nothing that has a value.
    await worker.evaluate(
      `(async () => { const [t] = await chrome.tabs.query({ url: '${formUrl}' }); await fill(t.id, 1); })()`,
    );
    expect(await page.evaluate('[fn.value, ad.value, cv.files.length]')).toEqual([
      p.first_name,
      '12 Old Street',
      1,
    ]);
    await page.close();
  }, 60_000);
});

describe('learning from the user', () => {
  it('keeps what the user typed when they go on, and fills it next time', async () => {
    const worker = await (
      await browser.waitForTarget((t) => t.url().endsWith('/background.js'))
    ).worker();
    if (!worker) throw new Error('no worker');
    const fillTab = () =>
      worker.evaluate(
        `(async () => { const [t] = await chrome.tabs.query({ url: '${formUrl}' }); await fill(t.id, 1); })()`,
      );
    const page = await browser.newPage();
    await page.goto(formUrl);
    await fillTab();
    await page.bringToFront();
    await page.type('#sal', '200,000 EGP a year');
    await page.type('#mid', 'Mohamed');
    await page.type('#lg', 'my-login');
    await page.select('#np', 'b'); // corrects what the add-on chose
    await page.click('button');
    await vi.waitFor(
      () => {
        expect(db.prepare('SELECT count(*) FROM learned_answers').pluck().get()).toBeGreaterThan(0);
      },
      { timeout: 5000 },
    );
    const learned = Object.fromEntries(
      learnedAnswers(db).map((x) => [x.question_norm, [x.value, x.source]]),
    );
    expect(learned['desired annual salary']).toEqual(['200,000 EGP a year', 'typed']);
    expect(learned['middle name']).toEqual(['Mohamed', 'typed']);
    expect(learned['notice period']).toEqual(['1 month', 'typed']);
    expect(learned['do you have linux experience']).toEqual(['Yes', 'kept']);
    // Contact details, sign-in fields, agreements, existing values: never.
    expect(Object.keys(learned).join()).not.toMatch(
      /email|first name|last name|login|agree|address/,
    );
    await page.close();

    const again = await browser.newPage();
    await again.goto(formUrl);
    asked.length = 0;
    await fillTab();
    expect(await again.evaluate('[sal.value, mid.value, np.value]')).toEqual([
      '200,000 EGP a year',
      'Mohamed',
      'b',
    ]);
    expect(asked.join()).not.toContain('"question": "Middle name"'); // no model call for it
    await again.close();
    // Learned: no longer waiting in the dashboard.
    expect(pendingQuestions(db)).toEqual([]);
    expect(forget(db, 'middle name')).toBe(true);
  }, 60_000);

  it('learns short general facts only', () => {
    const item = (label: string, value: string, inputType = 'text') => ({
      label,
      value,
      inputType,
      name: '',
      kind: 'text' as const,
      source: 'typed' as const,
    });
    for (const [l, v, t] of [
      ['Postal code *', '11765'],
      ['Middle name', 'Mohamed'],
      ['Title', 'Mr'],
      ['Highest education', "Bachelor's Degree"],
      ['Desired annual salary', '200000'],
    ] as [string, string, string?][])
      expect(notLearnable(item(l, v, t), 'Acme'), l).toBeNull();
    for (const [l, v, t] of [
      ['Email', 'a@b.c'],
      ['Contact', '0100 000 0000 1'],
      ['Mobile', '1'],
      ['Last name', 'Adel'],
      ['National ID', '2990101'],
      ['Username', 'x'],
      ['Gender', 'Male'],
      ['Date of birth', '1 Jan'],
      ['Nationality', 'x'],
      ['I agree to the terms', 'Yes'],
      ['How did you hear about us?', 'LinkedIn'],
      ['Why do you want to work here?', 'Because'],
      ['Have you worked at Acme before?', 'No'],
      ['Anything', 'x'.repeat(121)],
      ['Phone extension', '1', 'tel'],
      ['x', 'y'],
    ] as [string, string, string?][])
      expect(notLearnable(item(l, v, t), 'Acme'), l).not.toBeNull();
  });
});

const CHAT = (
  title: string,
  accepts: 'paste' | 'drop' | 'nothing',
) => `<!doctype html><meta charset="utf-8">
<div id="side"><div contenteditable="true" id="search">search</div></div>
<div id="main" style="height:300px"><header>${title}</header><footer><div id="box" contenteditable="true" style="min-height:20px"></div><button id="send">Send</button></footer></div>
<script>
 window.files = []; window.sent = 0; window.keys = [];
 send.onclick = () => window.sent++;
 document.addEventListener('keydown', (e) => window.keys.push(e.key), true);
 const preview = (f) => { window.files.push([f.name, f.type, f.size]); const d = document.createElement('div');
   d.innerHTML = '<div contenteditable="true" id="cap" style="min-height:20px"></div>'; document.body.append(d); };
 document.addEventListener('paste', (e) => { e.preventDefault(); const f = e.clipboardData.files[0];
   if (f) { if ('${accepts}' === 'paste') preview(f); return; }
   const el = e.target.closest('[contenteditable]'); el.innerText += e.clipboardData.getData('text/plain'); });
 main.addEventListener('drop', (e) => { e.preventDefault(); if ('${accepts}' === 'drop') preview(e.dataTransfer.files[0]); });
</script>`;

describe('WhatsApp applications', () => {
  const script = readFileSync('extension/whatsapp.js', 'utf8');
  const run = async (html: string) => {
    const page = await browser.newPage();
    await page.setContent(html);
    await page.evaluate(script);
    const msg = {
      phone: '201000000000',
      text: 'Dear team,\n\nMy CV is attached.',
      file: { name: 'Ahmed-Khater-CV.pdf', base64: Buffer.from('%PDF').toString('base64') },
    };
    const result = (await page.evaluate(`window.__jobAgentWa.prepare(${JSON.stringify(msg)})`)) as {
      attached?: boolean;
      wrote?: boolean;
      error?: string;
    };
    const state = (await page.evaluate(
      `({ files: window.files, sent: window.sent, keys: window.keys, box: box.innerText, search: search.innerText, cap: document.getElementById('cap')?.innerText ?? null })`,
    )) as {
      files: unknown[];
      sent: number;
      keys: string[];
      box: string;
      search: string;
      cap: string | null;
    };
    await page.close();
    expect(state.sent).toBe(0); // never presses Send
    expect(state.keys).toEqual([]); // nor Enter
    expect(state.search).toBe('search');
    return { result, state };
  };

  it('puts the CV and the message in, by paste or by drop', async () => {
    for (const how of ['paste', 'drop'] as const) {
      const { result, state } = await run(CHAT('+20 100 000 0000', how));
      expect(result).toMatchObject({ attached: true, wrote: true });
      expect(state.files).toEqual([['Ahmed-Khater-CV.pdf', 'application/pdf', 4]]);
      expect(state.cap).toContain('My CV is attached.');
      expect(state.box.trim()).toBe('');
    }
  }, 60_000);

  it('says so when the file was not taken, and refuses the wrong chat or a draft', async () => {
    const none = await run(CHAT('Acme HR', 'nothing'));
    expect(none.result).toMatchObject({ attached: false, wrote: true });
    expect(none.state.box).toContain('Dear team');
    const wrong = await run(CHAT('+20 111 111 1111', 'paste'));
    expect(wrong.result.error).toContain('not the job');
    expect(wrong.state.files).toEqual([]);
    const draft = await run(
      CHAT('Acme HR', 'paste').replace(
        'style="min-height:20px"></div><button',
        'style="min-height:20px">half a message</div><button',
      ),
    );
    expect(draft.result.error).toContain('already has text');
    expect(draft.state.files).toEqual([]);
  }, 60_000);

  it('the server offers only WhatsApp jobs there, with the plain CV name', async () => {
    db.prepare(
      `INSERT INTO jobs (id, raw_item_id, title, title_norm, apply_channel, apply_phone, fingerprint, status, created_at, updated_at)
       VALUES (7, 1, 'IT Support', 'it support', 'whatsapp_dm', '0100 000 0000', 'f7', 'ready', 'now', 'now')`,
    ).run();
    db.prepare(
      `INSERT INTO applications (job_id, channel, mode, created_at, cv_pdf, cover_text) VALUES (7, 'whatsapp_dm', 'manual', 'now', ?, 'Dear team,')`,
    ).run(join(dir, 'CV.pdf'));
    const post = (path: string, payload: object) =>
      app.inject({
        method: 'POST',
        url: path,
        headers: {
          host: `127.0.0.1:${String(cfg.dashboard.port)}`,
          'content-type': 'application/json',
          origin: EXTENSION_ORIGIN,
        },
        payload,
      });
    recent = 7;
    const j = (await post('/api/ext/jobs', { url: 'https://web.whatsapp.com/' })).json<{
      jobs: { id: number }[];
      job_id: number;
      whatsapp: boolean;
    }>();
    expect([j.whatsapp, j.job_id, j.jobs.map((x) => x.id)]).toEqual([true, 7, [7]]);
    expect((await post('/api/ext/whatsapp', { job_id: 7 })).json()).toMatchObject({
      phone: '201000000000',
      text: 'Dear team,',
      file: { name: 'CV.pdf' },
    });
    expect((await post('/api/ext/whatsapp', { job_id: 1 })).statusCode).toBe(400);
    recent = null;
  });
});

describe('the server side', () => {
  const post = (path: string, payload: unknown, origin?: string) =>
    app.inject({
      method: 'POST',
      url: path,
      headers: {
        host: `127.0.0.1:${String(cfg.dashboard.port)}`,
        'content-type': 'application/json',
        ...(origin ? { origin } : {}),
      },
      payload: payload as object,
    });

  it('the manifest key gives exactly the origin the server trusts', () => {
    const m = JSON.parse(readFileSync('extension/manifest.json', 'utf8')) as {
      key: string;
      permissions: string[];
      host_permissions: string[];
    };
    const id = [
      ...createHash('sha256').update(Buffer.from(m.key, 'base64')).digest().subarray(0, 16),
    ]
      .map((b) => String.fromCharCode(97 + (b >> 4), 97 + (b & 15)))
      .join('');
    expect(EXTENSION_ORIGIN).toBe(`chrome-extension://${id}`);
    // No access to any website until the user clicks the add-on on it.
    expect(m.permissions).toEqual(['activeTab', 'scripting', 'storage']);
    expect(m.host_permissions).toEqual(['http://127.0.0.1/*']);
  });

  it('answers only the add-on, and the add-on reaches nothing else', async () => {
    const body = { url: 'https://careers.acme.example/a' };
    expect((await post('/api/ext/jobs', body, EXTENSION_ORIGIN)).statusCode).toBe(200);
    for (const o of [
      undefined,
      'https://evil.example',
      'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      `http://127.0.0.1:${String(cfg.dashboard.port)}`,
    ])
      expect((await post('/api/ext/jobs', body, o)).statusCode, o).toBe(403);
    expect((await post('/api/ext/answer', {}, 'https://evil.example')).statusCode).toBe(403);
    expect(
      (await post('/api/jobs/bulk', { ids: [1], action: 'skip' }, EXTENSION_ORIGIN)).statusCode,
    ).toBe(403);
  });

  it('refuses boards and jobs that are not waiting, and picks the job when it is clear', async () => {
    const jobs = async (url: string) =>
      (await post('/api/ext/jobs', { url }, EXTENSION_ORIGIN)).json<{
        job_id: number | null;
        refused: string | null;
      }>();
    expect((await jobs('https://linkedin.com/jobs/view/1')).refused).toContain('job board');
    expect((await jobs('https://new.example/apply')).job_id).toBeNull();
    recent = 2;
    expect((await jobs('https://new.example/apply')).job_id).toBe(2);
    recent = 99; // not a waiting job
    expect((await jobs('https://new.example/apply')).job_id).toBeNull();
    recent = null;
    const answer = (job_id: number, url: string) =>
      post('/api/ext/answer', { job_id, url, fields: [] }, EXTENSION_ORIGIN);
    expect((await answer(1, 'https://linkedin.com/jobs/view/1')).statusCode).toBe(400);
    expect((await answer(99, 'https://careers.acme.example/a')).statusCode).toBe(400);
    expect((await answer(2, 'https://careers.acme.example/step1')).statusCode).toBe(200);
    expect((await jobs('https://careers.acme.example/step2')).job_id).toBe(2); // the next step
    expect(db.prepare('SELECT apply_url_direct FROM jobs WHERE id = 2').pluck().get()).toBe(
      'https://careers.acme.example/step1',
    );
  });
});
