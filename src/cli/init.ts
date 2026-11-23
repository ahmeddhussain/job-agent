// `agent init` (D45): creates a profile folder for a new user.
//   1. checks Claude Code is installed (the only service the agent needs),
//   2. asks a few questions (name, country, city, time zone),
//   3. turns the user's CV into profile.yaml and titles.yaml with one Claude call, or
//      copies the fictional example,
//   4. writes config.yaml with only what differs from config/defaults.yaml,
//   5. marks the profile "review pending": runs refuse until `agent profile:reviewed`,
//      because every CV the agent sends is built from these facts.
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { extname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parse, stringify } from 'yaml';
import { z } from 'zod';
import { loadConfig } from '../config.js';
import type { LlmCallRecord } from '../llm/types.js';
import { loadPrompt } from '../pipeline/extract.js';
import { TitleMatcher } from '../pipeline/titles.js';
import { loadProfile, parseProfile } from '../profile/load.js';
import {
  activeName,
  checkName,
  EXAMPLE_PROFILE,
  profileDir,
  ProfileError,
  REVIEW_MARKER,
  setActive,
} from '../profiles.js';
import type { Io } from './program.js';
import { claude } from './run.js';

export interface InitOptions {
  name?: string;
  cv?: string;
  fromExample?: boolean;
}

const InitOutput = z.object({
  profile_yaml: z.string().min(200),
  search_titles: z.array(z.string().min(2).max(80)).min(1).max(12),
  titles: z.object({
    p1: z.array(z.string().min(1)),
    p2: z.array(z.string().min(1)),
    exclude: z.array(z.string().min(1)),
  }),
  questions: z.array(z.string()),
});
type InitOutput = z.infer<typeof InitOutput>;

