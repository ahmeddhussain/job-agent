// CLI actions for P4: wa:login, wa:groups, collect whatsapp, collect whatsapp-export.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import qrcode from 'qrcode-terminal';
import type { Config } from '../config.js';
import {
  collectWhatsApp,
  hashAuthor,
  loadOrCreateSalt,
  worthKeeping,
} from '../collect/whatsapp/collect.js';
import { exportRef, parseWhatsAppExport } from '../collect/whatsapp/export.js';
import { ReadOnlyWhatsApp } from '../collect/whatsapp/readonly.js';
import { migrate, openDb, type Db } from '../db/index.js';
import { insertRawItem, prepareRawItem } from '../pipeline/dedupe.js';
import { alive } from '../util/lock.js';
import { logger } from '../util/logger.js';
import type { Io } from './program.js';

/**
 * One WhatsApp command at a time: two processes can't share the Chrome profile in
 * data/wa-session (Chrome refuses the second one). A stale lock from a killed process
 * is detected by its pid and replaced (troubleshooting #14).
 */
export async function withWhatsAppLock<T>(
  cfg: Config,
  fn: (onExit: (cb: () => Promise<void>) => void) => Promise<T>,
): Promise<T> {
  const lockPath = join(dirname(cfg.whatsapp.session_path), 'wa.lock');
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  const take = () => {
    writeFileSync(lockPath, String(process.pid), { flag: 'wx', mode: 0o600 });
  };
  try {
    take();
  } catch {
    const pid = Number(readFileSync(lockPath, 'utf8').trim());
    if (alive(pid))
      throw new Error(
        `another WhatsApp command is running (pid ${String(pid)}); wait for it or stop it first`,
      );
    rmSync(lockPath, { force: true });
    take();
  }
  // Ctrl-C / kill: close the browser cleanly so the session isn't left half-written.
  let cleanup: (() => Promise<void>) | null = null;
  const onSignal = (sig: NodeJS.Signals) => {
    void (async () => {
      process.stderr.write(`\n${sig}: closing WhatsApp cleanly...\n`);
      if (cleanup) await cleanup();
      rmSync(lockPath, { force: true });
      process.exit(130);
    })();
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    return await fn((cb) => {
      cleanup = cb;
    });
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    rmSync(lockPath, { force: true });
  }
}

function startOptions(cfg: Config, timeoutSeconds: number) {
  return {
    sessionPath: cfg.whatsapp.session_path,
    webCachePath: cfg.whatsapp.web_cache_path,
    settleSeconds: cfg.whatsapp.settle_seconds,
    readyTimeoutSeconds: timeoutSeconds,
    authTimeoutSeconds: cfg.whatsapp.auth_timeout_seconds,
    log: logger,
  };
}

/** Links the number once: prints a QR, waits for the scan, then closes (never logs out). */
export async function waLogin(cfg: Config, io: Io): Promise<void> {
  await withWhatsAppLock(cfg, async (onExit) => {
    io.out('Open WhatsApp on the phone → Linked devices → Link a device, then scan:');
    const wa = await ReadOnlyWhatsApp.start({
      ...startOptions(cfg, cfg.whatsapp.login_timeout_seconds),
      settleSeconds: 5,
      onQr: (qr) => {
        qrcode.generate(qr, { small: true }, (art: string) => {
          io.out(art);
        });
        io.out('(a new QR appears about every 20 s until one is scanned)');
      },
      onProgress: (step) => {
        io.out(`… ${step}`);
      },
    });
    onExit(() => wa.destroy());
    try {
      const groups = (await wa.getChats()).filter((c) => c.isGroup).length;
      io.out(
        `Linked. Session saved in ${cfg.whatsapp.session_path} (keep it private). Groups visible: ${String(groups)}.`,
      );
      io.out(
        'Next: agent wa:groups, then put the job groups in whatsapp.groups in config/config.yaml.',
      );
    } finally {
      await wa.destroy();
    }
  });
}

export async function waGroups(cfg: Config, io: Io): Promise<void> {
  await withWhatsAppLock(cfg, async (onExit) => {
    const wa = await ReadOnlyWhatsApp.start({
      ...startOptions(cfg, cfg.whatsapp.ready_timeout_seconds),
      onProgress: (step) => {
        io.out(`… ${step}`);
      },
    });
    onExit(() => wa.destroy());
    try {
      const allow = new Set(cfg.whatsapp.groups.map((g) => g.trim().toLowerCase()));
      const groups = (await wa.getChats())
        .filter((c) => c.isGroup)
        .sort((a, b) => a.name.localeCompare(b.name));
      io.out(`${String(groups.length)} groups (* = allowlisted in whatsapp.groups):`);
      for (const g of groups) {
        const on = allow.has(g.name.trim().toLowerCase()) || allow.has(g.id.toLowerCase());
        io.out(`${on ? '*' : ' '} ${g.name}    ${g.id}`);
      }
    } finally {
      await wa.destroy();
    }
  });
}

