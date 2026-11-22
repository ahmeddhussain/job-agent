// Public ATS job feeds (D5). Shapes verified against live boards on 2026-11-22:
// Greenhouse (careem), Lever (palantir), Ashby (thndr), SmartRecruiters (smartrecruiters).
// Workable's job fields could not be verified live (the boards probed had no openings),
// so its adapter accepts every field as optional.
import { convert } from 'html-to-text';
import { z } from 'zod';
import type { PoliteHttp } from '../../util/http.js';

export type AtsKind = 'greenhouse' | 'lever' | 'ashby' | 'smartrecruiters' | 'workable';

export interface AtsPosting {
  externalId: string;
  title: string;
  company: string;
  location: string | null;
  remote: boolean | null;
  url: string;
  applyUrl: string | null;
  /** ISO time the posting was published or last updated, when the feed says. */
  postedAt: string | null;
  /** Plain-text description (may be empty until details are fetched). */
  text: string;
}

export interface AtsAdapter {
  kind: AtsKind;
  list(http: PoliteHttp, board: string, company: string): Promise<AtsPosting[]>;
  /** Fills `text` for feeds whose list endpoint has no description (SmartRecruiters). */
  details?(http: PoliteHttp, board: string, p: AtsPosting): Promise<AtsPosting>;
}

const enc = encodeURIComponent;

