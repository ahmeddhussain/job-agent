// Profiles (D45): each person's setup is one folder, profiles/<name>/, holding everything
// that is theirs: config.yaml (only the settings they change), profile.yaml (their facts),
// titles.yaml, companies.yaml, .env, secrets/, data/ and output/. The CLI runs inside the
// active profile's folder, so every relative path in config means "in this profile".
//
// Which profile: --profile <name>, else JOB_AGENT_PROFILE, else profiles/.active (written
// by `agent profile:use`), else the only profile there is (the shipped example excluded).
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigError } from './config.js';
import { REPO_ROOT } from './util/root.js';

export const PROFILES_DIR = join(REPO_ROOT, 'profiles');
export const EXAMPLE_PROFILE = 'example';
/** In a profile folder: `agent init` drafted it and its owner has not checked it yet. */
export const REVIEW_MARKER = '.review-pending';
const NAME = /^[a-z0-9][a-z0-9_-]{0,39}$/;

export class ProfileError extends ConfigError {
  override name = 'ProfileError';
}

export function checkName(name: string): string {
  if (!NAME.test(name))
    throw new ProfileError(
      `profile name "${name}": use lowercase letters, digits, - or _ (up to 40 characters)`,
    );
  return name;
}

export const profileDir = (name: string, root = PROFILES_DIR): string =>
  join(root, checkName(name));

/** Profiles that exist (a folder with a config.yaml), sorted, the example included. */
export function listProfiles(root = PROFILES_DIR): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((n) => NAME.test(n))
    .filter((n) => {
      const dir = join(root, n);
      return statSync(dir).isDirectory() && existsSync(join(dir, 'config.yaml'));
    })
    .sort();
}

export function activeName(root = PROFILES_DIR): string | null {
  const f = join(root, '.active');
  if (!existsSync(f)) return null;
  const n = readFileSync(f, 'utf8').trim();
  return n || null;
}

export function setActive(name: string, root = PROFILES_DIR): void {
  const all = listProfiles(root);
  if (!all.includes(checkName(name)))
    throw new ProfileError(`no profile "${name}" (profiles: ${all.join(', ') || 'none'})`);
  writeFileSync(join(root, '.active'), `${name}\n`, { mode: 0o600 });
}

export interface ResolvedProfile {
  name: string;
  dir: string;
  /** How it was chosen (shown by `agent profile:list`). */
  via: 'option' | 'env' | 'active' | 'only';
}

export function resolveProfile(explicit?: string, root = PROFILES_DIR): ResolvedProfile {
  const all = listProfiles(root);
  const pick = (name: string, via: ResolvedProfile['via']): ResolvedProfile => {
    if (!all.includes(checkName(name)))
      throw new ProfileError(
        `no profile "${name}" in ${root} (profiles: ${all.join(', ') || 'none'}; create one: ./agent.sh init)`,
      );
    return { name, dir: profileDir(name, root), via };
  };
  if (explicit) return pick(explicit, 'option');
  const env = process.env['JOB_AGENT_PROFILE'];
  if (env) return pick(env, 'env');
  const active = activeName(root);
  if (active) return pick(active, 'active');
  const own = all.filter((n) => n !== EXAMPLE_PROFILE);
  if (own.length === 1 && own[0]) return pick(own[0], 'only');
  if (own.length === 0) {
    if (existsSync(join(root, '..', 'config', 'config.yaml')))
      throw new ProfileError(
        'this checkout still has the old single-user layout (config/config.yaml): move it into a profile with scripts/migrate-to-profile.sh <name>',
      );
    throw new ProfileError(
      'no profile yet: create yours with ./agent.sh init (or try the example: --profile example)',
    );
  }
  throw new ProfileError(
    `several profiles (${own.join(', ')}): choose one with --profile <name> or ./agent.sh use <name>`,
  );
}
