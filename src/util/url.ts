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
  // Personal tokens in alert links (Bayt puts a per-user token in every link): never stored.
  'usertoken',
  'email_name',
]);

/**
 * Email click-trackers wrap the real link; the target is inside the wrapper, so it can be
 * read without a request (troubleshooting #20):
 * - Amazon SES (Wuzzuf): https://x.r.eu-west-1.awstrack.me/L0/<encoded target>/1/...
 * - Bayt: https://bayt.com/barrier/tracklink.adp?...&target_link=<encoded target>
 * - Google / Facebook redirectors: ?q= / ?u=
 */
export function unwrapTracking(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return raw;
  }
  const host = url.hostname.toLowerCase();
  let inner: string | null = null;
  if (host.endsWith('.awstrack.me')) {
    const seg = url.pathname.split('/')[2];
    if (url.pathname.startsWith('/L0/') && seg) inner = decodeURIComponent(seg);
  } else if (/(^|\.)bayt\.com$/.test(host) && url.pathname.includes('tracklink')) {
    inner = url.searchParams.get('target_link');
  } else if (/(^|\.)google\.[a-z.]+$/.test(host) && url.pathname === '/url') {
    inner = url.searchParams.get('q') ?? url.searchParams.get('url');
  } else if (/^l\.(facebook|instagram)\.com$/.test(host)) {
    inner = url.searchParams.get('u');
  }
  return inner && /^https?:\/\//i.test(inner) ? unwrapTracking(inner) : raw;
}

export function canonicalizeUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(unwrapTracking(raw.trim()));
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

  // Indeed links (rc/clk, viewjob, pagead…) carry the job key `jk`; the rest is tracking.
  const jk = url.searchParams.get('jk');
  if (/(^|\.)indeed\.com$/.test(url.hostname) && jk && /^[a-f0-9]{8,32}$/i.test(jk)) {
    return `https://${url.hostname}/viewjob?jk=${jk.toLowerCase()}`;
  }

  // Job pages on these boards are identified by the path alone; every parameter is tracking.
  if (
    /(^|\.)(wuzzuf\.net|bayt\.com)$/.test(url.hostname) &&
    /^\/(jobs|en\/[a-z-]+\/jobs)\//.test(url.pathname)
  ) {
    url.search = '';
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
