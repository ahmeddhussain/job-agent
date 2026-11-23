// D37-D41 without the network: LinkedIn search (saved real page, refusals, windows), the
// settings writer, company lists in scoring, "Not a fit" with draft deletion and learned
// rules, bulk actions, follow-up drafts, interview prep, the source scoreboard, and the
// dashboard endpoints for them.
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  collectLinkedinSearch,
  getWith429Retry,
  parseSearchCards,
} from '../../src/collect/linkedin.js';
import { loadConfig, parseConfig, type Config } from '../../src/config.js';
import {
  applySuggestion,
  bulk,
  discardJob,
  draftFollowup,
  followupsDue,
  interviewPrep,
  sourceScoreboard,
  suggestions,
} from '../../src/dashboard/actions.js';
import { RunManager } from '../../src/dashboard/runner.js';
import { buildDashboard } from '../../src/dashboard/server.js';
import { migrate, openDb, type Db } from '../../src/db/index.js';
import type { GmailWriter } from '../../src/gmail/client.js';
import type { Llm, LlmRequest } from '../../src/llm/types.js';
import type { CheckedJob } from '../../src/pipeline/extract.js';
import { hardFilter } from '../../src/pipeline/score.js';
import { TitleMatcher } from '../../src/pipeline/titles.js';
import { loadProfile } from '../../src/profile/load.js';
import { readSettings, SettingsError, updateSettings } from '../../src/settings.js';
import { PoliteHttp } from '../../src/util/http.js';

const log = pino({ level: 'silent' });
const NOW = new Date('2026-11-23T12:00:00Z');
let dir: string;
let cfgPath: string;
let titlesPath: string;
let cfg: Config;
const profile = loadProfile('profile/master_profile.example.yaml');

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'p9-'));
  cfgPath = join(dir, 'config.yaml');
  titlesPath = join(dir, 'titles.yaml');
  const text = readFileSync('config/config.example.yaml', 'utf8')
    .replace('to: TODO@gmail.com', 'to: me@example.com')
    .replace('titles: config/titles.yaml', `titles: ${titlesPath}`);
  writeFileSync(cfgPath, text);
  copyFileSync('config/titles.yaml', titlesPath);
  cfg = loadConfig(cfgPath);
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function db(): Db {
  const d = openDb(':memory:');
  migrate(d);
  d.prepare(
    `INSERT INTO raw_items (source, source_ref, source_name, posted_at, collected_at, text, content_hash)
     VALUES ('linkedin', '1', 'LinkedIn search: DevOps Engineer', 'now', 'now', 't', 'h')`,
  ).run();
  return d;
}
function addJob(
  d: Db,
  title: string,
  company: string,
  status = 'ready',
  channel = 'email',
): number {
  return Number(
    d
      .prepare(
        `INSERT INTO jobs (raw_item_id, title, title_norm, company, apply_channel, apply_email, fingerprint, flags, status, created_at, updated_at)
         VALUES (1, ?, ?, ?, ?, 'hr@x.example', 'f', '[]', ?, 'now', 'now')`,
      )
      .run(title, title.toLowerCase(), company, channel, status).lastInsertRowid,
  );
}
function fakeGmail(log: string[] = [], existing = new Set<string>(['d1'])): GmailWriter {
  return {
    myAddress: () => Promise.resolve('me@example.com'),
    search: () => Promise.resolve([]),
    getMessage: () => Promise.reject(new Error('unused')),
    createDraft: (raw, threadId) => {
      log.push(`draft:${threadId ?? '-'}:${raw.length > 0 ? 'mime' : 'empty'}`);
      return Promise.resolve({ draftId: 'fd', messageId: 'fm', threadId: threadId ?? 't' });
    },
    deleteOwnDraft: (id) => {
      log.push(`delete:${id}`);
      return Promise.resolve();
    },
    draftExists: (id) => Promise.resolve(existing.has(id)),
    threadMessages: () => Promise.resolve([]),
    sendRaw: () => Promise.reject(new Error('unused')),
    sendDraft: () => Promise.reject(new Error('unused')),
  };
}
function fakeHttp(pages: (url: string) => { status: number; body: string }, calls: string[] = []) {
  return new PoliteHttp({
    userAgent: 't',
    minIntervalMs: 0,
    resolve: () => Promise.resolve(['93.184.216.34']),
    fetchImpl: ((input: URL | string) => {
      calls.push(String(input));
      const p = pages(String(input));
      return Promise.resolve(
        new Response(p.body, { status: p.status, headers: { 'retry-after': '0' } }),
      );
    }) as typeof fetch,
  });
}

