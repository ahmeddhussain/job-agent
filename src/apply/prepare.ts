// One application's documents (PLAN 8, D28): Sonnet tailoring → truth validator →
// one-page CV → ATS check → cover letter text and email body. Shared by `agent run`
// and the P3 fixture gate, so both produce exactly the same thing.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../config.js';
import type { FitResult } from '../llm/schemas.js';
import type { Llm } from '../llm/types.js';
import type { Angle } from '../profile/specialisms.js';
import type { Profile } from '../profile/load.js';
import { atsCheck, type AtsReport } from '../render/ats.js';
import {
  buildCvModel,
  cvMarkdown,
  ensureDir,
  fileName,
  renderContextFor,
  renderOnePageCv,
  type FitReport,
} from '../render/cv.js';
import type { Renderer } from '../render/renderer.js';
import type { TailorOutput } from '../tailor/schema.js';
import { tailorJob, type TailorJob } from '../tailor/tailor.js';
import type { Vocabulary } from '../tailor/vocab.js';
import { coverLetterText, emailBody, emailSubject } from './email.js';

export interface PrepareDeps {
  llm: Llm;
  cfg: Config;
  profile: Profile;
  vocab: Vocabulary;
  renderer: Renderer;
}

export interface PrepareJob {
  title: string;
  company: string | null;
  location: string | null;
  requirements: string[];
  nice_to_have: string[];
  subject_hint: string | null;
}

export interface Prepared {
  dir: string;
  cvPath: string;
  cvMdPath: string;
  coverPath: string;
  coverText: string;
  subject: string;
  body: string;
  ats: AtsReport;
  fit: FitReport;
  attempts: number;
  fallbacks: string[];
  needsReview: string[];
  whyThisRole: string;
  output: TailorOutput;
  /** One page, ATS pass, validator clean: the only state an application may be made from. */
  ok: boolean;
  problems: string[];
}

export async function prepareApplication(
  d: PrepareDeps,
  job: PrepareJob,
  fit: FitResult,
  angle: Angle,
  dir: string,
  key?: string,
): Promise<Prepared> {
  const tj: TailorJob = {
    title: job.title,
    company: job.company,
    location: job.location,
    requirements: job.requirements,
    nice_to_have: job.nice_to_have,
    subject_hint: job.subject_hint,
    matched: fit.matched.map((m) => m.requirement),
    missing: fit.missing,
  };
  ensureDir(dir);
  const t = await tailorJob(d.llm, d.cfg, d.profile, d.vocab, angle, tj, key);
  const cvPath = join(dir, fileName(d.profile, 'CV', job.company, job.title));
  const ctx = renderContextFor(
    d.profile,
    angle,
    [job.title, ...job.requirements, ...job.nice_to_have].join('\n'),
    (text) => d.vocab.find(text),
    new Set(fit.matched.flatMap((m) => m.evidence)),
  );
  const fitRep = await renderOnePageCv(d.renderer, d.profile, t.output, d.cfg, cvPath, ctx);
  const ats = await atsCheck(cvPath, d.cfg, d.profile, d.vocab, tj.matched);

  const coverText = coverLetterText(d.profile, fitRep.output.cover_letter);
  const subject = emailSubject(d.profile, job.title, job.subject_hint);
  const body = emailBody(d.profile, fitRep.output.cover_letter);
  const coverPath = join(dir, 'cover_letter.txt');
  const cvMdPath = join(dir, 'cv.md');
  writeFileSync(coverPath, coverText);
  writeFileSync(cvMdPath, cvMarkdown(buildCvModel(d.profile, fitRep.output, fitRep.layout, ctx)));
  writeFileSync(join(dir, 'email.txt'), `Subject: ${subject}\n\n${body}`);

  const problems = [
    ...(fitRep.pages !== 1 ? [`CV is ${String(fitRep.pages)} pages`] : []),
    ...(!ats.pass ? [`ATS check failed: ${ats.failures.join('; ')}`] : []),
    ...t.needsReview,
  ];
  writeFileSync(
    join(dir, 'report.json'),
    `${JSON.stringify({ angle, attempts: t.attempts, fallbacks: t.fallbacks, needsReview: t.needsReview, fit: fitRep, ats, why_this_role: t.output.why_this_role }, null, 2)}\n`,
  );
  return {
    dir,
    cvPath,
    cvMdPath,
    coverPath,
    coverText,
    subject,
    body,
    ats,
    fit: fitRep,
    attempts: t.attempts,
    fallbacks: t.fallbacks,
    needsReview: t.needsReview,
    whyThisRole: t.output.why_this_role,
    output: fitRep.output,
    ok: problems.length === 0,
    problems,
  };
}
