// Digest email (PLAN 5.8): one summary to Ahmed after every run, failures included.
// It can only ever go to Ahmed's own address (checked against the Gmail account).
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { draftUrl, type GmailWriter } from '../gmail/client.js';
import { buildMime } from '../gmail/mime.js';

export interface Digest {
  subject: string;
  text: string;
}

interface JobRow {
  title: string;
  company: string | null;
  fit_score: number | null;
  status: string;
  skip_reason: string | null;
  apply_url: string | null;
  apply_url_direct: string | null;
  apply_channel: string;
  draft: string | null;
  package_dir: string | null;
}

export function buildDigest(
  db: Db,
  since: string,
  date: string,
  runError: string | null = null,
  health: string[] = [],
): Digest {
  const jobs = db
    .prepare(
      `SELECT j.title, j.company, j.fit_score, j.status, j.skip_reason, j.apply_url,
              j.apply_url_direct, j.apply_channel, a.gmail_message_id AS draft, a.package_dir
       FROM jobs j LEFT JOIN applications a ON a.job_id = j.id
       WHERE j.created_at >= ? OR j.updated_at >= ? ORDER BY j.priority, j.fit_score DESC`,
    )
    .all(since, since) as JobRow[];
  const ready = jobs.filter((j) => j.status === 'ready');
  const review = jobs.filter((j) => j.status === 'needs_review');
  const skipped = jobs.filter((j) => j.status === 'skipped');
  const by = new Map<string, number>();
  for (const j of skipped)
    by.set(j.skip_reason ?? 'other', (by.get(j.skip_reason ?? 'other') ?? 0) + 1);

  const line = (j: JobRow) =>
    `- ${j.title}${j.company ? ` · ${j.company}` : ''}${j.fit_score !== null ? ` · ${String(j.fit_score)}` : ''}`;
  const parts: string[] = [];
  if (runError) parts.push(`RUN FAILED: ${runError}`, '');
  const drafts = ready.filter((j) => j.apply_channel === 'email');
  const packages = ready.filter((j) => j.apply_channel !== 'email');
  parts.push(`Email drafts ready to send (${String(drafts.length)}):`);
  for (const j of drafts) parts.push(`${line(j)}${j.draft ? `  ${draftUrl(j.draft)}` : ''}`);
  parts.push('', `Apply on the site (${String(packages.length)}), files in each package folder:`);
  for (const j of packages) {
    const link = j.apply_url_direct ?? j.apply_url;
    parts.push(`${line(j)}${link ? `  ${link}` : ''}`);
    if (j.package_dir) parts.push(`    ${j.package_dir}`);
  }
  parts.push('', `Needs review (${String(review.length)}):`);
  for (const j of review) parts.push(`${line(j)}  (${j.skip_reason ?? 'check'})`);
  parts.push(
    '',
    `Skipped (${String(skipped.length)}): ${[...by].map(([r, n]) => `${r} ${String(n)}`).join(', ') || 'none'}`,
  );
  if (health.length) parts.push('', ...health);
  const subject = runError
    ? `Job agent — run failed (${date})`
    : `Job agent — ${String(ready.length)} ready, ${String(review.length)} need review (${date})`;
  return { subject, text: `${parts.join('\n')}\n` };
}

export async function sendDigest(gmail: GmailWriter, cfg: Config, d: Digest): Promise<void> {
  const me = await gmail.myAddress();
  const to = cfg.digest.to ?? '(not set)';
  if (to.toLowerCase() !== me) {
    throw new Error(`digest.to (${to}) must be your own Gmail address (${me})`);
  }
  await gmail.sendRaw(
    buildMime({ fromName: 'Job agent', fromEmail: me, to: me, subject: d.subject, text: d.text }),
  );
}
