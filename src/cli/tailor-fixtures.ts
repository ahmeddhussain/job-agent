// `agent tailor:fixtures [ids...] [--record | --replay]` (P3 gate): scored fixture jobs
// (replayed from P2 recordings) → Sonnet tailoring → validator → one-page PDF → ATS
// check → cover letter. Files go to output/fixtures/<fixture>/ (gitignored).
import { join } from 'node:path';
import type { Config } from '../config.js';
import { loadFixtures } from '../dev/fixtures.js';
import { ClaudeCli } from '../llm/claude-cli.js';
import { RecordingLlm, ReplayLlm } from '../llm/replay.js';
import type { Llm, LlmCallRecord } from '../llm/types.js';
import { runFixtures } from '../pipeline/dry-run.js';
import { TitleMatcher } from '../pipeline/titles.js';
import { loadProfile } from '../profile/load.js';
import { prepareApplication } from '../apply/prepare.js';
import { Renderer } from '../render/renderer.js';
import { vocabularyFor } from '../tailor/vocab.js';
import { loadDotEnv } from '../util/env.js';
import { logger } from '../util/logger.js';
import type { Io } from './program.js';
import {
  FIXTURE_PROFILE,
  FIXTURE_RUN_DATE,
  FIXTURE_TITLES,
  RECORDINGS_DIR,
} from './run-fixtures.js';

export const GATE_FIXTURES = ['01-devops-email-en', '11-app-support-form', '12-network-backoffice'];

export interface TailorFlags {
  record?: boolean;
  replay?: boolean;
  out?: string;
  profileFile?: string;
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
  const profile = loadProfile(flags.profileFile ?? FIXTURE_PROFILE);
  const vocab = vocabularyFor(profile);
  const wanted = ids.length > 0 ? ids : GATE_FIXTURES;
  const outRoot = flags.out ?? join(cfg.apply.output_dir, 'fixtures');

  // P2 results from recordings: fast and deterministic.
  const scored = await runFixtures({
    cfg,
    profile,
    matcher: TitleMatcher.fromFile(FIXTURE_TITLES),
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
      const started = Date.now();
      const prep = await prepareApplication(
        { llm, cfg, profile, vocab, renderer },
        job,
        fit,
        angle,
        join(outRoot, id),
        `${id}.tailor`,
      );
      const { ats, fit: fitRep, cvPath } = prep;
      const t = {
        attempts: prep.attempts,
        fallbacks: prep.fallbacks,
        needsReview: prep.needsReview,
      };
      const ok = prep.ok;
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
