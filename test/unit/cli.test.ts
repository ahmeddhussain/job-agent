import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildProgram } from '../../src/cli/program.js';

const COMMANDS = [
  'run',
  'wa:login',
  'wa:groups',
  'gmail:auth',
  'reprocess',
  'digest',
  'ats:detect',
  'tailor:fixtures',
  'collect',
  'gmail:check',
  'gmail:test-draft',
  'sync',
  'config:check',
  'db:migrate',
  'add',
  'companies',
  'dashboard',
  'assist',
  'send-drafts',
  'skipped',
  'retry-forms',
  'recheck-dates',
];

function makeProgram() {
  const lines: string[] = [];
  const program = buildProgram({ out: (l) => lines.push(l) }).exitOverride();
  return { program, lines };
}

describe('cli', () => {
  let dir: string;
  let configPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'job-agent-test-'));
    configPath = join(dir, 'config.yaml');
    const example = readFileSync('config/config.example.yaml', 'utf8')
      .replace('to: TODO@gmail.com', 'to: someone@example.com')
      .replace('db: data/agent.db', `db: ${join(dir, 'agent.db')}`)
      .replace('lock_file: data/run.lock', `lock_file: ${join(dir, 'run.lock')}`);
    writeFileSync(configPath, example);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('registers every command (PLAN.md P0 plus P7/P8 additions)', () => {
    const { program } = makeProgram();
    expect(program.commands.map((c) => c.name()).sort()).toEqual([...COMMANDS].sort());
  });

  it('reprocess refuses an unknown job before touching anything', async () => {
    const { program } = makeProgram();
    await expect(
      program.parseAsync(['node', 'agent', '-c', configPath, 'reprocess', '1']),
    ).rejects.toThrow(/job 1 not found/);
    await expect(
      program.parseAsync(['node', 'agent', '-c', configPath, 'reprocess', 'x']),
    ).rejects.toThrow(/not a job id/);
  });

  it('add stores a pasted post once', async () => {
    const post = join(dir, 'post.txt');
    writeFileSync(
      post,
      'DevOps Engineer at Acme, Cairo. Linux, Docker, AWS. Send CV to jobs@acme.example',
    );
    const a = makeProgram();
    await a.program.parseAsync(['node', 'agent', '-c', configPath, 'add', post, '--name', 'test']);
    expect(a.lines[0]).toMatch(/^stored as item 1/);
    const b = makeProgram();
    await b.program.parseAsync(['node', 'agent', '-c', configPath, 'add', post]);
    expect(b.lines[0]).toMatch(/already stored/);
  });

  it('config:check validates and summarizes the config', async () => {
    const { program, lines } = makeProgram();
    await program.parseAsync(['node', 'agent', '-c', configPath, 'config:check']);
    expect(lines[0]).toBe(`config OK: ${configPath}`);
    expect(lines.join('\n')).toContain('apply.mode=draft');
  });

  it('db:migrate creates the database, and a rerun applies nothing', async () => {
    const first = makeProgram();
    await first.program.parseAsync(['node', 'agent', '-c', configPath, 'db:migrate']);
    expect(first.lines).toContain(
      'applied: 001_init.sql, 002_run.sql, 003_forms.sql, 004_dates_questions.sql',
    );

    const second = makeProgram();
    await second.program.parseAsync(['node', 'agent', '-c', configPath, 'db:migrate']);
    expect(second.lines).toContain('applied: none');
  });
});
