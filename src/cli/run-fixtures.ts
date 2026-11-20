// CLI action for `agent run --dry-run --fixtures [--record | --replay]` (P2 gate).
import { join } from 'node:path';
import type { Config } from '../config.js';
import { loadFixtures } from '../dev/fixtures.js';
import { ClaudeCli } from '../llm/claude-cli.js';
import { RecordingLlm, ReplayLlm } from '../llm/replay.js';
import type { Llm, LlmCallRecord } from '../llm/types.js';
import { compareWithExpected, runFixtures, type FixtureRun } from '../pipeline/dry-run.js';
import { TitleMatcher } from '../pipeline/titles.js';
import { loadProfile } from '../profile/load.js';
import { loadDotEnv } from '../util/env.js';
import { logger } from '../util/logger.js';
import type { Io } from './program.js';

export const RECORDINGS_DIR = join('test', 'fixtures', 'llm');
/** Fixed evaluation date so deadlines in fixtures give the same answer every time. */
export const FIXTURE_RUN_DATE = '2026-11-20';

export interface FixtureFlags {
  record?: boolean;
  replay?: boolean;
  profile?: string;
}

export async function runFixturesCommand(
  cfg: Config,
  flags: FixtureFlags,
  io: Io,
): Promise<number> {
  const calls: LlmCallRecord[] = [];
  let llm: Llm;
  if (flags.replay) {
    llm = new ReplayLlm(RECORDINGS_DIR);
    io.out(`model: replaying recordings from ${RECORDINGS_DIR}`);
  } else {
    const env = loadDotEnv(cfg.paths.env);
    for (const w of env.warnings) logger.warn(w);
    const cli = new ClaudeCli({
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
    const pf = await cli.preflight(cfg.llm.extract_model);
    io.out(`preflight: claude ${pf.version}, apiKeySource=${pf.apiKeySource} (subscription)`);
    llm = flags.record ? new RecordingLlm(cli, RECORDINGS_DIR) : cli;
  }

  const run = await runFixtures({
    cfg,
    profile: loadProfile(flags.profile ?? cfg.paths.profile),
    matcher: TitleMatcher.fromFile(cfg.paths.titles),
    llm,
    fixtures: loadFixtures(),
    runDate: FIXTURE_RUN_DATE,
    log: logger,
    calls,
  });
  printRun(run, io);
  const mismatches = compareWithExpected(run);
  io.out('');
  if (mismatches.length === 0) {
    io.out(`GATE PASS: all ${String(run.outcomes.length)} fixtures match their expected fields`);
    return 0;
  }
  io.out(`GATE FAIL: ${String(mismatches.length)} mismatch(es)`);
  for (const m of mismatches) {
    io.out(
      `  ${m.fixture}${m.job === null ? '' : `#${String(m.job)}`} ${m.field}: expected ${JSON.stringify(m.expected)}, got ${JSON.stringify(m.actual)}`,
    );
  }
  return 1;
}

function pad(s: string | number | null | undefined, n: number): string {
  const t = s === null || s === undefined ? '-' : String(s);
  return t.length > n ? `${t.slice(0, n - 1)}…` : t.padEnd(n);
}

function printRun(run: FixtureRun, io: Io): void {
  io.out(`run: ${run.status}${run.stopReason ? ` (${run.stopReason})` : ''}`);
  io.out(
    `${pad('fixture', 30)} ${pad('title', 34)} ${pad('channel', 11)} ${pad('P', 2)} ${pad('score', 5)} ${pad('skl/exp', 7)} ${pad('status', 13)} reason / flags`,
  );
  for (const o of run.outcomes) {
    if (o.notReached) {
      io.out(`${pad(o.fixture.id, 30)} (not reached: usage limit)`);
      continue;
    }
    if (o.raw) {
      io.out(`${pad(o.fixture.id, 30)} duplicate post (${o.raw.layer})`);
      continue;
    }
    if (o.jobs.length === 0) io.out(`${pad(o.fixture.id, 30)} not a job post`);
    for (const j of o.jobs) {
      const d = j.decision;
      io.out(
        `${pad(o.fixture.id, 30)} ${pad(j.job.title, 34)} ${pad(j.job.apply_channel, 11)} ${pad(d.priority, 2)} ${pad(d.scores?.final, 4)} ${pad(d.scores ? `${String(d.scores.skills)}/${String(d.scores.experience)}` : null, 7)} ${pad(d.status, 13)} ${[...new Set([d.skip_reason, ...d.flags])].filter(Boolean).join(', ')}`,
      );
    }
  }
  if (run.calls.length > 0) {
    const sum = (k: 'input_tokens' | 'output_tokens' | 'cache_read_tokens') =>
      run.calls.reduce((a, c) => a + (c.usage?.[k] ?? 0), 0);
    const failed = run.calls.filter((c) => !c.ok).length;
    const secs = run.calls.reduce((a, c) => a + c.durationMs, 0) / 1000;
    io.out(
      `model calls: ${String(run.calls.length)} (${String(failed)} failed), tokens in=${String(sum('input_tokens'))} out=${String(sum('output_tokens'))} cache_read=${String(sum('cache_read_tokens'))}, ${secs.toFixed(0)} s`,
    );
  }
}
