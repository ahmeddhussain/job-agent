// CLI actions for P4: wa:login, wa:groups, collect whatsapp, collect whatsapp-export.
import { readFileSync } from 'node:fs';
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
import { migrate, openDb } from '../db/index.js';
import { insertRawItem, prepareRawItem } from '../pipeline/dedupe.js';
import { logger } from '../util/logger.js';
import type { Io } from './program.js';

function startOptions(cfg: Config, timeoutSeconds: number) {
  return {
    sessionPath: cfg.whatsapp.session_path,
    webCachePath: cfg.whatsapp.web_cache_path,
    settleSeconds: cfg.whatsapp.settle_seconds,
    readyTimeoutSeconds: timeoutSeconds,
    log: logger,
  };
}

/** Links the number once: prints a QR, waits for the scan, then closes (never logs out). */
export async function waLogin(cfg: Config, io: Io): Promise<void> {
  io.out('Open WhatsApp on the phone → Linked devices → Link a device, then scan:');
  const wa = await ReadOnlyWhatsApp.start({
    ...startOptions(cfg, cfg.whatsapp.login_timeout_seconds),
    settleSeconds: 5,
    onQr: (qr) => {
      qrcode.generate(qr, { small: true }, (art: string) => {
        io.out(art);
      });
    },
  });
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
}

export async function waGroups(cfg: Config, io: Io): Promise<void> {
  const wa = await ReadOnlyWhatsApp.start(startOptions(cfg, cfg.whatsapp.ready_timeout_seconds));
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
}

export async function collectWhatsAppCommand(
  cfg: Config,
  opts: { since?: string; dryRun?: boolean },
  io: Io,
): Promise<void> {
  const db = openDb(cfg.paths.db);
  migrate(db);
  const wa = await ReadOnlyWhatsApp.start(startOptions(cfg, cfg.whatsapp.ready_timeout_seconds));
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
        `${g.name}: since ${g.since} fetched=${String(g.fetched)} in-window=${String(g.inWindow)} kept=${String(g.kept)} new=${String(g.inserted)}${g.limitHit ? ' (LIMIT HIT)' : ''}`,
      );
    }
    for (const w of res.warnings) io.out(`warning: ${w}`);
    io.out(opts.dryRun ? 'dry run: nothing written' : `stored ${String(res.inserted)} new posts`);
  } finally {
    await wa.destroy();
    db.close();
  }
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
