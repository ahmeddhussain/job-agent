import { describe, expect, it } from 'vitest';
import { TitleMatcher } from '../../src/pipeline/titles.js';
import { loadFixtures } from '../helpers/fixtures.js';

const matcher = TitleMatcher.fromFile('config/titles.yaml');

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

  it.each(cases)('$fixture: "$title" → tier $tier, angle $angle', (c) => {
    const d = matcher.classify(c.title);
    expect(d.tier).toBe(c.tier);
    if (d.tier === null) {
      expect(d.excluded).toBe(c.excluded);
    } else {
      expect(d.angle).toBe(c.angle);
    }
  });

  it('does not exclude seniority words (D21): years decide, not the title', () => {
    expect(matcher.classify('Senior Cloud Engineer').tier).toBe(1);
    expect(matcher.classify('Lead Technical Support Engineer').tier).toBe(1);
  });

  it('fails loudly on an invalid regex in titles.yaml', () => {
    const bad = { p1: ['('], p2: ['x'], exclude: ['x'] };
    const angles = {
      devops: ['x'],
      support: ['x'],
      monitoring: ['x'],
      networking: ['x'],
      systems: ['x'],
    };
    expect(() => new TitleMatcher({ ...bad, angles })).toThrow(/invalid regex/);
  });
});
