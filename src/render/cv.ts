// Assembles the CV in the layout of Ahmed's own CV from the profile + the validated
// selection, and fits it to exactly one page (R14, D13, D24). Contact data, education
// and certifications come from the profile only; the model never writes them.
import { mkdirSync, writeFileSync } from 'node:fs';
import type { Config } from '../config.js';
import type { Profile } from '../profile/load.js';
import type { TailorOutput } from '../tailor/schema.js';
import { lastTextY, pdfInfo } from './poppler.js';
import { renderTemplate, type Renderer } from './renderer.js';

/** Section names exactly as on Ahmed's CV. */
const CATEGORY_LABELS: Record<string, string> = {
  linux: 'Linux',
  networking: 'Networking',
  cloud: 'Cloud',
  iac_config: 'Infrastructure as Code & Configuration',
  containers: 'Containers & Orchestration',
  service_mesh: 'Service Mesh & Traffic',
  cicd_gitops: 'CI/CD & GitOps',
  devsecops: 'DevSecOps',
  secrets: 'Secrets Management',
  messaging: 'Messaging',
  databases: 'Databases',
  observability: 'Monitoring & Observability',
  reliability: 'Reliability & Scaling',
  programming: 'Programming & Scripting',
  testing: 'Testing',
  devplatform: 'Developer Platform & Version Control',
};

const display = (url: string) =>
  url
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/$/, '');

/** Contact links appear as words with the URL behind them (Ahmed, D25). */
const LINK_WORDS: Record<string, string> = {
  github: 'GitHub',
  linkedin: 'LinkedIn',
  portfolio: 'Portfolio',
};

export interface Link {
  text: string;
  href: string | null;
}

/** Location | email | phones | GitHub | LinkedIn | portfolio, with real hyperlinks. */
export function contactLine(p: Profile): Link[] {
  const c = p.candidate;
  return [
    { text: c.location, href: null },
    { text: c.email, href: `mailto:${c.email}` },
    { text: c.phone, href: null },
    ...(c.phone_alt ? [{ text: c.phone_alt, href: null }] : []),
    ...Object.entries(c.links).map(([k, u]) => ({ text: LINK_WORDS[k] ?? display(u), href: u })),
  ];
}

/** First `max` top-level items of a stack line, within about one printed line. */
export function shortStack(stack: string, max = 8, maxChars = 105): string {
  const items: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of stack) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      items.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) items.push(cur.trim());
  const out: string[] = [];
  for (const it of items.slice(0, max)) {
    if (out.length > 0 && [...out, it].join(', ').length > maxChars) break;
    out.push(it);
  }
  return out.join(', ');
}

/** What the job needs from the CV, decided once per job by the caller. */
export interface RenderContext {
  /** True when the job asks for this skill (adds it next to the main titles). */
  jobMatch: (skillName: string, skillId: string) => boolean;
  /** Projects shown with bullets; all others show title + stack only (D25). */
  bulletProjects: Set<string>;
}

export const CORE_ONLY: RenderContext = { jobMatch: () => false, bulletProjects: new Set() };

export interface Layout {
  fontPt: number;
  shortStacks: boolean;
  /** Skills dropped from the least relevant end of the ordered list (last resort). */
  skillsDropped: number;
}

/**
 * Skills in Ahmed's categories: the main titles (`core`) always, plus any other skill the
 * job asks for, so the ATS finds the job's keywords. Order follows the model's ranking.
 */
