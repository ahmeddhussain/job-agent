// D34/D35: real posting dates and the stale filter; form questions answered once (stored
// in the profile, comments kept, validated) and the forms that waited for them retried.
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { retryAnsweredForms } from '../../src/apply/apply.js';
import type { FormFiller } from '../../src/apply/forms.js';
import {
  allAnswered,
  answerKey,
  normQuestion,
  pendingQuestions,
  recordQuestions,
} from '../../src/apply/questions.js';
import { agoToIso } from '../../src/collect/pages/jobpage.js';
import { parseConfig, type Config } from '../../src/config.js';
import { buildDashboard } from '../../src/dashboard/server.js';
import { migrate, openDb, type Db } from '../../src/db/index.js';
import type { CheckedJob } from '../../src/pipeline/extract.js';
import { hardFilter } from '../../src/pipeline/score.js';
import { TitleMatcher } from '../../src/pipeline/titles.js';
import { AnswerError, setAnswer } from '../../src/profile/answers.js';
import { loadProfile } from '../../src/profile/load.js';

const raw = parse(readFileSync('config/config.example.yaml', 'utf8')) as Record<
  string,
  Record<string, unknown>
>;
raw['digest'] = { ...raw['digest'], to: 'me@example.com' };
let dir: string;
let profilePath: string;
let cfg: Config;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'q-'));
  profilePath = join(dir, 'profile.yaml');
  copyFileSync('profile/master_profile.example.yaml', profilePath);
  raw['paths'] = { ...raw['paths'], profile: profilePath };
  raw['apply'] = { ...raw['apply'], output_dir: join(dir, 'output') };
  cfg = parseConfig(raw);
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function db(): Db {
  const d = openDb(':memory:');
  migrate(d);
  d.prepare(
    `INSERT INTO raw_items (source, source_ref, posted_at, collected_at, text, content_hash) VALUES ('manual', 'm', 'now', 'now', 't', 'h')`,
  ).run();
  d.prepare(
    `INSERT INTO jobs (raw_item_id, title, title_norm, company, apply_channel, apply_url, fingerprint, flags, status, created_at, updated_at)
     VALUES (1, 'DevOps Engineer', 'devops engineer', 'Acme', 'form', 'https://jobs.ashbyhq.com/acme/1/application', 'f', '[]', 'ready', 'now', 'now')`,
  ).run();
  return d;
}

describe('posting dates (D34)', () => {
  const now = new Date('2026-11-23T12:00:00Z');
  it('reads LinkedIn\'s "N units ago"', () => {
    expect(agoToIso('2 days ago', now)).toBe('2026-11-21T12:00:00.000Z');
    expect(agoToIso('3 months ago', now)?.slice(0, 10)).toBe('2026-08-25');
    expect(agoToIso('Reposted 1 week ago', now)?.slice(0, 10)).toBe('2026-11-16');
    expect(agoToIso('Be among the first 25 applicants', now)).toBeNull();
  });
  it('skips jobs posted longer ago than filters.max_job_age_days', () => {
    const job = {
      title: 'DevOps Engineer',
      years_min: null,
      deadline: null,
      country: 'Egypt',
      work_mode: 'onsite',
    } as CheckedJob;
    const ctx = {
      cfg,
      matcher: TitleMatcher.fromFile('config/titles.yaml'),
      runDate: '2026-11-23',
    };
    expect(hardFilter({ ...job, job_posted_at: '2026-08-25T00:00:00Z' }, ctx).reason).toBe('stale');
    expect(hardFilter({ ...job, job_posted_at: '2026-11-20T00:00:00Z' }, ctx).reason).toBeNull();
    expect(hardFilter(job, ctx).reason).toBeNull(); // unknown date: not skipped
  });
});

describe('form questions (D35)', () => {
  it('normalizes questions and makes readable answer keys', () => {
    expect(normQuestion('Current Salary*')).toBe('current salary');
    expect(answerKey('What are your monthly salary expectations (gross)?*')).toBe(
      'what_are_your_monthly_salary_expectations_gross',
    );
  });
  it('records each question once, counts repeats, ignores filling errors', () => {
    const d = db();
    expect(
      recordQuestions(d, ['Current Salary*', 'Visa status (could not fill: x)'], 1, 'a'),
    ).toEqual(['Current Salary*']);
    expect(recordQuestions(d, ['current salary'], 1, 'b')).toEqual([]);
    const p = pendingQuestions(d);
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({
      question: 'Current Salary',
      times: 2,
      suggested_key: 'current_salary',
    });
    expect(allAnswered(d, ['Current Salary*'])).toBe(false);
    d.prepare(`UPDATE form_questions SET answer_key = 'current_salary'`).run();
    expect(allAnswered(d, ['Current Salary*'])).toBe(true);
    expect(pendingQuestions(d)).toEqual([]);
  });
});

