// The `agent` command tree. Built by a factory so tests can run it without a process.
import { join, resolve } from 'node:path';
import { Argument, Command, Option } from 'commander';
import { loadConfig } from '../config.js';
import { listTables, migrate, openDb } from '../db/index.js';
import { resolveProfile } from '../profiles.js';

export class NotImplementedError extends Error {
  override name = 'NotImplementedError';
  constructor(command: string, phase: string) {
    super(`'${command}' is not implemented yet (arrives in ${phase}, PLAN.md section 14)`);
  }
}

export interface Io {
  out: (line: string) => void;
}

/** Commands that work without a profile (they create or choose one). */
const NO_PROFILE = new Set(['init', 'profile:list', 'profile:use']);

const INVOKED_FROM = process.cwd();

/**
 * A path the user typed, relative to where they typed it (agent.sh passes its caller's
 * directory, since the CLI itself runs inside the profile folder: D45).
 */
export const userPath = (p: string): string =>
  resolve(process.env['JOB_AGENT_CALLER_CWD'] ?? INVOKED_FROM, p);

export function buildProgram(io: Io): Command {
  const program = new Command()
    .name('agent')
    .description('Job-application agent: collect, score, tailor, apply, track (README.md)')
    .option('-p, --profile <name>', 'profile to use (profiles/<name>; default: the active one)')
    .option('-c, --config <path>', 'a config file outside the profiles (tests, development)')
    .showHelpAfterError();

  let selected: string | null = null;
  // Before every command: choose the profile and run inside its folder, so its relative
  // paths (data/, output/, secrets/, profile.yaml) are its own. Child processes (the
  // dashboard's runs) inherit the choice through the environment.
  program.hook('preAction', (_cmd, action) => {
    if (NO_PROFILE.has(action.name())) return;
    const o = program.opts<{ profile?: string; config?: string }>();
    const explicit = o.config ?? (o.profile ? undefined : process.env['CONFIG_PATH']);
    if (explicit) {
      selected = userPath(explicit);
      process.env['CONFIG_PATH'] = selected;
      return;
    }
    const p = resolveProfile(o.profile);
    process.chdir(p.dir);
    process.env['JOB_AGENT_PROFILE'] = p.name;
    selected = join(p.dir, 'config.yaml');
  });
  const configPath = (): string => {
    if (!selected) throw new Error('no profile selected');
    return selected;
  };

  program
    .command('run')
    .description('collect, dedupe, score, tailor and prepare applications (end to end)')
    .option('--dry-run', 'on a copy of the database; no Gmail writes; digest printed')
    .option('--fixtures', 'with --dry-run: the P2 fixture gate instead of live sources')
    .addOption(
      new Option('--source <name>', 'collect one source only').choices([
        'whatsapp',
        'linkedin',
        'alerts',
        'ats',
      ]),
    )
    .option('--since <iso>', 'override the per-source watermark (ISO-8601)')
    .option('--no-collect', 'read only items already stored (e.g. added with `agent add`)')
    .option('--record', 'with --fixtures: save model outputs to test/fixtures/llm')
    .option('--replay', 'with --fixtures: use saved model outputs, no Claude calls')
    .option(
      '--profile-file <path>',
      'with --fixtures: profile file (default: test/fixtures/profile.yaml)',
    )
    .action(
      async (opts: {
        dryRun?: boolean;
        fixtures?: boolean;
        source?: string;
        since?: string;
        collect?: boolean;
        record?: boolean;
        replay?: boolean;
        profileFile?: string;
      }) => {
        if (opts.profileFile) opts.profileFile = userPath(opts.profileFile);
        if (opts.fixtures) {
          if (!opts.dryRun) throw new Error('--fixtures needs --dry-run');
          if (opts.record && opts.replay) throw new Error('--record and --replay are exclusive');
          const { runFixturesCommand } = await import('./run-fixtures.js');
          const code = await runFixturesCommand(loadConfig(configPath()), opts, io);
          if (code !== 0) process.exitCode = code;
          return;
        }
        const { runCommand } = await import('./run.js');
        const code = await runCommand(loadConfig(configPath()), opts, io);
        if (code !== 0) process.exitCode = code;
      },
    );

  program
    .command('add')
    .description('store a job post by hand (file, or stdin) for the next run')
    .argument('[file]', 'text file with the post (default: stdin)')
    .option('--name <label>', 'where it came from (shown in the tracker)')
    .option('--posted <iso>', 'when it was posted (default: now)')
    .action(async (file: string | undefined, opts: { name?: string; posted?: string }) => {
      const { addCommand } = await import('./run.js');
      addCommand(loadConfig(configPath()), file === undefined ? file : userPath(file), opts, io);
    });

  program
    .command('assist')
    .description('open each "apply yourself" job in your browser; you submit')
    .option('--job <id>', 'only this job')
    .action(async (opts: { job?: string }) => {
      const { assistCommand } = await import('./assist.js');
      await assistCommand(loadConfig(configPath()), opts.job ? { job: Number(opts.job) } : {}, io);
    });

  program
    .command('send-drafts')
    .description('send every reviewed application draft still in Gmail Drafts (asks once)')
    .option('--yes', 'do not ask for confirmation')
    .action(async (opts: { yes?: boolean }) => {
      const { sendDraftsCommand } = await import('./assist.js');
      await sendDraftsCommand(loadConfig(configPath()), opts, io);
    });

  program
    .command('skipped')
    .description('list skipped jobs with their reason and link, to catch what the agent missed')
    .option('--days <n>', 'look back this many days', '7')
    .option('--reason <r>', 'only this reason (low_fit, excluded_title, over_experience, ...)')
    .option('--all', 'include duplicates')
    .action(async (opts: { days?: string; reason?: string; all?: boolean }) => {
      const { skippedCommand } = await import('./assist.js');
      skippedCommand(loadConfig(configPath()), opts, io);
    });

  program
    .command('retry-forms')
    .description('retry forms that waited only for questions you have since answered')
    .action(async () => {
      const { retryFormsCommand } = await import('./assist.js');
      await retryFormsCommand(loadConfig(configPath()), io);
    });

  program
    .command('recheck-dates')
    .description('read the real posting date of jobs not yet applied to; skip the stale ones')
    .action(async () => {
      const { recheckDatesCommand } = await import('./assist.js');
      await recheckDatesCommand(loadConfig(configPath()), io);
    });

  program
    .command('companies')
    .description('list the company boards polled: companies.yaml plus discovered ones')
    .action(async () => {
      const { companiesCommand } = await import('./ats.js');
      companiesCommand(loadConfig(configPath()), io);
    });

  program
    .command('dashboard')
    .description('serve the tracker on 127.0.0.1 (dashboard.host:port)')
    .action(async () => {
      const { serveDashboard } = await import('../dashboard/server.js');
      await serveDashboard(loadConfig(configPath()), io, configPath());
    });

  program
    .command('tailor:fixtures')
    .description('tailor, render and ATS-check fixture jobs (P3 gate; default: 3 gate fixtures)')
    .argument('[ids...]', 'fixture ids')
    .option('--record', 'save the tailor outputs to test/fixtures/llm')
    .option('--replay', 'use saved tailor outputs, no Claude calls')
    .option('--out <dir>', 'output directory (default: <apply.output_dir>/fixtures)')
    .option('--profile-file <path>', 'profile file (default: test/fixtures/profile.yaml)')
    .action(
      async (
        ids: string[],
        opts: { record?: boolean; replay?: boolean; out?: string; profileFile?: string },
      ) => {
        if (opts.record && opts.replay) throw new Error('--record and --replay are exclusive');
        if (opts.profileFile) opts.profileFile = userPath(opts.profileFile);
        if (opts.out) opts.out = userPath(opts.out);
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
      new Argument('<source>', 'source').choices([
        'whatsapp',
        'whatsapp-export',
        'linkedin',
        'alerts',
        'ats',
      ]),
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
        if (source === 'linkedin') {
          const r = await import('./run.js');
          await r.collectLinkedinCommand(cfg, opts, io);
          return;
        }
        if (source === 'ats') {
          const a = await import('./ats.js');
          await a.collectAtsCommand(cfg, opts, io);
          return;
        }
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
          {
            file: userPath(opts.file),
            group: opts.group,
            ...(opts.dryRun ? { dryRun: true } : {}),
          },
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
    .description('redo one job: rescore it, or re-tailor its CV and letter')
    .argument('<jobId>', 'job id (dashboard, or the run output)')
    .addOption(
      new Option('--from <stage>', 'first stage to rerun')
        .choices(['score', 'tailor'])
        .default('tailor'),
    )
    .action(async (jobId: string, opts: { from: 'score' | 'tailor' }) => {
      const id = Number(jobId);
      if (!Number.isInteger(id) || id <= 0) throw new Error(`not a job id: ${jobId}`);
      const { reprocessCommand } = await import('./run.js');
      const code = await reprocessCommand(loadConfig(configPath()), id, opts.from, io);
      if (code !== 0) process.exitCode = code;
    });

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
    .description(
      'detect the ATS behind a careers URL, verify its feed, print the companies.yaml entry',
    )
    .argument('<url>', 'careers page URL')
    .action(async (url: string) => {
      const a = await import('./ats.js');
      await a.atsDetectCommand(loadConfig(configPath()), url, io);
    });

  program
    .command('config:check')
    .description('validate the config file and print a summary (no secrets)')
    .action(() => {
      const cfg = loadConfig(configPath());
      io.out(`config OK: ${configPath()} (merged over config/defaults.yaml)`);
      io.out(`  profile: ${process.env['JOB_AGENT_PROFILE'] ?? '(none: --config)'}`);
      io.out(`  apply.mode=${cfg.apply.mode}  cv.max_pages=${cfg.cv.max_pages}`);
      io.out(`  models: extract=${cfg.llm.extract_model} tailor=${cfg.llm.tailor_model}`);
      io.out(`  countries: ${cfg.filters.countries.join(', ')}`);
      io.out(
        `  sources: whatsapp=${cfg.whatsapp.enabled ? 'on' : 'off'} linkedin=${cfg.search.linkedin.enabled ? 'on' : 'off'} alerts=${cfg.alerts.enabled && cfg.gmail.enabled ? 'on' : 'off'} company boards=${cfg.ats.enabled ? 'on' : 'off'}`,
      );
      io.out(
        `  gmail: ${cfg.gmail.enabled ? 'on (email drafts)' : 'off (email jobs become packages)'}`,
      );
      io.out(`  whatsapp groups allowlisted: ${String(cfg.whatsapp.groups.length)}`);
    });

  program
    .command('profile:list')
    .description('list the profiles and which one is active')
    .action(async () => {
      const { profileListCommand } = await import('./profiles.js');
      profileListCommand(program.opts<{ profile?: string }>().profile, io);
    });

  program
    .command('profile:use')
    .description('make a profile the default for every command')
    .argument('<name>', 'profile name (profiles/<name>)')
    .action(async (name: string) => {
      const { profileUseCommand } = await import('./profiles.js');
      profileUseCommand(name, io);
    });

  program
    .command('demo:seed')
    .description('fill the example profile with fictional jobs, to try the dashboard')
    .action(async () => {
      const { demoSeedCommand } = await import('../dev/demo.js');
      demoSeedCommand(loadConfig(configPath()), io.out);
    });

  program
    .command('profile:reviewed')
    .description('after checking profile.yaml and titles.yaml: validate them and allow runs')
    .action(async () => {
      const { reviewedCommand } = await import('./init.js');
      const cfg = loadConfig(configPath());
      reviewedCommand(process.cwd(), cfg.paths.profile, cfg.paths.titles, io);
    });

  program
    .command('init')
    .description('create your profile: config, facts from your CV (via Claude), titles')
    .option('--name <name>', 'profile name (default: asked)')
    .option('--cv <file>', 'your current CV (PDF, DOCX, TXT or Markdown)')
    .option('--from-example', 'start from the fictional example instead of a CV')
    .action(async (opts: { name?: string; cv?: string; fromExample?: boolean }) => {
      const { initCommand } = await import('./init.js');
      await initCommand({ ...opts, ...(opts.cv ? { cv: userPath(opts.cv) } : {}) }, io);
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
