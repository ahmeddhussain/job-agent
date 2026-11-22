// Parsers for public job pages (D30). Two machine-readable sources, no scraping of layout
// where a standard exists:
// - schema.org JobPosting JSON-LD, which careers sites and boards (Wuzzuf) publish for
//   search engines: title, description, company, dates.
// - LinkedIn's logged-out job page (no cookies, no login): its markup is the only source.
// Everything returned is untrusted text: it goes to the model inside <job_post> fences.
import { htmlText } from '../ats/adapters.js';

export interface PageJob {
  title: string | null;
  company: string | null;
  location: string | null;
  text: string;
  postedAt: string | null;
  validThrough: string | null;
  /** LinkedIn only: true = "Apply on company website", false = Easy Apply on LinkedIn. */
  offsite: boolean | null;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** The first schema.org JobPosting on the page, or null. */
export function jsonLdJobPosting(html: string): PageJob | null {
  const blocks = html.matchAll(
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  );
  for (const [, body] of blocks) {
    let data: unknown;
    try {
      data = JSON.parse(body ?? '');
    } catch {
      continue;
    }
    const graph = (data as { '@graph'?: unknown })['@graph'];
    const items: unknown[] = Array.isArray(data) ? data : Array.isArray(graph) ? graph : [data];
    for (const it of items) {
      const o = it as Record<string, unknown>;
      const type = o['@type'];
      if (type !== 'JobPosting' && !(Array.isArray(type) && type.includes('JobPosting'))) continue;
      const org = o['hiringOrganization'] as Record<string, unknown> | undefined;
      const loc = (Array.isArray(o['jobLocation']) ? o['jobLocation'][0] : o['jobLocation']) as
        { address?: Record<string, unknown> } | undefined;
      const a = loc?.address;
      const location =
        [str(a?.['addressLocality']), str(a?.['addressRegion']), str(a?.['addressCountry'])]
          .filter(Boolean)
          .join(', ') || null;
      const text = htmlText(str(o['description']) ?? '');
      if (!text) continue;
      return {
        title: str(o['title']),
        company: str(org?.['name']),
        location,
        text,
        postedAt: str(o['datePosted']),
        validThrough: str(o['validThrough']),
        offsite: null,
      };
    }
  }
  return null;
}

/** LinkedIn job id from a canonical https://linkedin.com/jobs/view/<id> link. */
export function linkedinJobId(url: string): string | null {
  return /^https:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/jobs\/view\/(\d{6,})$/.exec(url)?.[1] ?? null;
}

/** "3 months ago" / "2 days ago" (LinkedIn) → an ISO date, counted back from `now`. */
export function agoToIso(text: string | null, now: Date): string | null {
  const m = /(\d+)\s*(minute|hour|day|week|month|year)s?\s+ago/i.exec(text ?? '');
  if (!m) return null;
  const n = Number(m[1]);
  const unit = (m[2] ?? '').toLowerCase();
  const day = 86_400_000;
  const ms =
    unit === 'minute'
      ? n * 60_000
      : unit === 'hour'
        ? n * 3_600_000
        : unit === 'day'
          ? n * day
          : unit === 'week'
            ? n * 7 * day
            : unit === 'month'
              ? n * 30 * day
              : n * 365 * day;
  return new Date(now.getTime() - ms).toISOString();
}

/** LinkedIn's logged-out page (jobs-guest/jobs/api/jobPosting/<id>). Shapes seen 2026-11-22. */
export function linkedinGuestJob(html: string, now: Date = new Date()): PageJob | null {
  const pick = (re: RegExp) => {
    const m = re.exec(html)?.[1];
    return m ? decodeEntities(m) || null : null;
  };
  const markup = /class="show-more-less-html__markup[^"]*"[^>]*>([\s\S]*?)<\/div>/.exec(html)?.[1];
  if (!markup) return null;
  const criteria = [
    ...html.matchAll(
      /description__job-criteria-subheader">\s*([^<]+?)\s*<\/h3>\s*<span[^>]*>\s*([^<]+?)\s*<\/span>/g,
    ),
  ].map(([, k, v]) => `${decodeEntities(k ?? '')}: ${decodeEntities(v ?? '')}`);
  const text = [htmlText(markup), ...criteria].join('\n\n').trim();
  return {
    title: pick(/topcard__title"[^>]*>([^<]+)</),
    company: pick(/topcard__org-name-link[^>]*>\s*([^<]+?)\s*</),
    location: pick(/topcard__flavor topcard__flavor--bullet"[^>]*>\s*([^<]+?)\s*</),
    text,
    postedAt: agoToIso(pick(/posted-time-ago__text[^"]*"[^>]*>\s*([^<]+?)\s*</), now),
    validThrough: null,
    offsite: /apply-link-offsite/.test(html),
  };
}
