#!/usr/bin/env node
// Entry point: `npm run agent -- <command>` (dev) or `agent <command>` (built).
import { whatsAppCrashHint } from './collect/whatsapp/crash-hint.js';
import { ConfigError } from './config.js';
import { GmailAuthError } from './gmail/auth.js';
import { buildProgram, NotImplementedError } from './cli/program.js';
import { logger } from './util/logger.js';

// A closed pipe (`agent ... | head`) is a normal end of output, not a crash.
process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') process.exit(0);
  throw err;
});

// Says how to fix a crash from the WhatsApp library. The monitor only observes: the crash,
// its stack trace and exit code 1 stay exactly as they are (troubleshooting #34).
process.on('uncaughtExceptionMonitor', (err) => {
  const hint = whatsAppCrashHint(err);
  if (hint) process.stderr.write(`${hint}\n`);
});

const program = buildProgram({ out: (line) => process.stdout.write(`${line}\n`) });

try {
  await program.parseAsync(process.argv);
} catch (err) {
  if (err instanceof NotImplementedError) {
    process.stderr.write(`${err.message}\n`);
    process.exitCode = 2;
  } else if (err instanceof ConfigError) {
    process.stderr.write(`${err.message}\n`);
    process.exitCode = 78; // EX_CONFIG
  } else if (err instanceof GmailAuthError) {
    process.stderr.write(`${err.message}\n`);
    process.exitCode = 77; // EX_NOPERM
  } else {
    // One readable line. Full error objects (request configs, response bodies) are logged
    // only at debug level: troubleshooting #17.
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    logger.debug({ err }, 'command failed');
    process.exitCode = 1;
  }
}