function which(cmd: string): string | null {
  try {
    return execFileSync('sh', ['-c', `command -v ${cmd}`], { encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}

/** Plain text of a CV: PDF (poppler's pdftotext), DOCX (its XML), or a text file. */
export function cvText(path: string): string {
  if (!existsSync(path)) throw new Error(`CV not found: ${path}`);
  const ext = extname(path).toLowerCase();
  let text: string;
  if (ext === '.pdf') {
    text = execFileSync('pdftotext', ['-layout', path, '-'], { encoding: 'utf8' });
  } else if (ext === '.docx') {
    const xml = execFileSync('unzip', ['-p', path, 'word/document.xml'], {
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
    });
    text = xml
      .replace(/<\/w:p>/g, '\n')
      .replace(/<w:tab\/>/g, '\t')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'");
  } else if (['.txt', '.md', '.markdown', ''].includes(ext)) {
    text = readFileSync(path, 'utf8');
  } else {
    throw new Error(`unsupported CV format ${ext}: use PDF, DOCX, TXT or Markdown`);
  }
  text = text.replace(/\n{3,}/g, '\n\n').trim();
  if (text.length < 300)
    throw new Error(`could not read enough text from ${path} (a scanned PDF? export it as text)`);
  return text.slice(0, 40_000);
}

/** config.yaml for a new profile: only the keys that differ from the shipped defaults. */
export function profileConfigText(v: {
  timezone: string;
  country: string;
  city: string;
  titles: string[];
  maxYears: number;
  claudeBinary: string;
}): string {
  const keep = [...new Set([v.country, v.city, 'Remote'].filter(Boolean))];
  const body = stringify(
    {
      timezone: v.timezone,
      search: { linkedin: { titles: v.titles, locations: [v.country] } },
      filters: { countries: [v.country], max_years_required: v.maxYears },
      ats: { keep_locations: keep },
      llm: { cli: { binary: v.claudeBinary } },
    },
    { collectionStyle: 'block' },
  );
  return `# config.yaml: only the settings this profile changes. Everything else comes from
# config/defaults.yaml (read it for every option and its meaning). Relative paths are
# inside this folder. Most of this is also editable in the dashboard (Settings).
# Reference: docs/configuration.md.

${body}
# Optional sources, off until you connect them (docs/sources.md):
# whatsapp:
#   enabled: true
#   groups: [ "Some jobs group" ]   # names from ./agent.sh whatsapp-groups
# gmail:
#   enabled: true                   # then ./agent.sh gmail-auth (docs/gmail-setup.md)
# alerts:
#   enabled: true                   # job-alert emails (Wuzzuf, Indeed, Bayt...) in Gmail
# digest:
#   enabled: true
#   to: you@gmail.com
`;
}

const ENV_TEXT = `# .env: private values for this profile (never committed; chmod 600).
# The agent uses Claude Code on your Claude subscription. By default it uses the account
# you signed in to with \`claude\`. To use a long-lived token instead, run
# \`claude setup-token\` and put it here:
# CLAUDE_CODE_OAUTH_TOKEN=
# Never put ANTHROPIC_API_KEY here: the agent refuses to run with one (it would bill API
# credits instead of your subscription).
`;

async function fromCv(dir: string, cvPath: string, io: Io): Promise<InitOutput> {
  const text = cvText(cvPath);
  io.out(`read ${String(text.length)} characters from ${cvPath}`);
  const cfg = loadConfig(join(dir, 'config.yaml'));
  const calls: LlmCallRecord[] = [];
  const llm = claude(cfg, calls);
  io.out('checking Claude Code (your subscription)...');
  const pf = await llm.preflight(cfg.llm.extract_model);
  io.out(`  claude ${pf.version}: OK`);
  const system = loadPrompt('init-profile', {
    example: readFileSync(join(profileDir(EXAMPLE_PROFILE), 'profile.yaml'), 'utf8'),
    example_titles: readFileSync(join(profileDir(EXAMPLE_PROFILE), 'titles.yaml'), 'utf8'),
  });
  const cvBlock = `<cv>\n${text.replace(/<\/?\s*cv\s*>/gi, '[tag removed]')}\n</cv>`;
  io.out(`writing your profile from the CV with ${cfg.llm.tailor_model} (about a minute)...`);
  let out = await llm.call({
    purpose: 'init',
    model: cfg.llm.tailor_model,
    system,
    prompt: `Build the profile from this CV.\n\n${cvBlock}`,
    schema: InitOutput,
    timeoutMs: cfg.llm.tailor_timeout_seconds * 1000,
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    const problems = checkOutput(out);
    if (!problems) return out;
    io.out(`  the draft has problems; asking for a fix: ${problems.slice(0, 200)}`);
    out = await llm.call({
      purpose: 'init',
      model: cfg.llm.tailor_model,
      system,
      prompt: `Your previous profile failed validation:\n${problems}\n\nFix those problems and return the whole output again. The previous profile_yaml:\n<previous>\n${out.profile_yaml}\n</previous>\n\n${cvBlock}`,
      schema: InitOutput,
      timeoutMs: cfg.llm.tailor_timeout_seconds * 1000,
    });
  }
  const left = checkOutput(out);
  if (left) out.questions.unshift(`The profile still fails validation; fix it: ${left}`);
  return out;
}

/** null when the profile and the title tiers are valid, else the problems. */
function checkOutput(o: InitOutput): string | null {
  const problems: string[] = [];
  try {
    parseProfile(parse(o.profile_yaml));
  } catch (err) {
    problems.push(err instanceof Error ? err.message : String(err));
  }
  try {
    new TitleMatcher(o.titles);
  } catch (err) {
    problems.push(`titles: ${err instanceof Error ? err.message : String(err)}`);
  }
  return problems.length ? problems.join('\n') : null;
}

export async function initCommand(opts: InitOptions, io: Io): Promise<void> {
  const tty = process.stdin.isTTY;
  const rl = tty ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  const ask = async (q: string, def = ''): Promise<string> => {
    if (!rl) return def;
    const a = (await rl.question(`${q}${def ? ` [${def}]` : ''}: `)).trim();
    return a || def;
  };
  try {
    io.out('Job agent setup: creates your profile in profiles/<name>/ (private, never committed).');
    const claudeBinary = which('claude');
    if (!claudeBinary)
      throw new ProfileError(
        'Claude Code is not installed. Install it (npm install -g @anthropic-ai/claude-code), run `claude` once to sign in with your Claude subscription, then run init again.',
      );

    const defName = (process.env['USER'] ?? 'me').toLowerCase().replace(/[^a-z0-9_-]/g, '') || 'me';
    const name = checkName(opts.name ?? (await ask('Profile name (lowercase)', defName)));
    if (name === EXAMPLE_PROFILE)
      throw new ProfileError('"example" is the shipped example: pick another name');
    const dir = profileDir(name);
    if (existsSync(join(dir, 'config.yaml')))
      throw new ProfileError(`profile "${name}" exists already (profiles/${name})`);

    const country = await ask('Country you look for jobs in', 'Egypt');
    const city = await ask('Your city (optional)', '');
    const timezone = await ask(
      'Time zone',
      Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    );
    const cv =
      opts.cv ??
      (opts.fromExample
        ? ''
        : await ask(
            'Path to your CV (PDF, DOCX, TXT or Markdown; empty = start from the example)',
            '',
          ));

    for (const sub of ['', 'data', 'output', 'secrets'])
      mkdirSync(join(dir, sub), { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, '.env'), ENV_TEXT, { mode: 0o600 });
    copyFileSync(join(profileDir(EXAMPLE_PROFILE), 'companies.yaml'), join(dir, 'companies.yaml'));
    chmodSync(join(dir, 'companies.yaml'), 0o600);
    const base = { timezone, country, city, claudeBinary };
    writeFileSync(
      join(dir, 'config.yaml'),
      profileConfigText({ ...base, titles: [], maxYears: 3 }),
      { mode: 0o600 },
    );

    let questions: string[];
    try {
      if (cv) {
        const out = await fromCv(dir, cv, io);
        writeFileSync(join(dir, 'profile.yaml'), out.profile_yaml, { mode: 0o600 });
        writeFileSync(
          join(dir, 'titles.yaml'),
          `# titles.yaml: job-title tiers (regexes). p1: wanted most; p2: adjacent; exclude: never.\n# Drafted by init from your CV: review it. Reference: docs/profiles.md.\n\n${stringify(out.titles)}`,
          { mode: 0o600 },
        );
        let maxYears = 3;
        try {
          maxYears =
            (parse(out.profile_yaml) as { max_years_required?: number }).max_years_required ?? 3;
        } catch {
          /* the profile's own problems are in questions */
        }
        writeFileSync(
          join(dir, 'config.yaml'),
          profileConfigText({ ...base, titles: out.search_titles, maxYears }),
          { mode: 0o600 },
        );
        questions = out.questions;
      } else {
        for (const f of ['profile.yaml', 'titles.yaml']) {
          copyFileSync(join(profileDir(EXAMPLE_PROFILE), f), join(dir, f));
          chmodSync(join(dir, f), 0o600);
        }
        writeFileSync(
          join(dir, 'config.yaml'),
          profileConfigText({
            ...base,
            titles: ['Cloud Engineer', 'DevOps Engineer', 'IT Support Engineer'],
            maxYears: 2,
          }),
          { mode: 0o600 },
        );
        questions = [
          'profile.yaml is the FICTIONAL example (Mona Adel): replace every fact with your own.',
          "titles.yaml and the search titles in config.yaml are the example's: set your own.",
        ];
      }
    } catch (err) {
      rmSync(dir, { recursive: true, force: true });
      throw err;
    }

    const review = [
      `Review before the first run (${new Date().toISOString().slice(0, 10)}):`,
      '',
      '1. profile.yaml: every fact is true and nothing is missing (the agent can only use what is here).',
      '2. application_answers: salary, notice period and other answers forms ask.',
      '3. titles.yaml and search titles (config.yaml): the jobs you want.',
      ...(questions.length ? ['', 'Points to check:', ...questions.map((q) => `- ${q}`)] : []),
      '',
      `When done: ./agent.sh --profile ${name} reviewed`,
      '',
    ].join('\n');
    writeFileSync(join(dir, REVIEW_MARKER), review, { mode: 0o600 });
    if (!activeName()) setActive(name);

    io.out('');
    io.out(
      `Created profiles/${name}/ ${activeName() === name ? '(active)' : `(make it active: ./agent.sh use ${name})`}`,
    );
    io.out(review);
    io.out('Then: ./agent.sh dry-run (nothing is sent), and ./agent.sh dashboard.');
    io.out('Optional: WhatsApp and Gmail (docs/sources.md).');
  } finally {
    rl?.close();
  }
}

/** `agent profile:reviewed`: validates the profile, then lets runs use it. */
export function reviewedCommand(
  dir: string,
  profilePath: string,
  titlesPath: string,
  io: Io,
): void {
  loadProfile(profilePath);
  TitleMatcher.fromFile(titlesPath);
  rmSync(join(dir, REVIEW_MARKER), { force: true });
  io.out('profile and titles are valid: runs can use this profile now');
}
