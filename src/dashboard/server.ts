// Tracker API and page (PLAN 10, D10, D32). Fastify on 127.0.0.1 only.
// Security (docs/security.md A15–A17):
// - binds to a loopback address; refuses to start on anything else;
// - Host header allowlist, so a web page can't reach the API through DNS rebinding;
// - writes need Content-Type: application/json and, when sent, a same-origin Origin
//   (a cross-site form can't send JSON without a CORS preflight, which is never granted);
// - files are looked up by job id and kind in the database, never from a path in the
//   request, and must resolve inside apply.output_dir.
import { readFileSync, realpathSync, existsSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from '../config.js';
import { migrate, openDb, type Db } from '../db/index.js';
import { updateJobStatus, type Status } from '../db/jobs.js';
import { insertRawItem, prepareRawItem } from '../pipeline/dedupe.js';
import { sha256 } from '../util/hash.js';
import { pendingQuestions } from '../apply/questions.js';
import { loadProfile } from '../profile/load.js';
import { AnswerError, setAnswer } from '../profile/answers.js';
import { draftUrl, GmailFacade, type GmailWriter } from '../gmail/client.js';
import { gmailAuthClient } from '../gmail/auth.js';
import type { Llm } from '../llm/types.js';
import { claude } from '../cli/run.js';
import { readSettings, updateSettings } from '../settings.js';
import {
  applySuggestion,
  bulk,
  DISCARD_REASONS,
  discardJob,
  dismissSuggestion,
  draftFollowup,
  followupsDue,
  interviewPrep,
  sourceScoreboard,
  suggestions,
} from './actions.js';
import { RunManager } from './runner.js';
import { AssistSession } from './assist.js';
import type { Io } from '../cli/program.js';

const PAGE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dashboard', 'index.html');
const FONTS_DIR = join(dirname(PAGE), 'fonts');
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
  .strictObject({
    status: z.enum(STATUSES).optional(),
    notes: z.string().max(5000).optional(),
    /** Edits the cover letter of a prepared application (paste box / apply window). */
    cover_text: z.string().min(50).max(6000).optional(),
  })
  .refine(
    (v) => v.status !== undefined || v.notes !== undefined || v.cover_text !== undefined,
    'nothing to change',
  );
const AnswerBody = z.strictObject({
  key: z.string().max(50),
  value: z.string().max(500),
  /** The form question this answers (form_questions.id), if any. */
  question_id: z.number().int().positive().optional(),
});
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
  job_posted_at: string | null;
  post_text: string | null;
  requirements: string | null;
  apply_phone: string | null;
  sent_at_app: string | null;
  form_report: string | null;
  interview_prep: string | null;
  discard_reason: string | null;
  followup_at: string | null;
}

