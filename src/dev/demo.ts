// `agent demo:seed` (D45): fills the fictional example profile's database with made-up
// jobs, so the dashboard can be tried (and screenshotted) without any account:
//   ./agent.sh --profile example demo   then   ./agent.sh --profile example dashboard
// Every company, job and person here is invented. It refuses to run on any other profile.
import { existsSync, rmSync } from 'node:fs';
import type { Config } from '../config.js';
import { migrate, openDb } from '../db/index.js';
import { insertRawItem, prepareRawItem, type RawSource } from '../pipeline/dedupe.js';
import { EXAMPLE_PROFILE } from '../profiles.js';

interface DemoJob {
  title: string;
  company: string;
  source: RawSource;
  sourceName: string;
  daysAgo: number;
  status: 'new' | 'ready' | 'applied' | 'interview' | 'rejected' | 'skipped' | 'needs_review';
  channel: 'email' | 'form' | 'whatsapp_dm';
  priority: 1 | 2 | 3 | null;
  fit: number | null;
  mode?: 'draft' | 'submitted' | 'manual' | 'send';
  skip?: string;
  manual?: string;
  location?: string;
  work?: 'onsite' | 'hybrid' | 'remote';
  years?: number;
  reply?: boolean;
}

const JOBS: DemoJob[] = [
  {
    title: 'Junior Cloud Engineer',
    company: 'Nilecode Systems',
    source: 'linkedin',
    sourceName: 'Cloud Engineer',
    daysAgo: 0,
    status: 'ready',
    channel: 'email',
    priority: 1,
    fit: 82,
    mode: 'draft',
    work: 'hybrid',
    years: 1,
  },
  {
    title: 'IT Support Engineer',
    company: 'Pharos Logistics',
    source: 'whatsapp',
    sourceName: 'Alex Tech Jobs',
    daysAgo: 0,
    status: 'ready',
    channel: 'email',
    priority: 1,
    fit: 77,
    mode: 'draft',
    years: 1,
  },
  {
    title: 'DevOps Engineer (Junior)',
    company: 'Lotus Fintech',
    source: 'linkedin',
    sourceName: 'DevOps Engineer',
    daysAgo: 1,
    status: 'ready',
    channel: 'form',
    priority: 1,
    fit: 74,
    mode: 'manual',
    manual: 'LinkedIn Easy Apply: apply on LinkedIn (the agent never signs in for you)',
    work: 'remote',
    years: 2,
  },
  {
    title: 'Cloud Support Associate',
    company: 'Sinai Data Centers',
    source: 'ats',
    sourceName: 'greenhouse/sinaidata',
    daysAgo: 1,
    status: 'ready',
    channel: 'form',
    priority: 1,
    fit: 71,
    mode: 'manual',
    manual: 'the form has a captcha: open it pre-filled and submit',
    years: 0,
  },
  {
    title: 'Technical Support Engineer',
    company: 'Delta Telecom',
    source: 'whatsapp_channel',
    sourceName: 'Egypt IT Jobs',
    daysAgo: 0,
    status: 'applied',
    channel: 'form',
    priority: 1,
    fit: 79,
    mode: 'submitted',
    years: 1,
  },
  {
    title: 'Systems Administrator',
    company: 'Corniche Health',
    source: 'alert_email',
    sourceName: 'Wuzzuf',
    daysAgo: 3,
    status: 'applied',
    channel: 'email',
    priority: 2,
    fit: 68,
    mode: 'send',
    years: 2,
    reply: true,
  },
  {
    title: 'Linux Engineer',
    company: 'Mariout Energy',
    source: 'linkedin',
    sourceName: 'Linux Engineer',
    daysAgo: 5,
    status: 'interview',
    channel: 'email',
    priority: 2,
    fit: 72,
    mode: 'send',
    years: 2,
    reply: true,
  },
  {
    title: 'Help Desk Specialist',
    company: 'Qaitbay Retail',
    source: 'whatsapp',
    sourceName: 'Alex Tech Jobs',
    daysAgo: 0,
    status: 'applied',
    channel: 'form',
    priority: 1,
    fit: 70,
    mode: 'submitted',
    years: 0,
  },
  {
    title: 'Infrastructure Engineer',
    company: 'Montaza Bank',
    source: 'ats',
    sourceName: 'lever/montaza',
    daysAgo: 8,
    status: 'rejected',
    channel: 'form',
    priority: 2,
    fit: 63,
    mode: 'submitted',
    years: 2,
  },
  {
    title: 'Senior Platform Engineer',
    company: 'Lotus Fintech',
    source: 'linkedin',
    sourceName: 'Platform Engineer',
    daysAgo: 1,
    status: 'skipped',
    channel: 'form',
    priority: null,
    fit: null,
    skip: 'over_experience',
    years: 6,
  },
  {
    title: 'Sales Engineer - Cloud',
    company: 'Delta Telecom',
    source: 'linkedin',
    sourceName: 'Cloud Engineer',
    daysAgo: 2,
    status: 'skipped',
    channel: 'email',
    priority: null,
    fit: null,
    skip: 'excluded_title',
  },
  {
    title: 'Network Operations Engineer',
    company: 'Agami Networks',
    source: 'whatsapp_channel',
    sourceName: 'Egypt IT Jobs',
    daysAgo: 2,
    status: 'skipped',
    channel: 'email',
    priority: 3,
    fit: 48,
    skip: 'low_fit',
    years: 1,
  },
  {
    title: 'Cloud Engineer',
    company: 'Rashid Shipping',
    source: 'alert_email',
    sourceName: 'Indeed',
    daysAgo: 4,
    status: 'skipped',
    channel: 'form',
    priority: 1,
    fit: null,
    skip: 'stale',
    years: 1,
  },
  {
    title: 'IT Specialist',
    company: 'Stanley Hotels',
    source: 'whatsapp',
    sourceName: 'Alex Tech Jobs',
    daysAgo: 0,
    status: 'needs_review',
    channel: 'whatsapp_dm',
    priority: 1,
    fit: 66,
    skip: 'eligibility: "male candidates only"',
    years: 1,
  },
  {
    title: 'Monitoring Engineer',
    company: 'Nilecode Systems',
    source: 'ats',
    sourceName: 'ashby/nilecode',
    daysAgo: 0,
    status: 'new',
    channel: 'form',
    priority: 2,
    fit: 69,
    years: 1,
  },
];

