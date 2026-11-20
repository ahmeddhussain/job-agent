// Stage 5.3: raw text → structured jobs (Haiku via claude -p), then code-level checks
// that don't trust the model: addresses must be copied from the post, URLs canonical.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ExtractResultSchema, type ExtractedJob } from '../llm/schemas.js';
import type { Llm } from '../llm/types.js';
import { canonicalizeUrl, findUrls } from '../util/url.js';

export const PROMPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'prompts');

export function loadPrompt(name: string, vars: Record<string, string> = {}): string {
  let text = readFileSync(join(PROMPTS_DIR, `${name}.md`), 'utf8');
  for (const [k, v] of Object.entries(vars)) text = text.replaceAll(`{{${k}}}`, v);
  const left = /\{\{(\w+)\}\}/.exec(text);
  if (left) throw new Error(`prompt ${name}: unfilled placeholder {{${left[1] ?? ''}}}`);
  return text;
}

/** Removes characters that could close or fake our delimiters inside untrusted text. */
export function fence(text: string): string {
  return text.replace(/<\/?\s*(job_post|job)\s*>/gi, '[tag removed]');
}

const EMAIL_RE = /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i;

export interface CheckedJob extends ExtractedJob {
  flags: string[];
}

/** Post-validation (PLAN 5.3): the model may only copy contact targets, never invent them. */
export function checkExtractedJob(job: ExtractedJob, sourceText: string): CheckedJob {
  const flags: string[] = [];
  const lowerSource = sourceText.toLowerCase();

  let apply_email = job.apply_email?.trim().toLowerCase() ?? null;
  if (apply_email !== null && (!EMAIL_RE.test(apply_email) || !lowerSource.includes(apply_email))) {
    apply_email = null;
    flags.push('email_unverified');
  }

  let apply_url: string | null = null;
  if (job.apply_url) {
    const wanted = canonicalizeUrl(job.apply_url);
    const inSource = findUrls(sourceText).map(canonicalizeUrl);
    if (wanted !== null && inSource.includes(wanted)) apply_url = wanted;
    else flags.push('url_unverified');
  }

  let apply_phone = job.apply_phone?.replace(/[^\d+]/g, '') ?? null;
  if (
    apply_phone !== null &&
    !sourceText.replace(/[^\d+]/g, '').includes(apply_phone.replace(/^\+/, ''))
  ) {
    apply_phone = null;
    flags.push('phone_unverified');
  }

  const deadline = job.deadline && /^\d{4}-\d{2}-\d{2}$/.test(job.deadline) ? job.deadline : null;
  if (job.scam_signals.length > 0) flags.push('suspicious');

  return { ...job, title: job.title.trim(), apply_email, apply_url, apply_phone, deadline, flags };
}

export interface ExtractInput {
  text: string;
  posted_at: string;
  source: string;
  source_name: string | null;
}

export async function extractJobs(
  llm: Llm,
  model: string,
  input: ExtractInput,
  key?: string,
): Promise<CheckedJob[]> {
  const result = await llm.call({
    purpose: 'extract',
    model,
    system: loadPrompt('extract'),
    prompt: [
      `Post date: ${input.posted_at.slice(0, 10)}. Source: ${input.source}${input.source_name ? ` (${input.source_name})` : ''}.`,
      '<job_post>',
      fence(input.text),
      '</job_post>',
    ].join('\n'),
    schema: ExtractResultSchema,
    ...(key ? { key } : {}),
  });
  if (!result.is_job_post) return [];
  return result.jobs.map((j) => checkExtractedJob(j, input.text));
}
