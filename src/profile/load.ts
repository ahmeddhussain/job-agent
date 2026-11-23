// Loads profile/master_profile.yaml: the only source of facts (PLAN 8.1).
// Items marked `confirmed: false` are removed before anything else sees them (D11).
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';

const id = z.string().regex(/^[a-z0-9_]+$/, 'ids are lowercase snake_case');
const status = z.enum(['done', 'in_progress']);

const Bullet = z.strictObject({
  id,
  /** Bold lead-in, as in Ahmed's own CV ("Platform & Security: ..."). */
  label: z.string().max(60).optional(),
  text: z.string().min(10),
  tags: z.array(z.string()).default([]),
  status: status.optional(),
});

const Entry = z.strictObject({
  id,
  name: z.string().optional(),
  title: z.string().optional(),
  company: z.string().optional(),
  /** Overrides the default "Company — Title" line on the CV. */
  heading: z.string().optional(),
  dates: z.string().optional(),
  link: z.url().optional(),
  stack: z.string().optional(),
  status,
  bullets: z.array(Bullet),
});

const Skill = z.strictObject({
  id,
  /** Main title shown on every CV; other skills appear only when a job asks for them (D25). */
  core: z.boolean().default(false),
  name: z.string(),
  level: z.enum(['strong', 'working', 'familiar']),
  evidence: z.array(id),
});

/**
 * A specialism (D44): one way the candidate presents themself (e.g. DevOps, Support,
 * Frontend). Defined in the profile, never in code: which job titles pick it, the CV
 * headline and summary, the cover-letter pitch, and which projects get detailed bullets.
 */
const Specialism = z.strictObject({
  /** Job-title patterns (case-insensitive regexes); the first specialism that matches wins. */
  match: z.array(z.string().min(1)).default([]),
  headline: z.string().min(3),
  summary: z.string().min(20),
  pitch: z.string().min(10),
  /** Fact ids the cover letter should prefer. */
  evidence: z.array(id),
  motivation: z.string().min(10),
  /** Projects that get bullets on the CV for this specialism, besides featured_projects. */
  detailed_projects: z.array(id).default([]),
});
export type SpecialismDef = z.infer<typeof Specialism>;

export const ProfileSchema = z.strictObject({
  candidate: z.strictObject({
    first_name: z.string(),
    last_name: z.string(),
    full_name: z.string(),
    location: z.string(),
    email: z.email(),
    phone: z.string(),
    phone_alt: z.string().optional(),
    links: z.record(z.string(), z.url()),
  }),
  max_years_required: z.number().int().min(0),
  /** In order of priority: a job title is matched against each specialism's patterns. */
  specialisms: z.record(id, Specialism).refine((r) => Object.keys(r).length > 0, 'define at least one specialism'),
  /** Used when no specialism matches the job title. */
  default_specialism: id,
  /** Projects that always get bullets on the CV (the rest show their stack only). */
  featured_projects: z.array(id).default([]),
  cover_letter: z.strictObject({
    style: z.array(z.string()),
  }),
  education: z.array(
    z.strictObject({
      id,
      degree: z.string(),
      school: z.string(),
      dates: z.string(),
      gpa: z.string().optional(),
    }),
  ),
  certifications: z.array(z.strictObject({ id, name: z.string(), issuer: z.string() })),
  badges: z.array(z.strictObject({ id, name: z.string() })),
  courses: z.array(z.strictObject({ id, name: z.string(), dates: z.string().optional() })),
  not_held: z.array(z.string().min(2)),
  experience: z.array(Entry),
  projects: z.array(Entry),
  stories: z.array(z.strictObject({ id, text: z.string() })),
  skills: z.record(z.string(), z.array(Skill)),
  soft_skills: z.array(z.string()),
  known_gaps: z.array(z.string()),
  languages: z.array(z.strictObject({ name: z.string(), level: z.string() })),
  application_answers: z.record(z.string(), z.string()),
});

export type Profile = z.infer<typeof ProfileSchema>;

/** Recursively drops every array item that has `confirmed: false`; strips the key elsewhere. */
export function dropUnconfirmed(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value
      .filter((v) => !(v && typeof v === 'object' && (v as Record<string, unknown>)['confirmed'] === false))
      .map(dropUnconfirmed);
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) if (k !== 'confirmed') out[k] = dropUnconfirmed(v);
    return out;
  }
  return value;
}

export class ProfileError extends Error {
  override name = 'ProfileError';
}

