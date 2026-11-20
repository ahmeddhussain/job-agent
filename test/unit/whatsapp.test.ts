// P4: WhatsApp is read-only (grep test), the collector's window/allowlist/watermark
// logic (with a fake reader), and the chat-export fallback parser.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pino } from 'pino';
import { beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  allowlisted,
  collectWhatsApp,
  hashAuthor,
  worthKeeping,
} from '../../src/collect/whatsapp/collect.js';
import { exportRef, parseWhatsAppExport, zonedToUtc } from '../../src/collect/whatsapp/export.js';
import type { WaChat, WaMessage, WhatsAppReader } from '../../src/collect/whatsapp/readonly.js';
import { parseConfig, type Config } from '../../src/config.js';
import { migrate, openDb, type Db } from '../../src/db/index.js';

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? sourceFiles(p) : p.endsWith('.ts') ? [p] : [];
  });
}

describe('WhatsApp is read-only (hard rule 1)', () => {
  const files = sourceFiles('src');
  // WhatsApp write operations. Only the facade can hold a client, so it gets the full
  // list (including generic names such as delete/reply/join); the rest of src/ gets the
  // WhatsApp-specific names, which can't collide with ordinary code like Array.join.
  const WA_SPECIFIC =
    /\b(sendMessage|sendSeen|sendPresence\w*|acceptInvite|acceptGroupV4Invite|setStatus|setDisplayName|setProfilePicture|logout|markChatUnread|archiveChat|unarchiveChat|pinChat|unpinChat|muteChat|unmuteChat|sendStateTyping|sendStateRecording|createGroup|addParticipants|removeParticipants|promoteParticipants|demoteParticipants)\s*\(/;
  const GENERIC =
    /\.(react|reply|forward|delete|leave|join\w*|archive|unarchive|pin|unpin|mute|unmute|markUnread|clearMessages|block|unblock|setSubject|setDescription)\s*\(/;
  const FACADE = join('src', 'collect', 'whatsapp', 'readonly.ts');

  it('only the facade imports whatsapp-web.js', () => {
    const importers = files.filter((f) =>
      /from ['"]whatsapp-web\.js['"]/.test(readFileSync(f, 'utf8')),
    );
    expect(importers).toEqual([join('src', 'collect', 'whatsapp', 'readonly.ts')]);
  });

  it('no file in src/ calls a WhatsApp write operation', () => {
    const hits = files.flatMap((f) =>
      readFileSync(f, 'utf8')
        .split('\n')
        .map((line, i) => ({ f, i: i + 1, line }))
        .filter(({ f, line }) => {
          const t = line.trim();
          if (t.startsWith('//') || t.startsWith('*')) return false;
          return WA_SPECIFIC.test(line) || (f === FACADE && GENERIC.test(line));
        }),
    );
    expect(hits.map((h) => `${h.f}:${String(h.i)} ${h.line.trim()}`)).toEqual([]);
  });

  it('the facade never exposes the client', () => {
    const src = readFileSync(FACADE, 'utf8');
    expect(src).toMatch(/private readonly client/);
    expect(src).not.toMatch(/(public|readonly) client\b(?!:)/);
  });

  it('the grep patterns really catch write calls (self-test)', () => {
    for (const bad of [
      'client.sendMessage(id, "hi")',
      'chat.sendSeen()',
      'msg.react("👍")',
      'client.logout()',
      'client.acceptInvite(code)',
    ]) {
      expect(WA_SPECIFIC.test(bad) || GENERIC.test(bad)).toBe(true);
    }
  });
});

const raw = parse(readFileSync('config/config.example.yaml', 'utf8')) as Record<
  string,
  Record<string, unknown>
>;
raw['digest'] = { ...raw['digest'], to: 'someone@example.com' };
raw['whatsapp'] = { ...raw['whatsapp'], groups: ['Egypt DevOps Jobs'], fetch_limit: 50 };
const cfg: Config = parseConfig(raw);
const log = pino({ level: 'silent' });
const NOW = new Date('2026-11-21T06:00:00Z');
const hoursAgo = (h: number) => Math.floor((NOW.getTime() - h * 3_600_000) / 1000);
const JOB =
  'We are hiring a DevOps Engineer in Cairo. AWS, Terraform, Kubernetes. CV to hr@acme.example';

class FakeReader implements WhatsAppReader {
  calls: string[] = [];
  constructor(
    private readonly chats: WaChat[],
    private readonly msgs: Record<string, WaMessage[]>,
  ) {}
  getChats() {
    this.calls.push('getChats');
    return Promise.resolve(this.chats);
  }
  fetchMessages(chatId: string, limit: number) {
    this.calls.push(`fetchMessages:${chatId}:${String(limit)}`);
    return Promise.resolve((this.msgs[chatId] ?? []).slice(-limit));
  }
  destroy() {
    return Promise.resolve();
  }
}

const msg = (id: string, h: number, body: string, extra: Partial<WaMessage> = {}): WaMessage => ({
  id,
  timestamp: hoursAgo(h),
  body,
  author: '201000000001@c.us',
  type: 'chat',
  fromMe: false,
  ...extra,
});

describe('collectWhatsApp', () => {
  let db: Db;
  const chats: WaChat[] = [
    { id: 'g1@g.us', name: 'Egypt DevOps Jobs', isGroup: true },
    { id: 'g2@g.us', name: 'Family', isGroup: true },
    { id: 'p1@c.us', name: 'Someone', isGroup: false },
  ];
  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
  });

  it('first run: last 24 h of allowlisted groups only, text posts only, authors hashed', async () => {
    const reader = new FakeReader(chats, {
      'g1@g.us': [
        msg('old', 30, JOB),
        msg('m1', 5, JOB),
        msg('short', 4, 'thanks!'),
        msg('mine', 3, JOB, { fromMe: true }),
        msg('sticker', 2, '', { type: 'sticker' }),
        msg('flyer', 2, `Caption: ${JOB}`, { type: 'image', id: 'cap' }),
        msg('voice', 1, '', { type: 'ptt' }),
      ],
      'g2@g.us': [msg('fam', 1, JOB)],
    });
    const res = await collectWhatsApp({ wa: reader, db, cfg, now: NOW, salt: 's', log });
    expect(reader.calls).not.toContain('fetchMessages:g2@g.us:50');
    expect(res.inserted).toBe(2); // m1 + the caption of the image post
    const rows = db
      .prepare('SELECT source_ref, author FROM raw_items ORDER BY source_ref')
      .all() as { source_ref: string; author: string }[];
    expect(rows.map((r) => r.source_ref)).toEqual(['cap', 'm1']);
    expect(rows[0]?.author).not.toContain('201000000001');
    expect(rows[0]?.author).toBe(hashAuthor('201000000001@c.us', 's'));
  });

  it('second run: only messages newer than the watermark (minus overlap) are new', async () => {
    const msgs = { 'g1@g.us': [msg('m1', 5, JOB)] };
    await collectWhatsApp({ wa: new FakeReader(chats, msgs), db, cfg, now: NOW, salt: 's', log });
    const later = new Date(NOW.getTime() + 2 * 3_600_000);
    const msgs2 = {
      'g1@g.us': [
        msg('m1', 5, JOB),
        { ...msg('m2', 0, JOB), timestamp: Math.floor((later.getTime() - 600_000) / 1000) },
      ],
    };
    const res = await collectWhatsApp({
      wa: new FakeReader(chats, msgs2),
      db,
      cfg,
      now: later,
      salt: 's',
      log,
    });
    expect(res.groups[0]?.inWindow).toBe(1);
    expect(res.inserted).toBe(1);
    expect(db.prepare('SELECT COUNT(*) FROM raw_items').pluck().get()).toBe(2);
  });

  it('dry run writes nothing, not even the watermark', async () => {
    const res = await collectWhatsApp({
      wa: new FakeReader(chats, { 'g1@g.us': [msg('m1', 5, JOB)] }),
      db,
      cfg,
      now: NOW,
      salt: 's',
      log,
      dryRun: true,
    });
    expect(res.groups[0]?.kept).toBe(1);
    expect(db.prepare('SELECT COUNT(*) FROM raw_items').pluck().get()).toBe(0);
    expect(db.prepare('SELECT COUNT(*) FROM source_state').pluck().get()).toBe(0);
  });

  it('warns when the fetch limit is hit inside the window, and about missing groups', async () => {
    const many = Array.from({ length: 50 }, (_, i) => msg(`x${String(i)}`, 1, JOB));
    const res = await collectWhatsApp({
      wa: new FakeReader([chats[1] as WaChat, chats[0] as WaChat], { 'g1@g.us': many }),
      db,
      cfg: parseConfig({
        ...raw,
        whatsapp: { ...raw['whatsapp'], groups: ['Egypt DevOps Jobs', 'Gone Group'] },
      }),
      now: NOW,
      salt: 's',
      log,
    });
    expect(res.groups[0]?.limitHit).toBe(true);
    expect(res.warnings.join('\n')).toMatch(/fetch_limit/);
    expect(res.warnings.join('\n')).toMatch(/Gone Group/);
  });

  it('pre-filter and allowlist helpers', () => {
    expect(worthKeeping('interested', 40)).toBe(false);
    expect(worthKeeping('CV: a@b.example', 40)).toBe(true);
    expect(allowlisted(chats, ['egypt devops jobs', 'g2@g.us']).chosen.map((c) => c.id)).toEqual([
      'g1@g.us',
      'g2@g.us',
    ]);
  });
});

describe('chat export fallback', () => {
  const opts = { dateOrder: 'dmy' as const, timeZone: 'Africa/Cairo' };

  it('parses Android exports, multi-line messages and Arabic, skipping media lines', () => {
    const txt = [
      '20/11/2026, 07:12 - Messages and calls are end-to-end encrypted.',
      '20/11/2026, 07:12 - Recruiter Mona: We are hiring a DevOps Engineer',
      'AWS, Terraform',
      'CV: hr@acme.example',
      '20/11/2026, 7:30 pm - +20 100 000 0001: مطلوب مهندس دعم فني',
      '20/11/2026, 21:00 - Someone: <Media omitted>',
    ].join('\n');
    const m = parseWhatsAppExport(txt, opts);
    expect(m).toHaveLength(2);
    expect(m[0]?.text).toBe('We are hiring a DevOps Engineer\nAWS, Terraform\nCV: hr@acme.example');
    expect(m[0]?.posted_at).toBe('2026-11-20T05:12:00.000Z'); // Cairo is UTC+2 in November
    expect(m[1]?.posted_at).toBe('2026-11-20T17:30:00.000Z');
    expect(m[1]?.text).toBe('مطلوب مهندس دعم فني');
  });

  it('parses iOS exports with seconds', () => {
    const m = parseWhatsAppExport(
      '[21/11/2026, 09:05:33] Ali: Cloud Engineer role, send CV to x@y.example',
      opts,
    );
    expect(m[0]?.author).toBe('Ali');
    expect(m[0]?.posted_at).toBe('2026-11-21T07:05:33.000Z');
  });

  it('converts Cairo summer time (UTC+3) correctly', () => {
    expect(zonedToUtc(2026, 7, 1, 12, 0, 0, 'Africa/Cairo').toISOString()).toBe(
      '2026-07-01T09:00:00.000Z',
    );
  });

  it('gives a stable reference per message, so re-importing an export adds nothing', () => {
    const [a] = parseWhatsAppExport(
      '20/11/2026, 07:12 - A: hello there friends of the group',
      opts,
    );
    if (!a) throw new Error('no message');
    expect(exportRef('G', a)).toBe(exportRef('G', { ...a }));
  });
});
