// P2 gate without Claude: replays the recorded model outputs (test/fixtures/llm) through
// the real pipeline, against the committed example profile and example config.
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { FIXTURE_RUN_DATE, RECORDINGS_DIR } from '../../src/cli/run-fixtures.js';
import { parseConfig } from '../../src/config.js';
import { ReplayLlm } from '../../src/llm/replay.js';
import type { ExtractedJob } from '../../src/llm/schemas.js';
import { compareWithExpected, runFixtures } from '../../src/pipeline/dry-run.js';
import { checkExtractedJob } from '../../src/pipeline/extract.js';
import {
  combineScores,
  experienceScore,
  hardFilter,
  scamSignals,
} from '../../src/pipeline/score.js';
import { TitleMatcher } from '../../src/pipeline/titles.js';
import {
  dropUnconfirmed,
  loadProfile,
  parseProfile,
  profileForPrompt,
} from '../../src/profile/load.js';
import { loadDotEnv } from '../../src/util/env.js';
import { loadFixtures } from '../helpers/fixtures.js';

const raw = parse(readFileSync('config/config.example.yaml', 'utf8')) as Record<
  string,
  Record<string, unknown>
>;
raw['digest'] = { ...raw['digest'], to: 'someone@example.com' };
const cfg = parseConfig(raw);
const profile = loadProfile('profile/master_profile.example.yaml');
const matcher = TitleMatcher.fromFile('config/titles.yaml');

describe('P2 gate on recorded model outputs', () => {
  it("reproduces every fixture's expected fields", async () => {
    const run = await runFixtures({
      cfg,
      profile,
      matcher,
      llm: new ReplayLlm(RECORDINGS_DIR),
      fixtures: loadFixtures(),
      runDate: FIXTURE_RUN_DATE,
      log: pino({ level: 'silent' }),
    });
    expect(run.status).toBe('success');
    expect(compareWithExpected(run)).toEqual([]);
    const statuses = run.db
      .prepare('SELECT status, COUNT(*) AS n FROM jobs GROUP BY status')
      .all() as { status: string; n: number }[];
    expect(statuses.map((s) => s.status).sort()).toEqual(['needs_review', 'new', 'skipped']);
  });
});

const baseJob: ExtractedJob = {
  title: 'DevOps Engineer',
  company: 'Acme',
  location: 'Cairo',
  country: 'Egypt',
  work_mode: 'onsite',
  seniority: 'unknown',
  years_min: 1,
  requirements: [],
  nice_to_have: [],
  apply_channel: 'email',
  apply_email: 'hr@acme.example',
  apply_url: null,
  apply_phone: null,
  subject_hint: null,
  deadline: null,
  language: 'en',
  eligibility: [],
  scam_signals: [],
};

describe('extraction post-validation (PLAN 5.3)', () => {
  const src =
    'DevOps Engineer at Acme. CV to HR@acme.example or apply https://acme.example/jobs/1?utm_source=wa';

  it('keeps an email that appears literally in the post', () => {
    expect(checkExtractedJob(baseJob, src).apply_email).toBe('hr@acme.example');
  });

  it('drops an email the model invented and flags it', () => {
    const j = checkExtractedJob({ ...baseJob, apply_email: 'attacker@evil.example' }, src);
    expect(j.apply_email).toBeNull();
    expect(j.flags).toContain('email_unverified');
  });

  it('keeps a URL only when it is in the post, canonicalized', () => {
    expect(
      checkExtractedJob({ ...baseJob, apply_url: 'https://acme.example/jobs/1' }, src).apply_url,
    ).toBe('https://acme.example/jobs/1');
    const bad = checkExtractedJob({ ...baseJob, apply_url: 'https://evil.example/x' }, src);
    expect(bad.apply_url).toBeNull();
    expect(bad.flags).toContain('url_unverified');
  });

  it('flags model-reported scam signals', () => {
    expect(
      checkExtractedJob({ ...baseJob, scam_signals: ['asks for a fee'] }, src).flags,
    ).toContain('suspicious');
  });
});