export function parseProfile(raw: unknown, source = 'profile'): Profile {
  const res = ProfileSchema.safeParse(dropUnconfirmed(raw));
  if (!res.success) throw new ProfileError(`${source} is invalid:\n${z.prettifyError(res.error)}`);
  const p = res.data;

  // Referential integrity: every evidence id must exist.
  const entryIds = new Set([...p.experience, ...p.projects].map((e) => e.id));
  const factIds = new Set([
    ...[...p.experience, ...p.projects].flatMap((e) => e.bullets.map((b) => b.id)),
    ...p.stories.map((s) => s.id),
  ]);
  const problems: string[] = [];
  for (const s of Object.values(p.skills).flat()) {
    for (const e of s.evidence) if (!entryIds.has(e)) problems.push(`skill ${s.id}: unknown evidence ${e}`);
  }
  const projectIds = new Set(p.projects.map((e) => e.id));
  if (!(p.default_specialism in p.specialisms))
    problems.push(`default_specialism ${p.default_specialism} is not one of the specialisms`);
  for (const pid of p.featured_projects)
    if (!projectIds.has(pid)) problems.push(`featured_projects: unknown project ${pid}`);
  for (const [name, sp] of Object.entries(p.specialisms)) {
    for (const e of sp.evidence) if (!factIds.has(e)) problems.push(`specialisms.${name}: unknown evidence ${e}`);
    for (const pid of sp.detailed_projects)
      if (!projectIds.has(pid)) problems.push(`specialisms.${name}: unknown project ${pid}`);
    for (const m of sp.match) {
      try {
        new RegExp(m, 'i');
      } catch {
        problems.push(`specialisms.${name}: invalid title pattern ${JSON.stringify(m)}`);
      }
    }
  }
  const all = [...entryIds, ...factIds, ...Object.values(p.skills).flat().map((s) => s.id)];
  const dup = all.filter((x, i) => all.indexOf(x) !== i);
  if (dup.length) problems.push(`duplicate ids: ${[...new Set(dup)].join(', ')}`);
  if (problems.length) throw new ProfileError(`${source}: ${problems.join('; ')}`);
  return p;
}

export function loadProfile(path: string): Profile {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new ProfileError(`cannot read ${path}`, { cause: err });
  }
  return parseProfile(parse(text), path);
}

/** The id a language is cited by: "English" → lang_english. */
export const languageId = (name: string): string =>
  `lang_${name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;

/** Every fact the model may cite, keyed by id (bullets and stories). */
export function factIndex(p: Profile): Map<string, string> {
  const m = new Map<string, string>();
  for (const e of [...p.experience, ...p.projects]) for (const b of e.bullets) m.set(b.id, b.text);
  for (const s of p.stories) m.set(s.id, s.text);
  return m;
}

/**
 * The profile as the model sees it for scoring: facts with ids, no contact details.
 * Phone numbers and email never leave the machine through a prompt.
 */
export function profileForPrompt(p: Profile): string {
  const lines: string[] = [];
  lines.push(`Location: ${p.candidate.location}. Max years of experience the candidate can match: ${p.max_years_required}.`);
  // Education, certifications and languages carry ids so the scorer can cite them as
  // evidence (live run 1: "degree … has no citable id", troubleshooting #29).
  lines.push(`Education: ${p.education.map((e) => `${e.id}: ${e.degree}, ${e.school} (${e.dates})`).join('; ')}`);
  lines.push(`Certifications held: ${p.certifications.map((c) => `${c.id}: ${c.name}`).join('; ')}`);
  lines.push(`Courses (not certifications): ${p.courses.map((c) => c.name).join('; ')}`);
  lines.push(`NOT held (never claim): ${p.not_held.join('; ')}`);
  lines.push(`Languages: ${p.languages.map((l) => `${languageId(l.name)}: ${l.name} (${l.level})`).join(', ')}`);
  lines.push(`Military status: ${p.application_answers['military_status'] ?? 'unknown'}`);
  lines.push(`Known gaps: ${p.known_gaps.join('; ')}`);
  lines.push('', 'SKILLS (id: name, level, evidence entries):');
  for (const [cat, skills] of Object.entries(p.skills)) {
    for (const s of skills) lines.push(`- ${s.id}: ${s.name} [${cat}, ${s.level}] evidence=${s.evidence.join(',') || 'none'}`);
  }
  lines.push('', 'FACTS (id: text):');
  for (const e of [...p.experience, ...p.projects]) {
    lines.push(`# ${e.id}: ${e.title ? `${e.title}, ${e.company ?? ''}` : (e.name ?? '')} (${e.status})`);
    for (const b of e.bullets)
      lines.push(
        `- ${b.id}: ${b.label ? `[${b.label}] ` : ''}${b.text}${b.status === 'in_progress' ? ' (in progress)' : ''}`);
  }
  lines.push('# stories');
  for (const s of p.stories) lines.push(`- ${s.id}: ${s.text}`);
  return lines.join('\n');
}
