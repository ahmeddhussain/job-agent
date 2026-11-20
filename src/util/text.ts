// Text normalization shared by hashing, dedupe and title matching (PLAN 5.2).

// Emoji, pictographs, symbols, variation selectors, zero-width joiners and box/arrow
// decoration that job-group posts are full of. Letters and digits are untouched.
const DECORATION =
  /[\p{Extended_Pictographic}\p{So}\p{Sk}\u{FE00}-\u{FE0F}\u{200B}-\u{200F}\u{2060}\u{E0020}-\u{E007F}]|\u{20E3}/gu;
const ARABIC_DIACRITICS = /[ً-ٰٟۖ-ۭ]/g;
const TATWEEL = /ـ/g;
const WHATSAPP_MARKUP = /[*_~`]/g; // *bold* _italic_ ~strike~ ```mono```

/** Display-safe normalization: NFKC, decoration removed, whitespace collapsed per line. */
export function normalizeText(input: string): string {
  return input
    .normalize('NFKC')
    .replace(DECORATION, ' ')
    .split('\n')
    .map((line) => line.replace(/[ \t\f\v\u00A0]+/g, ' ').trim())
    .filter((line, i, all) => line !== '' || (i > 0 && all[i - 1] !== ''))
    .join('\n')
    .trim();
}

/**
 * Hashing key: everything that doesn't change meaning is removed, so a forward with
 * different emoji, bold markers, Arabic diacritics or line breaks hashes the same.
 */
export function hashKey(input: string): string {
  return normalizeText(input)
    .toLowerCase()
    .replace(WHATSAPP_MARKUP, '')
    .replace(ARABIC_DIACRITICS, '')
    .replace(TATWEEL, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[^\p{L}\p{N}@./:+#-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Word tokens of the hashing key (used by simhash and token-set similarity). */
export function tokens(input: string): string[] {
  return hashKey(input)
    .split(' ')
    .map((t) => t.replace(/^[./:+#-]+|[./:+#-]+$/g, ''))
    .filter((t) => t.length > 0);
}

/** Jaccard similarity of the two token sets, 0..1. */
export function tokenSetSimilarity(a: string, b: string): number {
  const sa = new Set(tokens(a));
  const sb = new Set(tokens(b));
  if (sa.size === 0 && sb.size === 0) return 1;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  return inter / (sa.size + sb.size - inter);
}

/** Sørensen–Dice similarity on character bigrams, 0..1. Robust to small wording changes. */
export function diceSimilarity(a: string, b: string): number {
  const x = a.toLowerCase().replace(/\s+/g, ' ').trim();
  const y = b.toLowerCase().replace(/\s+/g, ' ').trim();
  if (x === y) return 1;
  if (x.length < 2 || y.length < 2) return 0;
  const grams = new Map<string, number>();
  for (let i = 0; i < x.length - 1; i++) {
    const g = x.slice(i, i + 2);
    grams.set(g, (grams.get(g) ?? 0) + 1);
  }
  let inter = 0;
  for (let i = 0; i < y.length - 1; i++) {
    const g = y.slice(i, i + 2);
    const n = grams.get(g) ?? 0;
    if (n > 0) {
      grams.set(g, n - 1);
      inter++;
    }
  }
  return (2 * inter) / (x.length - 1 + (y.length - 1));
}

/** Title as matched against titles.yaml: lowercase, decoration and odd punctuation removed. */
export function normalizeTitle(title: string): string {
  return normalizeText(title)
    .toLowerCase()
    .replace(/[()[\]{}|,;:!?"'«»–—_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const SENIORITY_WORDS =
  /\b(senior|sr\.?|junior|jr\.?|mid(-level)?|entry(-level)?|lead|principal|staff|intern(ship)?|graduate|trainee|i{1,3}|[1-3])\b/g;
const TITLE_SYNONYMS: [RegExp, string][] = [
  [/\bdev\s?ops\b/g, 'devops'],
  [/\bsre\b/g, 'site reliability engineer'],
  [/\bsys\s?admin\b/g, 'system administrator'],
  [/\bsystems\b/g, 'system'],
  [/\badmin\b/g, 'administrator'],
  [/\beng\.?\b/g, 'engineer'],
  [/\binfra\b/g, 'infrastructure'],
  [/\bapp\b/g, 'application'],
  [/\btech\b/g, 'technical'],
];

/** Canonical title for the L3 fingerprint (PLAN 7): seniority removed, synonyms mapped. */
export function canonicalTitle(title: string): string {
  let t = normalizeTitle(title).replace(SENIORITY_WORDS, ' ');
  for (const [re, rep] of TITLE_SYNONYMS) t = t.replace(re, rep);
  return t
    .replace(/[^\p{L}\p{N}/&+ ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Company name for matching: lowercase, legal suffixes and punctuation removed. */
export function normalizeCompany(company: string | null | undefined): string | null {
  if (!company) return null;
  const c = normalizeText(company)
    .toLowerCase()
    .replace(/\b(inc|llc|ltd|co|corp|company|group|s\.?a\.?e|plc|gmbh)\b\.?/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return c === '' ? null : c;
}
