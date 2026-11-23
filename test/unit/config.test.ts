import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { ConfigError, loadConfig, mergeConfig, parseConfig } from '../../src/config.js';

type Raw = Record<string, Record<string, unknown>>;

/** The committed example with its one placeholder (digest.to) filled in. */
function validRaw(): Raw {
  const raw = parse(readFileSync('config/defaults.yaml', 'utf8')) as Raw;
  raw['digest'] = { ...raw['digest'], to: 'someone@example.com' };
  return raw;
}

describe('config loader', () => {
  it('accepts the example config once placeholders are filled', () => {
    const cfg = parseConfig(validRaw());
    expect(cfg.apply.mode).toBe('draft');
    expect(cfg.cv.max_pages).toBe(1);
    expect(cfg.llm.tailor_model).toBeTruthy();
  });

  it('accepts the shipped defaults as they are (a profile config only changes keys)', () => {
    const raw = parse(readFileSync('config/defaults.yaml', 'utf8')) as unknown;
    expect(parseConfig(raw).gmail.enabled).toBe(false);
  });

  it('needs digest.to when the digest is on', () => {
    const raw = validRaw();
    raw['digest'] = { enabled: true, to: null };
    expect(() => parseConfig(raw)).toThrow(/digest\.to/);
  });

  it('merges a profile config over the defaults: maps key by key, lists replaced', () => {
    const merged = mergeConfig(validRaw(), {
      filters: { countries: ['Jordan'] },
      search: { linkedin: { titles: ['Data Analyst'] } },
    }) as Raw;
    const cfg = parseConfig(merged);
    expect(cfg.filters.countries).toEqual(['Jordan']);
    expect(cfg.filters.allow_remote).toBe(true);
    expect(cfg.search.linkedin.titles).toEqual(['Data Analyst']);
    expect(cfg.search.linkedin.max_pages).toBe(5);
  });

  it('loads every profile config under profiles/ merged over the defaults', () => {
    for (const n of readdirSync('profiles')) {
      const f = join('profiles', n, 'config.yaml');
      if (existsSync(f)) expect(() => loadConfig(f)).not.toThrow();
    }
  });

  it('rejects any TODO placeholder, e.g. in the WhatsApp allowlist', () => {
    const raw = validRaw();
    raw['whatsapp'] = { ...raw['whatsapp'], groups: ['TODO: some group'] };
    expect(() => parseConfig(raw)).toThrow(/placeholder/);
  });

  it('enforces the one-page CV rule (R14): max_pages 2 is invalid', () => {
    const raw = validRaw();
    raw['cv'] = { ...raw['cv'], max_pages: 2 };
    expect(() => parseConfig(raw)).toThrow(ConfigError);
  });

  it('has no switch to turn the ATS check off (R15)', () => {
    const raw = validRaw();
    raw['ats_check'] = { ...raw['ats_check'], enabled: false };
    expect(() => parseConfig(raw)).toThrow(/enabled/);
  });

  it('rejects unknown keys so typos are caught', () => {
    const raw = validRaw();
    raw['apply'] = { ...raw['apply'], mdoe: 'send' };
    expect(() => parseConfig(raw)).toThrow(/mdoe/);
  });

  it('rejects an invalid apply mode', () => {
    const raw = validRaw();
    raw['apply'] = { ...raw['apply'], mode: 'yolo' };
    expect(() => parseConfig(raw)).toThrow(/apply\.mode/);
  });
});
