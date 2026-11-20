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
  const backed = vocab.find(profileText(profile));
  const wanted = new Set<string>();
  for (const r of backedRequirements)
    for (const t of vocab.find(r)) if (backed.has(t)) wanted.add(t);
  const inCv = vocab.find(text);
  const keywordsMissing = [...wanted].filter((t) => !inCv.has(t));
  const keywordCoverage =
    wanted.size === 0 ? 1 : (wanted.size - keywordsMissing.length) / wanted.size;
  if (keywordCoverage < cfg.ats_check.min_keyword_coverage) {
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
