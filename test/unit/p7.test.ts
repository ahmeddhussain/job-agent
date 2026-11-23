// P7 without the network or Claude: migration 002, tracking-link unwrapping, job-page
// parsers on saved real pages, company discovery, enrichment, the lock, and `agent run`
// end to end on fixtures (recorded model outputs, real PDF rendering, a fake Gmail).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  boardFromName,
  boardFromText,
  companiesToPoll,
  matchPosting,
  slugCandidates,
} from '../../src/collect/ats/discover.js';
import {
  jsonLdJobPosting,
  linkedinGuestJob,
  linkedinJobId,
} from '../../src/collect/pages/jobpage.js';
import { parseConfig, type Config } from '../../src/config.js';
import { migrate, openDb, type Db } from '../../src/db/index.js';
import type { GmailWriter } from '../../src/gmail/client.js';
import { ReplayLlm } from '../../src/llm/replay.js';
import { UsageLimitError, type Llm, type LlmRequest } from '../../src/llm/types.js';
import { insertRawItem, prepareRawItem } from '../../src/pipeline/dedupe.js';
import { enrichJob } from '../../src/pipeline/enrich.js';
import type { CheckedJob } from '../../src/pipeline/extract.js';
import { TitleMatcher } from '../../src/pipeline/titles.js';
import { loadProfile } from '../../src/profile/load.js';
import { Renderer } from '../../src/render/renderer.js';
import { runAgent, type RunDeps } from '../../src/run/orchestrator.js';
import { PoliteHttp } from '../../src/util/http.js';
import { acquireLock, LockedError } from '../../src/util/lock.js';
import { canonicalizeUrl, unwrapTracking } from '../../src/util/url.js';
import { loadFixtures } from '../helpers/fixtures.js';

const raw = parse(readFileSync('config/config.example.yaml', 'utf8')) as Record<
  string,
  Record<string, unknown>
>;
raw['digest'] = { ...raw['digest'], to: 'me@example.com' };
const cfg: Config = parseConfig(raw);
const log = pino({ level: 'silent' });
const NOW = new Date('2026-11-22T12:00:00Z');
const page = (f: string) => readFileSync(`test/fixtures/pages/${f}`, 'utf8');

function fakeHttp(routes: Record<string, string>, calls: string[] = []) {
  return new PoliteHttp({
    userAgent: 'test',
    minIntervalMs: 0,
    retryDelayMs: 1,
    resolve: () => Promise.resolve(['93.184.216.34']),
    fetchImpl: ((input: URL | string) => {
      const url = String(input);
      calls.push(url);
      const hit = Object.entries(routes).find(([p]) => url.startsWith(p));
      return Promise.resolve(
        hit ? new Response(hit[1], { status: 200 }) : new Response('nope', { status: 404 }),
      );
    }) as typeof fetch,
  });
}

const ASHBY_THNDR = JSON.stringify({
  jobs: [
    {
      id: '4f9738fc-892b-466f-99db-ac8fcd95dc82',
      title: 'Senior DevOps/Infrastructure Engineer',
      jobUrl: 'https://jobs.ashbyhq.com/thndr/4f9738fc-892b-466f-99db-ac8fcd95dc82',
      applyUrl: 'https://jobs.ashbyhq.com/thndr/4f9738fc-892b-466f-99db-ac8fcd95dc82/application',
      location: 'Cairo Office',
      isRemote: false,
      isListed: true,
      publishedAt: '2026-11-15T10:00:00Z',
      descriptionPlain:
        'Kubernetes, Terraform, AWS, CI/CD, monitoring with Prometheus and Grafana, Linux.',
    },
  ],
});

function thinJob(over: Partial<CheckedJob> = {}): CheckedJob {
  return {
    title: 'Senior DevOps/Infrastructure Engineer',
    company: 'Thndr',
    location: 'Cairo',
    country: 'Egypt',
    work_mode: 'unknown',
    seniority: 'unknown',
    years_min: null,
    requirements: [],
    nice_to_have: [],
    apply_channel: 'form',
    apply_email: null,
    apply_url: 'https://linkedin.com/jobs/view/4492953317',
    apply_phone: null,
    subject_hint: null,
    deadline: null,
    language: 'en',
    eligibility: [],
    scam_signals: [],
    flags: [],
    ...over,
  };
}