describe('hard filters and scam rules (PLAN 5.5)', () => {
  const ctx = { cfg, matcher, runDate: '2026-11-20' };
  const job = (over: Partial<ExtractedJob>) =>
    checkExtractedJob({ ...baseJob, ...over }, 'hr@acme.example');

  it('skips more years than allowed, past deadlines and other countries; keeps all of Egypt and remote', () => {
    expect(hardFilter(job({ years_min: 5 }), ctx).reason).toBe('over_experience');
    expect(hardFilter(job({ years_min: 3, seniority: 'senior' }), ctx).reason).toBeNull();
    expect(hardFilter(job({ deadline: '2026-11-01' }), ctx).reason).toBe('deadline_passed');
    expect(hardFilter(job({ location: 'Riyadh', country: 'Saudi Arabia' }), ctx).reason).toBe(
      'location',
    );
    expect(
      hardFilter(job({ location: 'Riyadh', country: 'Saudi Arabia', work_mode: 'remote' }), ctx)
        .reason,
    ).toBeNull();
    expect(hardFilter(job({ location: 'Alexandria', country: 'Egypt' }), ctx).reason).toBeNull();
    expect(hardFilter(job({ location: null, country: null }), ctx).reason).toBeNull();
  });

  it('scores fresh and 0-2 year posts higher on experience, and combines it with skills (D21)', () => {
    expect(experienceScore(job({ seniority: 'junior', years_min: null }), cfg)).toBe(100);
    expect(experienceScore(job({ years_min: 0 }), cfg)).toBe(100);
    expect(experienceScore(job({ years_min: 1 }), cfg)).toBe(90);
    expect(experienceScore(job({ years_min: 2 }), cfg)).toBe(80);
    expect(experienceScore(job({ years_min: 3 }), cfg)).toBe(60);
    expect(experienceScore(job({ years_min: null }), cfg)).toBe(70);
    // Same skills, fresher post ranks higher.
    expect(combineScores(70, 100, cfg)).toBeGreaterThan(combineScores(70, 60, cfg));
    expect(combineScores(80, 100, cfg)).toBe(86);
  });

  it('detects scam patterns in English and Arabic', () => {
    expect(scamSignals('Pay a 1500 EGP training fee to start')).toContain('fee');
    expect(scamSignals('Earn $150/day from home')).toContain('earnings_promise');
    expect(scamSignals('Contact us on Telegram only')).toContain('telegram_only');
    expect(scamSignals('مطلوب دفع رسوم التدريب')).toContain('fee');
    expect(scamSignals('DevOps Engineer, AWS, Terraform. CV to hr@acme.example')).toEqual([]);
  });
});

describe('profile loader (PLAN 8.1, D11)', () => {
  it('drops items marked confirmed: false', () => {
    expect(dropUnconfirmed({ a: [{ id: 'x' }, { id: 'y', confirmed: false }] })).toEqual({
      a: [{ id: 'x' }],
    });
  });

  it('rejects evidence that points at an id that does not exist', () => {
    const p = parse(readFileSync('profile/master_profile.example.yaml', 'utf8')) as {
      specialisms: { devops: { evidence: string[]; detailed_projects: string[] } };
      default_specialism: string;
    };
    p.specialisms.devops.evidence.push('made_up_fact');
    expect(() => parseProfile(p)).toThrow(/unknown evidence made_up_fact/);
    p.specialisms.devops.evidence.pop();
    p.specialisms.devops.detailed_projects.push('no_such_project');
    expect(() => parseProfile(p)).toThrow(/unknown project no_such_project/);
    p.specialisms.devops.detailed_projects.pop();
    p.default_specialism = 'astronaut';
    expect(() => parseProfile(p)).toThrow(/default_specialism astronaut/);
  });

  it('never puts contact details into the scoring prompt', () => {
    const text = profileForPrompt(profile);
    expect(text).not.toContain(profile.candidate.email);
    expect(text).not.toContain(profile.candidate.phone);
  });
});

describe('.env loader (security A6)', () => {
  it('parses values without exporting them and warns on loose permissions', () => {
    const d = mkdtempSync(join(tmpdir(), 'env-test-'));
    const f = join(d, '.env');
    writeFileSync(f, '# c\nexport A="1"\nB=two\n');
    chmodSync(f, 0o644);
    const env = loadDotEnv(f);
    expect(env.values).toEqual({ A: '1', B: 'two' });
    expect(env.warnings[0]).toMatch(/chmod 600/);
    expect(process.env['B']).toBeUndefined();
    rmSync(d, { recursive: true, force: true });
  });
});