describe('LinkedIn search (D38)', () => {
  const page = readFileSync('test/fixtures/pages/linkedin-search-cloud.html', 'utf8');
  it('parses the cards of a saved real results page', () => {
    const cards = parseSearchCards(page);
    expect(cards).toHaveLength(10);
    expect(cards[0]).toMatchObject({
      id: '4460388911',
      title: 'Senior Cloud Engineer - AI-ML Platform (all genders)',
      company: 'Merck Group',
      location: 'Cairo, Cairo, Egypt',
      url: 'https://linkedin.com/jobs/view/4460388911',
    });
    expect(cards[0]?.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('retries a refused page, stores matching titles only, advances the window', async () => {
    const d = db();
    let refusedOnce = false;
    const calls: string[] = [];
    const http = fakeHttp((u) => {
      if (!refusedOnce) {
        refusedOnce = true;
        return { status: 429, body: '' };
      }
      return { status: 200, body: new URL(u).searchParams.get('start') === '0' ? page : '' };
    }, calls);
    const r = await collectLinkedinSearch({
      http,
      db: d,
      cfg: {
        ...cfg,
        search: {
          linkedin: { ...cfg.search.linkedin, titles: ['Cloud Engineer'], retry_wait_seconds: 5 },
        },
      },
      matcher: TitleMatcher.fromFile('config/titles.yaml'),
      now: NOW,
      log,
      sleep: () => Promise.resolve(),
    });
    expect(r.refused).toBe(0); // the retry succeeded
    expect(r.results[0]).toMatchObject({ found: 10, complete: true });
    const stored = d
      .prepare(`SELECT source_ref FROM raw_items WHERE source = 'linkedin' AND source_ref <> '1'`)
      .pluck()
      .all();
    expect(stored.length).toBe(r.inserted);
    expect(stored.length).toBeGreaterThan(0);
    expect(stored.length).toBeLessThan(10); // not every listed title is a priority title
    expect(calls[0]).toContain('f_TPR=r86400'); // first run: 24 h
    expect(
      d
        .prepare(`SELECT 1 FROM source_state WHERE source = 'linkedin:Cloud Engineer|Egypt'`)
        .pluck()
        .get(),
    ).toBe(1);
  });

  it('a page still refused after the retries keeps the old window for the next run', async () => {
    const d = db();
    const http = fakeHttp(() => ({ status: 429, body: '' }));
    const r = await collectLinkedinSearch({
      http,
      db: d,
      cfg: {
        ...cfg,
        search: {
          linkedin: { ...cfg.search.linkedin, titles: ['Cloud Engineer'], retry_wait_seconds: 5 },
        },
      },
      matcher: TitleMatcher.fromFile('config/titles.yaml'),
      now: NOW,
      log,
      sleep: () => Promise.resolve(),
    });
    expect(r.refused).toBe(1);
    expect(r.results[0]?.complete).toBe(false);
    expect(d.prepare(`SELECT count(*) FROM source_state`).pluck().get()).toBe(0);
  });

  it('getWith429Retry gives up on other errors at once', async () => {
    let n = 0;
    const http = fakeHttp(() => {
      n++;
      return { status: 404, body: '' };
    });
    await expect(
      getWith429Retry(http, 'https://www.linkedin.com/x', 3, 1, () => Promise.resolve()),
    ).rejects.toThrow(/404/);
    expect(n).toBe(1);
  });
});

describe('settings written to the YAML files (D39)', () => {
  it('changes titles, switches and lists, keeps comments, validates, keeps a .bak', () => {
    const before = readFileSync(cfgPath, 'utf8');
    const c = updateSettings(cfgPath, titlesPath, {
      search_titles: ['DevOps Engineer', 'SRE', 'SRE ', ''],
      alerts_enabled: false,
      blocked_companies: ['Acme Corp'],
      thresholds: { p1: 50, p2: 60, p3: 80 },
      excluded_titles: ['sales', '\\bqa\\b'],
    });
    expect(c.search.linkedin.titles).toEqual(['DevOps Engineer', 'SRE']);
    expect(c.alerts.enabled).toBe(false);
    expect(readFileSync(cfgPath, 'utf8')).toContain('# D38'); // comments kept
    expect(readFileSync(`${cfgPath}.bak`, 'utf8')).toBe(before);
    expect(readSettings(c).excluded_titles).toEqual(['sales', '\\bqa\\b']);
    expect(TitleMatcher.fromFile(titlesPath).classify('QA Engineer').tier).toBeNull();
  });
  it('refuses invalid values without touching the file', () => {
    const before = readFileSync(cfgPath, 'utf8');
    expect(() => updateSettings(cfgPath, titlesPath, { search_locations: [] })).toThrow(
      SettingsError,
    );
    expect(() => updateSettings(cfgPath, titlesPath, { excluded_titles: ['(unclosed'] })).toThrow(
      SettingsError,
    );
    expect(readFileSync(cfgPath, 'utf8')).toBe(before);
  });
});

describe('company lists in scoring (D39)', () => {
  it('blocked companies are skipped before scoring', () => {
    const c = parseConfig({ ...(parse(readFileSync(cfgPath, 'utf8')) as object) });
    const job = {
      title: 'DevOps Engineer',
      company: 'ACME corp.',
      years_min: null,
      deadline: null,
      country: 'Egypt',
      work_mode: 'onsite',
    } as CheckedJob;
    const ctx = {
      cfg: { ...c, preferences: { blocked_companies: ['Acme'], favorite_companies: [] } },
      matcher: TitleMatcher.fromFile('config/titles.yaml'),
      runDate: '2026-11-23',
    };
    expect(hardFilter(job, ctx).reason).toBe('blocked_company');
  });
});

describe('"Not a fit" and what the agent learns (D39)', () => {
  it('skips the job with the reason and deletes only its own unsent draft', async () => {
    const d = db();
    const id = addJob(d, 'QA Automation Engineer', 'Acme');
    d.prepare(
      `INSERT INTO applications (job_id, channel, gmail_draft_id, mode, created_at) VALUES (?, 'email', 'd1', 'draft', 'now')`,
    ).run(id);
    const events: string[] = [];
    const r = await discardJob(d, fakeGmail(events), id, 'wrong_field', null);
    expect(r.draftDeleted).toBe(true);
    expect(events).toEqual(['delete:d1']);
    expect(d.prepare('SELECT status, skip_reason FROM jobs WHERE id = ?').get(id)).toEqual({
      status: 'skipped',
      skip_reason: 'discarded: wrong_field',
    });
    expect(
      d.prepare('SELECT gmail_draft_id FROM applications WHERE job_id = ?').pluck().get(id),
    ).toBeNull();
    const applied = addJob(d, 'DevOps Engineer', 'Beta', 'applied');
    await expect(discardJob(d, fakeGmail(), applied, 'other', null)).rejects.toThrow(
      /already applied/,
    );
  });

  it('suggests a title word after 2 wrong-field discards and a company after a company discard; apply writes the rule', async () => {
    const d = db();
    addJob(d, 'DevOps Engineer', 'Gamma'); // a kept job: "devops" must never be suggested
    for (const t of ['Data Scientist', 'Senior Data Analyst'])
      await discardJob(d, null, addJob(d, t, 'Zeta'), 'wrong_field', null);
    await discardJob(d, null, addJob(d, 'Cloud Engineer', 'Spammy Recruiters'), 'company', null);
    const s = suggestions(d, cfg);
    expect(s.map((x) => x.key)).toEqual(
      expect.arrayContaining([
        'exclude_title:data',
        'block_company:spammy recruiters',
        'block_company:zeta',
      ]),
    );
    expect(s.some((x) => x.value === 'devops')).toBe(false);
    const data = s.find((x) => x.key === 'exclude_title:data');
    if (!data) throw new Error('no data suggestion');
    const c2 = applySuggestion(cfgPath, cfg, data);
    expect(TitleMatcher.fromFile(c2.paths.titles).classify('Data Engineer').tier).toBeNull();
    expect(suggestions(d, c2).some((x) => x.key === 'exclude_title:data')).toBe(false);
  });

  it('bulk actions apply to each job and report failures', async () => {
    const d = db();
    const a = addJob(d, 'A', 'x', 'skipped'),
      b = addJob(d, 'B', 'y', 'applied');
    expect(await bulk(d, null, [a], 'prepare')).toEqual({ done: 1, failed: [] });
    expect(d.prepare('SELECT status FROM jobs WHERE id = ?').pluck().get(a)).toBe('new');
    const r = await bulk(d, null, [a, b], 'discard', 'other');
    expect(r.done).toBe(1);
    expect(r.failed[0]).toMatch(/already applied/);
  });
});

describe('follow-ups (D40), interview prep (D41), scoreboard', () => {
  it('lists email applications without a reply after N days and drafts in the same thread', async () => {
    const d = db();
    const id = addJob(d, 'DevOps Engineer', 'Acme', 'applied');
    d.prepare(
      `INSERT INTO applications (job_id, channel, to_email, subject, gmail_thread_id, mode, created_at, sent_at)
      VALUES (?, 'email', 'hr@x.example', 'Application – DevOps Engineer', 'th1', 'draft', 'now', '2026-11-10T10:00:00Z')`,
    ).run(id);
    expect(followupsDue(d, cfg, NOW).map((f) => f.job_id)).toEqual([id]);
    const events: string[] = [];
    await draftFollowup(d, fakeGmail(events), profile, id);
    expect(events).toEqual(['draft:th1:mime']); // in the original thread
    expect(followupsDue(d, cfg, NOW)).toEqual([]); // drafted once
  });

  it('interview prep keeps only real profile ids as evidence', async () => {
    const d = db();
    const id = addJob(d, 'DevOps Engineer', 'Acme');
    const llm: Llm = {
      call: <T>(req: LlmRequest<T>) =>
        Promise.resolve(
          req.schema.parse({
            questions: [1, 2, 3].map((i) => ({
              question: `Q${String(i)}`,
              why: 'w',
              answer_points: ['p'],
              evidence: ['nexora', 'made_up_id'],
            })),
            gaps: [{ gap: 'Azure', how: 'AWS equivalent' }],
            questions_to_ask: ['?'],
          }),
        ),
    };
    const p = await interviewPrep(d, llm, cfg, profile, id);
    expect(p.questions[0]?.evidence).not.toContain('made_up_id');
    expect(
      JSON.parse(
        d.prepare('SELECT interview_prep FROM jobs WHERE id = ?').pluck().get(id) as string,
      ),
    ).toEqual(p);
  });

  it('scoreboard groups jobs by source', () => {
    const d = db();
    addJob(d, 'A', 'x', 'applied');
    addJob(d, 'B', 'y', 'skipped');
    expect(sourceScoreboard(d)).toEqual([
      {
        source: 'linkedin',
        name: 'LinkedIn search: DevOps Engineer',
        jobs: 2,
        matched: 1,
        prepared: 1,
        applied: 1,
        replies: 0,
      },
    ]);
  });
});

describe('dashboard endpoints (D39-D41)', () => {
  const H = { host: '127.0.0.1:8080', 'content-type': 'application/json' };
  it('settings, discard, suggestions and run now', async () => {
    const d = db();
    const id = addJob(d, 'QA Engineer', 'Omega Staffing');
    const runner = new RunManager({
      cmd: 'node',
      args: () => ['-e', "console.log('collect linkedin: ok')"],
    });
    const app = buildDashboard(cfg, d, {
      configPath: cfgPath,
      gmail: () => Promise.resolve(null),
      runner,
    });
    const s = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: H,
      payload: { search_titles: ['DevOps Engineer', 'SRE'] },
    });
    expect(s.statusCode).toBe(200);
    expect(loadConfig(cfgPath).search.linkedin.titles).toEqual(['DevOps Engineer', 'SRE']);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/settings',
          headers: H,
          payload: { search_titles: 'x' },
        })
      ).statusCode,
    ).toBe(400);
    const dis = await app.inject({
      method: 'POST',
      url: `/api/jobs/${String(id)}/discard`,
      headers: H,
      payload: { reason: 'company' },
    });
    expect(dis.statusCode).toBe(200);
    expect(dis.json<{ suggestions: { key: string }[] }>().suggestions.map((x) => x.key)).toContain(
      'block_company:omega staffing',
    );
    const start = await app.inject({
      method: 'POST',
      url: '/api/run',
      headers: H,
      payload: { kind: 'queue' },
    });
    expect(start.json<{ running: boolean }>().running).toBe(true);
    for (let i = 0; i < 50 && runner.status().running; i++)
      await new Promise((r) => setTimeout(r, 100));
    const st = (
      await app.inject({ method: 'GET', url: '/api/run', headers: { host: H.host } })
    ).json<{ exit_code: number; lines: string[] }>();
    expect(st.exit_code).toBe(0);
    expect(st.lines).toContain('collect linkedin: ok');
    const font = await app.inject({
      method: 'GET',
      url: '/fonts/Inter.woff2',
      headers: { host: H.host },
    });
    expect(font.headers['content-type']).toBe('font/woff2');
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/fonts/..%2Fpackage.json',
          headers: { host: H.host },
        })
      ).statusCode,
    ).toBe(404);
  });
});

