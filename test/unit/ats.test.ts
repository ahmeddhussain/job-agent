// P6 without the network: adapters on real recorded responses (test/fixtures/ats),
// pre-filter, detection, the SSRF guard, retries on truncated JSON, and the collector.
import { readFileSync } from 'node:fs';
import { pino } from 'pino';
import { beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { ADAPTERS, htmlText, type AtsPosting } from '../../src/collect/ats/adapters.js';
import { collectAts, postingText, prefilter } from '../../src/collect/ats/collect.js';
import { detectIn } from '../../src/collect/ats/detect.js';
import { parseConfig, type Config } from '../../src/config.js';
import { migrate, openDb, type Db } from '../../src/db/index.js';
import { TitleMatcher } from '../../src/pipeline/titles.js';
import { isPrivateAddress, PoliteHttp } from '../../src/util/http.js';

const raw = parse(readFileSync('config/config.example.yaml', 'utf8')) as Record<
  string,
  Record<string, unknown>
>;
raw['digest'] = { ...raw['digest'], to: 'me@example.com' };
const cfg: Config = parseConfig(raw);
const matcher = TitleMatcher.fromFile('config/titles.yaml');
const log = pino({ level: 'silent' });
const NOW = new Date('2026-11-22T12:00:00Z');
const fixture = (f: string) => readFileSync(`test/fixtures/ats/${f}`, 'utf8');

/** A PoliteHttp whose network is a map of URL prefix → body (public DNS, no delay). */
function fakeHttp(routes: Record<string, string | (() => string)>, calls: string[] = []) {
  return new PoliteHttp({
    userAgent: 'test',
    minIntervalMs: 0,
    retryDelayMs: 1,
    resolve: () => Promise.resolve(['93.184.216.34']),
    fetchImpl: ((input: URL | string) => {
      const url = String(input);
      calls.push(url);
      const hit = Object.entries(routes).find(([p]) => url.startsWith(p));
      if (!hit) return Promise.resolve(new Response('not found', { status: 404 }));
      const body = typeof hit[1] === 'function' ? hit[1]() : hit[1];
      return Promise.resolve(new Response(body, { status: 200 }));
    }) as typeof fetch,
  });
}

describe('ATS adapters on real recorded feeds', () => {
  it('Greenhouse (careem): title, location, URL, date, unescaped description', async () => {
    const http = fakeHttp({
      'https://boards-api.greenhouse.io/v1/boards/careem/jobs': fixture('greenhouse-careem.json'),
    });
    const jobs = await ADAPTERS.greenhouse.list(http, 'careem', 'Careem');
    expect(jobs).toHaveLength(3);
    expect(jobs[0]).toMatchObject({
      title: 'Account Manager I',
      location: 'Amman, Jordan',
    });
    expect(jobs[0]?.url).toContain('greenhouse.io/careem/jobs/');
    expect(jobs[0]?.postedAt).toMatch(/^2026-/);
    expect(jobs[0]?.text).not.toMatch(/&lt;|<p>/);
  });

  it('Lever (palantir): categories.location, workplaceType, lists in the text', async () => {
    const http = fakeHttp({
      'https://api.lever.co/v0/postings/palantir': fixture('lever-palantir.json'),
    });
    const jobs = await ADAPTERS.lever.list(http, 'palantir', 'Palantir');
    expect(jobs.length).toBeGreaterThan(0);
    expect(jobs[0]?.url).toMatch(/^https:\/\/jobs\.lever\.co\/palantir\//);
    expect(jobs[0]?.postedAt).toMatch(/^20\d\d-/);
    expect(jobs[0]?.text.length).toBeGreaterThan(50);
  });

  it('Ashby (thndr): listed jobs with apply URLs and remote flag', async () => {
    const http = fakeHttp({
      'https://api.ashbyhq.com/posting-api/job-board/thndr': fixture('ashby-thndr.json'),
    });
    const jobs = await ADAPTERS.ashby.list(http, 'thndr', 'Thndr');
    expect(jobs).toHaveLength(3);
    expect(jobs[0]?.applyUrl).toMatch(/^https:\/\/jobs\.ashbyhq\.com\/thndr\/.+\/application$/);
    expect(typeof jobs[0]?.remote).toBe('boolean');
  });

  it('SmartRecruiters: list, then details fill the description and public URLs', async () => {
    const list = fixture('smartrecruiters-list.json');
    const id = (JSON.parse(list) as { content: { id: string }[] }).content[0]?.id ?? '';
    const http = fakeHttp({
      [`https://api.smartrecruiters.com/v1/companies/smartrecruiters/postings/${id}`]: fixture(
        'smartrecruiters-detail.json',
      ),
      'https://api.smartrecruiters.com/v1/companies/smartrecruiters/postings?': list,
    });
    const sr = ADAPTERS.smartrecruiters;
    const [first] = await sr.list(http, 'smartrecruiters', 'SmartRecruiters');
    if (!first || !sr.details) throw new Error('no posting');
    expect(first.text).toBe('');
    const full = await sr.details(http, 'smartrecruiters', first);
    expect(full.url).toMatch(/^https:\/\/jobs\.smartrecruiters\.com\/smartrecruiters\//);
    expect(full.text.length).toBeGreaterThan(50);
  });

  it('Workable: accepts the documented account shape (no live sample was available)', async () => {
    const body = JSON.stringify({
      name: 'Acme',
      jobs: [
        {
          title: 'DevOps Engineer',
          shortcode: 'AB12',
          url: 'https://apply.workable.com/acme/j/AB12/',
          city: 'Cairo',
          country: 'Egypt',
          description: '<p>AWS</p>',
        },
      ],
    });
    const jobs = await ADAPTERS.workable.list(
      fakeHttp({ 'https://apply.workable.com/api/v1/widget/accounts/acme': body }),
      'acme',
      'Acme',
    );
    expect(jobs[0]).toMatchObject({
      externalId: 'AB12',
      company: 'Acme',
      location: 'Cairo, Egypt',
      text: 'AWS',
    });
  });
});

const posting = (over: Partial<AtsPosting>): AtsPosting => ({
  externalId: '1',
  title: 'DevOps Engineer',
  company: 'Acme',
  location: 'Cairo, Egypt',
  remote: false,
  url: 'https://x.example/1',
  applyUrl: null,
  postedAt: '2026-11-20T00:00:00Z',
  text: 'AWS',
  ...over,
});

describe('pre-filter and posting text', () => {
  it('keeps priority titles in Egypt or remote; drops other titles, places and stale posts', () => {
    expect(prefilter(posting({}), cfg, matcher, NOW)).toBe('keep');
    expect(prefilter(posting({ title: 'Account Manager I' }), cfg, matcher, NOW)).toBe('title');
    expect(prefilter(posting({ title: 'Data Analyst' }), cfg, matcher, NOW)).toBe('title'); // P3 never from big boards
    expect(prefilter(posting({ location: 'Amman, Jordan' }), cfg, matcher, NOW)).toBe('location');
    expect(prefilter(posting({ location: 'Amman, Jordan', remote: true }), cfg, matcher, NOW)).toBe(
      'keep',
    );
    expect(prefilter(posting({ postedAt: '2026-08-01T00:00:00Z' }), cfg, matcher, NOW)).toBe(
      'stale',
    );
  });

  it('gives extraction the apply URL literally and caps the size', () => {
    const t = postingText(
      posting({ applyUrl: 'https://jobs.ashbyhq.com/acme/x/application' }),
      20000,
    );
    expect(t).toContain('Apply: https://jobs.ashbyhq.com/acme/x/application');
    expect(postingText(posting({ text: 'x'.repeat(500) }), 100)).toMatch(/\[truncated\]$/);
  });

  it('turns HTML-escaped HTML into text', () => {
    expect(htmlText('&lt;p&gt;Hello &amp;amp; welcome&lt;/p&gt;')).toBe('Hello & welcome');
  });
});

describe('ats:detect', () => {
  it.each([
    ['https://boards.greenhouse.io/careem', 'greenhouse', 'careem'],
    ['https://job-boards.greenhouse.io/careem/jobs/123', 'greenhouse', 'careem'],
    ['https://boards.greenhouse.io/embed/job_board?for=careem', 'greenhouse', 'careem'],
    ['https://jobs.lever.co/palantir/abc', 'lever', 'palantir'],
    ['https://jobs.ashbyhq.com/thndr', 'ashby', 'thndr'],
    ['https://apply.workable.com/instabug/', 'workable', 'instabug'],
    ['https://instabug.workable.com/', 'workable', 'instabug'],
    ['https://jobs.smartrecruiters.com/Vodafone', 'smartrecruiters', 'Vodafone'],
  ])('%s → %s/%s', (url, ats, board) => {
    expect(detectIn(url)).toEqual({ ats, board });
  });

  it('finds a board embedded in a company careers page', () => {
    expect(detectIn('<iframe src="https://jobs.ashbyhq.com/thndr/embed"></iframe>')).toEqual({
      ats: 'ashby',
      board: 'thndr',
    });
    expect(detectIn('<html>no ATS here</html>')).toBeNull();
  });
});

describe('guarded HTTP (security A8)', () => {
  it('classifies private, reserved and metadata addresses', () => {
    for (const ip of [
      '127.0.0.1',
      '10.0.1.5',
      '172.20.0.1',
      '192.168.231.131',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '::1',
      'fd00::1',
      '::ffff:10.0.0.1',
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ['93.184.216.34', '57.144.17.32', '2606:4700::1111'])
      expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it('refuses http, credentials, and hosts that resolve to private addresses', async () => {
    const http = new PoliteHttp({
      userAgent: 't',
      minIntervalMs: 0,
      resolve: () => Promise.resolve(['169.254.169.254']),
    });
    await expect(http.get('https://metadata.example/')).rejects.toThrow(/private or reserved/);
    await expect(http.get('http://example.com/')).rejects.toThrow(/non-https/);
    await expect(http.get('https://user:pw@example.com/')).rejects.toThrow(/credentials/);
  });

  it('re-checks redirect targets', async () => {
    let n = 0;
    const http = new PoliteHttp({
      userAgent: 't',
      minIntervalMs: 0,
      resolve: (h) => Promise.resolve([h === 'internal.example' ? '10.0.0.5' : '93.184.216.34']),
      fetchImpl: () => {
        n++;
        return Promise.resolve(
          new Response(null, { status: 302, headers: { location: 'https://internal.example/' } }),
        );
      },
    });
    await expect(http.get('https://public.example/')).rejects.toThrow(/private or reserved/);
    expect(n).toBe(1);
  });

  it('retries a truncated JSON body (flaky network, troubleshooting #19)', async () => {
    let n = 0;
    const http = fakeHttp({
      'https://api.example/': () => (++n === 1 ? '{"jobs":[{"title":"Dev' : '{"jobs":[]}'),
    });
    await expect(http.json('https://api.example/')).resolves.toEqual({ jobs: [] });
    expect(n).toBe(2);
  });
});

describe('collectAts', () => {
  let db: Db;
  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
  });
  const board = JSON.stringify({
    jobs: [
      {
        id: 'a',
        title: 'DevOps Engineer',
        jobUrl: 'https://jobs.ashbyhq.com/acme/a',
        location: 'Cairo',
        isRemote: false,
        publishedAt: '2026-11-20T00:00:00Z',
        descriptionPlain: 'AWS',
      },
      {
        id: 'b',
        title: 'Account Executive',
        jobUrl: 'https://jobs.ashbyhq.com/acme/b',
        location: 'Cairo',
        isRemote: false,
        publishedAt: '2026-11-20T00:00:00Z',
      },
    ],
  });

  it('stores kept postings once; a second run stores nothing new', async () => {
    const http = fakeHttp({ 'https://api.ashbyhq.com/posting-api/job-board/acme': board });
    const companies = [{ name: 'Acme', ats: 'ashby' as const, board: 'acme' }];
    const r1 = await collectAts({ http, db, cfg, companies, matcher, now: NOW, log });
    expect(r1[0]).toMatchObject({ listed: 2, kept: 1, inserted: 1, dropped: { title: 1 } });
    const r2 = await collectAts({
      http,
      db,
      cfg,
      companies,
      matcher,
      now: new Date(NOW.getTime() + 86_400_000),
      log,
    });
    expect(r2[0]?.inserted).toBe(0);
    expect(db.prepare('SELECT source_ref FROM raw_items').pluck().all()).toEqual(['ashby:acme:a']);
  });

  it('one failing board does not stop the others', async () => {
    const http = fakeHttp({ 'https://api.ashbyhq.com/posting-api/job-board/acme': board });
    const r = await collectAts({
      http,
      db,
      cfg,
      matcher,
      now: NOW,
      log,
      companies: [
        { name: 'Gone', ats: 'lever', board: 'gone' },
        { name: 'Acme', ats: 'ashby', board: 'acme' },
      ],
    });
    expect(r[0]?.error).toMatch(/HTTP 404/);
    expect(r[1]?.inserted).toBe(1);
  });

  it('html pages: a new raw item only when the page content changes', async () => {
    let page =
      '<main><h1>Careers</h1><p>DevOps Engineer, Cairo. Email jobs@acme.example</p></main>';
    const http = fakeHttp({ 'https://acme.example/careers': () => page });
    const companies = [{ name: 'Acme', ats: 'html' as const, url: 'https://acme.example/careers' }];
    expect(
      (await collectAts({ http, db, cfg, companies, matcher, now: NOW, log }))[0]?.inserted,
    ).toBe(1);
    expect(
      (await collectAts({ http, db, cfg, companies, matcher, now: NOW, log }))[0]?.inserted,
    ).toBe(0);
    page = page.replace('DevOps Engineer', 'Cloud Engineer');
    expect(
      (await collectAts({ http, db, cfg, companies, matcher, now: NOW, log }))[0]?.inserted,
    ).toBe(1);
  });
});
