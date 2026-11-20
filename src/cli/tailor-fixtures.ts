// `agent tailor:fixtures [ids...] [--record | --replay]` (P3 gate): scored fixture jobs
// (replayed from P2 recordings) → Sonnet tailoring → validator → one-page PDF → ATS
// check → cover letter. Files go to output/fixtures/<fixture>/ (gitignored).
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../config.js';
import { loadFixtures } from '../dev/fixtures.js';
import { ClaudeCli } from '../llm/claude-cli.js';
import { RecordingLlm, ReplayLlm } from '../llm/replay.js';
import type { Llm, LlmCallRecord } from '../llm/types.js';
import { runFixtures } from '../pipeline/dry-run.js';
import { TitleMatcher } from '../pipeline/titles.js';
import { loadProfile, type Profile } from '../profile/load.js';
import { atsCheck, type AtsReport } from '../render/ats.js';
import {
  coverLetterHtml,
  cvMarkdown,
  buildCvModel,
  ensureDir,
  fileName,
  renderContextFor,
  renderOnePageCv,
} from '../render/cv.js';
import { Renderer } from '../render/renderer.js';
import { tailorJob, type TailorJob } from '../tailor/tailor.js';
import { vocabularyFor } from '../tailor/vocab.js';
import { loadDotEnv } from '../util/env.js';
import { logger } from '../util/logger.js';
import type { Io } from './program.js';
import { FIXTURE_RUN_DATE, RECORDINGS_DIR } from './run-fixtures.js';

export const GATE_FIXTURES = ['01-devops-email-en', '11-app-support-form', '12-network-backoffice'];

export interface TailorFlags {
  record?: boolean;
  replay?: boolean;
  out?: string;
  profile?: string;
}

function emailSubject(p: Profile, title: string, hint: string | null): string {
  return hint ?? `Application – ${title} – ${p.candidate.first_name} ${p.candidate.last_name}`;
}

function signature(p: Profile): string {
  const c = p.candidate;
  return [
    'Best regards,',
    `${c.first_name} ${c.last_name}`,
    [c.phone, c.phone_alt].filter(Boolean).join(' | '),
    ...Object.entries(c.links).map(([k, u]) => `${k[0]?.toUpperCase() ?? ''}${k.slice(1)}: ${u}`),
  ].join('\n');
}

function liveLlm(cfg: Config, calls: LlmCallRecord[]): ClaudeCli {
  const env = loadDotEnv(cfg.paths.env);
  for (const w of env.warnings) logger.warn(w);
  return new ClaudeCli({
    binary: cfg.llm.cli.binary,
    pinnedVersion: cfg.llm.cli.pinned_version,
    timeoutMs: cfg.llm.timeout_seconds * 1000,
    maxRetries: cfg.llm.max_retries,
    dotenv: env.values,
    isolatedHome: cfg.llm.cli.home,
    workDir: cfg.llm.cli.workdir,
    log: logger,
    onCall: (r) => calls.push(r),
  });
}

