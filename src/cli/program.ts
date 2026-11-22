// The `agent` command tree. Built by a factory so tests can run it without a process.
import { Argument, Command, Option } from 'commander';
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
    .command('tailor:fixtures')
    .description('tailor, render and ATS-check fixture jobs (P3 gate; default: 3 gate fixtures)')
    .argument('[ids...]', 'fixture ids')
    .option('--record', 'save the tailor outputs to test/fixtures/llm')
    .option('--replay', 'use saved tailor outputs, no Claude calls')
    .option('--out <dir>', 'output directory (default: <apply.output_dir>/fixtures)')
    .option('--profile <path>', 'profile file (default: paths.profile)')
    .action(
      async (
        ids: string[],
        opts: { record?: boolean; replay?: boolean; out?: string; profile?: string },
      ) => {
        if (opts.record && opts.replay) throw new Error('--record and --replay are exclusive');
        const { tailorFixturesCommand } = await import('./tailor-fixtures.js');
        const code = await tailorFixturesCommand(loadConfig(configPath()), ids, opts, io);
        if (code !== 0) process.exitCode = code;
      },
    );

  program
    .command('wa:login')
    .description('link the WhatsApp number once (QR in the terminal)')
    .action(async () => {
      const { waLogin } = await import('./whatsapp.js');
      await waLogin(loadConfig(configPath()), io);
    });

  program
    .command('wa:groups')
    .description('list WhatsApp groups with their ids, to build the allowlist')
    .action(async () => {
      const { waGroups } = await import('./whatsapp.js');
      await waGroups(loadConfig(configPath()), io);
    });

  program
    .command('collect')
    .description('collect new posts from one source into the database (no model calls)')
    .addArgument(
      new Argument('<source>', 'source').choices(['whatsapp', 'whatsapp-export', 'alerts']),
    )
    .option('--since <iso>', 'override the watermark (ISO-8601)')
    .option('--dry-run', 'count only; write nothing')
    .option('--file <path>', 'whatsapp-export: the exported chat .txt')
    .option('--group <name>', 'whatsapp-export: the group the export came from')
    .option('--extract', 'alerts: also show the jobs extracted from each alert (no storage)')
    .action(
      async (
        source: string,
        opts: {
          since?: string;
          dryRun?: boolean;
          file?: string;
          group?: string;
          extract?: boolean;
        },
      ) => {
        const cfg = loadConfig(configPath());
        if (source === 'alerts') {
          const g = await import('./gmail.js');
          await g.collectAlertsCommand(cfg, opts, io);
          return;
        }
        const wa = await import('./whatsapp.js');
        if (source === 'whatsapp') {
          await wa.collectWhatsAppCommand(cfg, opts, io);
          return;
        }
        if (!opts.file || !opts.group) throw new Error('whatsapp-export needs --file and --group');
        wa.collectExportCommand(
          cfg,
          { file: opts.file, group: opts.group, ...(opts.dryRun ? { dryRun: true } : {}) },
          io,
        );
      },
    );

  program
    .command('gmail:auth')
    .description('authorize Gmail (desktop OAuth, loopback; see docs/gmail-setup.md)')
    .action(async () => {
      const g = await import('./gmail.js');
      await g.gmailAuthCommand(loadConfig(configPath()), io);
    });

  program
    .command('gmail:check')
    .description('show the authorized account, scopes and job-alert label count')
    .action(async () => {
      const g = await import('./gmail.js');
      await g.gmailCheckCommand(loadConfig(configPath()), io);
    });

  program
    .command('gmail:test-draft')
    .description('P5 gate: draft a fixture application to yourself with both PDFs')
    .argument('[fixture]', 'fixture id', '01-devops-email-en')
    .action(async (fixture: string) => {
      const g = await import('./gmail.js');
      await g.testDraftCommand(loadConfig(configPath()), fixture, io);
    });

  program
    .command('sync')
    .description('mark sent drafts as applied and flag replies (Gmail)')
    .action(async () => {
      const g = await import('./gmail.js');
      await g.syncCommand(loadConfig(configPath()), io);
    });

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
    .description('print the digest of the last 24 h (--send emails it to yourself)')
    .option('--send', 'send it to digest.to (must be your own address)')
    .option('--hours <n>', 'period to summarize', '24')
    .action(async (opts: { send?: boolean; hours?: string }) => {
      const g = await import('./gmail.js');
      await g.digestCommand(loadConfig(configPath()), opts, io);
    });

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
