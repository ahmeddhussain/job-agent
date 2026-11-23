// ATS check (PLAN 8.6, R15, D14): reads the PDF the way a parser does and blocks the
// application on any failure. Runs before every application; there is no off switch.
import { readFileSync } from 'node:fs';
import type { Config } from '../config.js';
import type { Profile } from '../profile/load.js';
import { profileText, type Vocabulary } from '../tailor/vocab.js';
import { imageCount, pdfInfo, pdfText, unembeddedFonts } from './poppler.js';

export interface AtsReport {
  pass: boolean;
  failures: string[];
  pages: number;
  images: number;
  unembeddedFonts: string[];
  headingsFound: string[];
  keywordCoverage: number;
  keywordsMissing: string[];
  checkedAt: string;
}

const digits = (s: string) => s.replace(/\D/g, '');

/** "one or more of: networking, Linux, Java…" lists alternatives: any one of them covers it. */
const ALTERNATIVES =
  /\b(one or more of|any of|at least one of|either|such as|e\.g\.|for example|or similar|or equivalent)\b|\bor\b/i;

/**
 * Coverage of the technologies named in backed requirements, by the CV text. A plain
 * requirement counts each backed term; a requirement listing alternatives counts once,
 * covered when any of its backed terms is in the CV (troubleshooting #32).
 */
export function keywordCoverageOf(
  requirements: string[],
  backed: Set<string>,
  inCv: Set<string>,
  find: (text: string) => Set<string>,
): { coverage: number; missing: string[]; units: number } {
  const singles = new Set<string>();
  const groups: string[][] = [];
  for (const r of requirements) {
    const terms = [...find(r)].filter((t) => backed.has(t));
    if (terms.length === 0) continue;
    if (terms.length > 1 && ALTERNATIVES.test(r)) groups.push(terms);
    else for (const t of terms) singles.add(t);
  }
  const missing = [...singles].filter((t) => !inCv.has(t));
  let covered = singles.size - missing.length;
  for (const g of groups) {
    if (g.some((t) => inCv.has(t))) covered++;
    else missing.push(g.join(' / '));
  }
  const units = singles.size + groups.length;
  return { coverage: units === 0 ? 1 : covered / units, missing, units };
}

/** Every URI link target in the PDF (Chrome writes link annotations uncompressed). */
export function linkTargets(pdf: Buffer): Set<string> {
  const text = pdf.toString('latin1');
  return new Set(
    [...text.matchAll(/\/URI\s*\(([^)]*)\)/g)].map((m) => (m[1] ?? '').replace(/\/$/, '')),
  );
}

export async function atsCheck(
  pdfPath: string,
  cfg: Config,
  profile: Profile,
  vocab: Vocabulary,
  /** Requirements the profile backs (fit.matched), whose keywords must appear in the CV. */
  backedRequirements: string[],
): Promise<AtsReport> {
  const failures: string[] = [];
  const [{ pages }, images, fonts, text] = await Promise.all([
    pdfInfo(pdfPath),
    imageCount(pdfPath),
    unembeddedFonts(pdfPath),
    pdfText(pdfPath),
  ]);
  if (pages !== cfg.cv.max_pages)
    failures.push(`pages: ${String(pages)} (must be ${String(cfg.cv.max_pages)})`);
  if (images > 0) failures.push(`images: ${String(images)} (text must not be in images)`);
  if (fonts.length > 0) failures.push(`fonts not embedded: ${fonts.join(', ')}`);
  if (text.replace(/\s/g, '').length < 500)
    failures.push('almost no extractable text (image-only PDF?)');

  // Headings: each required one is its own line, in the template's order.
  const lines = text.split('\n').map((l) => l.trim().toLowerCase());
  const positions = cfg.ats_check.required_headings.map((h) => ({
    h,
    i: lines.indexOf(h.toLowerCase()),
  }));
  const missing = positions.filter((x) => x.i < 0).map((x) => x.h);
  if (missing.length > 0) failures.push(`headings missing: ${missing.join(', ')}`);
  const found = positions.filter((x) => x.i >= 0);
  for (let k = 1; k < found.length; k++) {
    const a = found[k - 1];
    const b = found[k];
    if (a && b && b.i < a.i) failures.push(`heading order: "${b.h}" comes before "${a.h}"`);
  }

  // Contact details must be parseable as text.
  const flat = text.replace(/\s+/g, ' ');
  const c = profile.candidate;
  if (!flat.toLowerCase().includes(c.email.toLowerCase())) failures.push('email not found');
  for (const ph of [c.phone, c.phone_alt].filter((x): x is string => Boolean(x))) {
    if (!digits(flat).includes(digits(ph))) failures.push(`phone ${ph.slice(0, 4)}… not found`);
  }
  // Links are words ("GitHub", "Portfolio") with the URL behind them (D25), so check the
  // PDF's link annotations: each profile link must be a real, clickable target.
  const uris = linkTargets(readFileSync(pdfPath));
  for (const [name, url] of Object.entries(c.links)) {
    if (!uris.has(url.replace(/\/$/, ''))) failures.push(`${name} link missing`);
  }

  // Keyword coverage: technologies named in backed requirements must be in the CV text.
  // Only keywords the profile backs count: a requirement note like "Jira itself not
  // shown" must not demand Jira (troubleshooting #13).
  const {
    coverage: keywordCoverage,
    missing: keywordsMissing,
    units,
  } = keywordCoverageOf(
    backedRequirements,
    vocab.find(profileText(profile)),
    vocab.find(text),
    (t) => vocab.find(t),
  );
  // With 3 or fewer keywords one miss is allowed: 1 of 2 is 50% but says little (#32).
  const smallSetOk = units <= 3 && units - Math.round(keywordCoverage * units) <= 1;
  if (keywordCoverage < cfg.ats_check.min_keyword_coverage && !smallSetOk) {
    failures.push(
      `keyword coverage ${(keywordCoverage * 100).toFixed(0)}% < ${(cfg.ats_check.min_keyword_coverage * 100).toFixed(0)}%`,
    );
  }

  return {
    pass: failures.length === 0,
    failures,
    pages,
    images,
    unembeddedFonts: fonts,
    headingsFound: found.map((x) => x.h),
    keywordCoverage,
    keywordsMissing,
    checkedAt: new Date().toISOString(),
  };
}
