// Stage 5.3b, enrichment (D30): a job from an alert or a group post often has only a
// title, a company and a link. Before scoring, the link is followed (guarded, polite)
// to the full description and, when the company hires through an ATS, to the job on the
// company's own board. That board is then polled on later runs (dynamic companies).
//
// Never fetched: hosts that refuse automated access (enrich.skip_hosts: Indeed 401,
// Bayt 403) and application forms (enrich.form_hosts: the form is the application).
import type { Logger } from 'pino';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { ADAPTERS, htmlText } from '../collect/ats/adapters.js';
import { postingText } from '../collect/ats/collect.js';
import { boardFromName, boardFromText, type BoardHit } from '../collect/ats/discover.js';
import { detectIn } from '../collect/ats/detect.js';
import {
  jsonLdJobPosting,
  linkedinGuestJob,
  linkedinJobId,
  type PageJob,
} from '../collect/pages/jobpage.js';
import { UsageLimitError, type Llm } from '../llm/types.js';
import type { PoliteHttp } from '../util/http.js';
import { canonicalTitle, diceSimilarity } from '../util/text.js';
import { canonicalizeUrl } from '../util/url.js';
import { extractJobs, type CheckedJob } from './extract.js';

export interface EnrichDeps {
  http: PoliteHttp;
  /** Short-timeout, single-attempt client for guessing boards (see DiscoverDeps). */
  probeHttp?: PoliteHttp;
  /** Paced separately (alerts.linkedin_min_interval_seconds). */
  linkedinHttp: PoliteHttp;
  db: Db;
  cfg: Config;
  llm: Llm;
  now: Date;
  log: Logger;
}

export interface Enrichment {
  job: CheckedJob;
  /** Apply on the company's own site (ATS posting), when found. */
  directUrl: string | null;
  /** linkedin_offsite | linkedin_easy_apply | form | blocked_host */
  note: string | null;
  /** The page the full description came from. */
  enrichedFrom: string | null;
  companyId: number | null;
}

const SHORTENERS =
  /^(bit\.ly|lnkd\.in|tinyurl\.com|t\.co|cutt\.ly|rb\.gy|shorturl\.at|is\.gd|ow\.ly|buff\.ly|tiny\.cc|t\.ly)$/;

const hostIn = (host: string, list: string[]) =>
  list.some((h) => host === h || host.endsWith(`.${h}`));

function isoDate(v: string | null): string | null {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
}

/** Re-extracts from the full description and merges what the short version lacked. */
async function mergeFull(
  d: EnrichDeps,
  job: CheckedJob,
  full: { text: string; from: string; page: PageJob | null },
  key: string | undefined,
): Promise<CheckedJob> {
  const jobs = await extractJobs(
    d.llm,
    d.cfg.llm.extract_model,
    { text: full.text, posted_at: d.now.toISOString(), source: 'job_page', source_name: full.from },
    key,
  );
  const want = canonicalTitle(job.title);
  const best = jobs
    .map((j) => ({ j, s: diceSimilarity(want, canonicalTitle(j.title)) }))
    .sort((a, b) => b.s - a.s)[0];
  const deadline = job.deadline ?? isoDate(full.page?.validThrough ?? null);
  if (!best || best.s < 0.5) {
    return { ...job, deadline, company: job.company ?? full.page?.company ?? null };
  }
  const f = best.j;
  return {
    ...job,
    // What the short post said about the target stays (verified against the post);
    // the description adds the details that scoring and tailoring need.
    company: job.company ?? f.company ?? full.page?.company ?? null,
    location: job.location ?? f.location ?? full.page?.location ?? null,
    country: job.country ?? f.country,
    work_mode: job.work_mode === 'unknown' ? f.work_mode : job.work_mode,
    seniority: job.seniority === 'unknown' ? f.seniority : job.seniority,
    years_min: job.years_min ?? f.years_min,
    requirements:
      f.requirements.length > job.requirements.length ? f.requirements : job.requirements,
    nice_to_have: f.nice_to_have.length > 0 ? f.nice_to_have : job.nice_to_have,
    eligibility: [...new Set([...job.eligibility, ...f.eligibility])],
    deadline: deadline ?? f.deadline,
    flags: [...new Set([...job.flags, ...f.flags.filter((x) => x === 'suspicious')])],
  };
}

