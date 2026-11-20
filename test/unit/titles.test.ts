import { describe, expect, it } from 'vitest';
import { TitleMatcher } from '../../src/pipeline/titles.js';
import { loadFixtures } from '../helpers/fixtures.js';

const matcher = TitleMatcher.fromFile('config/titles.yaml');
const MAX_YEARS = 3;

const cases = loadFixtures().flatMap((f) => f.expected.jobs.map((j) => ({ fixture: f.id, ...j })));

describe('title matcher (PLAN section 6)', () => {
  it('has fixtures covering every tier, both exclusion reasons and every angle', () => {
    const tiers = new Set(cases.map((c) => c.tier));
    const excluded = new Set(cases.map((c) => c.excluded));
    const angles = new Set(cases.map((c) => c.angle));
    expect([...tiers].sort()).toEqual([1, 2, 3, null]);
    expect(excluded).toContain('seniority');
    expect(excluded).toContain('excluded_title');
    for (const a of ['devops', 'support', 'monitoring', 'networking', 'systems']) {
      expect(angles).toContain(a);
    }
  });

  it.each(cases)('$fixture: "$title" → tier $tier, angle $angle', (c) => {
    const d = matcher.classify(c.title, {
      yearsMin: c.years_min,
      juniorHint: c.seniority === 'junior' || c.seniority === 'intern',
      maxYearsRequired: MAX_YEARS,
    });
    expect(d.tier).toBe(c.tier);
    if (d.tier === null) {
      expect(d.excluded).toBe(c.excluded);
    } else {
      expect(d.angle).toBe(c.angle);
    }
  });

  it('excludes a senior title when the post gives no years', () => {
    expect(
      matcher.classify('Lead Cloud Engineer', { maxYearsRequired: MAX_YEARS }).tier,
    ).toBeNull();
  });

  it('keeps a senior title when the post itself says junior/entry', () => {
    const d = matcher.classify('Senior Technical Support Engineer', {
      juniorHint: true,
      maxYearsRequired: MAX_YEARS,
    });
    expect(d.tier).toBe(1);
  });

  it('fails loudly on an invalid regex in titles.yaml', () => {
    const bad = { p1: ['('], p2: ['x'], exclude: ['x'], seniority_exclude: ['x'] };
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