export function orderedSkills(
  p: Profile,
  ranked: string[],
  dropped = 0,
  jobMatch: (name: string, id: string) => boolean = () => false,
) {
  const all = Object.entries(p.skills).flatMap(([cat, list]) => list.map((s) => ({ cat, ...s })));
  const shown = all.filter((s) => s.core);
  const shownText = () => shown.map((s) => s.name).join(' | ');
  for (const s of all) {
    if (s.core || !jobMatch(s.name, s.id)) continue;
    // Skip an extra already covered by a shown title as a whole word ("Amazon EKS" vs
    // "AWS (… EKS …)"); "SQL" is NOT covered by "MySQL" (troubleshooting #13).
    const core = s.name
      .replace(/^amazon\s+|^aws\s+/i, '')
      .replace(/\(.*?\)/g, '')
      .trim();
    const esc = core.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (core && new RegExp(`(?<![A-Za-z0-9])${esc}(?![A-Za-z0-9])`, 'i').test(shownText())) {
      continue;
    }
    shown.push(s);
  }
  const rank = new Map(ranked.map((id, i) => [id, i]));
  const score = (s: (typeof all)[number]) => rank.get(s.id) ?? 1e6 + all.indexOf(s);
  const sorted = [...shown].sort((a, b) => score(a) - score(b));
  const kept = sorted.slice(0, Math.max(0, sorted.length - dropped));
  const cats: string[] = [];
  for (const s of kept) if (!cats.includes(s.cat)) cats.push(s.cat);
  return cats.map((cat) => ({
    label: CATEGORY_LABELS[cat] ?? cat,
    items: kept
      .filter((s) => s.cat === cat)
      .map((s) => s.name)
      .join(', '),
  }));
}

export function buildCvModel(
  p: Profile,
  out: TailorOutput,
  layout: Layout = { fontPt: 10, shortStacks: false, skillsDropped: 0 },
  ctx: RenderContext = CORE_ONLY,
): Record<string, unknown> {
  const labelOf = new Map(
    [...p.experience, ...p.projects].flatMap((e) => e.bullets.map((b) => [b.id, b.label] as const)),
  );
  const bullets = (picks: { id: string; text: string; label?: string | undefined }[]) =>
    picks.map((b) => ({ label: b.label ?? labelOf.get(b.id) ?? null, text: b.text }));
  // Experience in profile order (as on Ahmed's CV).
  const experience = p.experience
    .map((e) => ({ e, pick: out.experience.find((x) => x.id === e.id) }))
    .filter((x) => x.pick)
    .map(({ e, pick }) => ({
      heading: e.heading ?? `${e.company ?? ''} — ${e.title ?? ''}`,
      dates: e.dates ?? '',
      bullets: bullets(pick?.bullets ?? []),
    }));
  return {
    fontPt: layout.fontPt,
    name: p.candidate.full_name,
    headline: out.headline,
    contact: contactLine(p),
    summary: out.summary,
    education: p.education.map((e) => ({
      degree: e.degree,
      school: e.school,
      dates: e.dates,
      gpa: e.gpa ?? null,
    })),
    certifications: p.certifications.map((c) => c.name),
    courses: out.courses.map((id) => p.courses.find((c) => c.id === id)?.name).filter(Boolean),
    experience,
    projects: out.projects.map((x) => {
      const e = p.projects.find((pr) => pr.id === x.id);
      return {
        name: e?.name ?? x.id,
        link: e?.link ?? null,
        stack: e?.stack ? (layout.shortStacks ? shortStack(e.stack) : e.stack) : null,
        bullets: ctx.bulletProjects.has(x.id) ? bullets(x.bullets) : [],
      };
    }),
    skills: [
      ...orderedSkills(p, out.skills, layout.skillsDropped, ctx.jobMatch),
      { label: 'Soft Skills', items: p.soft_skills.join(', ') },
    ],
    languages: p.languages.map((l) => `${l.name} (${l.level})`).join(' | '),
  };
}

interface MdBullet {
  label: string | null;
  text: string;
}

export function cvMarkdown(m: Record<string, unknown>): string {
  const li = (b: MdBullet) => `- ${b.label ? `**${b.label}:** ` : ''}${b.text}`;
  const md: string[] = [`# ${String(m['name'])}`, '', `**${String(m['headline'])}**`, ''];
  const contact = m['contact'] as Link[];
  md.push(contact.map((c) => (c.href ? `[${c.text}](${c.href})` : c.text)).join(' | '), '');
  md.push('## Profile', '', String(m['summary']), '', '## Experience', '');
  for (const e of m['experience'] as { heading: string; dates: string; bullets: MdBullet[] }[]) {
    md.push(`**${e.heading}** (${e.dates})`, ...e.bullets.map(li), '');
  }
  md.push('## Projects', '');
  for (const pr of m['projects'] as {
    name: string;
    link: string | null;
    stack: string | null;
    bullets: MdBullet[];
  }[]) {
    const title = pr.link ? `[${pr.name}](${pr.link})` : pr.name;
    md.push(`**${title}**${pr.stack ? ` — *${pr.stack}*` : ''}`, ...pr.bullets.map(li), '');
  }
  md.push('## Skills', '');
  for (const s of m['skills'] as { label: string; items: string }[]) {
    md.push(`- **${s.label}:** ${s.items}`);
  }
  return `${md.join('\n')}\n`;
}

