// Exercises scripts/check-secrets.sh in throwaway git repos. Fake secrets are built at
// runtime so this file itself never contains a value the scanner would block.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = resolve('scripts/check-secrets.sh');
const FAKE_TOKEN = ['sk', 'ant', 'oat01', 'x'.repeat(40)].join('-');
const FAKE_PRIVATE_NUMBER = ['0109', '876', '5432'].join('');

let repo: string;

function git(...args: string[]) {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
}

function stage(path: string, content: string) {
  const full = join(repo, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
  git('add', '-f', path);
}

function scan() {
  const r = spawnSync('bash', [SCRIPT], {
    cwd: repo,
    encoding: 'utf8',
    env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: repo },
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

describe('scripts/check-secrets.sh', () => {
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'secrets-test-'));
    git('init', '-q');
    writeFileSync(join(repo, '.secrets-blocklist'), `# private\n${FAKE_PRIVATE_NUMBER}\n`);
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('passes clean changes', () => {
    stage('src/a.ts', 'export const a = 1;\n');
    stage('.env.example', 'CLAUDE_CODE_OAUTH_TOKEN=REPLACE_ME\n');
    expect(scan().code).toBe(0);
  });

  it('blocks a Claude OAuth token and never prints it', () => {
    stage('src/leak.ts', `const t = '${FAKE_TOKEN}';\n`);
    const r = scan();
    expect(r.code).toBe(1);
    expect(r.out).toContain('anthropic-key-or-oauth-token');
    expect(r.out).not.toContain(FAKE_TOKEN);
  });

  it('blocks the blocklisted private number, also when formatted', () => {
    stage('docs/a.md', `call ${FAKE_PRIVATE_NUMBER}\n`);
    expect(scan().code).toBe(1);
    git('rm', '-q', '--cached', 'docs/a.md');
    const formatted = `${FAKE_PRIVATE_NUMBER.slice(0, 4)} ${FAKE_PRIVATE_NUMBER.slice(4, 7)}-${FAKE_PRIVATE_NUMBER.slice(7)}`;
    stage('docs/b.md', `call ${formatted}\n`);
    const r = scan();
    expect(r.code).toBe(1);
    expect(r.out).toContain('blocklisted number (formatted)');
  });

  it.each([
    '.env',
    'secrets/gmail_token.json',
    'data/agent.db',
    'profile/master_profile.yaml',
    'config/config.yaml',
    'config/config.yaml.bak',
    'config/config.yaml.pre-specialisms',
    'profiles/ahmed/profile.yaml',
  ])('blocks the forbidden path %s even when force-added', (path) => {
    stage(path, 'x\n');
    const r = scan();
    expect(r.code).toBe(1);
    expect(r.out).toContain('forbidden path');
  });

  it('allows the shipped example profile', () => {
    stage('profiles/example/profile.yaml', 'name: example\n');
    expect(scan().code).toBe(0);
  });
});