describe('audit follow-ups (D42) and dashboard actions (D43)', () => {
  const H = { host: '127.0.0.1:8080', 'content-type': 'application/json' };
  it('the optional senior-title rule skips Senior titles unless the post asks for 2 years or fewer', () => {
    const base = {
      title: 'Senior DevOps Engineer',
      company: 'X',
      years_min: null,
      deadline: null,
      country: 'Egypt',
      work_mode: 'onsite',
    } as CheckedJob;
    const on = {
      cfg: { ...cfg, filters: { ...cfg.filters, skip_senior_titles: true } },
      matcher: TitleMatcher.fromFile('config/titles.yaml'),
      runDate: '2026-11-23',
    };
    expect(hardFilter(base, on).reason).toBe('senior_title');
    expect(hardFilter({ ...base, years_min: 2 }, on).reason).toBeNull();
    expect(hardFilter({ ...base, title: 'DevOps Engineer' }, on).reason).toBeNull();
    expect(hardFilter(base, { ...on, cfg }).reason).toBeNull(); // off by default
  });

  it('learns "skip senior" from senior jobs turned down (never applied) and a threshold from applications below it', () => {
    const d = db();
    for (const t of ['Senior DevOps Engineer', 'Lead Cloud Engineer', 'IT Manager']) {
      const id = addJob(d, t, 'Q', 'ready');
      d.prepare(
        `INSERT INTO status_history (job_id, from_status, to_status, by, at) VALUES (?, 'ready', 'rejected', 'ahmed', 'now')`,
      ).run(id);
      d.prepare(`UPDATE jobs SET status = 'rejected' WHERE id = ?`).run(id);
    }
    // A job marked applied and then rejected may be a company's rejection: not counted.
    const maybe = addJob(d, 'Senior SRE', 'Q', 'rejected');
    d.prepare(
      `INSERT INTO status_history (job_id, from_status, to_status, by, at) VALUES (?, 'ready', 'applied', 'ahmed', 'now')`,
    ).run(maybe);
    for (const f of [50, 52]) {
      const id = addJob(d, 'IT Help Desk', 'H', 'applied');
      d.prepare('UPDATE jobs SET fit_score = ?, priority = 2 WHERE id = ?').run(f, id);
    }
    const s = suggestions(d, cfg);
    expect(s.find((x) => x.kind === 'skip_senior')?.why).toMatch(/turned down 3/);
    expect(s.find((x) => x.kind === 'threshold')?.value).toBe('p2=48');
  });

  it('a company is never suggested for blocking because of job-specific reasons', async () => {
    const d = db();
    await discardJob(d, null, addJob(d, 'Senior DevOps Engineer', 'Capgemini'), 'too_senior', null);
    await discardJob(d, null, addJob(d, 'DevOps Engineer', 'Capgemini'), 'location', null);
    expect(suggestions(d, cfg).some((x) => x.kind === 'block_company')).toBe(false);
    await discardJob(d, null, addJob(d, 'Cloud Engineer', 'Capgemini'), 'company', null);
    expect(suggestions(d, cfg).map((x) => x.key)).toContain('block_company:capgemini');
  });

  it('quick add stores a post once; undo restores the status before "Not a fit"; no desktop, no apply window', async () => {
    const d = db();
    const app = buildDashboard(cfg, d, { configPath: cfgPath, gmail: () => Promise.resolve(null) });
    const text =
      'DevOps Engineer at Acme, Cairo. Linux, Docker, AWS. Send your CV to jobs@acme.example';
    const a1 = await app.inject({ method: 'POST', url: '/api/add', headers: H, payload: { text } });
    expect(a1.json<{ inserted: boolean }>().inserted).toBe(true);
    expect(
      (await app.inject({ method: 'POST', url: '/api/add', headers: H, payload: { text } })).json<{
        inserted: boolean;
      }>().inserted,
    ).toBe(false);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/add',
          headers: H,
          payload: { text: 'short' },
        })
      ).statusCode,
    ).toBe(400);

    const id = addJob(d, 'Cloud Engineer', 'Acme', 'ready');
    d.prepare(
      `INSERT INTO status_history (job_id, from_status, to_status, by, at) VALUES (?, NULL, 'ready', 'agent', 'now')`,
    ).run(id);
    await app.inject({
      method: 'POST',
      url: `/api/jobs/${String(id)}/discard`,
      headers: H,
      payload: { reason: 'other' },
    });
    const u = await app.inject({
      method: 'POST',
      url: `/api/jobs/${String(id)}/undiscard`,
      headers: H,
      payload: {},
    });
    expect(u.json<{ status: string }>().status).toBe('ready');
    expect(d.prepare('SELECT count(*) FROM discards').pluck().get()).toBe(0);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/jobs/${String(id)}/assist`,
          headers: H,
          payload: {},
        })
      ).statusCode,
    ).toBe(503);
  });
});
