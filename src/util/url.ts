// URL canonicalization for apply links (PLAN 5.3, dedupe L3). Offline only; resolving
// shorteners needs a network request and is done in the extract stage (P2).

const TRACKING_PARAMS = new Set([
  'trk',
  'trkinfo',
  'refid',
  'trackingid',
  'lipi',
  'fbclid',
  'gclid',
  'msclkid',
  'mc_cid',
  'mc_eid',
  'ref',
  'src',
  'source',
  'originalsubdomain',
  'lever-source', // Lever boards
  'gh_src', // Greenhouse boards
]);

export function canonicalizeUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

  url.hash = '';
  url.username = '';
  url.password = '';
  url.hostname = url.hostname.toLowerCase().replace(/^(www\.|m\.)/, '');
  if (url.port === '80' || url.port === '443') url.port = '';

  // LinkedIn job links: the numeric id is the identity; everything else is tracking.
  const li = /^(?:\/comm)?\/jobs\/view\/(?:[^/]*?-)?(\d+)\/?$/.exec(url.pathname); // alert emails use /comm/
  if (url.hostname.endsWith('linkedin.com') && li?.[1]) {
    return `https://linkedin.com/jobs/view/${li[1]}`;
  }
  const liParam = url.searchParams.get('currentJobId');
  if (url.hostname.endsWith('linkedin.com') && liParam && /^\d+$/.test(liParam)) {
    return `https://linkedin.com/jobs/view/${liParam}`;
  }

  for (const key of [...url.searchParams.keys()]) {
    const k = key.toLowerCase();
    if (k.startsWith('utm_') || TRACKING_PARAMS.has(k)) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  url.protocol = 'https:';

  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '');
  const s = url.toString();
  return url.pathname === '/' && url.search === '' ? s.replace(/\/$/, '') : s;
}

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

export function findEmails(text: string): string[] {
  return [...new Set((text.match(EMAIL_RE) ?? []).map((e) => e.toLowerCase()))];
}

export function findUrls(text: string): string[] {
  return [...new Set(text.match(/https?:\/\/[^\s<>"')\]]+/gi) ?? [])];
}
