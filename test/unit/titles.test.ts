import { describe, expect, it } from 'vitest';
import { TitleMatcher } from '../../src/pipeline/titles.js';
import { loadProfile } from '../../src/profile/load.js';
import { specialismFor } from '../../src/profile/specialisms.js';
import { loadFixtures } from '../helpers/fixtures.js';

const matcher = TitleMatcher.fromFile('config/titles.yaml');
// Specialisms come from the profile (D44); the example profile defines the five used here.
const profile = loadProfile('profile/master_profile.example.yaml');

const cases = loadFixtures().flatMap((f) => f.expected.jobs.map((j) => ({ fixture: f.id, ...j })));

describe('title matcher (PLAN section 6)', () => {
  it('has fixtures covering every tier, both exclusion reasons and every angle', () => {
    const tiers = new Set(cases.map((c) => c.tier));
    const excluded = new Set(cases.map((c) => c.excluded));
    const angles = new Set(cases.map((c) => c.angle));
    expect([...tiers].sort()).toEqual([1, 2, 3, null]);
    expect(excluded).toContain('excluded_title');
    for (const a of ['devops', 'support', 'monitoring', 'networking', 'systems']) {
      expect(angles).toContain(a);
    }
  });

  it.each(cases)('$fixture: "$title" → tier $tier, specialism $angle', (c) => {
    const d = matcher.classify(c.title);
    expect(d.tier).toBe(c.tier);
    if (d.tier === null) {
      expect(d.excluded).toBe(c.excluded);
    } else {
      expect(specialismFor(profile, c.title)).toBe(c.angle);
    }
  });

  it('specialisms are data: any names, profile order decides, default when nothing matches', () => {
    const base = profile.specialisms['devops'];
    if (!base) throw new Error('example profile has no devops specialism');
    const p = {
      ...profile,
      specialisms: {
        frontend: { ...base, match: ['front.?end', 'react'] },
        data: { ...base, match: ['data', 'analyst'] },
      },
      default_specialism: 'data',
    };
    expect(specialismFor(p, 'React Developer')).toBe('frontend');
    expect(specialismFor(p, 'Frontend Data Visualisation Engineer')).toBe('frontend'); // order
    expect(specialismFor(p, 'Accountant')).toBe('data'); // default
  });

  it('does not exclude seniority words (D21): years decide, not the title', () => {
    expect(matcher.classify('Senior Cloud Engineer').tier).toBe(1);
    expect(matcher.classify('Lead Technical Support Engineer').tier).toBe(1);
  });

  it('fails loudly on an invalid regex in titles.yaml', () => {
    const bad = { p1: ['('], p2: ['x'], exclude: ['x'] };
    expect(() => new TitleMatcher(bad)).toThrow(/invalid regex/);
  });
});
