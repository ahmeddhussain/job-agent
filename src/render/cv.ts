// Assembles the CV from the profile + the validated selection, renders it, and trims or
// fills it until it is exactly one page (R14, D13). Contact data, education and
// certifications come from the profile only; the model never writes them.
import { mkdirSync, writeFileSync } from 'node:fs';
import type { Config } from '../config.js';
import type { Profile } from '../profile/load.js';
import type { TailorOutput } from '../tailor/schema.js';
import { lastTextY, pdfInfo } from './poppler.js';
import { renderTemplate, type Renderer } from './renderer.js';

const CATEGORY_LABELS: Record<string, string> = {
  linux: 'Linux',
  networking: 'Networking',
  cloud: 'Cloud',
  iac_config: 'IaC & Configuration',
  containers: 'Containers & Orchestration',
  cicd_gitops: 'CI/CD & GitOps',
  security: 'DevSecOps',
  observability: 'Monitoring & Observability',
  data_messaging: 'Databases & Messaging',
  programming: 'Programming & Scripting',
  other: 'Other',
};

/** First `max` top-level items of a stack line (commas inside parentheses don't split). */
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

const display = (url: string) => url.replace(/^https?:\/\//, '').replace(/\/$/, '');

export function contactLine(p: Profile): string[] {
  const c = p.candidate;
  return [
    c.location,
    c.email,
    c.phone,
    ...(c.phone_alt ? [c.phone_alt] : []),
    ...Object.values(c.links).map(display),
  ];
}

export function buildCvModel(p: Profile, out: TailorOutput): Record<string, unknown> {
  const skillById = new Map(
    Object.entries(p.skills).flatMap(([cat, list]) =>
      list.map((s) => [s.id, { cat, name: s.name }] as const),
    ),
  );
  const groups = new Map<string, string[]>();
  for (const id of out.skills) {
    const s = skillById.get(id);
    if (!s) continue;
    groups.set(s.cat, [...(groups.get(s.cat) ?? []), s.name]);
  }
  const entry = (pool: Profile['projects'], id: string) => pool.find((e) => e.id === id);
  return {
    name: p.candidate.full_name,
    headline: out.headline,
    contact: contactLine(p),
    summary: out.summary,
    skills: [...groups].map(([cat, items]) => ({
      label: CATEGORY_LABELS[cat] ?? cat,
      items: items.join(', '),
    })),
    experience: out.experience.map((x) => {
      const e = entry(p.experience, x.id);
      return {
        title: e?.title ?? '',
        company: e?.company ?? '',
        dates: e?.dates ?? '',
        bullets: x.bullets.map((b) => b.text),
      };
    }),
    projects: out.projects.map((x) => {
      const e = entry(p.projects, x.id);
      return {
        name: e?.name ?? x.id,
        link: e?.link ? display(e.link) : null,
        stack: e?.stack ? shortStack(e.stack) : null,
        inProgress: e?.status === 'in_progress',
        bullets: x.bullets.map((b) => b.text),
      };
    }),
    education: p.education.map((e) => ({
      degree: e.degree,
      school: e.school,
      dates: e.dates,
      gpa: e.gpa ?? null,
    })),
    certifications: p.certifications.map((c) => c.name),
    courses: out.courses.map((id) => p.courses.find((c) => c.id === id)?.name).filter(Boolean),
    languages: p.languages.map((l) => `${l.name} (${l.level})`).join(' | '),
  };
}

export function cvMarkdown(m: Record<string, unknown>): string {
  const md: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- typed accessor for the template model
  const get = <T>(k: string) => m[k] as T;
  md.push(
    `# ${get<string>('name')}`,
    '',
    `**${get<string>('headline')}**`,
    '',
    get<string[]>('contact').join(' | '),
    '',
  );
  md.push('## Summary', '', get<string>('summary'), '', '## Skills', '');
  for (const s of get<{ label: string; items: string }[]>('skills'))
    md.push(`- **${s.label}:** ${s.items}`);
  md.push('', '## Experience', '');
  for (const e of get<{ title: string; company: string; dates: string; bullets: string[] }[]>(
    'experience',
  )) {
    md.push(`**${e.title}**, ${e.company} (${e.dates})`, ...e.bullets.map((b) => `- ${b}`), '');
  }
  md.push('## Projects', '');
  for (const pr of get<{ name: string; link: string | null; bullets: string[] }[]>('projects')) {
    md.push(
      `**${pr.name}**${pr.link ? ` | ${pr.link}` : ''}`,
      ...pr.bullets.map((b) => `- ${b}`),
      '',
    );
  }
  return `${md.join('\n')}\n`;
}

export interface FitReport {
  pages: number;
  fill: number;
  rounds: number;
  trimmed: string[];
  added: string[];
}

/** One trim step, least relevant first. Returns a description, or null when nothing is left to cut. */
function trimOnce(out: TailorOutput): string | null {
  // 1. Experience keeps its single most relevant bullet first (projects carry the evidence).
  for (const ex of out.experience)
    if (ex.bullets.length > 1) return `bullet ${ex.bullets.pop()?.id ?? '?'}`;
  // 2. Lowest-ranked project bullets, last project first, keeping 2 per project...
  for (let i = out.projects.length - 1; i >= 0; i--) {
    const pr = out.projects[i];
    if (pr && pr.bullets.length > 2) return `bullet ${pr.bullets.pop()?.id ?? '?'}`;
  }
  // 3. ...then the last project (never below 2 projects)...
  if (out.projects.length > 2) return `project ${out.projects.pop()?.id ?? '?'}`;
  // 4. ...then down to 1 bullet per project, courses and the tail of the skills list.
  for (let i = out.projects.length - 1; i >= 0; i--) {
    const pr = out.projects[i];
    if (pr && pr.bullets.length > 1) return `bullet ${pr.bullets.pop()?.id ?? '?'}`;
  }
  if (out.courses.length > 0) return `course ${out.courses.pop() ?? '?'}`;
  if (out.skills.length > 10) {
    out.skills.splice(-2);
    return 'two skills';
  }
  return null;
}

/** One fill step: the next unused bullet of a selected project, in profile order (untouched text). */
function fillOnce(out: TailorOutput, p: Profile): string | null {
  for (const pick of out.projects) {
    const e = p.projects.find((x) => x.id === pick.id);
    const next = e?.bullets.find(
      (b) => !pick.bullets.some((x) => x.id === b.id) && b.status !== 'in_progress',
    );
    if (next) {
      pick.bullets.push({ id: next.id, text: next.text });
      return `bullet ${next.id}`;
    }
  }
  return null;
}

const BOTTOM_MARGIN_PT = (11 / 25.4) * 72;

async function measure(renderer: Renderer, p: Profile, out: TailorOutput, path: string) {
  writeFileSync(path, await renderer.pdf(renderTemplate('cv', buildCvModel(p, out))));
  const { pages, heightPt } = await pdfInfo(path);
  const fill = pages === 1 ? (await lastTextY(path)) / (heightPt - BOTTOM_MARGIN_PT) : 1;
  return { pages, fill };
}

/** Renders `out` to `path`, trimming or filling until exactly one page (or giving up). */
export async function renderOnePageCv(
  renderer: Renderer,
  p: Profile,
  selection: TailorOutput,
  cfg: Config,
  path: string,
): Promise<FitReport & { output: TailorOutput }> {
  const out = structuredClone(selection);
  const trimmed: string[] = [];
  const added: string[] = [];
  let { pages, fill } = await measure(renderer, p, out, path);
  let rounds = 0;
  while (pages > 1 && rounds < cfg.cv.max_trim_rounds) {
    const cut = trimOnce(out);
    if (!cut) break;
    trimmed.push(cut);
    rounds++;
    ({ pages, fill } = await measure(renderer, p, out, path));
  }
  while (pages === 1 && fill < cfg.cv.min_fill && rounds < cfg.cv.max_trim_rounds * 2) {
    const before = structuredClone(out);
    const add = fillOnce(out, p);
    if (!add) break;
    rounds++;
    const m = await measure(renderer, p, out, path);
    if (m.pages > 1) {
      // Too much: undo and re-render the last one-page version.
      Object.assign(out, before);
      ({ pages, fill } = await measure(renderer, p, out, path));
      break;
    }
    added.push(add);
    ({ pages, fill } = m);
  }
  return { pages, fill, rounds, trimmed, added, output: out };
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
