// Settings edited from the dashboard (D39) are written back to the YAML files they live in
// (config/config.yaml, config/titles.yaml), so the files stay the single source of truth:
// comments are kept, the result is validated before writing, the previous file is kept as
// .bak, and the write is atomic.
import { copyFileSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { parse, parseDocument, type Document } from 'yaml';
import { parseConfig, type Config } from './config.js';
import { TitleMatcher } from './pipeline/titles.js';

export class SettingsError extends Error {
  override name = 'SettingsError';
}

function writeYaml(path: string, doc: Document, validate: (js: unknown) => void): void {
  const js = doc.toJS() as unknown;
  try {
    validate(js);
  } catch (err) {
    throw new SettingsError(err instanceof Error ? err.message : String(err));
  }
  copyFileSync(path, `${path}.bak`);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, doc.toString(), { mode: 0o600 });
  renameSync(tmp, path);
}

export interface Settings {
  search_titles: string[];
  search_locations: string[];
  linkedin_enabled: boolean;
  channels_follow_all: boolean;
  channels_exclude: string[];
  alerts_enabled: boolean;
  ats_enabled: boolean;
  max_job_age_days: number;
  max_years_required: number;
  thresholds: { p1: number; p2: number; p3: number };
  blocked_companies: string[];
  favorite_companies: string[];
  excluded_titles: string[];
}

export function readSettings(cfg: Config): Settings {
  const titles = parse(readFileSync(cfg.paths.titles, 'utf8')) as { exclude?: string[] };
  return {
    search_titles: cfg.search.linkedin.titles,
    search_locations: cfg.search.linkedin.locations,
    linkedin_enabled: cfg.search.linkedin.enabled,
    channels_follow_all: cfg.whatsapp.channels.follow_all,
    channels_exclude: cfg.whatsapp.channels.exclude,
    alerts_enabled: cfg.alerts.enabled,
    ats_enabled: cfg.ats.enabled,
    max_job_age_days: cfg.filters.max_job_age_days,
    max_years_required: cfg.filters.max_years_required,
    thresholds: cfg.scoring.thresholds,
    blocked_companies: cfg.preferences.blocked_companies,
    favorite_companies: cfg.preferences.favorite_companies,
    excluded_titles: titles.exclude ?? [],
  };
}

const PATHS: Record<Exclude<keyof Settings, 'excluded_titles' | 'thresholds'>, string[]> = {
  search_titles: ['search', 'linkedin', 'titles'],
  search_locations: ['search', 'linkedin', 'locations'],
  linkedin_enabled: ['search', 'linkedin', 'enabled'],
  channels_follow_all: ['whatsapp', 'channels', 'follow_all'],
  channels_exclude: ['whatsapp', 'channels', 'exclude'],
  alerts_enabled: ['alerts', 'enabled'],
  ats_enabled: ['ats', 'enabled'],
  max_job_age_days: ['filters', 'max_job_age_days'],
  max_years_required: ['filters', 'max_years_required'],
  blocked_companies: ['preferences', 'blocked_companies'],
  favorite_companies: ['preferences', 'favorite_companies'],
};

/** Applies a partial change; returns the new config (already validated). */
export function updateSettings(
  configPath: string,
  titlesPath: string,
  change: Partial<Settings>,
): Config {
  const cleanList = (xs: string[]) => [...new Set(xs.map((x) => x.trim()).filter(Boolean))];
  const doc = parseDocument(readFileSync(configPath, 'utf8'));
  for (const [k, path] of Object.entries(PATHS) as [keyof typeof PATHS, string[]][]) {
    const v = change[k];
    if (v === undefined) continue;
    doc.setIn(path, Array.isArray(v) ? cleanList(v) : v);
  }
  if (change.thresholds) {
    for (const t of ['p1', 'p2', 'p3'] as const)
      doc.setIn(['scoring', 'thresholds', t], change.thresholds[t]);
  }
  writeYaml(configPath, doc, (js) => parseConfig(js, configPath));
  if (change.excluded_titles) {
    const words = cleanList(change.excluded_titles);
    for (const w of words) {
      try {
        new RegExp(w, 'i');
      } catch {
        throw new SettingsError(`not a valid title pattern: ${w}`);
      }
    }
    const tdoc = parseDocument(readFileSync(titlesPath, 'utf8'));
    tdoc.setIn(['exclude'], words);
    writeYaml(titlesPath, tdoc, (js) => {
      new TitleMatcher(js);
    });
  }
  return parseConfig(parse(readFileSync(configPath, 'utf8')), configPath);
}