export function demoSeedCommand(cfg: Config, out: (l: string) => void): void {
  if (process.env['JOB_AGENT_PROFILE'] !== EXAMPLE_PROFILE)
    throw new Error(
      'demo data goes only into the example profile: ./agent.sh --profile example demo',
    );
  for (const ext of ['', '-wal', '-shm']) rmSync(`${cfg.paths.db}${ext}`, { force: true });
  const db = openDb(cfg.paths.db);
  migrate(db);
  const now = Date.now();
  const iso = (daysAgo: number, hour = 9) =>
    new Date(now - daysAgo * 86_400_000 - (12 - hour) * 3_600_000).toISOString();
  const tx = db.transaction(() => {
    for (const [i, j] of JOBS.entries()) {
      const text = `${j.title} at ${j.company}, ${j.location ?? 'Alexandria, Egypt'}. ${String(j.years ?? 1)}+ years. Linux, cloud and support skills. (fictional demo post ${String(i + 1)})`;
      const raw = insertRawItem(
        db,
        prepareRawItem({
          source: j.source,
          source_ref: `demo-${String(i + 1)}`,
          source_name: j.sourceName,
          posted_at: iso(j.daysAgo, 8),
          text,
        }),
        iso(j.daysAgo, 8),
      );
      db.prepare('UPDATE raw_items SET processed_at = ? WHERE id = ?').run(
        iso(j.daysAgo, 9),
        raw.id,
      );
      const created = iso(j.daysAgo, 9);
      const job = db
        .prepare(
          `INSERT INTO jobs (raw_item_id, title, title_norm, company, company_norm, location, work_mode,
             years_min, requirements, apply_channel, apply_email, apply_url, fingerprint, priority, fit_score,
             fit_reasons, flags, status, skip_reason, has_reply, created_at, updated_at, job_posted_at)
           VALUES (@raw, @title, lower(@title), @company, lower(@company), @loc, @work, @years, @req, @channel,
             @email, @url, @fp, @prio, @fit, @reasons, '[]', @status, @skip, @reply, @at, @at, @at)`,
        )
        .run({
          raw: raw.id,
          title: j.title,
          company: j.company,
          loc: j.location ?? 'Alexandria, Egypt',
          work: j.work ?? 'onsite',
          years: j.years ?? null,
          req: JSON.stringify([
            'Linux administration',
            'Cloud basics (AWS)',
            'Troubleshooting',
            'Clear written English',
          ]),
          channel: j.channel,
          email:
            j.channel === 'email'
              ? `careers@${j.company.toLowerCase().replace(/[^a-z]+/g, '')}.example`
              : null,
          url: j.channel === 'email' ? null : `https://jobs.example/${String(i + 1)}`,
          fp: `demo-${String(i + 1)}`,
          prio: j.priority,
          fit: j.fit,
          reasons: j.fit
            ? JSON.stringify({
                matched: ['Linux administration', 'Cloud basics (AWS)', 'Troubleshooting'],
                missing: j.fit < 70 ? ['Clear written English (not evidenced)'] : [],
                summary:
                  'Linux and AWS projects match the requirements; experience within the range asked.',
              })
            : null,
          status: j.status,
          skip: j.skip ?? null,
          reply: j.reply ? 1 : 0,
          at: created,
        });
      const jobId = Number(job.lastInsertRowid);
      const hist = (to: string, at: string, from: string | null) =>
        db
          .prepare(
            'INSERT INTO status_history (job_id, from_status, to_status, by, at) VALUES (?, ?, ?, ?, ?)',
          )
          .run(jobId, from, to, to === 'interview' || to === 'rejected' ? 'ahmed' : 'agent', at);
      hist('new', created, null);
      if (j.mode) {
        const appliedAt = ['applied', 'interview', 'rejected'].includes(j.status)
          ? iso(j.daysAgo, 11)
          : null;
        db.prepare(
          `INSERT INTO applications (job_id, channel, to_email, subject, body, cover_text, why_this_role, mode,
             created_at, sent_at, manual_reason)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          jobId,
          j.channel,
          j.channel === 'email'
            ? `careers@${j.company.toLowerCase().replace(/[^a-z]+/g, '')}.example`
            : null,
          `Application: ${j.title} (Mona Adel)`,
          `Dear ${j.company} team,\n\nI am applying for the ${j.title} role. (Fictional demo letter.)\n\nBest regards,`,
          `I am applying for the ${j.title} role at ${j.company}. (Fictional demo letter.)`,
          'Hands-on Linux and AWS work matches the role.',
          j.mode,
          iso(j.daysAgo, 10),
          appliedAt,
          j.manual ?? null,
        );
        hist('ready', iso(j.daysAgo, 10), 'new');
        if (appliedAt) hist('applied', appliedAt, 'ready');
        if (j.status === 'interview') hist('interview', iso(j.daysAgo - 2, 15), 'applied');
        if (j.status === 'rejected') hist('rejected', iso(j.daysAgo - 3, 15), 'applied');
      } else if (j.status !== 'new') hist(j.status, created, 'new');
    }
    for (let d = 6; d >= 0; d--) {
      const at = iso(d, 8);
      db.prepare(
        `INSERT INTO runs (started_at, finished_at, status, mode, stats) VALUES (?, ?, 'success', 'live', ?)`,
      ).run(
        at,
        new Date(Date.parse(at) + 24 * 60_000).toISOString(),
        JSON.stringify({
          sources: [
            { name: 'linkedin', ok: true, inserted: 6 + d, detail: '4 searches' },
            { name: 'whatsapp', ok: true, inserted: 3, detail: '2 groups, 1 channel' },
            { name: 'ats', ok: true, inserted: 1, detail: '12 boards' },
          ],
          items: { processed: 10 + d, duplicates: 3, failed: 0, left: 0 },
          jobs: {},
          applications: { drafts: 1, packages: 1, submitted: 1, sent: 0, review: 0, left: 0 },
          companies_discovered: d % 3 === 0 ? 1 : 0,
          llm: { calls: 30 + d, failed: 0, output_tokens: 40_000 },
        }),
      );
    }
  });
  tx();
  db.close();
  out(`demo data: ${String(JOBS.length)} fictional jobs and 7 runs in ${cfg.paths.db}`);
  out('open it: ./agent.sh --profile example dashboard');
  if (!existsSync(cfg.paths.profile)) out('(the example profile.yaml is missing)');
}
