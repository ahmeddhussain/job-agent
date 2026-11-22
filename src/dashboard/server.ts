// Tracker API and page (PLAN 10, D10, D32). Fastify on 127.0.0.1 only.
// Security (docs/security.md A15–A17):
// - binds to a loopback address; refuses to start on anything else;
// - Host header allowlist, so a web page can't reach the API through DNS rebinding;
// - writes need Content-Type: application/json and, when sent, a same-origin Origin
//   (a cross-site form can't send JSON without a CORS preflight, which is never granted);
// - files are looked up by job id and kind in the database, never from a path in the
//   request, and must resolve inside apply.output_dir.
import { readFileSync, realpathSync, existsSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from '../config.js';
import { migrate, openDb, type Db } from '../db/index.js';
import { updateJobStatus } from '../db/jobs.js';
import { draftUrl } from '../gmail/client.js';
import type { Io } from '../cli/program.js';

const PAGE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dashboard', 'index.html');
const STATUSES = [
  'new',
  'skipped',
  'needs_review',
  'ready',
  'applied',
  'interview',
  'offer',
  'rejected',
] as const;
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

const JobsQuery = z.object({
  status: z.enum(STATUSES).optional(),
  source: z.string().max(30).optional(),
  priority: z.coerce.number().int().min(1).max(3).optional(),
  q: z.string().max(200).optional(),
  include_duplicates: z.enum(['true', 'false']).optional(),
});
const Patch = z
  .strictObject({ status: z.enum(STATUSES).optional(), notes: z.string().max(5000).optional() })
  .refine((v) => v.status !== undefined || v.notes !== undefined, 'nothing to change');
const FileParams = z.object({
  id: z.coerce.number().int().positive(),
  kind: z.enum(['cv', 'cover', 'cv_md', 'package', 'form']),
});

interface Row {
  id: number;
  title: string;
  company: string | null;
  location: string | null;
  work_mode: string;
  source: string;
  source_name: string | null;
  posted_at: string;
  priority: number | null;
  fit_score: number | null;
  fit_reasons: string | null;
  apply_channel: string;
  apply_email: string | null;
  apply_url: string | null;
  apply_url_direct: string | null;
  apply_note: string | null;
  status: string;
  flags: string | null;
  skip_reason: string | null;
  has_reply: number;
  notes: string | null;
  duplicate_of: number | null;
  seen: number;
  gmail_message_id: string | null;
  sent_at: string | null;
  cv_pdf: string | null;
  cv_md: string | null;
  cover_text: string | null;
  package_dir: string | null;
  why_this_role: string | null;
  ats_report: string | null;
  company_board: string | null;
  app_mode: string | null;
  manual_reason: string | null;
}

function toJob(r: Row) {
  const reasons = (() => {
    try {
      return JSON.parse(r.fit_reasons ?? '{}') as { summary?: string };
    } catch {
      return {};
    }
  })();
  const ats = (() => {
    try {
      return JSON.parse(r.ats_report ?? 'null') as { keywordCoverage?: number } | null;
    } catch {
      return null;
    }
  })();
  return {
    id: r.id,
    title: r.title,
    company: r.company,
    location: r.location,
    work_mode: r.work_mode,
    source: r.source,
    source_name: r.source_name,
    seen_count: r.seen,
    posted_at: r.posted_at,
    priority: r.priority,
    fit_score: r.fit_score,
    apply_channel: r.apply_channel,
    apply_email: r.apply_email,
    apply_url: r.apply_url,
    apply_url_direct: r.apply_url_direct,
    apply_note: r.apply_note,
    company_board: r.company_board,
    status: r.status,
    flags: JSON.parse(r.flags ?? '[]') as string[],
    skip_reason: r.skip_reason,
    has_reply: r.has_reply === 1,
    gmail_draft_url: r.gmail_message_id && !r.sent_at ? draftUrl(r.gmail_message_id) : null,
    files: {
      ...(r.cv_pdf ? { cv: `/files/${String(r.id)}/cv` } : {}),
      ...(r.cover_text ? { cover: `/files/${String(r.id)}/cover` } : {}),
      ...(r.cv_md ? { cv_md: `/files/${String(r.id)}/cv_md` } : {}),
      ...(r.package_dir ? { package: `/files/${String(r.id)}/package` } : {}),
      ...(r.package_dir && r.app_mode === 'manual' ? { form: `/files/${String(r.id)}/form` } : {}),
    },
    app_mode: r.app_mode,
    manual_reason: r.manual_reason,
    fit_summary: reasons.summary ?? null,
    why_this_role: r.why_this_role,
    ats_keywords: ats?.keywordCoverage ?? null,
    cover_text: r.cover_text,
    notes: r.notes ?? '',
  };
}

export function buildDashboard(cfg: Config, db: Db): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024 });
  const port = String(cfg.dashboard.port);
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  const outputRoot = (() => {
    const r = resolve(cfg.apply.output_dir);
    return existsSync(r) ? realpathSync(r) : r;
  })();

  app.addHook('onRequest', async (req, reply) => {
    if (!allowedHosts.has(req.headers.host ?? '')) {
      return reply.code(403).send({ error: 'host not allowed' });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const origin = req.headers.origin;
      if (origin && !allowedHosts.has(origin.replace(/^http:\/\//, ''))) {
        return reply.code(403).send({ error: 'cross-origin write refused' });
      }
      if (!(req.headers['content-type'] ?? '').startsWith('application/json')) {
        return reply.code(415).send({ error: 'application/json required' });
      }
    }
    void reply.headers({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy':
        "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      'Cache-Control': 'no-store',
    });
  });

  app.get('/', (_req, reply) =>
    reply.type('text/html; charset=utf-8').send(readFileSync(PAGE, 'utf8')),
  );
  app.get('/healthz', (_req, reply) => reply.send({ ok: true }));

  app.get('/api/jobs', (req, reply) => {
    const q = JobsQuery.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: z.prettifyError(q.error) });
    const where: string[] = [];
    const args: Record<string, unknown> = {};
    if (q.data.include_duplicates !== 'true') where.push('j.duplicate_of IS NULL');
    if (q.data.status) {
      where.push('j.status = @status');
      args['status'] = q.data.status;
    }
    if (q.data.source) {
      where.push('r.source = @source');
      args['source'] = q.data.source;
    }
    if (q.data.priority) {
      where.push('j.priority = @priority');
      args['priority'] = q.data.priority;
    }
    if (q.data.q) {
      where.push(
        `(j.title LIKE @q OR j.company LIKE @q OR j.apply_email LIKE @q OR r.source_name LIKE @q OR j.notes LIKE @q)`,
      );
      args['q'] = `%${q.data.q.replace(/[%_]/g, '')}%`;
    }
    const rows = db
      .prepare(
        `SELECT j.*, r.source, r.source_name, r.posted_at,
           1 + (SELECT count(*) FROM jobs d WHERE d.duplicate_of = j.id) AS seen,
           a.gmail_message_id, a.sent_at, a.cv_pdf, a.cv_md, a.cover_text, a.package_dir,
           a.why_this_role, a.ats_report, a.mode AS app_mode, a.manual_reason,
           CASE WHEN c.id IS NULL THEN NULL ELSE c.ats || '/' || COALESCE(c.board, c.url) END AS company_board
         FROM jobs j JOIN raw_items r ON r.id = j.raw_item_id
         LEFT JOIN applications a ON a.job_id = j.id
         LEFT JOIN companies c ON c.id = j.company_id
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY r.posted_at DESC, j.id DESC LIMIT 2000`,
      )
      .all(args) as Row[];
    return reply.send({ jobs: rows.map(toJob) });
  });

  app.get('/api/stats', (_req, reply) => {
    const last = db
      .prepare(
        `SELECT id, status, started_at, finished_at, error, stats, mode FROM runs
         WHERE mode = 'live' ORDER BY id DESC LIMIT 1`,
      )
      .get() as
      | {
          id: number;
          status: string;
          started_at: string;
          finished_at: string | null;
          error: string | null;
          stats: string | null;
        }
      | undefined;
    const byStatus = Object.fromEntries(
      (
        db.prepare('SELECT status, count(*) n FROM jobs WHERE duplicate_of IS NULL GROUP BY status').all() as {
          status: string;
          n: number;
        }[]
      ).map((r) => [r.status, r.n]),
    );
    // Applied per day: status changes to applied (by sync, send mode or Ahmed), last 14 days.
    const days: { date: string; count: number }[] = [];
    const today = new Date();
    for (let i = 13; i >= 0; i--) {
      const dt = new Date(today.getTime() - i * 86_400_000).toISOString().slice(0, 10);
      days.push({ date: dt, count: 0 });
    }
    const counts = db
      .prepare(
        `SELECT substr(at, 1, 10) d, count(DISTINCT job_id) n FROM status_history
         WHERE to_status = 'applied' AND at >= ? GROUP BY d`,
      )
      .all(days[0]?.date ?? '') as { d: string; n: number }[];
    for (const c of counts) {
      const day = days.find((x) => x.date === c.d);
      if (day) day.count = c.n;
    }
    const companies = db
      .prepare(
        `SELECT name, ats, board, url, source, active, evidence, added_at FROM companies ORDER BY added_at DESC`,
      )
      .all();
    const queue = db
      .prepare('SELECT count(*) FROM raw_items WHERE processed_at IS NULL')
      .pluck()
      .get() as number;
    return reply.send({
      last_run: last
        ? {
            status: last.status,
            started_at: last.started_at,
            finished_at: last.finished_at,
            error: last.error,
            stats: last.stats ? (JSON.parse(last.stats) as unknown) : null,
          }
        : null,
      stale_run_hours: cfg.dashboard.stale_run_hours,
      counts: { by_status: byStatus },
      applied_per_day: days,
      companies,
      unread_items: queue,
    });
  });

  app.patch('/api/jobs/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: 'bad id' });
    const body = Patch.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: z.prettifyError(body.error) });
    const exists = db.prepare('SELECT 1 FROM jobs WHERE id = ?').pluck().get(id);
    if (!exists) return reply.code(404).send({ error: 'job not found' });
    const at = new Date().toISOString();
    db.transaction(() => {
      if (body.data.status) updateJobStatus(db, id, body.data.status, 'ahmed', at);
      if (body.data.notes !== undefined)
        db.prepare('UPDATE jobs SET notes = ?, updated_at = ? WHERE id = ?').run(
          body.data.notes,
          at,
          id,
        );
    })();
    return { ok: true };
  });

  app.get('/files/:id/:kind', async (req, reply) => {
    const p = FileParams.safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: 'bad file request' });
    const a = db
      .prepare(
        'SELECT cv_pdf, cv_md, cover_text, package_dir FROM applications WHERE job_id = ?',
      )
      .get(p.data.id) as
      | { cv_pdf: string | null; cv_md: string | null; cover_text: string | null; package_dir: string | null }
      | undefined;
    if (!a) return reply.code(404).send({ error: 'no application for this job' });
    if (p.data.kind === 'cover') {
      if (!a.cover_text) return reply.code(404).send({ error: 'no cover letter' });
      return reply.type('text/plain; charset=utf-8').send(a.cover_text);
    }
    const file =
      p.data.kind === 'cv'
        ? a.cv_pdf
        : p.data.kind === 'cv_md'
          ? a.cv_md
          : a.package_dir
            ? join(a.package_dir, p.data.kind === 'form' ? 'form-filled.png' : 'apply.md')
            : null;
    if (!file || !existsSync(file)) return reply.code(404).send({ error: 'file not found' });
    const real = realpathSync(file);
    if (!real.startsWith(outputRoot + sep)) {
      return reply.code(403).send({ error: 'file outside the output directory' });
    }
    const type = real.endsWith('.pdf')
      ? 'application/pdf'
      : real.endsWith('.png')
        ? 'image/png'
        : 'text/plain; charset=utf-8';
    return reply
      .type(type)
      .header('Content-Disposition', `inline; filename="${basename(real).replace(/[^\w.-]/g, '_')}"`)
      .send(readFileSync(real));
  });

  return app;
}

export async function serveDashboard(cfg: Config, io: Io): Promise<void> {
  if (!LOOPBACK.has(cfg.dashboard.host))
    throw new Error(
      `dashboard.host must be a loopback address (127.0.0.1); got ${cfg.dashboard.host}. ` +
        'To reach it remotely, use an SSH tunnel, never an open port.',
    );
  const db = openDb(cfg.paths.db);
  migrate(db);
  const app = buildDashboard(cfg, db);
  const close = async () => {
    await app.close();
    db.close();
    process.exit(0);
  };
  process.once('SIGINT', () => void close());
  process.once('SIGTERM', () => void close());
  await app.listen({ host: cfg.dashboard.host, port: cfg.dashboard.port });
  io.out(`dashboard: http://127.0.0.1:${String(cfg.dashboard.port)}  (Ctrl-C to stop)`);
}
