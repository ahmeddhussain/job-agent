// The truth validator and the tailor step's retry/fallback (PLAN 8.1, P3 gate).
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { parseConfig } from '../../src/config.js';
import type { Llm, LlmRequest } from '../../src/llm/types.js';
import { loadProfile } from '../../src/profile/load.js';
import { fileName, shortStack } from '../../src/render/cv.js';
import type { TailorOutput } from '../../src/tailor/schema.js';
import { tailorJob, type TailorJob } from '../../src/tailor/tailor.js';
import { describe as describeErrors, validateTailor } from '../../src/tailor/validate.js';
import { numbersIn, vocabularyFor } from '../../src/tailor/vocab.js';

const raw = parse(readFileSync('config/config.example.yaml', 'utf8')) as Record<
  string,
  Record<string, unknown>
>;
raw['digest'] = { ...raw['digest'], to: 'someone@example.com' };
const cfg = parseConfig(raw);
const profile = loadProfile('profile/master_profile.example.yaml');
const vocab = vocabularyFor(profile);
const job = { title: 'DevOps Engineer', company: 'Nilecode Systems' };

/** A recorded, real Sonnet output for fixture 01 (validated when it was recorded). */
const recorded = (): TailorOutput =>
  JSON.parse(
    readFileSync('test/fixtures/llm/01-devops-email-en.tailor.1.json', 'utf8'),
  ) as TailorOutput;

const firstBullet = (o: TailorOutput) => {
  const b = o.projects[0]?.bullets[0];
  if (!b) throw new Error('recording has no project bullet');
  return b;
};

describe('truth validator', () => {
  it('accepts the recorded real output', () => {
    const v = validateTailor(recorded(), profile, vocab, job);
    expect(describeErrors(v)).toEqual([]);
  });

  it('blocks a certification from not_held anywhere (RHCSA in the summary)', () => {
    const o = recorded();
    o.summary = `${o.summary} RHCSA certified.`;
    const v = validateTailor(o, profile, vocab, job);
    expect(v.ok).toBe(false);
    expect(v.fields.get('summary')?.join()).toMatch(/rhcsa/i);
  });

  it('blocks a number that is not in the source bullet', () => {
    const o = recorded();
    const b = firstBullet(o);
    b.text = `${b.text} Cut deployment time by 73%.`;
    const v = validateTailor(o, profile, vocab, job);
    expect(v.bullets.get(b.id)?.join()).toMatch(/number 73/);
  });

  it('blocks a technology that is not in the source bullet', () => {
    const o = recorded();
    const b = firstBullet(o);
    b.text = `${b.text} Also migrated it to Azure AKS.`;
    expect(validateTailor(o, profile, vocab, job).bullets.get(b.id)?.join()).toMatch(/azure/);
  });

  it('blocks a technology the profile does not have in the cover letter, even to say it is missing', () => {
    const o = recorded();
    o.cover_letter.paragraphs[2] = `${o.cover_letter.paragraphs[2] ?? ''} I have not used Azure yet.`;
    expect(validateTailor(o, profile, vocab, job).fields.get('cover_letter')?.join()).toMatch(
      /azure/,
    );
  });

  it('blocks a seniority claim in the headline and cliches in the letter', () => {
    const o = recorded();
    o.headline = 'Senior DevOps Engineer';
    o.cover_letter.paragraphs[0] = `I am writing to express my interest. ${o.cover_letter.paragraphs[0] ?? ''}`;
    const v = validateTailor(o, profile, vocab, job);
    expect(v.fields.get('headline')?.join()).toMatch(/seniority/);
    expect(v.fields.get('cover_letter')?.join()).toMatch(/express my interest/);
  });

  it('requires "Dear Hiring Team" when the company is unknown, and 180-250 words', () => {
    const o = recorded();
    o.cover_letter.greeting = 'Dear Mr. Smith,';
    o.cover_letter.paragraphs = ['Short.', 'Too short.', 'Way too short.'];
    const msgs = validateTailor(o, profile, vocab, { title: 'X', company: null })
      .fields.get('cover_letter')
      ?.join();
    expect(msgs).toMatch(/Dear Hiring Team/);
    expect(msgs).toMatch(/must be 180-250/);
  });

  it('rejects ids that do not exist', () => {
    const o = recorded();
    o.skills.push('kubernetes_ninja');
    expect(validateTailor(o, profile, vocab, job).fields.get('selection')?.join()).toMatch(
      /kubernetes_ninja/,
    );
  });

  it('reads numbers as claims but not product names like EC2 or S3', () => {
    expect(
      [...numbersIn('EC2, S3 and k8s; 23 minutes 50 seconds; 3,660 ms; Terraform 1.10+')].sort(),
    ).toEqual(['1.10', '23', '3660', '50'].sort());
  });
});

class ScriptedLlm implements Llm {
  calls = 0;
  constructor(private readonly outputs: TailorOutput[]) {}
  call<T>(req: LlmRequest<T>): Promise<T> {
    const out = this.outputs[Math.min(this.calls, this.outputs.length - 1)];
    this.calls++;
    return Promise.resolve(req.schema.parse(out));
  }
}

