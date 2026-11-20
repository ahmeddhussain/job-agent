// The `agent` command tree. Built by a factory so tests can run it without a process.
import { Command, Option } from 'commander';
import { loadConfig } from '../config.js';
import { listTables, migrate, openDb } from '../db/index.js';

export class NotImplementedError extends Error {
  override name = 'NotImplementedError';
  constructor(command: string, phase: string) {
    super(`'${command}' is not implemented yet (arrives in ${phase}, PLAN.md section 14)`);
  }
}

export interface Io {
  out: (line: string) => void;
}

const defaultConfigPath = (): string => process.env['CONFIG_PATH'] ?? 'config/config.yaml';

function notYet(command: string, phase: string): () => never {
  return () => {
    throw new NotImplementedError(command, phase);
  };
}

export function buildProgram(io: Io): Command {
  const program = new Command()
    .name('agent')
    .description('Daily read-only job-hunting agent (PLAN.md)')
    .option('-c, --config <path>', 'config file', defaultConfigPath())
    .showHelpAfterError();

  const configPath = (): string => program.opts<{ config: string }>().config;

  program
    .command('run')
    .description('collect, dedupe, score, tailor and prepare applications')
    .option('--dry-run', 'no Gmail writes; print the digest to stdout')
    .option('--fixtures', 'use test/fixtures instead of live sources')
    .addOption(
      new Option('--source <name>', 'run one source only').choices(['whatsapp', 'alerts', 'ats']),
    )
    .option('--since <iso>', 'override the per-source watermark (ISO-8601)')
    .option('--record', 'with --fixtures: save model outputs to test/fixtures/llm')
    .option('--replay', 'with --fixtures: use saved model outputs, no Claude calls')
    .option('--profile <path>', 'with --fixtures: profile file (default: paths.profile)')
    .action(
      async (opts: {
        dryRun?: boolean;
        fixtures?: boolean;
        record?: boolean;
        replay?: boolean;
        profile?: string;
      }) => {
        if (!(opts.dryRun && opts.fixtures))
          throw new NotImplementedError('run (live sources)', 'P7');
        if (opts.record && opts.replay) throw new Error('--record and --replay are exclusive');
        const { runFixturesCommand } = await import('./run-fixtures.js');
        const code = await runFixturesCommand(loadConfig(configPath()), opts, io);
        if (code !== 0) process.exitCode = code;
      },
    );

  program
    .command('wa:login')
    .description('link the WhatsApp number once (QR in the terminal)')
    .action(notYet('wa:login', 'P4'));

  program
    .command('wa:groups')
    .description('list WhatsApp groups with their ids, to build the allowlist')
    .action(notYet('wa:groups', 'P4'));

  program
    .command('gmail:auth')
    .description('authorize Gmail (desktop OAuth, loopback)')
    .action(notYet('gmail:auth', 'P5'));

  program
    .command('reprocess')
    .description('rerun pipeline stages for one job')
    .argument('<jobId>', 'job id')
    .addOption(
      new Option('--from <stage>', 'first stage to rerun')
        .choices(['extract', 'dedupe', 'score', 'tailor', 'apply'])
        .default('tailor'),
    )
    .action(notYet('reprocess', 'P7'));

  program
    .command('digest')
    .description('build and send the digest email for the last run')
    .action(notYet('digest', 'P5'));

  program
    .command('ats:detect')
    .description('detect the ATS behind a careers URL and print its companies.yaml entry')
    .argument('<url>', 'careers page URL')
    .action(notYet('ats:detect', 'P6'));

  program
    .command('config:check')
    .description('validate the config file and print a summary (no secrets)')
    .action(() => {
      const cfg = loadConfig(configPath());
      io.out(`config OK: ${configPath()}`);
      io.out(`  apply.mode=${cfg.apply.mode}  cv.max_pages=${cfg.cv.max_pages}`);
      io.out(`  models: extract=${cfg.llm.extract_model} tailor=${cfg.llm.tailor_model}`);
      io.out(`  countries: ${cfg.filters.countries.join(', ')}`);
      io.out(`  whatsapp groups allowlisted: ${cfg.whatsapp.groups.length}`);
    });

  program
    .command('db:migrate')
    .description('create or upgrade the SQLite database')
    .action(() => {
      const cfg = loadConfig(configPath());
      const db = openDb(cfg.paths.db);
      try {
        const res = migrate(db);
        io.out(`database: ${cfg.paths.db}`);
        io.out(`applied: ${res.applied.join(', ') || 'none'}`);
        io.out(`already applied: ${res.alreadyApplied.join(', ') || 'none'}`);
        io.out(`tables: ${listTables(db).join(', ')}`);
      } finally {
        db.close();
      }
    });

  return program;
}