export interface FitReport {
  pages: number;
  fill: number;
  rounds: number;
  fontPt: number;
  trimmed: string[];
  added: string[];
}

/**
 * One step towards one page, cheapest loss first (D24, D25): smaller font, extra
 * experience bullets, detailed-project bullets beyond 2, stack-only projects beyond
 * `min_projects`, shorter stack lines, up to `max_skills_dropped` least relevant skills,
 * detailed-project bullets beyond 1, then more skills.
 */
function shrinkOnce(out: TailorOutput, layout: Layout, cfg: Config, ctx: RenderContext): string {
  if (layout.fontPt - cfg.cv.font_pt.step >= cfg.cv.font_pt.min - 1e-9) {
    layout.fontPt = Math.round((layout.fontPt - cfg.cv.font_pt.step) * 10) / 10;
    return `font ${String(layout.fontPt)}pt`;
  }
  for (const ex of out.experience) {
    if (ex.bullets.length > 1) return `bullet ${ex.bullets.pop()?.id ?? '?'}`;
  }
  const detailed = out.projects.filter((pr) => ctx.bulletProjects.has(pr.id));
  for (let i = detailed.length - 1; i >= 0; i--) {
    const pr = detailed[i];
    if (pr && pr.bullets.length > 2) return `bullet ${pr.bullets.pop()?.id ?? '?'}`;
  }
  if (out.projects.length > cfg.cv.min_projects) {
    for (let i = out.projects.length - 1; i >= 0; i--) {
      const pr = out.projects[i];
      if (pr && !ctx.bulletProjects.has(pr.id)) {
        out.projects.splice(i, 1);
        return `project ${pr.id}`;
      }
    }
  }
  if (!layout.shortStacks) {
    layout.shortStacks = true;
    return 'shorter stack lines';
  }
  if (layout.skillsDropped < cfg.cv.max_skills_dropped) {
    layout.skillsDropped += 3;
    return 'three least relevant skills';
  }
  for (let i = detailed.length - 1; i >= 0; i--) {
    const pr = detailed[i];
    if (pr && pr.bullets.length > 1) return `bullet ${pr.bullets.pop()?.id ?? '?'}`;
  }
  if (out.courses.length > 0) return `course ${out.courses.pop() ?? '?'}`;
  layout.skillsDropped += 3;
  return 'three least relevant skills';
}

/**
 * One step back towards a full page: first the next unused bullet of a detailed project
 * (untouched profile text, labelled bullets first), then one more stack-only project.
 */
function growOnce(out: TailorOutput, p: Profile, cfg: Config, ctx: RenderContext): string | null {
  for (const pick of out.projects.filter((pr) => ctx.bulletProjects.has(pr.id))) {
    const e = p.projects.find((x) => x.id === pick.id);
    const next = e?.bullets.find(
      (b) => !pick.bullets.some((x) => x.id === b.id) && b.status !== 'in_progress',
    );
    if (next) {
      pick.bullets.push({
        id: next.id,
        text: next.text,
        ...(next.label ? { label: next.label } : {}),
      });
      return `bullet ${next.id}`;
    }
  }
  if (out.projects.length < cfg.cv.max_projects) {
    const extra = p.projects.find((x) => x.stack && !out.projects.some((pr) => pr.id === x.id));
    if (extra) {
      out.projects.push({ id: extra.id, bullets: [] });
      return `project ${extra.id}`;
    }
  }
  return null;
}

const BOTTOM_MARGIN_PT = (9 / 25.4) * 72;

async function measure(
  renderer: Renderer,
  p: Profile,
  out: TailorOutput,
  layout: Layout,
  ctx: RenderContext,
  path: string,
) {
  writeFileSync(path, await renderer.pdf(renderTemplate('cv', buildCvModel(p, out, layout, ctx))));
  const { pages, heightPt } = await pdfInfo(path);
  const fill = pages === 1 ? (await lastTextY(path)) / (heightPt - BOTTOM_MARGIN_PT) : 1;
  return { pages, fill };
}

