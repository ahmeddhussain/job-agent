// The truth validator (PLAN 8.1). The model may select and rephrase; it may never add
// a fact. Every check here is in code, so a prompt injection or a model mistake can't
// get an invented certification, number or tool into an application.
import type { Profile } from '../profile/load.js';
import type { TailorOutput } from './schema.js';
import { numbersIn, profileText, type Vocabulary } from './vocab.js';

export interface JobContext {
  title: string;
  company: string | null;
}

export type Field =
  'headline' | 'summary' | 'cover_letter' | 'email_body' | 'why_this_role' | 'selection';

export interface ValidationResult {
  ok: boolean;
  /** Problems per bullet id (rephrase vs source). */
  bullets: Map<string, string[]>;
  /** Problems per free-text field, or with the selection of ids. */
  fields: Map<Field, string[]>;
}

const CLICHES = [
  'i am writing to express my interest',
  'i am writing to apply',
  'team player',
  'passionate about technology',
  'hard-working',
  'hardworking',
  'go-getter',
  'think outside the box',
  'start of my career',
  'beginning of my career',
  'eager to learn',
  'want to learn',
];
const SENIORITY_CLAIMS = /\b(senior|lead|principal|staff|head of|manager|architect)\b/i;
const IN_PROGRESS = /\b(in progress|ongoing|currently|being built|underway)\b/i;

/** Case-insensitive whole-phrase matcher; spaces and hyphens in the phrase match either. */
export function notHeldRegex(phrase: string): RegExp {
  const body = phrase
    .trim()
    .split(/[\s-]+/)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[\\s-]+');
  return new RegExp(`(?<![A-Za-z0-9])${body}(?![A-Za-z0-9])`, 'i');
}

function words(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

export function validateTailor(
  out: TailorOutput,
  profile: Profile,
  vocab: Vocabulary,
  job: JobContext,
): ValidationResult {
  const bullets = new Map<string, string[]>();
  const fields = new Map<Field, string[]>();
  const addField = (f: Field, msg: string) => fields.set(f, [...(fields.get(f) ?? []), msg]);
  const addBullet = (id: string, msg: string) => bullets.set(id, [...(bullets.get(id) ?? []), msg]);

  // Whole words only: "CKA" must not match inside "package" (troubleshooting #12).
  const notHeld = profile.not_held.map((n) => ({ n, re: notHeldRegex(n) }));
  const allText = profileText(profile);
  const profileNumbers = numbersIn(allText);
  const profileTerms = vocab.find(allText);

  // ---- selection: every id must exist where the model says it does
  const skillIds = new Set(
    Object.values(profile.skills)
      .flat()
      .map((s) => s.id),
  );
  for (const s of out.skills) if (!skillIds.has(s)) addField('selection', `unknown skill id ${s}`);
  const courseIds = new Set(profile.courses.map((c) => c.id));
  for (const c of out.courses)
    if (!courseIds.has(c)) addField('selection', `unknown course id ${c}`);

  const check = (picks: TailorOutput['projects'], pool: Profile['projects'], kind: string) => {
    for (const pick of picks) {
      const entry = pool.find((e) => e.id === pick.id);
      if (!entry) {
        addField('selection', `unknown ${kind} id ${pick.id}`);
        continue;
      }
      for (const b of pick.bullets) {
        const src = entry.bullets.find((x) => x.id === b.id);
        if (!src) {
          addField('selection', `bullet ${b.id} does not belong to ${kind} ${pick.id}`);
          continue;
        }
        // Numbers and technologies in the rephrase must come from this bullet.
        // Label + text of the rephrase vs label + text of the source.
        const srcFull = `${src.label ?? ''} ${src.text}`;
        const outFull = `${b.label ?? ''} ${b.text}`;
        const srcNums = numbersIn(srcFull);
        for (const n of numbersIn(outFull))
          if (!srcNums.has(n)) addBullet(b.id, `number ${n} is not in the source bullet`);
        const srcTerms = vocab.find(srcFull);
        for (const t of vocab.find(outFull))
          if (!srcTerms.has(t)) addBullet(b.id, `"${t}" is not in the source bullet`);
        if (
          (src.status === 'in_progress' ||
            (entry.status === 'in_progress' && src.status !== 'done')) &&
          !IN_PROGRESS.test(b.text)
        ) {
          addBullet(b.id, 'in-progress work must be described as in progress');
        }
        for (const { n, re } of notHeld)
          if (re.test(outFull)) addBullet(b.id, `mentions "${n}" (not held)`);
      }
    }
  };
  check(out.experience, profile.experience, 'experience');
  check(out.projects, profile.projects, 'project');

  // ---- free text: numbers and technologies must exist somewhere in the profile
  const free: [Field, string][] = [
    ['headline', out.headline],
    ['summary', out.summary],
    [
      'cover_letter',
      [out.cover_letter.greeting, ...out.cover_letter.paragraphs, out.cover_letter.closing].join(
        '\n',
      ),
    ],
    ['email_body', out.email_body],
    ['why_this_role', out.why_this_role],
  ];
  for (const [f, text] of free) {
    for (const n of numbersIn(text))
      if (!profileNumbers.has(n)) addField(f, `number ${n} is not in the profile`);
    for (const t of vocab.find(text))
      if (!profileTerms.has(t)) addField(f, `"${t}" is not in the profile`);
    for (const { n, re } of notHeld) if (re.test(text)) addField(f, `mentions "${n}" (not held)`);
  }
  if (SENIORITY_CLAIMS.test(out.headline))
    addField('headline', 'headline claims a seniority level');

  // ---- cover letter rules (PLAN 8.4)
  const letter = out.cover_letter.paragraphs.join(' ');
  const n = words(letter);
  if (n < 180 || n > 250) addField('cover_letter', `body is ${String(n)} words; must be 180-250`);
  const lowerLetter = `${letter} ${out.email_body}`.toLowerCase();
  for (const c of CLICHES)
    if (lowerLetter.includes(c)) addField('cover_letter', `uses the phrase "${c}"`);
  if (job.company === null && !/^dear hiring team/i.test(out.cover_letter.greeting.trim())) {
    addField('cover_letter', 'company unknown: greeting must be "Dear Hiring Team,"');
  }
  if (words(out.summary) > 75)
    addField('summary', `summary is ${String(words(out.summary))} words; max 75`);

  return { ok: bullets.size === 0 && fields.size === 0, bullets, fields };
}

/** Human-readable list of every problem, fed back to the model on the retry. */
export function describe(v: ValidationResult): string[] {
  return [
    ...[...v.fields].flatMap(([f, msgs]) => msgs.map((m) => `${f}: ${m}`)),
    ...[...v.bullets].flatMap(([id, msgs]) => msgs.map((m) => `bullet ${id}: ${m}`)),
  ];
}
