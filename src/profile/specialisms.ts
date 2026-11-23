// Which of the candidate's specialisms fits a job title (D44). The list, its order and its
// title patterns come from the profile, so any field works: DevOps, support, frontend…
import { normalizeTitle } from '../util/text.js';
import type { Profile } from './load.js';

/** A specialism name, as defined in the profile. */
export type Angle = string;

const cache = new WeakMap<Profile, [string, RegExp[]][]>();

function compiled(p: Profile): [string, RegExp[]][] {
  let c = cache.get(p);
  if (!c) {
    c = Object.entries(p.specialisms).map(([name, s]) => [name, s.match.map((m) => new RegExp(m, 'i'))]);
    cache.set(p, c);
  }
  return c;
}

/** The first specialism (in profile order) whose patterns match the title; else the default. */
export function specialismFor(p: Profile, title: string): Angle {
  const t = normalizeTitle(title);
  for (const [name, res] of compiled(p)) if (res.some((r) => r.test(t))) return name;
  return p.default_specialism;
}

/** The specialism's definition (the default one if the name is unknown). */
export function specialism(p: Profile, name: Angle) {
  const s = p.specialisms[name] ?? p.specialisms[p.default_specialism];
  if (!s) throw new Error(`profile has no specialism ${name}`);
  return s;
}
