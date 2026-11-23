// Profiles (D45): which profile a command uses, and the layered config.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { listProfiles, resolveProfile, setActive } from '../../src/profiles.js';

let root: string;
const make = (name: string, config = 'timezone: UTC\n') => {
  mkdirSync(join(root, name), { recursive: true });
  writeFileSync(join(root, name, 'config.yaml'), config);
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'job-agent-profiles-'));
  delete process.env['JOB_AGENT_PROFILE'];
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env['JOB_AGENT_PROFILE'];
});

describe('profile selection', () => {
  it('asks for init when only the example exists', () => {
    make('example');
    expect(() => resolveProfile(undefined, root)).toThrow(/init/);
  });

  it('uses the only own profile; the example does not count', () => {
    make('example');
    make('mona');
    expect(resolveProfile(undefined, root)).toMatchObject({ name: 'mona', via: 'only' });
  });

  it('with several, needs a choice; then option > env > active file', () => {
    make('a');
    make('b');
    expect(() => resolveProfile(undefined, root)).toThrow(/several profiles/);
    setActive('a', root);
    expect(resolveProfile(undefined, root)).toMatchObject({ name: 'a', via: 'active' });
    process.env['JOB_AGENT_PROFILE'] = 'b';
    expect(resolveProfile(undefined, root)).toMatchObject({ name: 'b', via: 'env' });
    expect(resolveProfile('a', root)).toMatchObject({ name: 'a', via: 'option' });
  });

  it('refuses unknown and badly named profiles', () => {
    make('a');
    expect(() => resolveProfile('zz', root)).toThrow(/no profile "zz"/);
    expect(() => resolveProfile('../etc', root)).toThrow(/profile name/);
  });

  it('lists only folders with a config.yaml', () => {
    make('a');
    mkdirSync(join(root, 'empty'));
    expect(listProfiles(root)).toEqual(['a']);
  });
});

describe('layered config', () => {
  it('a profile config holds only changes; the rest comes from config/defaults.yaml', () => {
    make('a', 'filters:\n  countries: [ Jordan ]\ngmail:\n  enabled: true\n');
    const cfg = loadConfig(join(root, 'a', 'config.yaml'));
    expect(cfg.filters.countries).toEqual(['Jordan']);
    expect(cfg.filters.max_job_age_days).toBe(30);
    expect(cfg.gmail.enabled).toBe(true);
    expect(cfg.whatsapp.enabled).toBe(false);
  });

  it('an empty profile config is the defaults', () => {
    make('a', '');
    expect(loadConfig(join(root, 'a', 'config.yaml')).apply.mode).toBe('draft');
  });

  it('a typo in a profile config is still caught', () => {
    make('a', 'apply:\n  mdoe: send\n');
    expect(() => loadConfig(join(root, 'a', 'config.yaml'))).toThrow(/mdoe/);
  });
});