const tj: TailorJob = {
  ...job,
  location: 'Cairo',
  requirements: [],
  nice_to_have: [],
  subject_hint: null,
  matched: [],
  missing: [],
};

describe('tailor retry and fallback (PLAN 8.1 rule 4)', () => {
  it('retries once with the errors, then falls back to the untouched source bullet', async () => {
    const bad = recorded();
    const b = firstBullet(bad);
    const source = [...profile.projects, ...profile.experience]
      .flatMap((e) => e.bullets)
      .find((x) => x.id === b.id)?.text;
    b.text = `${b.text} Saved 99% of costs.`;
    const llm = new ScriptedLlm([bad, bad]);
    const r = await tailorJob(llm, cfg, profile, vocab, 'devops', tj);
    expect(llm.calls).toBe(2);
    expect(r.attempts).toBe(2);
    expect(r.fallbacks).toContain(`bullet ${b.id}`);
    expect(firstBullet(r.output).text).toBe(source);
  });

  it('a cover letter that still fails goes to review instead of being sent', async () => {
    const bad = recorded();
    bad.cover_letter.paragraphs[1] = `${bad.cover_letter.paragraphs[1] ?? ''} I hold the RHCSA.`;
    const r = await tailorJob(new ScriptedLlm([bad, bad]), cfg, profile, vocab, 'devops', tj);
    expect(r.needsReview.join()).toMatch(/rhcsa/i);
  });

  it('uses the first answer when it is valid (one call)', async () => {
    const llm = new ScriptedLlm([recorded()]);
    const r = await tailorJob(llm, cfg, profile, vocab, 'devops', tj);
    expect(llm.calls).toBe(1);
    expect(r.fallbacks).toEqual([]);
  });
});

describe('render helpers', () => {
  it('keeps the stack line to about one printed line', () => {
    const s = shortStack(profile.projects.find((p) => p.id === 'nexora')?.stack ?? '');
    expect(s.length).toBeLessThanOrEqual(105);
    expect(s.startsWith('Terraform')).toBe(true);
  });

  it('names files {First}_{Last}_CV_{Company}_{Role}.pdf, sanitized, at most 80 chars', () => {
    expect(fileName(profile, 'CV', 'Nilecode Systems', 'DevOps Engineer')).toBe(
      'Ahmed_Khater_CV_Nilecode_Systems_DevOps_Engineer.pdf',
    );
    expect(fileName(profile, 'Cover_Letter', null, 'IT / Support (Tier 1)')).toBe(
      'Ahmed_Khater_Cover_Letter_IT_Support_Tier_1.pdf',
    );
    expect(fileName(profile, 'CV', 'A'.repeat(60), 'B'.repeat(60)).length).toBeLessThanOrEqual(80);
  });
});

describe("Ahmed's CV rules (D25)", () => {
  it('shows contact links as words with the URL behind them, and one phone', async () => {
    const { contactLine } = await import('../../src/render/cv.js');
    const c = contactLine(profile);
    expect(c.filter((x) => x.href?.startsWith('http')).map((x) => x.text)).toEqual([
      'GitHub',
      'LinkedIn',
      'Portfolio',
    ]);
    expect(c.filter((x) => /^\d{11}$/.test(x.text))).toHaveLength(1);
  });

  // .secrets-blocklist and the real profile are gitignored: this runs on Ahmed's machine, not in CI.
  it.runIf(existsSync('.secrets-blocklist') && existsSync('profile/master_profile.yaml'))(
    'never prints the private number (it is not in the profile at all)',
    () => {
      const blocklist = readFileSync('.secrets-blocklist', 'utf8')
        .split('\n')
        .filter((l) => /^\d+$/.test(l));
      const text = readFileSync('profile/master_profile.yaml', 'utf8');
      for (const n of blocklist) expect(text).not.toContain(n);
    },
  );

  it('shows core skill titles, plus skills the job asks for; "SQL" is not hidden by "MySQL"', async () => {
    const { orderedSkills } = await import('../../src/render/cv.js');
    const coreOnly = orderedSkills(profile, [])
      .map((c) => c.items)
      .join(' | ');
    expect(coreOnly).toContain('RHEL administration');
    expect(coreOnly).not.toContain('Podman');
    const withJob = orderedSkills(profile, [], 0, (_n, id) => id === 'sql' || id === 'podman')
      .map((c) => c.items)
      .join(' | ');
    expect(withJob).toMatch(/(^|, |: )SQL(,|$| \|)/);
    expect(withJob).toContain('Podman');
  });

  it('matches not-held phrases as whole words only', async () => {
    const { notHeldRegex } = await import('../../src/tailor/validate.js');
    expect(notHeldRegex('CKA').test('a package rollback')).toBe(false);
    expect(notHeldRegex('CKA').test('holds the CKA')).toBe(true);
    expect(notHeldRegex('double-entry').test('a double entry ledger')).toBe(true);
  });
});