export async function collectWhatsAppCommand(
  cfg: Config,
  opts: { since?: string; dryRun?: boolean },
  io: Io,
): Promise<void> {
  await withWhatsAppLock(cfg, async (onExit) => {
    const db = openDb(cfg.paths.db);
    migrate(db);
    const wa = await ReadOnlyWhatsApp.start(startOptions(cfg, cfg.whatsapp.ready_timeout_seconds));
    onExit(async () => {
      await wa.destroy();
      db.close();
    });
    try {
      const res = await collectWhatsApp({
        wa,
        db,
        cfg,
        now: new Date(),
        salt: loadOrCreateSalt(cfg.whatsapp.author_salt_file),
        log: logger,
        ...(opts.since ? { since: new Date(opts.since) } : {}),
        ...(opts.dryRun ? { dryRun: true } : {}),
      });
      for (const g of res.groups) {
        io.out(
          `${g.name}: since ${g.since} fetched=${String(g.fetched)} in-window=${String(g.inWindow)} kept=${String(g.kept)} new=${String(g.inserted)}${g.limitHit ? ' (LIMIT HIT)' : ''} [messages ${g.oldest ?? '-'} .. ${g.newest ?? '-'}]`,
        );
      }
      for (const w of res.warnings) io.out(`warning: ${w}`);
      io.out(opts.dryRun ? 'dry run: nothing written' : `stored ${String(res.inserted)} new posts`);
    } finally {
      await wa.destroy();
      db.close();
    }
  });
}

export function collectExportCommand(
  cfg: Config,
  opts: { file: string; group: string; dryRun?: boolean },
  io: Io,
): void {
  const msgs = parseWhatsAppExport(readFileSync(opts.file, 'utf8'), {
    dateOrder: cfg.whatsapp.export_date_order,
    timeZone: cfg.timezone,
  }).filter((m) => worthKeeping(m.text, cfg.whatsapp.min_text_chars));
  if (opts.dryRun) {
    io.out(`dry run: ${String(msgs.length)} messages would be stored from "${opts.group}"`);
    return;
  }
  const db = openDb(cfg.paths.db);
  migrate(db);
  const salt = loadOrCreateSalt(cfg.whatsapp.author_salt_file);
  let inserted = 0;
  db.transaction(() => {
    for (const m of msgs) {
      const item = prepareRawItem({
        source: 'whatsapp_export',
        source_ref: exportRef(opts.group, m),
        source_name: opts.group,
        author: hashAuthor(m.author, salt),
        posted_at: m.posted_at,
        text: m.text,
      });
      if (insertRawItem(db, item, new Date().toISOString()).inserted) inserted++;
    }
  })();
  db.close();
  io.out(
    `parsed ${String(msgs.length)} messages, stored ${String(inserted)} new from "${opts.group}"`,
  );
}

/** `agent run`'s WhatsApp source: same collector, inside the run's database and record. */
export async function collectWhatsAppForRun(
  cfg: Config,
  db: Db,
  runId: number,
  since?: Date,
): Promise<{ inserted: number; detail: string }> {
  return withWhatsAppLock(cfg, async (onExit) => {
    const wa = await ReadOnlyWhatsApp.start(startOptions(cfg, cfg.whatsapp.ready_timeout_seconds));
    onExit(async () => {
      await wa.destroy();
    });
    try {
      const res = await collectWhatsApp({
        wa,
        db,
        cfg,
        now: new Date(),
        salt: loadOrCreateSalt(cfg.whatsapp.author_salt_file),
        log: logger,
        runId,
        ...(since ? { since } : {}),
      });
      const groups = res.groups
        .map((g) => `${g.name} ${String(g.inserted)} new${g.limitHit ? ' (LIMIT HIT)' : ''}`)
        .join(', ');
      return {
        inserted: res.inserted,
        detail: `${String(res.inserted)} new posts (${groups || 'no groups'})${res.warnings.length ? `; ${res.warnings.join('; ')}` : ''}`,
      };
    } finally {
      await wa.destroy();
    }
  });
}