function freshDb(): Db {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

describe('migration 002', () => {
  it('rebuilds raw_items keeping rows and foreign keys, and accepts manual posts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mig-'));
    mkdirSync(join(dir, 'only1'));
    writeFileSync(
      join(dir, 'only1', '001_init.sql'),
      readFileSync('src/db/migrations/001_init.sql', 'utf8'),
    );
    const db = openDb(join(dir, 'a.db'));
    migrate(db, join(dir, 'only1'));
    db.prepare(
      `INSERT INTO raw_items (source, source_ref, posted_at, collected_at, text, content_hash)
       VALUES ('whatsapp', 'm1', '2026-11-20T00:00:00Z', '2026-11-20T00:00:00Z', 'x', 'h')`,
    ).run();
    db.prepare(
      `INSERT INTO jobs (raw_item_id, title, title_norm, apply_channel, fingerprint, created_at, updated_at)
       VALUES (1, 't', 't', 'form', 'f', 'now', 'now')`,
    ).run();
    const res = migrate(db);
    expect(res.applied).toEqual([
      '002_run.sql',
      '003_forms.sql',
      '004_dates_questions.sql',
      '005_search_channels.sql',
    ]);
    expect(
      db.prepare('SELECT count(*) FROM raw_items WHERE processed_at IS NULL').pluck().get(),
    ).toBe(1);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    db.prepare(
      `INSERT INTO raw_items (source, source_ref, posted_at, collected_at, text, content_hash)
       VALUES ('manual', 'm2', 'now', 'now', 'x', 'h2')`,
    ).run();
    expect(() =>
      db
        .prepare(
          `INSERT INTO jobs (raw_item_id, title, title_norm, apply_channel, fingerprint, created_at, updated_at)
       VALUES (99, 't', 't', 'form', 'f', 'now', 'now')`,
        )
        .run(),
    ).toThrow(/FOREIGN KEY/);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('tracking links (troubleshooting #20)', () => {
  it('unwraps Wuzzuf (Amazon SES) links without a request', () => {
    const wrapped =
      'https://jbyxlvy7.r.eu-west-1.awstrack.me/L0/https:%2F%2Fwuzzuf.net%2Fjobs%2Fp%2Fqenpbmle0qpo-junior-system-administrator-rayc-technologies-cairo-egypt%3Futm_source=wuzzuf%26utm_medium=email/1/0102abc=/xyz=123';
    expect(canonicalizeUrl(wrapped)).toBe(
      'https://wuzzuf.net/jobs/p/qenpbmle0qpo-junior-system-administrator-rayc-technologies-cairo-egypt',
    );
  });
  it('unwraps Bayt tracklinks and never keeps the personal userToken', () => {
    const t = 'v2%3A92403108%3Asecret';
    expect(
      canonicalizeUrl(
        `https://bayt.com/barrier/tracklink.adp?link_id=1&target_link=${encodeURIComponent(`https://www.bayt.com/en/egypt/jobs/devops-75445933/?userToken=${t}&utm_source=x`)}`,
      ),
    ).toBe('https://bayt.com/en/egypt/jobs/devops-75445933');
    expect(
      canonicalizeUrl(
        `https://www.bayt.com/en/egypt/jobs/devops-75445933/?email_name=j&userToken=${t}`,
      ),
    ).not.toContain('secret');
  });
  it('keeps only the path of Wuzzuf and Bayt job pages (all parameters are tracking)', () => {
    expect(
      canonicalizeUrl(
        'https://wuzzuf.net/jobs/p/vt9q66w4fv2b-medior-devops?a=Nancy+Weekly&l=rje&o=1',
      ),
    ).toBe('https://wuzzuf.net/jobs/p/vt9q66w4fv2b-medior-devops');
  });
  it('leaves ordinary links alone', () => {
    expect(unwrapTracking('https://jobs.lever.co/acme/123')).toBe('https://jobs.lever.co/acme/123');
  });
});

describe('job pages', () => {
  it('reads schema.org JobPosting (Wuzzuf, saved real page)', () => {
    const j = jsonLdJobPosting(page('wuzzuf-jsonld.html'));
    expect(j?.title).toBe('Junior System Administrator');
    expect(j?.company).toMatch(/RayC Technologies/);
    expect(j?.validThrough).toMatch(/^2026-11-30/);
    expect(j?.text.length).toBeGreaterThan(500);
  });
  it('reads the logged-out LinkedIn page (saved real page): offsite apply', () => {
    const j = linkedinGuestJob(page('linkedin-guest-thndr.html'));
    expect(j).toMatchObject({
      title: 'Senior DevOps/Infrastructure Engineer',
      company: 'Thndr',
      offsite: true,
    });
    expect(j?.text).toMatch(/cloud infrastructure/);
    expect(j?.text).toMatch(/Employment type: Full-time/);
  });
  it('recognises canonical LinkedIn job links only', () => {
    expect(linkedinJobId('https://linkedin.com/jobs/view/4492953317')).toBe('4492953317');
    expect(linkedinJobId('https://evil.example/linkedin.com/jobs/view/4492953317')).toBeNull();
  });
});

describe('company discovery (D30)', () => {
  it('derives board tokens from company names', () => {
    expect(slugCandidates('DXC Technology')).toEqual(['dxctechnology', 'dxc-technology', 'dxc']);
    expect(slugCandidates('Thndr')).toEqual(['thndr']);
    expect(slugCandidates('The HR Game')).toEqual(['hrgame', 'hr-game', 'hr']);
    expect(slugCandidates('Vodafone Egypt S.A.E')).toEqual(['vodafone']);
  });

  it('matches a posting by id in the link, else by title', () => {
    const ps = [
      { externalId: 'abc', title: 'Backend Engineer' },
      { externalId: 'def', title: 'DevOps Engineer' },
    ] as never[];
    expect(matchPosting(ps, 'x', 0.8, 'https://jobs.lever.co/a/abc')).toMatchObject({
      externalId: 'abc',
    });
    expect(matchPosting(ps, 'Senior DevOps Engineer', 0.8)).toMatchObject({ externalId: 'def' });
    expect(matchPosting(ps, 'Accountant', 0.8)).toBeNull();
  });

  it('adds a board guessed from the name only when it lists this job, and caches the probe', async () => {
    const db = freshDb();
    const calls: string[] = [];
    const http = fakeHttp(
      { 'https://api.ashbyhq.com/posting-api/job-board/thndr': ASHBY_THNDR },
      calls,
    );
    const d = { http, db, cfg, now: NOW, log };
    const hit = await boardFromName(
      d,
      { title: 'Senior DevOps/Infrastructure Engineer', company: 'Thndr' },
      null,
    );
    expect(hit?.entry).toEqual({ name: 'Thndr', ats: 'ashby', board: 'thndr' });
    expect(hit?.posting?.applyUrl).toMatch(/application$/);
    expect(companiesToPoll(db, [])).toEqual([{ name: 'Thndr', ats: 'ashby', board: 'thndr' }]);

    // Same slug, different job: a board that doesn't list the title is not added.
    const miss = await boardFromName(
      {
        ...d,
        http: fakeHttp({
          'https://boards-api.greenhouse.io/v1/boards/acme/': JSON.stringify({
            jobs: [{ id: 1, title: 'Chef', absolute_url: 'https://x' }],
          }),
        }),
      },
      { title: 'DevOps Engineer', company: 'Acme' },
      null,
    );
    expect(miss).toBeNull();
    expect(db.prepare('SELECT count(*) FROM companies').pluck().get()).toBe(1);

    // Cached negative probe: no network on the next run.
    const again: string[] = [];
    await boardFromName(
      { ...d, http: fakeHttp({}, again) },
      { title: 'DevOps Engineer', company: 'Acme' },
      null,
    );
    expect(again).toEqual([]);
  });

  it('takes the board from a link that points at it', async () => {
    const db = freshDb();
    const http = fakeHttp({ 'https://api.ashbyhq.com/posting-api/job-board/thndr': ASHBY_THNDR });
    const link = 'https://jobs.ashbyhq.com/thndr/4f9738fc-892b-466f-99db-ac8fcd95dc82';
    const hit = await boardFromText(
      { http, db, cfg, now: NOW, log },
      link,
      { title: 'DevOps', company: 'Thndr', link },
      null,
    );
    expect(hit?.posting?.externalId).toBe('4f9738fc-892b-466f-99db-ac8fcd95dc82');
    expect(db.prepare('SELECT evidence FROM companies').pluck().get()).toMatch(/job link/);
  });
});

describe('enrichment (D30)', () => {
  const extracted = {
    is_job_post: true,
    jobs: [
      {
        ...thinJob(),
        requirements: ['Kubernetes', 'Terraform', 'AWS', 'CI/CD', 'Prometheus'],
        years_min: 4,
        work_mode: 'onsite',
        flags: undefined,
      },
    ].map((j) => {
      const { flags, ...rest } = j;
      expect(flags).toBeUndefined();
      return rest;
    }),
  };
  const llm: Llm = {
    call: <T>(req: LlmRequest<T>) => Promise.resolve(req.schema.parse(extracted)),
  };

  it('LinkedIn alert job → full description, company board, direct apply link, details merged', async () => {
    const db = freshDb();
    const http = fakeHttp({ 'https://api.ashbyhq.com/posting-api/job-board/thndr': ASHBY_THNDR });
    const linkedinHttp = fakeHttp({
      'https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/4492953317': page(
        'linkedin-guest-thndr.html',
      ),
    });
    const e = await enrichJob({ http, linkedinHttp, db, cfg, llm, now: NOW, log }, thinJob(), {
      rawSource: 'alert_email',
    });
    expect(e.note).toBe('linkedin_offsite');
    expect(e.directUrl).toBe(
      'https://jobs.ashbyhq.com/thndr/4f9738fc-892b-466f-99db-ac8fcd95dc82/application',
    );
    expect(e.job.requirements).toContain('Terraform');
    expect(e.job.years_min).toBe(4);
    expect(e.job.apply_url).toBe('https://linkedin.com/jobs/view/4492953317'); // unchanged
    expect(e.companyId).not.toBeNull();
  });

  it('takes the country from the job page when the alert did not state it', async () => {
    const e = await enrichJob(
      {
        http: fakeHttp({}),
        linkedinHttp: fakeHttp({
          'https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/4492953317': page(
            'linkedin-guest-thndr.html',
          ),
        }),
        db: freshDb(),
        cfg: { ...cfg, enrich: { ...cfg.enrich, probe_ats_by_name: false } },
        llm,
        now: NOW,
        log,
      },
      thinJob({ country: null, requirements: ['a', 'b', 'c'] }),
      { rawSource: 'alert_email' },
    );
    expect(e.job.country).toBe('Egypt');
  });

  it('still looks for the company form when LinkedIn says Easy Apply', async () => {
    const easy = page('linkedin-guest-thndr.html').replaceAll('apply-link-offsite', 'apply-link-x');
    const e = await enrichJob(
      {
        http: fakeHttp({ 'https://api.ashbyhq.com/posting-api/job-board/thndr': ASHBY_THNDR }),
        linkedinHttp: fakeHttp({
          'https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/4492953317': easy,
        }),
        db: freshDb(),
        cfg,
        llm,
        now: NOW,
        log,
      },
      thinJob(),
      { rawSource: 'alert_email' },
    );
    expect(e.note).toBe('linkedin_easy_apply');
    expect(e.directUrl).toMatch(/jobs\.ashbyhq\.com\/thndr\/.*\/application$/);
  });

  it('never fetches application forms or hosts that refuse bots', async () => {
    const calls: string[] = [];
    const d = {
      http: fakeHttp({}, calls),
      linkedinHttp: fakeHttp({}, calls),
      db: freshDb(),
      cfg: { ...cfg, enrich: { ...cfg.enrich, probe_ats_by_name: false } },
      llm,
      now: NOW,
      log,
    };
    const form = await enrichJob(
      d,
      thinJob({ apply_url: 'https://docs.google.com/forms/d/e/x/viewform' }),
      { rawSource: 'whatsapp' },
    );
    expect(form.note).toBe('form');
    const indeed = await enrichJob(
      d,
      thinJob({ apply_url: 'https://eg.indeed.com/viewjob?jk=72ccb8546403b0b5' }),
      { rawSource: 'alert_email' },
    );
    expect(indeed.note).toBe('blocked_host');
    expect(calls).toEqual([]);
  });

  it('skips email jobs and feed postings', async () => {
    const d = {
      http: fakeHttp({}),
      linkedinHttp: fakeHttp({}),
      db: freshDb(),
      cfg,
      llm,
      now: NOW,
      log,
    };
    expect(
      (await enrichJob(d, thinJob({ apply_channel: 'email' }), { rawSource: 'whatsapp' }))
        .enrichedFrom,
    ).toBeNull();
    expect((await enrichJob(d, thinJob(), { rawSource: 'ats' })).enrichedFrom).toBeNull();
  });
});

describe('run lock', () => {
  it('refuses a second run while the first holds the lock', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lock-'));
    const path = join(dir, 'run.lock');
    const release = acquireLock(path, 'agent run');
    writeFileSync(path, '1'); // pid 1 (init) is always alive
    expect(() => acquireLock(path, 'agent run')).toThrow(LockedError);
    writeFileSync(path, '999999999'); // a dead pid: stale lock replaced
    const r2 = acquireLock(path, 'agent run');
    r2();
    release();
    expect(existsSync(path)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});

// ------------------------------------------------------------------ end to end

const FIXTURE_IDS = [
  '01-devops-email-en',
  '11-app-support-form',
  '15-non-job',
  '09-senior-7-years',
];
const fixtures = loadFixtures().filter((f) => FIXTURE_IDS.includes(f.id));

/** Replays recordings: the run's content-hash keys → fixture ids; tailor keys by job title. */
class FixtureLlm implements Llm {
  private readonly replay = new ReplayLlm('test/fixtures/llm');
  constructor(
    private readonly byHash: Map<string, string>,
    private readonly byTitle: Map<string, string>,
    private readonly failOn?: string,
  ) {}
  call<T>(req: LlmRequest<T>): Promise<T> {
    if (this.failOn && req.purpose === this.failOn)
      return Promise.reject(new UsageLimitError('limit (test)'));
    let key = req.key ?? '';
    if (req.purpose === 'tailor') {
      const title = /"title": "([^"]+)"/.exec(req.prompt)?.[1] ?? '';
      key = key.replace(/^job\d+\.tailor/, `${this.byTitle.get(title) ?? 'missing'}.tailor`);
    } else {
      const [hash, ...rest] = key.split('.');
      key = [this.byHash.get(hash ?? '') ?? 'missing', ...rest].join('.');
    }
    return this.replay.call({ ...req, key });
  }
}

describe('agent run end to end (fixtures, recorded model outputs, fake Gmail)', () => {
  const profile = loadProfile('profile/master_profile.example.yaml');
  const matcher = TitleMatcher.fromFile('config/titles.yaml');
  let renderer: Renderer;
  let out: string;
  const byHash = new Map<string, string>();
  const byTitle = new Map<string, string>();

  beforeAll(async () => {
    renderer = await Renderer.open();
    out = mkdtempSync(join(tmpdir(), 'run-'));
    for (const f of fixtures) {
      byHash.set(prepareRawItem({ ...f }).content_hash.slice(0, 12), f.id);
      const ex = JSON.parse(readFileSync(`test/fixtures/llm/${f.id}.extract.json`, 'utf8')) as {
        jobs: { title: string }[];
      };
      for (const j of ex.jobs) byTitle.set(j.title, f.id);
    }
  }, 60_000);
  afterAll(async () => {
    await renderer.close();
    rmSync(out, { recursive: true, force: true });
  });

  function gmail(drafts: { raw: string }[]): GmailWriter {
    return {
      myAddress: () => Promise.resolve(profile.candidate.email.toLowerCase()),
      search: () => Promise.resolve([]),
      getMessage: () => Promise.reject(new Error('unused')),
      createDraft: (raw) => {
        drafts.push({ raw });
        return Promise.resolve({
          draftId: `d${String(drafts.length)}`,
          messageId: `m${String(drafts.length)}`,
          threadId: 't',
        });
      },
      deleteOwnDraft: () => Promise.resolve(),
      draftExists: () => Promise.resolve(true),
      threadMessages: () => Promise.resolve([]),
      sendRaw: () => Promise.reject(new Error('no sending in tests')),
      sendDraft: () => Promise.reject(new Error('no sending in tests')),
    };
  }

  function deps(db: Db, llm: Llm, g: GmailWriter, lines: string[]): RunDeps {
    return {
      cfg: { ...cfg, enrich: { ...cfg.enrich, enabled: false } },
      profile,
      db,
      llm,
      preflight: null,
      gmailRead: g,
      gmailWrite: g,
      sources: [],
      http: fakeHttp({}),
      linkedinHttp: fakeHttp({}),
      matcher,
      // The shared browser stays open across runs; the run's close() is a no-op here.
      openRenderer: () =>
        Promise.resolve(
          Object.assign(Object.create(renderer) as Renderer, { close: () => Promise.resolve() }),
        ),
      now: () => new Date('2026-11-20T09:00:00Z'),
      log,
      out: (l) => lines.push(l),
      dryRun: false,
      outputRoot: out,
      calls: [],
      sendDigest: null,
    };
  }

  function seed(db: Db) {
    for (const f of fixtures) insertRawItem(db, prepareRawItem({ ...f }), f.posted_at);
  }

  it('reads every stored item once, drafts the email job, packages the form job', async () => {
    const db = freshDb();
    seed(db);
    const drafts: { raw: string }[] = [];
    const lines: string[] = [];
    const r = await runAgent(deps(db, new FixtureLlm(byHash, byTitle), gmail(drafts), lines));
    expect(r.error, lines.join('\n')).toBeNull();
    expect(r.status).toBe('success');
    expect(r.stats.items.processed).toBe(4);
    expect(r.stats.items.left).toBe(0);

    const jobs = db
      .prepare('SELECT id, title, status, skip_reason, apply_channel FROM jobs ORDER BY id')
      .all() as {
      id: number;
      title: string;
      status: string;
      skip_reason: string | null;
      apply_channel: string;
    }[];
    const email = jobs.find((j) => j.apply_channel === 'email' && j.status === 'ready');
    const form = jobs.find((j) => j.apply_channel === 'form' && j.status === 'ready');
    expect(email, JSON.stringify(jobs)).toBeDefined();
    expect(form, JSON.stringify(jobs)).toBeDefined();
    expect(jobs.find((j) => j.skip_reason === 'over_experience')).toBeDefined();

    expect(drafts).toHaveLength(1);
    const app = db.prepare('SELECT * FROM applications WHERE job_id = ?').get(form?.id) as {
      package_dir: string;
      mode: string;
    };
    expect(app.mode).toBe('manual'); // no form filler in this test: apply yourself
    const pkg = readFileSync(join(app.package_dir, 'apply.md'), 'utf8');
    expect(pkg).toMatch(
      /Apply here:\*\* https:\/\/pyramidpay\.example\/careers\/app-support-engineer/,
    );
    expect(pkg).toMatch(/## Cover letter/);
    expect(r.digest.text).toMatch(/Email drafts ready to send \(1\)/);
    expect(r.digest.text).toMatch(/Apply on the site \(1\)/);

    // Second run: nothing new to read, nothing to tailor, no new draft.
    const r2 = await runAgent(deps(db, new FixtureLlm(byHash, byTitle), gmail(drafts), []));
    expect(r2.stats.items.processed).toBe(0);
    expect(drafts).toHaveLength(1);
    expect(db.prepare(`SELECT count(*) FROM runs WHERE status = 'success'`).pluck().get()).toBe(2);
  }, 240_000);

  it('stops at the usage limit without losing or half-storing items (R18)', async () => {
    const db = freshDb();
    seed(db);
    const r = await runAgent(deps(db, new FixtureLlm(byHash, byTitle, 'score'), gmail([]), []));
    expect(r.status).toBe('partial');
    expect(r.stopReason).toMatch(/usage limit/);
    // The non-job post needs no score call, so it is done; every item that needed one is
    // still unread, and no job was stored half-way.
    const left = r.stats.items.left;
    expect(left).toBeGreaterThan(0);
    const jobsBefore = db.prepare('SELECT count(*) FROM jobs').pluck().get() as number;
    expect(jobsBefore).toBe(0);
    const r2 = await runAgent(deps(db, new FixtureLlm(byHash, byTitle), gmail([]), []));
    expect(r2.stats.items.processed).toBe(left);
    expect(r2.stats.items.left).toBe(0);
  }, 240_000);
});
