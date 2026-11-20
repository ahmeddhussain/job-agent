// Title tiers and angles (PLAN section 6), driven by config/titles.yaml so Ahmed can
// edit the lists without touching code.
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';
import { normalizeTitle } from '../util/text.js';

export const ANGLES = ['devops', 'support', 'monitoring', 'networking', 'systems'] as const;
export type Angle = (typeof ANGLES)[number];

const patternList = z.array(z.string().min(1)).min(1);
const TitlesSchema = z.strictObject({
  p1: patternList,
  p2: patternList,
  exclude: patternList,
  angles: z.strictObject({
    devops: patternList,
    support: patternList,
    monitoring: patternList,
    networking: patternList,
    systems: patternList,
  }),
});

interface Compiled {
  p1: RegExp[];
  p2: RegExp[];
  exclude: RegExp[];
  angles: [Angle, RegExp[]][];
}

export type TitleDecision =
  | { tier: 1 | 2 | 3; angle: Angle; matched: string | null; titleNorm: string }
  | { tier: null; excluded: 'excluded_title'; matched: string; titleNorm: string };

function compile(list: string[], where: string): RegExp[] {
  return list.map((p) => {
    try {
      return new RegExp(p, 'i');
    } catch (err) {
      throw new Error(`titles.yaml ${where}: invalid regex ${JSON.stringify(p)}`, { cause: err });
    }
  });
}

export class TitleMatcher {
  private readonly c: Compiled;

  constructor(raw: unknown) {
    const t = TitlesSchema.parse(raw);
    this.c = {
      p1: compile(t.p1, 'p1'),
      p2: compile(t.p2, 'p2'),
      exclude: compile(t.exclude, 'exclude'),
      angles: ANGLES.map((a) => [a, compile(t.angles[a], `angles.${a}`)]),
    };
  }

  static fromFile(path: string): TitleMatcher {
    return new TitleMatcher(parse(readFileSync(path, 'utf8')));
  }

  /**
   * The exclude list wins over everything (a "Sales Engineer – Cloud" is still sales);
   * then P1, P2, else P3 (applied only at a high score). Seniority words don't exclude
   * (D21): the years a post asks for are checked separately and drive the experience score.
   */
  classify(title: string): TitleDecision {
    const titleNorm = normalizeTitle(title);
    const hit = (res: RegExp[]) => res.find((r) => r.test(titleNorm));

    const ex = hit(this.c.exclude);
    if (ex) return { tier: null, excluded: 'excluded_title', matched: ex.source, titleNorm };

    const p1 = hit(this.c.p1);
    if (p1) return { tier: 1, angle: this.angle(titleNorm), matched: p1.source, titleNorm };
    const p2 = hit(this.c.p2);
    if (p2) return { tier: 2, angle: this.angle(titleNorm), matched: p2.source, titleNorm };
    return { tier: 3, angle: this.angle(titleNorm), matched: null, titleNorm };
  }

  /** First angle (in ANGLES order of specificity below) whose patterns match; default devops. */
  angle(titleNorm: string): Angle {
    // Specific angles first: "NOC Support Engineer" is monitoring, "Network Support" is networking.
    const order: Angle[] = ['monitoring', 'networking', 'systems', 'support', 'devops'];
    for (const a of order) {
      const res = this.c.angles.find(([name]) => name === a)?.[1] ?? [];
      if (res.some((r) => r.test(titleNorm))) return a;
    }
    return 'devops';
  }
}
