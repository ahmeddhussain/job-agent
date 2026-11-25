// Loads the configuration and validates it with zod. Every model ID, threshold, cap and
// path lives in config, never in code (CLAUDE.md hard rule 5).
// Layers (D45): config/defaults.yaml (shipped) with the profile's config.yaml merged over
// it key by key; lists and scalars in the profile replace the default.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { REPO_ROOT } from './util/root.js';

/** The shipped defaults every profile config is merged over. */
export const DEFAULTS_PATH = join(REPO_ROOT, 'config', 'defaults.yaml');

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
    env: realString,
  }),
  run: z.strictObject({
    first_run_lookback_hours: positiveInt,
    overlap_minutes: z.number().int().min(0),
    lock_file: realString,
  }),
  whatsapp: z.strictObject({
    /** Optional source: off until the number is linked (./agent.sh whatsapp-login). */
    enabled: z.boolean(),
    /** Stop the run when WhatsApp can't be read, instead of going on without it. */
    required: z.boolean(),
    session_path: realString,
    groups: z.array(realString),
    fetch_limit: positiveInt,
    settle_seconds: z.number().int().min(0),
    ready_timeout_seconds: positiveInt,
    auth_timeout_seconds: positiveInt,
    login_timeout_seconds: positiveInt,
    web_cache_path: realString,
    author_salt_file: realString,
    min_text_chars: positiveInt,
    export_date_order: z.enum(['dmy', 'mdy']),
    /** D37: read every channel the account follows (except these names or ids). */
    channels: z.strictObject({
      follow_all: z.boolean(),
      exclude: z.array(realString),
      fetch_limit: positiveInt,
    }),
  }),
  gmail: z.strictObject({
    /** Optional: without Gmail, email jobs become "send it yourself" packages. */
    enabled: z.boolean(),
    client_file: realString,
    token_file: realString,
    max_alert_chars: positiveInt,
  }),
  alerts: z.strictObject({
    enabled: z.boolean(),
    /** Senders whose alerts are ignored (LinkedIn's, once its search replaces them: D38). */
    skip_from: z.array(z.string().min(3)),
    gmail_label: realString,
    skip_subjects: z.array(z.string().min(3)),
    fetch_linkedin_public_page: z.boolean(),
    linkedin_min_interval_seconds: z.number().min(5),
  }),
  /** D53: application emails, read only in live runs. */
  tracking: z.strictObject({
    enabled: z.boolean(),
    first_run_days: positiveInt,
    max_emails_per_run: positiveInt,
    body_chars: positiveInt,
    batch: z.number().int().min(1).max(10),
    news_days: positiveInt,
    skip_from: z.array(z.string().min(3)),
  }),
  search: z.strictObject({
    /** D38: LinkedIn's public job search, one search per title and location per run. */
    linkedin: z.strictObject({
      enabled: z.boolean(),
      titles: z.array(z.string().min(2).max(80)).max(30),
      locations: z.array(z.string().min(2).max(60)).min(1).max(5),
      max_pages: z.number().int().min(1).max(10),
      min_interval_seconds: z.number().min(3),
      retries: z.number().int().min(0).max(5),
      retry_wait_seconds: z.number().int().min(5).max(300),
    }),
  }),
  ats: z.strictObject({
    enabled: z.boolean(),
    companies_file: realString,
    min_interval_seconds: z.number().min(1),
    user_agent: realString,
    keep_locations: z.array(realString).min(1),
    max_age_days: positiveInt,
    posting_max_chars: positiveInt,
    html_max_chars: positiveInt,
  }),
  enrich: z.strictObject({
    enabled: z.boolean(),
    min_interval_seconds: z.number().min(1),
    /** Never fetched: they refuse automated access (Indeed 401, Bayt 403). */
    skip_hosts: z.array(realString),
    /** The form is the application: never fetched, just linked. */
    form_hosts: z.array(realString),
    /** Job boards: their page text is not the company's own description. */
    board_hosts: z.array(realString),
    probe_ats_by_name: z.boolean(),
    probe_cache_days: positiveInt,
    min_title_similarity: ratio,
    /** Re-extract from the full description when the post listed fewer requirements. */
    thin_requirements: z.number().int().min(0),
  }),
  llm: z.strictObject({
    provider: z.literal('claude_cli'), // D17: headless Claude Code on the subscription
    cli: z.strictObject({
      binary: realString,
      pinned_version: z.string().regex(/^\d+\.\d+\.\d+$/),
      home: realString,
      workdir: realString,
    }),
    extract_model: realString,
    score_model: realString,
    tailor_model: realString,
    max_jobs_per_run: positiveInt.nullable(), // null = no cap (R18)
    max_tailor_per_run: positiveInt.nullable(),
    timeout_seconds: positiveInt,
    tailor_timeout_seconds: positiveInt,
    max_retries: z.number().int().min(0).max(10),
  }),
  filters: z.strictObject({
    countries: z.array(realString).min(1),
    allow_remote: z.boolean(),
    max_years_required: z.number().int().min(0),
    /** D42: skip Senior/Lead/Head… titles unless the post asks for at most 2 years. */
    skip_senior_titles: z.boolean(),
    /** Older jobs are skipped as stale when the posting date is known (D34). */
    max_job_age_days: positiveInt,
  }),
  /** The user's lists (D39): never apply to blocked companies; always prepare favorites. */
  preferences: z.strictObject({
    blocked_companies: z.array(z.string().min(1).max(120)),
    favorite_companies: z.array(z.string().min(1).max(120)),
  }),
  /** D40: follow-up drafts for email applications without a reply. */
  followup: z.strictObject({
    after_days: positiveInt,
  }),
  scoring: z.strictObject({
    weights: z
      .strictObject({ skills: ratio, experience: ratio })
      .refine((w) => Math.abs(w.skills + w.experience - 1) < 1e-9, 'weights must add up to 1'),
    experience_scores: z.strictObject({
      '0': z.number().int().min(0).max(100),
      '1': z.number().int().min(0).max(100),
      '2': z.number().int().min(0).max(100),
      '3': z.number().int().min(0).max(100),
      unknown: z.number().int().min(0).max(100),
    }),
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
    /** `agent send-drafts`: pause between sends of reviewed drafts. */
    send_all_interval_seconds: z.number().int().min(5),
    cv_language: z.enum(['en', 'ar']),
  }),
  forms: z.strictObject({
    /** Submit web forms when every required answer is known (D33); false = fill only. */
    auto_submit: z.boolean(),
    /** Never tried as forms: boards that need an account (LinkedIn, Wuzzuf, Indeed, Bayt). */
    never_hosts: z.array(realString),
    timeout_seconds: positiveInt,
    max_pages: positiveInt,
    /** Command of the browser jobs open in (e.g. brave-browser); null = the default browser. */
    browser: z
      .string()
      .regex(/^[\w./-]+$/, 'a command name or path, without arguments')
      .nullable(),
  }),
  cv: z.strictObject({
    max_pages: z.literal(1), // R14: an applied CV is exactly one page; not configurable upward
    min_fill: ratio,
    min_projects: z.number().int().min(1).max(8),
    max_projects: z.number().int().min(1).max(10),
    max_skills_dropped: z.number().int().min(0).max(30),
    font_pt: z.strictObject({
      max: z.number().min(8).max(12),
      min: z.number().min(8).max(12),
      step: z.number().positive(),
    }),
    max_trim_rounds: positiveInt,
  }),
  ats_check: z.strictObject({
    // R15: there is deliberately no `enabled` flag; the check always runs.
    required_headings: z.array(realString).min(1),
    min_keyword_coverage: ratio,
  }),
  digest: z
    .strictObject({
      enabled: z.boolean(),
      to: z.email().nullable(),
    })
    .refine((d) => !d.enabled || d.to !== null, {
      message: 'digest.enabled needs digest.to (an email address)',
    }),
  dashboard: z.strictObject({
    /** Applications per week the user aims for (Today's goal ring, editable in Settings). */
    weekly_goal: z.number().int().min(1).max(200),
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

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Deep merge: maps merge key by key; lists, scalars and null in `over` replace `base`. */
export function mergeConfig(base: unknown, over: unknown): unknown {
  if (over === undefined) return base;
  if (!isPlainObject(base) || !isPlainObject(over)) return over;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = mergeConfig(base[k], v);
  return out;
}

function readYaml(path: string, hint: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new ConfigError(`cannot read ${path} (${hint}): ${String(err)}`);
  }
  try {
    return parse(text) as unknown;
  } catch (err) {
    throw new ConfigError(`${path} is not valid YAML: ${String(err)}`);
  }
}

/** The shipped defaults with `override` (a profile's config.yaml contents) merged over. */
export function withDefaults(override: unknown): unknown {
  return mergeConfig(readYaml(DEFAULTS_PATH, 'the shipped defaults are missing'), override ?? {});
}

/** Loads a config file merged over the shipped defaults (a full file works the same). */
export function loadConfig(path: string): Config {
  const override = readYaml(path, 'create a profile first: ./agent.sh init');
  if (override !== null && override !== undefined && !isPlainObject(override))
    throw new ConfigError(`${path} must be a YAML map of settings`);
  return parseConfig(withDefaults(override), path);
}