function toJob(r: Row) {
  const reasons = (() => {
    try {
      return JSON.parse(r.fit_reasons ?? '{}') as {
        summary?: string;
        matched?: { requirement: string }[];
        missing?: string[];
        scores?: { skills: number; experience: number; final: number };
      };
    } catch {
      return {};
    }
  })();
  const form = (() => {
    try {
      return JSON.parse(r.form_report ?? 'null') as {
        filled?: { label: string; value: string }[];
        unanswered?: string[];
      } | null;
    } catch {
      return null;
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
      ...(r.package_dir && existsSync(join(r.package_dir, 'form-filled.png'))
        ? { form: `/files/${String(r.id)}/form` }
        : {}),
    },
    app_mode: r.app_mode,
    manual_reason: r.manual_reason,
    job_posted_at: r.job_posted_at,
    applied_at: r.sent_at_app,
    post_text: r.post_text,
    requirements: (() => {
      try {
        return JSON.parse(r.requirements ?? '[]') as string[];
      } catch {
        return [];
      }
    })(),
    matched: (reasons.matched ?? []).map((m) => m.requirement),
    missing: reasons.missing ?? [],
    scores: reasons.scores ?? null,
    apply_phone: r.apply_phone,
    form_filled: form?.filled ?? [],
    form_unanswered: form?.unanswered ?? [],
    interview_prep: (() => {
      try {
        return JSON.parse(r.interview_prep ?? 'null') as unknown;
      } catch {
        return null;
      }
    })(),
    discard_reason: r.discard_reason,
    followup_at: r.followup_at,
    fit_summary: reasons.summary ?? null,
    why_this_role: r.why_this_role,
    ats_keywords: ats?.keywordCoverage ?? null,
    cover_text: r.cover_text,
    notes: r.notes ?? '',
  };
}

export interface DashboardOptions {
  /** The config file settings are written to (D39); without it, settings are read-only. */
  configPath?: string;
  /** Gmail for deleting discarded drafts and drafting follow-ups; null when unavailable. */
  gmail?: () => Promise<GmailWriter | null>;
  /** The model client for interview prep (D41). */
  llm?: () => Llm;
  runner?: RunManager;
  /** Opens "apply yourself" jobs in the visible browser (D43). */
  assist?: AssistSession;
}

const SettingsBody = z
  .strictObject({
    search_titles: z.array(z.string().min(2).max(80)).max(30),
    search_locations: z.array(z.string().min(2).max(60)).min(1).max(5),
    linkedin_enabled: z.boolean(),
    channels_follow_all: z.boolean(),
    channels_exclude: z.array(z.string().min(1).max(120)).max(100),
    alerts_enabled: z.boolean(),
    ats_enabled: z.boolean(),
    max_job_age_days: z.number().int().min(1).max(365),
    max_years_required: z.number().int().min(0).max(20),
    skip_senior_titles: z.boolean(),
    weekly_goal: z.number().int().min(1).max(200),
    thresholds: z.strictObject({
      p1: z.number().int().min(0).max(100),
      p2: z.number().int().min(0).max(100),
      p3: z.number().int().min(0).max(100),
    }),
    blocked_companies: z.array(z.string().min(1).max(120)).max(500),
    favorite_companies: z.array(z.string().min(1).max(120)).max(500),
    excluded_titles: z.array(z.string().min(2).max(80)).max(200),
  })
  .partial();
const DiscardBody = z.strictObject({
  reason: z.enum(DISCARD_REASONS),
  note: z.string().max(500).optional(),
});
const BulkBody = z.strictObject({
  ids: z.array(z.number().int().positive()).min(1).max(500),
  action: z.enum(['prepare', 'skip', 'applied', 'discard']),
  reason: z.enum(DISCARD_REASONS).optional(),
});
const KeyBody = z.strictObject({ key: z.string().min(3).max(200) });
const AddBody = z.strictObject({
  text: z.string().min(40).max(20_000),
  name: z.string().max(80).optional(),
});
const RunBody = z.strictObject({
  kind: z.enum(['run', 'dry_run', 'queue', 'send', 'retry', 'recheck']).optional(),
  /** Older pages sent { dry_run }. */
  dry_run: z.boolean().optional(),
});
const FONTS = new Set(['Inter.woff2', 'SpaceGrotesk.woff2', 'JetBrainsMono.woff2', 'fonts.css']);

export function buildDashboard(cfg: Config, db: Db, opts: DashboardOptions = {}): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024 });
  // Settings edits replace the config in use (D39).
  let current = cfg;
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
      // The CV preview frames /files/* from this same page; nothing else may frame anything.
      'X-Frame-Options': req.url.startsWith('/files/') ? 'SAMEORIGIN' : 'DENY',
      'Content-Security-Policy': `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-src 'self'; frame-ancestors ${req.url.startsWith('/files/') ? "'self'" : "'none'"}; base-uri 'none'; form-action 'none'`,
      'Cache-Control': 'no-store',
    });
  });

  app.get('/', (_req, reply) =>
    reply.type('text/html; charset=utf-8').send(readFileSync(PAGE, 'utf8')),
  );
  app.get('/healthz', (_req, reply) => reply.send({ ok: true }));
  app.get('/fonts/:name', (req, reply) => {
    const name = (req.params as { name: string }).name;
    if (!FONTS.has(name)) return reply.code(404).send({ error: 'no such font' });
    return reply
      .type(name.endsWith('.css') ? 'text/css; charset=utf-8' : 'font/woff2')
      .header('Cache-Control', 'max-age=86400')
      .send(readFileSync(join(FONTS_DIR, name)));
  });

  // ------------------------------------------------------------------ settings (D39)
  app.get('/api/settings', (_req, reply) =>
    reply.send({ settings: readSettings(current), editable: Boolean(opts.configPath) }),
  );
  app.put('/api/settings', (req, reply) => {
    if (!opts.configPath) return reply.code(409).send({ error: 'settings are read-only here' });
    const b = SettingsBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: z.prettifyError(b.error) });
    try {
      current = updateSettings(opts.configPath, current.paths.titles, b.data);
      return reply.send({ ok: true, settings: readSettings(current) });
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ------------------------------------------------------------------ discard + learning
  app.post('/api/jobs/:id/discard', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const b = DiscardBody.safeParse(req.body);
    if (!Number.isInteger(id) || !b.success) return reply.code(400).send({ error: 'bad request' });
    try {
      const r = await discardJob(db, (await opts.gmail?.()) ?? null, id, b.data.reason, b.data.note ?? null);
      return await reply.send({ ok: true, ...r, suggestions: suggestions(db, current) });
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });
  app.get('/api/suggestions', (_req, reply) => reply.send({ suggestions: suggestions(db, current) }));
  app.post('/api/suggestions/apply', (req, reply) => {
    const b = KeyBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad request' });
    if (!opts.configPath) return reply.code(409).send({ error: 'settings are read-only here' });
    const s = suggestions(db, current).find((x) => x.key === b.data.key);
    if (!s) return reply.code(404).send({ error: 'no such suggestion' });
    current = applySuggestion(opts.configPath, current, s);
    return reply.send({ ok: true, settings: readSettings(current), suggestions: suggestions(db, current) });
  });
  app.post('/api/suggestions/dismiss', (req, reply) => {
    const b = KeyBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad request' });
    dismissSuggestion(db, b.data.key);
    return reply.send({ ok: true, suggestions: suggestions(db, current) });
  });
  app.post('/api/jobs/bulk', async (req, reply) => {
    const b = BulkBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: z.prettifyError(b.error) });
    const gmail = b.data.action === 'discard' ? ((await opts.gmail?.()) ?? null) : null;
    return reply.send(await bulk(db, gmail, b.data.ids, b.data.action, b.data.reason));
  });

  // ------------------------------------------------------------------ follow-ups, prep, sources
  app.get('/api/followups', (_req, reply) => reply.send({ due: followupsDue(db, current) }));
  app.post('/api/jobs/:id/followup', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: 'bad id' });
    const gmail = (await opts.gmail?.()) ?? null;
    if (!gmail) return reply.code(503).send({ error: 'Gmail is not available (./agent.sh gmail-auth)' });
    try {
      const d = await draftFollowup(db, gmail, loadProfile(current.paths.profile), id);
      return await reply.send({ ok: true, draft_url: draftUrl(d.draftId) });
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });
  app.post('/api/jobs/:id/prep', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: 'bad id' });
    if (!opts.llm) return reply.code(503).send({ error: 'interview prep needs the model client' });
    try {
      const prep = await interviewPrep(db, opts.llm(), current, loadProfile(current.paths.profile), id);
      return await reply.send({ ok: true, prep });
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });
  app.get('/api/sources', (_req, reply) => reply.send({ sources: sourceScoreboard(db) }));

  // ------------------------------------------------------------------ quick add, undo
  app.post('/api/add', (req, reply) => {
    const b = AddBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'paste the whole post (at least 40 characters)' });
    const text = b.data.text.trim();
    const r = insertRawItem(
      db,
      prepareRawItem({
        source: 'manual',
        source_ref: `manual:${sha256(text).slice(0, 16)}`,
        source_name: b.data.name?.trim() || 'added in the dashboard',
        posted_at: new Date().toISOString(),
        text,
      }),
      new Date().toISOString(),
    );
    return reply.send({ ok: true, inserted: r.inserted, id: r.id });
  });
  app.post('/api/jobs/:id/undiscard', (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const row = db.prepare('SELECT 1 FROM discards WHERE job_id = ?').pluck().get(id);
    if (!row) return reply.code(404).send({ error: 'not discarded' });
    // Back to the status it had before "Not a fit" (its deleted Gmail draft can't come back).
    const prev = (db
      .prepare('SELECT to_status FROM status_history WHERE job_id = ? ORDER BY id DESC LIMIT 1 OFFSET 1')
      .pluck()
      .get(id) ?? 'new') as Status;
    db.transaction(() => {
      db.prepare('DELETE FROM discards WHERE job_id = ?').run(id);
      updateJobStatus(db, id, prev === 'skipped' ? 'new' : prev, 'ahmed', new Date().toISOString(), null);
    })();
    return reply.send({ ok: true, status: prev === 'skipped' ? 'new' : prev });
  });

  // ------------------------------------------------------------------ apply from the dashboard
  app.post('/api/jobs/:id/assist', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: 'bad id' });
    if (!opts.assist) return reply.code(503).send({ error: 'the apply window is not available here' });
    try {
      return await reply.send(await opts.assist.open(id));
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });
  app.post('/api/assist/close', async (_req, reply) => {
    await opts.assist?.close();
    return reply.send({ ok: true });
  });

  // ------------------------------------------------------------------ run now
  app.get('/api/run', (_req, reply) =>
    reply.send(opts.runner?.status() ?? { running: false, lines: [], unavailable: true }),
  );
  app.post('/api/run', (req, reply) => {
    const b = RunBody.safeParse(req.body ?? {});
    if (!b.success) return reply.code(400).send({ error: 'bad request' });
    if (!opts.runner) return reply.code(503).send({ error: 'runs can only be started from the agent.sh dashboard' });
    try {
      return reply.send(opts.runner.start(b.data.kind ?? (b.data.dry_run ? 'dry_run' : 'run')));
    } catch (err) {
      return reply.code(409).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

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
           a.sent_at AS sent_at_app, a.form_report, substr(r.text, 1, 2500) AS post_text,
           a.followup_at, (SELECT reason FROM discards x WHERE x.job_id = j.id) AS discard_reason,
           CASE WHEN c.id IS NULL THEN NULL ELSE c.ats || '/' || COALESCE(c.board, c.url) END AS company_board
         FROM jobs j JOIN raw_items r ON r.id = j.raw_item_id
         LEFT JOIN applications a ON a.job_id = j.id
         LEFT JOIN companies c ON c.id = j.company_id
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY r.posted_at DESC, j.id DESC LIMIT 2000`,
      )
      .all(args) as Row[];
    const hist = new Map<number, { to: string; by: string; at: string }[]>();
    for (const h of db
      .prepare('SELECT job_id, to_status, by, at FROM status_history ORDER BY id')
      .all() as { job_id: number; to_status: string; by: string; at: string }[]) {
      const l = hist.get(h.job_id) ?? [];
      l.push({ to: h.to_status, by: h.by, at: h.at });
      hist.set(h.job_id, l);
    }
    return reply.send({ jobs: rows.map((r) => ({ ...toJob(r), history: hist.get(r.id) ?? [] })) });
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
    if (body.data.cover_text !== undefined) {
      const a = db
        .prepare('SELECT package_dir, channel, sent_at FROM applications WHERE job_id = ?')
        .get(id) as { package_dir: string | null; channel: string; sent_at: string | null } | undefined;
      if (!a) return reply.code(404).send({ error: 'no prepared application for this job' });
      if (a.sent_at) return reply.code(409).send({ error: 'already applied: the letter was sent' });
      db.prepare('UPDATE applications SET cover_text = ? WHERE job_id = ?').run(
        body.data.cover_text,
        id,
      );
      // Keep the package's paste-box file in step (only inside the output directory).
      if (a.package_dir && existsSync(a.package_dir)) {
        const dir = realpathSync(a.package_dir);
        if (dir.startsWith(outputRoot + sep))
          writeFileSync(join(dir, 'cover_letter.txt'), `${body.data.cover_text.trim()}\n`);
      }
      return {
        ok: true,
        note:
          a.channel === 'email'
            ? 'Saved here. The Gmail draft keeps its own text: edit it in Gmail.'
            : 'Saved: ./agent.sh apply uses this letter.',
      };
    }
    return { ok: true };
  });

  // ------------------------------------------------------------------ profile (D35)
  app.get('/api/profile', (_req, reply) => {
    const p = loadProfile(cfg.paths.profile);
    return reply.send({
      candidate: {
        full_name: p.candidate.full_name,
        location: p.candidate.location,
        email: p.candidate.email,
        phone: p.candidate.phone,
        links: p.candidate.links,
      },
      headlines: p.headlines,
      summaries: p.summaries,
      answers: p.application_answers,
      questions: pendingQuestions(db),
      counts: {
        projects: p.projects.length,
        experience: p.experience.length,
        certifications: p.certifications.length,
        skills: Object.values(p.skills).flat().length,
        not_held: p.not_held.length,
      },
      certifications: p.certifications.map((c) => c.name),
      projects: p.projects.map((e) => e.name ?? e.title ?? e.id),
    });
  });

  app.put('/api/profile/answers', (req, reply) => {
    const b = AnswerBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: z.prettifyError(b.error) });
    try {
      const answers = setAnswer(cfg.paths.profile, b.data.key, b.data.value);
      if (b.data.question_id && b.data.value.trim())
        db.prepare('UPDATE form_questions SET answer_key = ? WHERE id = ?').run(
          b.data.key,
          b.data.question_id,
        );
      return reply.send({ ok: true, answers, questions: pendingQuestions(db) });
    } catch (err) {
      if (err instanceof AnswerError) return reply.code(400).send({ error: err.message });
      return reply.code(400).send({ error: `profile not saved: ${String(err).slice(0, 300)}` });
    }
  });

  app.get('/api/runs', (_req, reply) =>
    reply.send({
      runs: (
        db
          .prepare(
            `SELECT id, status, mode, started_at, finished_at, error, stats FROM runs ORDER BY id DESC LIMIT 20`,
          )
          .all() as { stats: string | null }[]
      ).map((r) => ({ ...r, stats: r.stats ? (JSON.parse(r.stats) as unknown) : null })),
    }),
  );

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

export async function serveDashboard(cfg: Config, io: Io, configPath: string): Promise<void> {
  if (!LOOPBACK.has(cfg.dashboard.host))
    throw new Error(
      `dashboard.host must be a loopback address (127.0.0.1); got ${cfg.dashboard.host}. ` +
        'To reach it remotely, use an SSH tunnel, never an open port.',
    );
  const db = openDb(cfg.paths.db);
  migrate(db);
  let gmail: GmailFacade | null | undefined;
  const app = buildDashboard(cfg, db, {
    configPath,
    gmail: async () => {
      if (gmail !== undefined) return gmail;
      try {
        const g = new GmailFacade(gmailAuthClient(cfg));
        await g.myAddress();
        gmail = g;
      } catch {
        gmail = null; // the dashboard works without Gmail; actions that need it say so
      }
      return gmail;
    },
    llm: () => claude(cfg, []),
    runner: new RunManager(),
    assist: new AssistSession(() => cfg, db, () => claude(cfg, [])),
  });
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
