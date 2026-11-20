// Loads profile/master_profile.yaml: the only source of facts (PLAN 8.1).
// Items marked `confirmed: false` are removed before anything else sees them (D11).
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';
import { ANGLES } from '../pipeline/titles.js';

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

const angleRecord = <T extends z.ZodType>(v: T) =>
  z.strictObject(Object.fromEntries(ANGLES.map((a) => [a, v])) as Record<(typeof ANGLES)[number], T>);

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
  headlines: angleRecord(z.string()),
  summaries: angleRecord(z.string()),
  cover_letter: z.strictObject({
    style: z.array(z.string()),
    angles: angleRecord(
      z.strictObject({ pitch: z.string(), evidence: z.array(id), motivation: z.string() }),
    ),
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
  for (const [angle, cl] of Object.entries(p.cover_letter.angles)) {
    for (const e of cl.evidence) if (!factIds.has(e)) problems.push(`cover_letter.${angle}: unknown evidence ${e}`);
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
  lines.push(`Education: ${p.education.map((e) => `${e.degree}, ${e.school} (${e.dates})`).join('; ')}`);
  lines.push(`Certifications held: ${p.certifications.map((c) => c.name).join('; ')}`);
  lines.push(`Courses (not certifications): ${p.courses.map((c) => c.name).join('; ')}`);
  lines.push(`NOT held (never claim): ${p.not_held.join('; ')}`);
  lines.push(`Languages: ${p.languages.map((l) => `${l.name} (${l.level})`).join(', ')}`);
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
