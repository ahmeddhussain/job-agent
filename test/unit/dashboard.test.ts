// P8: the tracker API with Fastify's inject (no port opened). Gate items: real jobs are
// listed, a status change persists, file links work, path traversal is rejected.
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { parseConfig, type Config } from '../../src/config.js';
import { buildDashboard } from '../../src/dashboard/server.js';
import { migrate, openDb, type Db } from '../../src/db/index.js';

const raw = parse(readFileSync('config/config.example.yaml', 'utf8')) as Record<
  string,
  Record<string, unknown>
>;
raw['digest'] = { ...raw['digest'], to: 'me@example.com' };
let dir: string;
let cfg: Config;
let db: Db;
const HOST = { host: '127.0.0.1:8080' };

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'dash-'));
  raw['apply'] = { ...raw['apply'], output_dir: join(dir, 'output') };
  raw['dashboard'] = { ...raw['dashboard'], host: '127.0.0.1', port: 8080 };
  cfg = parseConfig(raw);
  mkdirSync(join(dir, 'output', 'pkg'), { recursive: true });
  writeFileSync(join(dir, 'output', 'pkg', 'cv.pdf'), '%PDF-1.4 test');
  writeFileSync(join(dir, 'output', 'pkg', 'apply.md'), '# package');
  writeFileSync(join(dir, 'secret.txt'), 'outside');
  symlinkSync(join(dir, 'secret.txt'), join(dir, 'output', 'pkg', 'link.pdf'));
  db = openDb(':memory:');
  migrate(db);
  db.prepare(
    `INSERT INTO raw_items (source, source_ref, source_name, posted_at, collected_at, text, content_hash)
     VALUES ('whatsapp', 'm1', 'Career Chance', '2026-11-22T08:00:00Z', 'now', 'post', 'h')`,
  ).run();
  const job = (title: string, status: string) =>
    db
      .prepare(
        `INSERT INTO jobs (raw_item_id, title, title_norm, company, apply_channel, apply_url, fingerprint,
           priority, fit_score, fit_reasons, flags, status, created_at, updated_at)
         VALUES (1, ?, ?, 'Acme', 'form', 'https://acme.example/jobs/1', 'f', 1, 80,
           '{"summary":"Strong on Linux"}', '[]', ?, 'now', 'now')`,
      )
      .run(title, title.toLowerCase(), status).lastInsertRowid;
  const a = job('DevOps Engineer', 'ready');
  const b = job('Cloud Engineer', 'ready');
  db.prepare(
    `INSERT INTO applications (job_id, channel, cv_pdf, cover_text, package_dir, mode, created_at)
     VALUES (?, 'form', ?, 'Dear team, ...', ?, 'package', 'now')`,
  ).run(a, join(dir, 'output', 'pkg', 'cv.pdf'), join(dir, 'output', 'pkg'));
  // A row pointing outside output/ (a corrupted or tampered DB) must not be served.
  db.prepare(
    `INSERT INTO applications (job_id, channel, cv_pdf, mode, created_at) VALUES (?, 'form', ?, 'package', 'now')`,
  ).run(b, join(dir, 'output', 'pkg', 'link.pdf'));
});
afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('dashboard API', () => {
  it('lists real jobs in the shape the page expects', async () => {
    const app = buildDashboard(cfg, db);
    const r = await app.inject({ method: 'GET', url: '/api/jobs', headers: HOST });
    expect(r.statusCode).toBe(200);
    const { jobs } = r.json<{ jobs: Record<string, unknown>[] }>();
    expect(jobs).toHaveLength(2);
    expect(jobs.find((j) => j['title'] === 'DevOps Engineer')).toMatchObject({
      source: 'whatsapp',
      source_name: 'Career Chance',
      fit_summary: 'Strong on Linux',
      files: { cv: '/files/1/cv', cover: '/files/1/cover', package: '/files/1/package' },
    });
    expect(r.headers['content-security-policy']).toMatch(/frame-ancestors 'none'/);
  });

  it('persists a status change with history (by ahmed) and notes', async () => {
    const app = buildDashboard(cfg, db);
    const r = await app.inject({
      method: 'PATCH',
      url: '/api/jobs/1',
      headers: { ...HOST, 'content-type': 'application/json' },
      payload: { status: 'applied', notes: 'sent on the site' },
    });
    expect(r.statusCode).toBe(200);
    const again = await buildDashboard(cfg, db).inject({
      method: 'GET',
      url: '/api/jobs?status=applied',
      headers: HOST,
    });
    expect(again.json<{ jobs: { id: number; notes: string }[] }>().jobs).toEqual([
      expect.objectContaining({ id: 1, notes: 'sent on the site' }),
    ]);
    expect(
      db
        .prepare(`SELECT by FROM status_history WHERE job_id = 1 AND to_status = 'applied'`)
        .pluck()
        .get(),
    ).toBe('ahmed');
    const stats = await app.inject({ method: 'GET', url: '/api/stats', headers: HOST });
    const s = stats.json<{ applied_per_day: { count: number }[] }>();
    expect(s.applied_per_day).toHaveLength(14);
    expect(s.applied_per_day.at(-1)?.count).toBe(1);
  });

  it('rejects bad statuses and unknown fields', async () => {
    const app = buildDashboard(cfg, db);
    for (const payload of [{ status: 'hired' }, { status: 'ready', role: 'admin' }, {}]) {
      const r = await app.inject({
        method: 'PATCH',
        url: '/api/jobs/1',
        headers: { ...HOST, 'content-type': 'application/json' },
        payload,
      });
      expect(r.statusCode).toBe(400);
    }
  });

  it('serves files by job id and kind only', async () => {
    const app = buildDashboard(cfg, db);
    const cv = await app.inject({ method: 'GET', url: '/files/1/cv', headers: HOST });
    expect(cv.statusCode).toBe(200);
    expect(cv.headers['content-type']).toBe('application/pdf');
    expect(
      (await app.inject({ method: 'GET', url: '/files/1/cover', headers: HOST })).body,
    ).toMatch(/Dear team/);
    expect((await app.inject({ method: 'GET', url: '/files/1/package', headers: HOST })).body).toBe(
      '# package',
    );
  });

  it('rejects path traversal and files outside the output directory', async () => {
    const app = buildDashboard(cfg, db);
    for (const url of [
      '/files/1/..%2F..%2Fsecret.txt',
      '/files/..%2F..%2Fetc%2Fpasswd/cv',
      '/files/1/cv%00.pdf',
      '/files/-1/cv',
      '/files/1/../../secret.txt',
    ]) {
      const r = await app.inject({ method: 'GET', url, headers: HOST });
      expect([400, 404], url).toContain(r.statusCode);
      expect(r.body).not.toContain('outside');
    }
    const link = await app.inject({ method: 'GET', url: '/files/2/cv', headers: HOST });
    expect(link.statusCode).toBe(403); // symlink resolving outside output/
  });

  it('refuses foreign Host headers (DNS rebinding) and cross-site writes', async () => {
    const app = buildDashboard(cfg, db);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/jobs',
          headers: { host: 'evil.example:8080' },
        })
      ).statusCode,
    ).toBe(403);
    const form = await app.inject({
      method: 'PATCH',
      url: '/api/jobs/1',
      headers: { ...HOST, 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'status=rejected',
    });
    expect(form.statusCode).toBe(415);
    const xorigin = await app.inject({
      method: 'PATCH',
      url: '/api/jobs/1',
      headers: { ...HOST, origin: 'https://evil.example', 'content-type': 'application/json' },
      payload: { status: 'rejected' },
    });
    expect(xorigin.statusCode).toBe(403);
    expect(db.prepare('SELECT status FROM jobs WHERE id = 1').pluck().get()).toBe('applied');
  });

  it('serves the page', async () => {
    const r = await buildDashboard(cfg, db).inject({ method: 'GET', url: '/', headers: HOST });
    expect(r.statusCode).toBe(200);
    expect(r.body).toMatch(/Job Tracker/);
  });
});