export async function tailorFixturesCommand(
  cfg: Config,
  ids: string[],
  flags: TailorFlags,
  io: Io,
): Promise<number> {
  const profile = loadProfile(flags.profile ?? cfg.paths.profile);
  const vocab = vocabularyFor(profile);
  const wanted = ids.length > 0 ? ids : GATE_FIXTURES;
  const outRoot = flags.out ?? join(cfg.apply.output_dir, 'fixtures');

  // P2 results from recordings: fast and deterministic.
  const scored = await runFixtures({
    cfg,
    profile,
    matcher: TitleMatcher.fromFile(cfg.paths.titles),
    llm: new ReplayLlm(RECORDINGS_DIR),
    fixtures: loadFixtures(),
    runDate: FIXTURE_RUN_DATE,
    log: logger,
  });

  const calls: LlmCallRecord[] = [];
  let llm: Llm;
  if (flags.replay) llm = new ReplayLlm(RECORDINGS_DIR);
  else {
    const cli = liveLlm(cfg, calls);
    const pf = await cli.preflight(cfg.llm.extract_model);
    io.out(`preflight: claude ${pf.version}, apiKeySource=${pf.apiKeySource} (subscription)`);
    llm = flags.record ? new RecordingLlm(cli, RECORDINGS_DIR) : cli;
  }

  const renderer = await Renderer.open();
  let failed = 0;
  try {
    for (const id of wanted) {
      const o = scored.outcomes.find((x) => x.fixture.id === id);
      const first = o?.jobs[0];
      if (!o || !first?.decision.fit || !first.decision.angle) {
        io.out(`${id}: no scored job to tailor (duplicate, skipped before scoring, or unknown id)`);
        failed++;
        continue;
      }
      const { job, decision } = first;
      const fit = decision.fit;
      const angle = decision.angle;
      if (!fit || !angle) continue;
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
      const dir = ensureDir(join(outRoot, id));
      const started = Date.now();
      const t = await tailorJob(llm, cfg, profile, vocab, angle, tj, `${id}.tailor`);

      const cvPath = join(dir, fileName(profile, 'CV', job.company, job.title));
      const ctx = renderContextFor(
        cfg,
        angle,
        [job.title, ...job.requirements, ...job.nice_to_have].join('\n'),
        (text) => vocab.find(text),
        new Set(fit.matched.flatMap((m) => m.evidence)),
      );
      const fitRep = await renderOnePageCv(renderer, profile, t.output, cfg, cvPath, ctx);
      const ats: AtsReport = await atsCheck(cvPath, cfg, profile, vocab, tj.matched);

      const coverPath = join(dir, fileName(profile, 'Cover_Letter', job.company, job.title));
      const date = new Date(`${FIXTURE_RUN_DATE}T12:00:00Z`).toLocaleDateString('en-GB', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      });
      writeFileSync(
        coverPath,
        await renderer.pdf(coverLetterHtml(profile, fitRep.output, job.company, date)),
      );
      const coverText = [
        fitRep.output.cover_letter.greeting,
        ...fitRep.output.cover_letter.paragraphs,
        fitRep.output.cover_letter.closing,
        `${profile.candidate.first_name} ${profile.candidate.last_name}`,
      ].join('\n\n');
      writeFileSync(join(dir, 'cover_letter.txt'), `${coverText}\n`);
      writeFileSync(
        join(dir, 'cv.md'),
        cvMarkdown(buildCvModel(profile, fitRep.output, fitRep.layout, ctx)),
      );
      writeFileSync(
        join(dir, 'email.txt'),
        `Subject: ${emailSubject(profile, job.title, job.subject_hint)}\n\n${fitRep.output.email_body}\n\n${signature(profile)}\n`,
      );
      writeFileSync(
        join(dir, 'report.json'),
        `${JSON.stringify({ angle, attempts: t.attempts, fallbacks: t.fallbacks, needsReview: t.needsReview, fit: fitRep, ats, why_this_role: t.output.why_this_role }, null, 2)}\n`,
      );

      const ok = ats.pass && fitRep.pages === 1 && t.needsReview.length === 0;
      if (!ok) failed++;
      io.out(
        `${ok ? 'PASS' : 'FAIL'} ${id} [${angle}] pages=${String(fitRep.pages)} fill=${(fitRep.fill * 100).toFixed(0)}% ` +
          `attempts=${String(t.attempts)} fallbacks=${String(t.fallbacks.length)} ats=${ats.pass ? 'pass' : `fail (${ats.failures.join('; ')})`} ` +
          `keywords=${(ats.keywordCoverage * 100).toFixed(0)}% ${((Date.now() - started) / 1000).toFixed(0)}s`,
      );
      if (fitRep.trimmed.length || fitRep.added.length)
        io.out(
          `      trimmed: ${fitRep.trimmed.join(', ') || '-'} | added: ${fitRep.added.join(', ') || '-'}`,
        );
      if (t.needsReview.length) io.out(`      needs review: ${t.needsReview.join('; ')}`);
      io.out(`      ${cvPath}`);
    }
  } finally {
    await renderer.close();
  }
  if (calls.length) {
    const out = calls.reduce((a, c) => a + (c.usage?.output_tokens ?? 0), 0);
    io.out(
      `model calls: ${String(calls.length)} (${String(calls.filter((c) => !c.ok).length)} failed), output tokens=${String(out)}`,
    );
  }
  io.out(
    failed === 0
      ? `P3 GATE PASS: ${String(wanted.length)} tailored applications`
      : `P3 GATE FAIL: ${String(failed)} of ${String(wanted.length)}`,
  );
  return failed === 0 ? 0 : 1;
}
