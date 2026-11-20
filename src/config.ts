// Loads config/config.yaml and validates it with zod. Every model ID, threshold,
// cap and path lives here, never in code (CLAUDE.md hard rule 5).
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';

const positiveInt = z.number().int().positive();
const ratio = z.number().min(0).max(1);

/** Rejects placeholder values copied from the example file. */
const realString = z
  .string()
  .min(1)
  .refine((v) => !v.trim().toUpperCase().startsWith('TODO'), {
    message: 'placeholder value (starts with TODO); set a real value',
  });

export const ConfigSchema = z.strictObject({
  timezone: realString,
  paths: z.strictObject({
    db: realString,
    profile: realString,
    titles: realString,
  }),
  run: z.strictObject({
    first_run_lookback_hours: positiveInt,
    overlap_minutes: z.number().int().min(0),
    lock_file: realString,
  }),
  whatsapp: z.strictObject({
    session_path: realString,
    groups: z.array(realString),
    fetch_limit: positiveInt,
    settle_seconds: z.number().int().min(0),
  }),
  alerts: z.strictObject({
    gmail_label: realString,
    fetch_linkedin_public_page: z.boolean(),
    linkedin_min_interval_seconds: z.number().min(5),
  }),
  ats: z.strictObject({
    companies_file: realString,
    min_interval_seconds: z.number().min(1),
    user_agent: realString,
  }),
  llm: z.strictObject({
    provider: z.literal('claude_cli'), // D17: headless Claude Code on the subscription
    cli: z.strictObject({
      binary: realString,
      pinned_version: z.string().regex(/^\d+\.\d+\.\d+$/),
    }),
    extract_model: realString,
    score_model: realString,
    tailor_model: realString,
    max_jobs_per_run: positiveInt.nullable(), // null = no cap (R18)
    max_tailor_per_run: positiveInt.nullable(),
    timeout_seconds: positiveInt,
    max_retries: z.number().int().min(0).max(10),
  }),
  filters: z.strictObject({
    locations: z.array(realString).min(1),
    allow_remote: z.boolean(),
    max_years_required: z.number().int().min(0),
    skip_seniority: z.array(z.enum(['intern', 'junior', 'mid', 'senior', 'lead'])),
  }),
  scoring: z.strictObject({
    thresholds: z.strictObject({
      p1: z.number().int().min(0).max(100),
      p2: z.number().int().min(0).max(100),
      p3: z.number().int().min(0).max(100),
    }),
  }),
  dedupe: z.strictObject({
    content_window_days: positiveInt,
    near_dup_window_days: positiveInt,
    simhash_max_distance: z.number().int().min(0).max(64),
    near_dup_similarity: ratio,
    title_similarity: ratio,
    cooldown_days: positiveInt,
    same_recruiter_days: positiveInt,
    check_gmail_sent: z.boolean(),
  }),
  apply: z.strictObject({
    mode: z.enum(['draft', 'send']),
    auto_send_min_score: z.number().int().min(0).max(100),
    auto_send_max_priority: z.number().int().min(1).max(3),
    daily_send_cap: z.number().int().min(0),
    min_seconds_between_sends: z.number().int().min(60),
    output_dir: realString,
    cv_language: z.enum(['en', 'ar']),
  }),
  cv: z.strictObject({
    max_pages: z.literal(1), // R14: an applied CV is exactly one page; not configurable upward
    min_fill: ratio,
    max_trim_rounds: positiveInt,
  }),
  ats_check: z.strictObject({
    // R15: there is deliberately no `enabled` flag; the check always runs.
    required_headings: z.array(realString).min(1),
    min_keyword_coverage: ratio,
  }),
  digest: z.strictObject({
    enabled: z.boolean(),
    to: realString.pipe(z.email()),
  }),
  dashboard: z.strictObject({
    host: realString,
    port: z.number().int().min(1).max(65535),
    stale_run_hours: positiveInt,
  }),
});

export type Config = z.infer<typeof ConfigSchema>;

export class ConfigError extends Error {
  override name = 'ConfigError';
}

/** Parses and validates a config object; throws ConfigError with every problem listed. */
export function parseConfig(raw: unknown, source = 'config'): Config {
  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new ConfigError(`${source} is invalid:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

export function loadConfig(path: string): Config {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new ConfigError(
      `cannot read ${path} (copy config/config.example.yaml to it first): ${String(err)}`,
    );
  }
  return parseConfig(parse(text), path);
}
