// Security behaviour of the claude -p wrapper (docs/dev/security.md A1-A5), against a fake CLI.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ClaudeCli, type ClaudeCliOptions } from '../../src/llm/claude-cli.js';
import {
  AuthGuardError,
  LlmError,
  UsageLimitError,
  type LlmCallRecord,
} from '../../src/llm/types.js';

const FAKE = resolve('test/fake/claude.mjs');
const FAKE_TOKEN = ['sk', 'ant', 'oat01', 'y'.repeat(30)].join('-');
const log = pino({ level: 'silent' });
const Ok = z.object({ ok: z.boolean() });
const Echo = z.object({
  args: z.array(z.string()),
  env: z.array(z.string()),
  cwd: z.string(),
  hasToken: z.boolean(),
});

let dir: string;
let calls: LlmCallRecord[];

function cli(over: Partial<ClaudeCliOptions> = {}): ClaudeCli {
  return new ClaudeCli({
    binary: FAKE,
    pinnedVersion: '2.1.317',
    timeoutMs: 10_000,
    maxRetries: 2,
    dotenv: { CLAUDE_CODE_OAUTH_TOKEN: FAKE_TOKEN },
    isolatedHome: join(dir, 'home'),
    workDir: join(dir, 'work'),
    log,
    onCall: (r) => calls.push(r),
    parentEnv: {
      PATH: process.env['PATH'] ?? '',
      HOME: '/home/someone',
      GITHUB_TOKEN: 'secret-gh',
      AWS_SECRET_ACCESS_KEY: 'secret-aws',
    },
    backoffMs: 1,
    ...over,
  });
}

const req = <T>(model: string, schema: z.ZodType<T>) => ({
  purpose: 'extract' as const,
  model,
  system: 'sys',
  prompt: 'Job post:\n<job_post>x</job_post>',
  schema,
});

describe('ClaudeCli', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'claude-cli-test-'));
    calls = [];
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses to start when ANTHROPIC_API_KEY is in the environment or .env (A3)', () => {
    expect(() => cli({ parentEnv: { ANTHROPIC_API_KEY: 'x' } })).toThrow(AuthGuardError);
    expect(() => cli({ dotenv: { ANTHROPIC_API_KEY: 'x' } })).toThrow(AuthGuardError);
  });

  it('runs with no tools, no MCP, no session files, never --bare (A1)', async () => {
    const r = await cli().call(req('fake-echo', Echo));
    const a = r.args;
    expect(a[a.indexOf('--tools') + 1]).toBe('');
    expect(a).toContain('--strict-mcp-config');
    expect(a).toContain('--no-session-persistence');
    expect(a).toContain('--json-schema');
    expect(a).not.toContain('--bare');
    expect(r.cwd).toBe(join(dir, 'work'));
  });

  it('passes only allowlisted variables plus the token to the CLI (A2)', async () => {
    const r = await cli().call(req('fake-echo', Echo));
    expect(r.hasToken).toBe(true);
    expect(r.env).not.toContain('GITHUB_TOKEN');
    expect(r.env).not.toContain('AWS_SECRET_ACCESS_KEY');
    const allowed = [
      'PATH',
      'HOME',
      'LANG',
      'DISABLE_AUTOUPDATER',
      'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
      'CLAUDE_CODE_OAUTH_TOKEN',
    ];
    // The OS may add a few process-level variables (e.g. PWD); nothing secret-looking.
    for (const k of r.env) {
      if (!allowed.includes(k)) expect(k).not.toMatch(/KEY|TOKEN|SECRET|PASS/i);
    }
  });

  it('uses an isolated HOME when a token is set, so user settings and hooks never load', () => {
    const child = cli().childEnv();
    expect(child['HOME']).toBe(join(dir, 'home'));
    expect(cli({ dotenv: {} }).childEnv()['HOME']).toBe('/home/someone');
  });

  it('resolves relative home and work paths to absolute ones (troubleshooting #7)', async () => {
    const prev = process.cwd();
    process.chdir(dir);
    try {
      const c = cli({ isolatedHome: 'rel-home', workDir: 'rel-work' });
      expect(c.childEnv()['HOME']).toBe(join(dir, 'rel-home'));
      const r = await c.call(req('fake-echo', Echo));
      expect(r.cwd).toBe(join(dir, 'rel-work'));
    } finally {
      process.chdir(prev);
    }
  });

  it('returns the validated structured output and records token usage', async () => {
    await expect(cli().call(req('fake-ok', Ok))).resolves.toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.usage).toEqual({ input_tokens: 3, output_tokens: 5, cache_read_tokens: 7 });
  });

  it('stops immediately on the usage limit, without retrying (R18)', async () => {
    await expect(cli().call(req('fake-limit', Ok))).rejects.toBeInstanceOf(UsageLimitError);
    expect(calls).toHaveLength(1);
  });

  it('retries output that fails the schema, then gives up with LlmError', async () => {
    await expect(cli().call(req('fake-badschema', Ok))).rejects.toBeInstanceOf(LlmError);
    expect(calls).toHaveLength(3);
  });

  it('retries unreadable output', async () => {
    await expect(cli().call(req('fake-garbage', Ok))).rejects.toThrow(/unreadable CLI output/);
    expect(calls).toHaveLength(3);
  });

  describe('preflight', () => {
    it('passes on subscription auth', async () => {
      await expect(cli().preflight('fake-ok')).resolves.toEqual({
        version: '2.1.317',
        apiKeySource: 'none',
      });
    });
    it('fails loudly when auth comes from an API key', async () => {
      await expect(cli().preflight('fake-apikey')).rejects.toThrow(/not the subscription/);
    });
    it('reports the usage limit', async () => {
      await expect(cli().preflight('fake-limit')).rejects.toBeInstanceOf(UsageLimitError);
    });
  });
});