/** HTML (or HTML-escaped HTML, as Greenhouse sends) → plain text. */
export function htmlText(html: string | null | undefined): string {
  if (!html) return '';
  const unescaped = /&lt;\w/.test(html)
    ? html
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&')
    : html;
  return convert(unescaped, { wordwrap: false, selectors: [{ selector: 'img', format: 'skip' }] })
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const iso = (v: unknown): string | null => {
  if (typeof v === 'number') return new Date(v).toISOString();
  if (typeof v === 'string' && !Number.isNaN(Date.parse(v))) return new Date(v).toISOString();
  return null;
};

// ------------------------------------------------------------------ Greenhouse
const GhJobs = z.looseObject({
  jobs: z.array(
    z.looseObject({
      id: z.union([z.number(), z.string()]),
      title: z.string(),
      absolute_url: z.string(),
      updated_at: z.string().nullish(),
      first_published: z.string().nullish(),
      location: z.looseObject({ name: z.string().nullish() }).nullish(),
      content: z.string().nullish(),
      company_name: z.string().nullish(),
    }),
  ),
});

const greenhouse: AtsAdapter = {
  kind: 'greenhouse',
  async list(http, board, company) {
    const d = GhJobs.parse(
      await http.json(`https://boards-api.greenhouse.io/v1/boards/${enc(board)}/jobs?content=true`),
    );
    return d.jobs.map((j) => ({
      externalId: String(j.id),
      title: j.title,
      company: j.company_name ?? company,
      location: j.location?.name ?? null,
      remote: j.location?.name ? /remote/i.test(j.location.name) : null,
      url: j.absolute_url,
      applyUrl: j.absolute_url,
      postedAt: iso(j.first_published ?? j.updated_at),
      text: htmlText(j.content),
    }));
  },
};

// ------------------------------------------------------------------ Lever
const LvJobs = z.array(
  z.looseObject({
    id: z.string(),
    text: z.string(),
    hostedUrl: z.string(),
    applyUrl: z.string().nullish(),
    createdAt: z.number().nullish(),
    workplaceType: z.string().nullish(),
    categories: z.looseObject({ location: z.string().nullish() }).nullish(),
    descriptionPlain: z.string().nullish(),
    additionalPlain: z.string().nullish(),
    lists: z
      .array(z.looseObject({ text: z.string().nullish(), content: z.string().nullish() }))
      .nullish(),
  }),
);

const lever: AtsAdapter = {
  kind: 'lever',
  async list(http, board, company) {
    const d = LvJobs.parse(
      await http.json(`https://api.lever.co/v0/postings/${enc(board)}?mode=json`),
    );
    return d.map((j) => ({
      externalId: j.id,
      title: j.text,
      company,
      location: j.categories?.location ?? null,
      remote: j.workplaceType ? j.workplaceType === 'remote' : null,
      url: j.hostedUrl,
      applyUrl: j.applyUrl ?? j.hostedUrl,
      postedAt: iso(j.createdAt),
      text: [
        j.descriptionPlain ?? '',
        ...(j.lists ?? []).map((l) => `${l.text ?? ''}\n${htmlText(l.content)}`),
        j.additionalPlain ?? '',
      ]
        .join('\n\n')
        .trim(),
    }));
  },
};

// ------------------------------------------------------------------ Ashby
const AbJobs = z.looseObject({
  jobs: z.array(
    z.looseObject({
      id: z.string(),
      title: z.string(),
      jobUrl: z.string(),
      applyUrl: z.string().nullish(),
      location: z.string().nullish(),
      isRemote: z.boolean().nullish(),
      isListed: z.boolean().nullish(),
      publishedAt: z.string().nullish(),
      descriptionPlain: z.string().nullish(),
    }),
  ),
});

const ashby: AtsAdapter = {
  kind: 'ashby',
  async list(http, board, company) {
    const d = AbJobs.parse(
      await http.json(`https://api.ashbyhq.com/posting-api/job-board/${enc(board)}`),
    );
    return d.jobs
      .filter((j) => j.isListed !== false)
      .map((j) => ({
        externalId: j.id,
        title: j.title,
        company,
        location: j.location ?? null,
        remote: j.isRemote ?? null,
        url: j.jobUrl,
        applyUrl: j.applyUrl ?? j.jobUrl,
        postedAt: iso(j.publishedAt),
        text: j.descriptionPlain ?? '',
      }));
  },
};

// ------------------------------------------------------------------ SmartRecruiters
const SrList = z.looseObject({
  totalFound: z.number().nullish(),
  content: z.array(
    z.looseObject({
      id: z.string(),
      name: z.string(),
      releasedDate: z.string().nullish(),
      location: z
        .looseObject({
          city: z.string().nullish(),
          country: z.string().nullish(),
          remote: z.boolean().nullish(),
        })
        .nullish(),
    }),
  ),
});
const SrDetail = z.looseObject({
  postingUrl: z.string().nullish(),
  applyUrl: z.string().nullish(),
  jobAd: z
    .looseObject({
      sections: z.record(z.string(), z.looseObject({ text: z.string().nullish() })).nullish(),
    })
    .nullish(),
});

const smartrecruiters: AtsAdapter = {
  kind: 'smartrecruiters',
  async list(http, board, company) {
    const out: AtsPosting[] = [];
    for (let offset = 0; offset < 1000; offset += 100) {
      const d = SrList.parse(
        await http.json(
          `https://api.smartrecruiters.com/v1/companies/${enc(board)}/postings?limit=100&offset=${String(offset)}`,
        ),
      );
      for (const j of d.content) {
        out.push({
          externalId: j.id,
          title: j.name,
          company,
          location:
            [j.location?.city, j.location?.country?.toUpperCase()].filter(Boolean).join(', ') ||
            null,
          remote: j.location?.remote ?? null,
          url: `https://jobs.smartrecruiters.com/${enc(board)}/${enc(j.id)}`,
          applyUrl: null,
          postedAt: iso(j.releasedDate),
          text: '',
        });
      }
      if (d.content.length < 100 || out.length >= (d.totalFound ?? 0)) break;
    }
    return out;
  },
  async details(http, board, p) {
    const d = SrDetail.parse(
      await http.json(
        `https://api.smartrecruiters.com/v1/companies/${enc(board)}/postings/${enc(p.externalId)}`,
      ),
    );
    const sections = Object.values(d.jobAd?.sections ?? {}).map((s) => htmlText(s.text));
    return {
      ...p,
      url: d.postingUrl ?? p.url,
      applyUrl: d.applyUrl ?? d.postingUrl ?? p.url,
      text: sections.join('\n\n').trim(),
    };
  },
};

// ------------------------------------------------------------------ Workable
const WkAccount = z.looseObject({
  name: z.string().nullish(),
  jobs: z.array(
    z.looseObject({
      title: z.string(),
      shortcode: z.string().nullish(),
      url: z.string().nullish(),
      application_url: z.string().nullish(),
      city: z.string().nullish(),
      country: z.string().nullish(),
      telecommuting: z.boolean().nullish(),
      published_on: z.string().nullish(),
      created_at: z.string().nullish(),
      description: z.string().nullish(),
    }),
  ),
});

const workable: AtsAdapter = {
  kind: 'workable',
  async list(http, board, company) {
    const d = WkAccount.parse(
      await http.json(
        `https://apply.workable.com/api/v1/widget/accounts/${enc(board)}?details=true`,
      ),
    );
    return d.jobs
      .filter((j) => j.url ?? j.shortcode)
      .map((j) => ({
        externalId: j.shortcode ?? j.url ?? j.title,
        title: j.title,
        company: d.name ?? company,
        location: [j.city, j.country].filter(Boolean).join(', ') || null,
        remote: j.telecommuting ?? null,
        url: j.url ?? `https://apply.workable.com/${enc(board)}/j/${enc(j.shortcode ?? '')}/`,
        applyUrl: j.application_url ?? j.url ?? null,
        postedAt: iso(j.published_on ?? j.created_at),
        text: htmlText(j.description),
      }));
  },
};

export const ADAPTERS: Record<AtsKind, AtsAdapter> = {
  greenhouse,
  lever,
  ashby,
  smartrecruiters,
  workable,
};