export async function enrichJob(
  d: EnrichDeps,
  job: CheckedJob,
  o: { rawSource: string; key?: string; jobId?: number | null },
): Promise<Enrichment> {
  const none: Enrichment = {
    job,
    directUrl: null,
    note: null,
    enrichedFrom: null,
    companyId: null,
  };
  const e = d.cfg.enrich;
  // Feed postings are complete already; email jobs need no website.
  if (!e.enabled || o.rawSource === 'ats' || o.rawSource === 'html') return none;
  if (job.apply_channel === 'email') return none;

  let link = job.apply_url;
  let note: string | null = null;
  let page: PageJob | null = null;
  let pageFrom: string | null = null;
  let hit: BoardHit | null = null;
  const jobRef = { title: job.title, company: job.company, link };

  try {
    if (link) {
      let host = new URL(link).hostname;
      if (hostIn(host, e.form_hosts)) return { ...none, note: 'form' };
      if (SHORTENERS.test(host)) {
        link = canonicalizeUrl(await d.http.finalUrl(link)) ?? link;
        host = new URL(link).hostname;
        jobRef.link = link;
      }
      const liId = linkedinJobId(link);
      if (detectIn(link)) {
        hit = await boardFromText(d, link, jobRef, o.jobId ?? null);
      } else if (liId) {
        if (d.cfg.alerts.fetch_linkedin_public_page) {
          const html = await d.linkedinHttp.get(
            `https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${liId}`,
            'text/html',
          );
          page = linkedinGuestJob(html);
          pageFrom = link;
          if (page?.offsite === true) note = 'linkedin_offsite';
          else if (page?.offsite === false) note = 'linkedin_easy_apply';
        }
      } else if (hostIn(host, e.skip_hosts)) {
        note = 'blocked_host';
      } else {
        const html = await d.http.get(link, 'text/html');
        page = jsonLdJobPosting(html);
        pageFrom = link;
        hit = await boardFromText(d, html, jobRef, o.jobId ?? null);
        if (!page && !hit && !hostIn(host, e.board_hosts)) {
          // The company's own job page without structured data: its text is the description.
          const text = htmlText(html).slice(0, d.cfg.ats.html_max_chars);
          if (text.length > 200)
            page = {
              title: null,
              company: null,
              location: null,
              text,
              postedAt: null,
              validThrough: null,
              offsite: null,
            };
        }
      }
    }
    const company = job.company ?? page?.company ?? null;
    // No company link yet: guess the board from the name (accepted only on a title match).
    if (!hit && company && e.probe_ats_by_name && note !== 'linkedin_easy_apply') {
      hit = await boardFromName(d, { title: job.title, company }, o.jobId ?? null);
    }
  } catch (err) {
    if (err instanceof UsageLimitError) throw err;
    d.log.warn({ job: job.title, link, err: String(err) }, 'enrichment fetch failed');
    return { ...none, job: { ...job, flags: [...job.flags, 'enrich_failed'] }, note };
  }

  let posting = hit?.posting ?? null;
  if (posting && hit && hit.entry.ats !== 'html') {
    const adapter = ADAPTERS[hit.entry.ats];
    if (adapter.details && !posting.text) {
      try {
        posting = await adapter.details(d.http, hit.entry.board, posting);
      } catch (err) {
        d.log.warn({ err: String(err) }, 'posting details failed');
      }
    }
  }
  const directUrl = posting ? canonicalizeUrl(posting.applyUrl ?? posting.url) : null;
  const full = posting?.text
    ? { text: postingText(posting, d.cfg.ats.posting_max_chars), from: posting.url, page }
    : page
      ? { text: page.text.slice(0, d.cfg.ats.posting_max_chars), from: pageFrom ?? '', page }
      : null;

  let merged = job;
  if (full && job.requirements.length < e.thin_requirements) {
    merged = await mergeFull(d, job, full, o.key);
  } else if (!job.company && page?.company) {
    merged = { ...job, company: page.company };
  }
  return {
    job: merged,
    directUrl,
    note,
    enrichedFrom: full?.from ?? null,
    companyId: hit?.companyId ?? null,
  };
}
