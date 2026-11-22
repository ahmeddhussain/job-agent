import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildProgram, NotImplementedError } from '../../src/cli/program.js';

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
      .replace('db: data/agent.db', `db: ${join(dir, 'agent.db')}`);
    writeFileSync(configPath, example);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('registers every command from PLAN.md P0', () => {
    const { program } = makeProgram();
    expect(program.commands.map((c) => c.name()).sort()).toEqual([...COMMANDS].sort());
  });

  it('commands from later phases fail loudly instead of pretending to work', async () => {
    const { program } = makeProgram();
    await expect(program.parseAsync(['node', 'agent', 'reprocess', '1'])).rejects.toBeInstanceOf(
      NotImplementedError,
    );
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
    expect(first.lines).toContain('applied: 001_init.sql');

    const second = makeProgram();
    await second.program.parseAsync(['node', 'agent', '-c', configPath, 'db:migrate']);
    expect(second.lines).toContain('applied: none');
  });
});
