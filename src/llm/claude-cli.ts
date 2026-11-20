// Every model call goes through the official Claude Code CLI in headless mode, on
// Ahmed's subscription (D17). Security controls A1-A5 from docs/security.md live here.
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Logger } from 'pino';
import { z } from 'zod';
import {
  AuthGuardError,
  LlmError,
  UsageLimitError,
  type Llm,
  type LlmCallRecord,
  type LlmRequest,
  type LlmUsage,
} from './types.js';

export interface ClaudeCliOptions {
  binary: string;
  pinnedVersion: string;
  timeoutMs: number;
  maxRetries: number;
  /** Values from .env (private; never process.env). */
  dotenv: Record<string, string>;
  /** Isolated HOME used when a token is present, so user settings, hooks and plugins don't load. */
  isolatedHome: string;
  /** Empty working directory: no CLAUDE.md or project settings are discovered. */
  workDir: string;
  log: Logger;
  onCall?: (rec: LlmCallRecord) => void;
  /** For tests: the parent environment to read PATH/HOME and the API-key guard from. */
  parentEnv?: NodeJS.ProcessEnv;
  /** For tests: backoff base in ms. */
  backoffMs?: number;
}

const MAX_OUTPUT_BYTES = 5 * 1024 * 1024;
const USAGE_LIMIT_RE =
  /usage limit|limit reached|hit your (usage )?limit|out of (extra )?usage|quota/i;
const FORBIDDEN_ENV = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'] as const;

const ResultSchema = z.looseObject({
  type: z.literal('result'),
  subtype: z.string(),
  is_error: z.boolean(),
  result: z.string().optional(),
  structured_output: z.unknown().optional(),
  api_error_status: z.number().nullable().optional(),
  usage: z
    .looseObject({
      input_tokens: z.number().optional(),
      output_tokens: z.number().optional(),
      cache_read_input_tokens: z.number().optional(),
    })
    .optional(),
});

interface Spawned {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export class ClaudeCli implements Llm {
  private readonly parentEnv: NodeJS.ProcessEnv;

  private readonly o: ClaudeCliOptions;

  constructor(opts: ClaudeCliOptions) {
    // Absolute paths: the CLI runs with cwd=workDir, so a relative HOME would resolve
    // inside the working directory (troubleshooting #7).
    this.o = { ...opts, isolatedHome: resolve(opts.isolatedHome), workDir: resolve(opts.workDir) };
    this.parentEnv = opts.parentEnv ?? process.env;
    this.assertNoApiKey();
    mkdirSync(this.o.workDir, { recursive: true, mode: 0o700 });
    if (this.token()) mkdirSync(this.o.isolatedHome, { recursive: true, mode: 0o700 });
  }

  /** A3: an API key anywhere would silently replace the subscription in -p mode. */
  private assertNoApiKey(): void {
    for (const k of FORBIDDEN_ENV) {
      if (this.parentEnv[k] || this.o.dotenv[k]) {
        throw new AuthGuardError(
          `${k} is set (environment or .env). In 'claude -p' mode it overrides the subscription and bills API credits. Remove it and retry.`,
        );
      }
    }
  }

  private token(): string | undefined {
    const t = this.o.dotenv['CLAUDE_CODE_OAUTH_TOKEN'];
    return t && t !== 'REPLACE_ME' ? t : undefined;
  }

  /** A2: the child gets an allowlisted environment, never the agent's own. */
  childEnv(): NodeJS.ProcessEnv {
    const token = this.token();
    const env: NodeJS.ProcessEnv = {
      PATH: this.parentEnv['PATH'] ?? '/usr/bin:/bin',
      HOME: token ? this.o.isolatedHome : (this.parentEnv['HOME'] ?? this.o.isolatedHome),
      LANG: 'C.UTF-8',
      DISABLE_AUTOUPDATER: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    };
    if (token) env['CLAUDE_CODE_OAUTH_TOKEN'] = token;
    return env;
  }

  /** A1: no tools, no MCP, no session files, empty cwd, stdin closed. Never --bare. */
  private baseArgs(model: string): string[] {
    return [
      '-p',
      '--model',
      model,
      '--tools',
      '',
      '--strict-mcp-config',
      '--no-session-persistence',
    ];
  }

