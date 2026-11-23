// Used by scripts/migrate-to-profile.sh (D45): turns an old full config/config.yaml into a
// profile config.yaml holding only what differs from config/defaults.yaml.
//   npx tsx src/dev/config-overrides.ts <old config.yaml> <new config.yaml> <whatsapp on: 0|1> <gmail on: 0|1>
import { readFileSync, writeFileSync } from 'node:fs';
import { parse, stringify } from 'yaml';
import { DEFAULTS_PATH, mergeConfig, parseConfig } from '../config.js';

type Map = Record<string, unknown>;
const isMap = (v: unknown): v is Map => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Keys of `cur` whose values differ from `base` (maps compared key by key). */
function diff(base: unknown, cur: unknown): unknown {
  if (isMap(base) && isMap(cur)) {
    const out: Map = {};
    for (const [k, v] of Object.entries(cur)) {
      const d = diff(base[k], v);
      if (d !== undefined) out[k] = d;
    }
    return Object.keys(out).length ? out : undefined;
  }
  return JSON.stringify(base) === JSON.stringify(cur) ? undefined : cur;
}

const [oldPath, newPath, wa, gm] = process.argv.slice(2);
if (!oldPath || !newPath)
  throw new Error('usage: config-overrides.ts <old> <new> <wa 0|1> <gmail 0|1>');
const defaults = parse(readFileSync(DEFAULTS_PATH, 'utf8')) as Map;
const old = parse(readFileSync(oldPath, 'utf8')) as Map;

// The old layout's paths, as they are inside the profile folder now.
const moved: Record<string, string> = {
  'profile/master_profile.yaml': 'profile.yaml',
  'config/titles.yaml': 'titles.yaml',
  'config/companies.yaml': 'companies.yaml',
};
const fix = (v: unknown): unknown => {
  if (typeof v === 'string') return moved[v] ?? v;
  if (Array.isArray(v)) return v.map(fix);
  if (isMap(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fix(x)]));
  return v;
};
const current = fix(old) as Map;
current['whatsapp'] = { ...(current['whatsapp'] as Map), enabled: wa === '1' };
current['gmail'] = { ...(current['gmail'] as Map), enabled: gm === '1' };

const over = (diff(defaults, current) ?? {}) as Map;
// Sanity: the profile config merged over the defaults is exactly the old config (plus flags).
const merged = parseConfig(mergeConfig(defaults, over), newPath);
if (JSON.stringify(parseConfig(current, oldPath)) !== JSON.stringify(merged))
  throw new Error('the reduced config does not reproduce the old one: not written');

writeFileSync(
  newPath,
  `# config.yaml: only the settings this profile changes; everything else comes from
# config/defaults.yaml. Made from the old config/config.yaml by
# scripts/migrate-to-profile.sh (${new Date().toISOString().slice(0, 10)}). Reference: docs/configuration.md.

${stringify(over)}`,
  { mode: 0o600 },
);
process.stdout.write(`wrote ${newPath}: ${Object.keys(over).join(', ')}\n`);