describe('answers written to the profile', () => {
  it('adds, changes and removes an answer, keeping the comments and a backup', () => {
    const before = readFileSync(profilePath, 'utf8');
    const answers = setAnswer(profilePath, 'current_salary', 'Around 15,000 EGP per month');
    expect(answers['current_salary']).toBe('Around 15,000 EGP per month');
    const after = readFileSync(profilePath, 'utf8');
    expect(after).toContain('current_salary: Around 15,000 EGP per month');
    expect(after.match(/^#.*$/gm)).toEqual(before.match(/^#.*$/gm)); // comments kept
    expect(readFileSync(`${profilePath}.bak`, 'utf8')).toBe(before);
    expect(loadProfile(profilePath).application_answers['current_salary']).toBeDefined();
    setAnswer(profilePath, 'current_salary', '');
    expect(loadProfile(profilePath).application_answers['current_salary']).toBeUndefined();
  });
  it('refuses bad keys and multi-line or huge values', () => {
    expect(() => setAnswer(profilePath, 'Bad Key', 'x')).toThrow(AnswerError);
    expect(() => setAnswer(profilePath, '../x', 'x')).toThrow(AnswerError);
    expect(() => setAnswer(profilePath, 'ok_key', 'a\nb')).toThrow(AnswerError);
    expect(() => setAnswer(profilePath, 'ok_key', 'x'.repeat(501))).toThrow(AnswerError);
  });
});

describe('dashboard profile endpoints', () => {
  const HOST = { host: '127.0.0.1:8080', 'content-type': 'application/json' };
  it('answers a pending question once; it leaves the list and lands in the profile', async () => {
    const d = db();
    recordQuestions(d, ['Notice period in days*'], 1, 'now');
    const app = buildDashboard(cfg, d);
    const p = (await app.inject({ method: 'GET', url: '/api/profile', headers: HOST })).json<{
      questions: { id: number; suggested_key: string }[];
      answers: Record<string, string>;
    }>();
    expect(p.questions).toHaveLength(1);
    const q = p.questions[0];
    const r = await app.inject({
      method: 'PUT',
      url: '/api/profile/answers',
      headers: HOST,
      payload: { key: q?.suggested_key, value: '0 (immediate)', question_id: q?.id },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json<{ questions: unknown[] }>().questions).toEqual([]);
    expect(loadProfile(profilePath).application_answers['notice_period_in_days']).toBe(
      '0 (immediate)',
    );
    const bad = await app.inject({
      method: 'PUT',
      url: '/api/profile/answers',
      headers: HOST,
      payload: { key: 'Bad Key', value: 'x' },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('edits the cover letter of a prepared application, not of a sent one', async () => {
    const d = db();
    d.prepare(
      `INSERT INTO applications (job_id, channel, cover_text, mode, created_at) VALUES (1, 'form', 'old', 'manual', 'now')`,
    ).run();
    const app = buildDashboard(cfg, d);
    const letter = 'Dear team, '.padEnd(80, 'x');
    const r = await app.inject({
      method: 'PATCH',
      url: '/api/jobs/1',
      headers: HOST,
      payload: { cover_text: letter },
    });
    expect(r.statusCode).toBe(200);
    expect(d.prepare('SELECT cover_text FROM applications WHERE job_id = 1').pluck().get()).toBe(
      letter,
    );
    d.prepare(`UPDATE applications SET sent_at = 'now'`).run();
    const sent = await app.inject({
      method: 'PATCH',
      url: '/api/jobs/1',
      headers: HOST,
      payload: { cover_text: letter },
    });
    expect(sent.statusCode).toBe(409);
  });
});

describe('retrying forms after an answer (D35)', () => {
  it('retries only forms whose missing questions are all answered now', async () => {
    const d = db();
    d.prepare(
      `INSERT INTO applications (job_id, channel, cv_pdf, package_dir, cover_text, form_report, mode, created_at)
       VALUES (1, 'form', ?, ?, 'letter', ?, 'manual', 'now')`,
    ).run(
      join(dir, 'cv.pdf'),
      dir,
      JSON.stringify({ unanswered: ['Current Salary*'], filled: [] }),
    );
    recordQuestions(d, ['Current Salary*'], 1, 'now');
    let runs = 0;
    const forms = {
      run: () => {
        runs++;
        return Promise.resolve({
          outcome: 'submitted',
          reason: null,
          url: 'u',
          finalUrl: 'u',
          captcha: false,
          filled: [],
          unanswered: [],
          screenshots: [],
          at: 'now',
          page: { close: () => Promise.resolve() },
        });
      },
    } as unknown as FormFiller;
    const deps = {
      db: d,
      cfg,
      profile: loadProfile(profilePath),
      gmail: null,
      dryRun: false,
      now: () => new Date(),
      forms,
    };
    expect(await retryAnsweredForms(deps, () => undefined)).toEqual({ tried: 0, submitted: 0 }); // not answered yet
    d.prepare(`UPDATE form_questions SET answer_key = 'current_salary'`).run();
    expect(await retryAnsweredForms(deps, () => undefined)).toEqual({ tried: 1, submitted: 1 });
    expect(runs).toBe(1);
    expect(d.prepare('SELECT status FROM jobs WHERE id = 1').pluck().get()).toBe('applied');
    expect(d.prepare('SELECT mode FROM applications WHERE job_id = 1').pluck().get()).toBe(
      'submitted',
    );
  });
});