  private run(args: string[]): Promise<Spawned> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.o.binary, args, {
        cwd: this.o.workDir,
        env: this.childEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      let bytes = 0;
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 5000).unref();
      }, this.o.timeoutMs);
      child.stdout.setEncoding('utf8').on('data', (d: string) => {
        bytes += d.length;
        if (bytes > MAX_OUTPUT_BYTES) child.kill('SIGKILL');
        else stdout += d;
      });
      child.stderr.setEncoding('utf8').on('data', (d: string) => {
        if (stderr.length < 8192) stderr += d;
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(
          new LlmError(`cannot start ${this.o.binary}: ${err.message}`, false, { cause: err }),
        );
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr, timedOut });
      });
    });
  }

  /**
   * Runs once per run before any real call (A3). Fails loudly if the call isn't
   * authenticated by the subscription or the CLI can't answer.
   */
  async preflight(model: string): Promise<{ version: string; apiKeySource: string }> {
    const out = await this.run([
      ...this.baseArgs(model),
      '--output-format',
      'stream-json',
      '--verbose',
      'Reply with the single word OK.',
    ]);
    let init: Record<string, unknown> | undefined;
    let result: z.infer<typeof ResultSchema> | undefined;
    for (const line of out.stdout.split('\n')) {
      if (!line.trim()) continue;
      let ev: unknown;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      const e = ev as Record<string, unknown>;
      if (e['type'] === 'system' && e['subtype'] === 'init') init = e;
      if (e['type'] === 'result') result = ResultSchema.safeParse(e).data;
    }
    if (!init) {
      throw new AuthGuardError(
        `preflight: no init event from ${this.o.binary} (exit ${String(out.code)}): ${out.stderr.slice(0, 300)}`,
      );
    }
    const apiKeySource = String(init['apiKeySource']);
    const version = String(init['claude_code_version']);
    if (apiKeySource !== 'none') {
      throw new AuthGuardError(
        `preflight: authenticated by '${apiKeySource}', not the subscription. Refusing to run (D17).`,
      );
    }
    if (result?.is_error) {
      const msg = result.result ?? result.subtype;
      if (USAGE_LIMIT_RE.test(msg)) throw new UsageLimitError(`preflight: ${msg}`);
      throw new AuthGuardError(`preflight failed: ${msg}`);
    }
    if (version !== this.o.pinnedVersion) {
      this.o.log.warn(
        { version, pinned: this.o.pinnedVersion },
        'claude CLI version differs from llm.cli.pinned_version',
      );
    }
    return { version, apiKeySource };
  }

  async call<T>(req: LlmRequest<T>): Promise<T> {
    const jsonSchema = z.toJSONSchema(req.schema, { target: 'draft-7' });
    const args = [
      ...this.baseArgs(req.model),
      '--output-format',
      'json',
      '--json-schema',
      JSON.stringify(jsonSchema),
      '--system-prompt',
      req.system,
      req.prompt,
    ];

    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.o.maxRetries; attempt++) {
      if (attempt > 0) {
        const wait = (this.o.backoffMs ?? 2000) * 2 ** (attempt - 1);
        await new Promise((r) => setTimeout(r, wait));
      }
      const started = Date.now();
      let usage: LlmUsage | null = null;
      try {
        const out = await this.run(args);
        if (out.timedOut) throw new LlmError(`timed out after ${this.o.timeoutMs} ms`, true);
        let parsed: z.infer<typeof ResultSchema>;
        try {
          parsed = ResultSchema.parse(JSON.parse(out.stdout));
        } catch (err) {
          throw new LlmError(
            `unreadable CLI output (exit ${String(out.code)}): ${out.stderr.slice(0, 300)}`,
            true,
            { cause: err },
          );
        }
        usage = {
          input_tokens: parsed.usage?.input_tokens ?? 0,
          output_tokens: parsed.usage?.output_tokens ?? 0,
          cache_read_tokens: parsed.usage?.cache_read_input_tokens ?? 0,
        };
        if (parsed.is_error) {
          const msg = parsed.result ?? parsed.subtype;
          if (USAGE_LIMIT_RE.test(msg)) throw new UsageLimitError(msg);
          const status = parsed.api_error_status ?? 0;
          throw new LlmError(
            `${parsed.subtype}: ${msg.slice(0, 300)}`,
            status === 429 || status >= 500 || status === 0,
          );
        }
        const value = req.schema.safeParse(parsed.structured_output);
        if (!value.success) {
          throw new LlmError(
            `output failed schema: ${z.prettifyError(value.error).slice(0, 300)}`,
            true,
          );
        }
        this.o.onCall?.({
          purpose: req.purpose,
          model: req.model,
          usage,
          ok: true,
          jobId: req.jobId ?? null,
          durationMs: Date.now() - started,
        });
        return value.data;
      } catch (err) {
        this.o.onCall?.({
          purpose: req.purpose,
          model: req.model,
          usage,
          ok: false,
          jobId: req.jobId ?? null,
          durationMs: Date.now() - started,
        });
        if (err instanceof UsageLimitError || err instanceof AuthGuardError) throw err;
        lastErr = err;
        const retryable = err instanceof LlmError ? err.retryable : false;
        this.o.log.warn(
          { purpose: req.purpose, attempt, err: (err as Error).message },
          'claude call failed',
        );
        if (!retryable) break;
      }
    }
    // 429s that never cleared are treated as the usage limit, so the run stops cleanly.
    if (lastErr instanceof LlmError && /\b429\b|rate/i.test(lastErr.message)) {
      throw new UsageLimitError(lastErr.message);
    }
    throw lastErr instanceof Error ? lastErr : new LlmError(String(lastErr), false);
  }
}