/** Renders `selection` to `path`, shrinking or growing until exactly one page. */
export async function renderOnePageCv(
  renderer: Renderer,
  p: Profile,
  selection: TailorOutput,
  cfg: Config,
  path: string,
  ctx: RenderContext = CORE_ONLY,
): Promise<FitReport & { output: TailorOutput; layout: Layout }> {
  const out = structuredClone(selection);
  const layout: Layout = { fontPt: cfg.cv.font_pt.max, shortStacks: false, skillsDropped: 0 };
  const trimmed: string[] = [];
  const added: string[] = [];
  let { pages, fill } = await measure(renderer, p, out, layout, ctx, path);
  let rounds = 0;
  while (pages > 1 && rounds < cfg.cv.max_trim_rounds) {
    trimmed.push(shrinkOnce(out, layout, cfg, ctx));
    rounds++;
    ({ pages, fill } = await measure(renderer, p, out, layout, ctx, path));
  }
  while (pages === 1 && fill < cfg.cv.min_fill && rounds < cfg.cv.max_trim_rounds * 2) {
    const before = structuredClone(out);
    const step = growOnce(out, p, cfg, ctx);
    if (!step) break;
    rounds++;
    const m = await measure(renderer, p, out, layout, ctx, path);
    if (m.pages > 1) {
      out.projects = before.projects;
      out.experience = before.experience;
      ({ pages, fill } = await measure(renderer, p, out, layout, ctx, path));
      break;
    }
    added.push(step);
    ({ pages, fill } = m);
  }
  return { pages, fill, rounds, fontPt: layout.fontPt, trimmed, added, output: out, layout };
}

/**
 * The render context for one job: which projects show bullets (the featured ones, plus
 * Packet Tracer for networking jobs) and which extra skills the job's text asks for.
 */
export function renderContextFor(
  cfg: Config,
  angle: string,
  jobText: string,
  findTerms: (text: string) => Set<string>,
  /** Skill ids the fit score cited as evidence for this job's requirements. */
  evidenceIds: Set<string> = new Set(),
): RenderContext {
  const bulletProjects = new Set(cfg.cv.featured_projects);
  if (angle === 'networking') for (const id of cfg.cv.networking_projects) bulletProjects.add(id);
  const jobTerms = findTerms(jobText);
  const lower = jobText.toLowerCase();
  return {
    bulletProjects,
    jobMatch: (name, id) => {
      if (evidenceIds.has(id)) return true;
      const terms = findTerms(name);
      if (terms.size > 0) return [...terms].some((t) => jobTerms.has(t));
      const plain = name
        .replace(/\(.*?\)/g, '')
        .trim()
        .toLowerCase();
      return plain.length > 2 && lower.includes(plain);
    },
  };
}

/** `{First}_{Last}_CV_{Company}_{Role}.pdf`, sanitized, at most 80 characters. */
export function fileName(
  p: Profile,
  kind: 'CV' | 'Cover_Letter',
  company: string | null,
  role: string,
): string {
  const clean = (s: string) =>
    s
      .normalize('NFKD')
      .replace(/[^\w]+/g, '_')
      .replace(/^_+|_+$/g, '');
  const head = `${clean(p.candidate.first_name)}_${clean(p.candidate.last_name)}_${kind}`;
  const tail = [company ? clean(company) : null, clean(role)].filter(Boolean).join('_');
  return `${`${head}_${tail}`.slice(0, 76).replace(/_+$/, '')}.pdf`;
}

export function ensureDir(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function coverLetterHtml(
  p: Profile,
  out: TailorOutput,
  company: string | null,
  date: string,
): string {
  return renderTemplate('cover_letter', {
    name: p.candidate.full_name,
    contact: contactLine(p),
    date,
    recipient: company ? `Hiring Team, ${company}` : null,
    greeting: out.cover_letter.greeting,
    paragraphs: out.cover_letter.paragraphs,
    closing: out.cover_letter.closing,
  });
}
