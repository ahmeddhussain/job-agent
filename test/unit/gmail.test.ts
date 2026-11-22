// P5 without a Google account: MIME, the Gmail facade's limits, alerts, L4 guard, sync, digest.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pino } from 'pino';
import { beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { applicationGuard } from '../../src/apply/guard.js';
import { alertToText, collectAlerts } from '../../src/collect/alerts.js';
import { parseConfig, type Config } from '../../src/config.js';
import { migrate, openDb, type Db } from '../../src/db/index.js';
import type { GmailWriter, MailSummary } from '../../src/gmail/client.js';
import { buildMime, encodeHeader } from '../../src/gmail/mime.js';
import { syncGmail } from '../../src/gmail/sync.js';
import { explainGmailError, GmailAuthError } from '../../src/gmail/auth.js';
import { buildDigest, sendDigest } from '../../src/pipeline/digest.js';

const raw = parse(readFileSync('config/config.example.yaml', 'utf8')) as Record<
  string,
  Record<string, unknown>
>;
raw['digest'] = { ...raw['digest'], to: 'me@example.com' };
const cfg: Config = parseConfig(raw);
const log = pino({ level: 'silent' });
const NOW = new Date('2026-11-22T12:00:00Z');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
  });
}

describe('MIME builder', () => {
  const decode = (r: string) => Buffer.from(r, 'base64url').toString('utf8');

  it('builds multipart/mixed with the body and named PDF attachments', () => {
    const msg = decode(
      buildMime(
        {
          fromName: 'Ahmed Khater',
          fromEmail: 'me@example.com',
          to: 'hr@acme.example',
          subject: 'Application – DevOps Engineer – Ahmed Khater',
          text: 'Hello,\nCV attached.',
          attachments: [
            {
              filename: 'Ahmed_Khater_CV_Acme_DevOps.pdf',
              contentType: 'application/pdf',
              content: Buffer.from('%PDF-1.4 cv'),
            },
            {
              filename: 'Ahmed_Khater_Cover_Letter_Acme_DevOps.pdf',
              contentType: 'application/pdf',
              content: Buffer.from('%PDF-1.4 cl'),
            },
          ],
        },
        'BOUNDARY',
      ),
    );
    expect(msg).toContain('Content-Type: multipart/mixed; boundary="BOUNDARY"');
    expect(msg).toContain(
      `Subject: ${encodeHeader('Application – DevOps Engineer – Ahmed Khater')}`,
    );
    expect(msg).toContain('filename="Ahmed_Khater_CV_Acme_DevOps.pdf"');
    expect(msg).toContain('filename="Ahmed_Khater_Cover_Letter_Acme_DevOps.pdf"');
    expect(msg.match(/^--BOUNDARY(--)?\r?$/gm)).toHaveLength(4); // body, 2 attachments, closing
    expect(msg.trimEnd().endsWith('--BOUNDARY--')).toBe(true);
  });

  it('encodes non-ASCII subjects and leaves ASCII alone', () => {
    expect(encodeHeader('Plain subject')).toBe('Plain subject');
    expect(encodeHeader('Application – X')).toMatch(/^=\?UTF-8\?B\?.+\?=$/);
  });

  it('rejects header injection and invalid recipients', () => {
    const base = {
      fromName: 'A',
      fromEmail: 'me@example.com',
      to: 'hr@acme.example',
      subject: 'x',
      text: 'y',
    };
    expect(() => buildMime({ ...base, subject: 'Hi\r\nBcc: evil@x.example' })).toThrow(
      /line break/,
    );
    expect(() => buildMime({ ...base, to: 'not-an-email' })).toThrow(/invalid recipient/);
  });
});

describe('Gmail facade limits (security A10)', () => {
  const src = files('src');
  const FACADE = join('src', 'gmail', 'client.ts');

  it('only the facade imports @googleapis/gmail', () => {
    expect(
      src.filter((f) => /from ['"]@googleapis\/gmail['"]/.test(readFileSync(f, 'utf8'))),
    ).toEqual([FACADE]);
  });

  it('the facade never deletes, trashes, relabels or changes settings', () => {
    const code = readFileSync(FACADE, 'utf8');
    expect(code).not.toMatch(
      /\.(delete|trash|untrash|modify|batchModify|batchDelete|insert|import)\s*\(/,
    );
    expect(code).not.toMatch(/\.(labels|settings|filters|forwardingAddresses|sendAs)\./);
  });

  it('sending is called only from the digest and the apply stage', () => {
    const callers = src.filter(
      (f) => f !== FACADE && /\.send(Raw|Draft)\(/.test(readFileSync(f, 'utf8')),
    );
    expect(
      callers.every(
        (f) => f.endsWith(join('pipeline', 'digest.ts')) || f.includes(join('src', 'apply')),
      ),
    ).toBe(true);
  });
});

class FakeGmail implements GmailWriter {
  sent: string[] = [];
  searches: string[] = [];
  drafts = new Set<string>();
  threads = new Map<
    string,
    { id: string; labelIds: string[]; from: string; internalDate: string }[]
  >();
  messages = new Map<string, MailSummary>();
  sentTo = new Set<string>();
  constructor(private readonly me = 'me@example.com') {}
  myAddress() {
    return Promise.resolve(this.me);
  }
  search(q: string, max: number) {
    this.searches.push(q);
    if (q.startsWith('in:sent')) {
      const to = /to:(\S+)/.exec(q)?.[1] ?? '';
      return Promise.resolve(this.sentTo.has(to) ? ['s1'] : []);
    }
    return Promise.resolve([...this.messages.keys()].slice(0, max));
  }
  getMessage(id: string) {
    const m = this.messages.get(id);
    return m ? Promise.resolve(m) : Promise.reject(new Error('404'));
  }
  createDraft() {
    this.drafts.add('d1');
    return Promise.resolve({ draftId: 'd1', messageId: 'm1', threadId: 't1' });
  }
  draftExists(id: string) {
    return Promise.resolve(this.drafts.has(id));
  }
  threadMessages(id: string) {
    return Promise.resolve(this.threads.get(id) ?? []);
  }
  sendRaw(r: string) {
    this.sent.push(r);
    return Promise.resolve({ messageId: 'x', threadId: 'y' });
  }
  sendDraft() {
    return Promise.resolve({ messageId: 'x', threadId: 'y' });
  }
}

const alert: MailSummary = {
  id: 'a1',
  threadId: 't',
  internalDate: '2026-11-22T06:00:00.000Z',
  from: 'LinkedIn Job Alerts <jobalerts-noreply@linkedin.com>',
  to: 'me@example.com',
  subject: '"DevOps Engineer": 3 new jobs',
  labelIds: ['Label_1'],
  html: '<table><tr><td><a href="https://www.linkedin.com/comm/jobs/view/4123456789/?trk=x">DevOps Engineer</a></td></tr><tr><td>Acme · Cairo</td></tr></table><img src="x.png">',
  text: null,
};

describe('alerts', () => {
  let db: Db;
  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
  });

  it('keeps link targets as text and drops images', () => {
    const t = alertToText(alert, 20000);
    expect(t).toContain(
      'DevOps Engineer (https://www.linkedin.com/comm/jobs/view/4123456789/?trk=x)',
    );
    expect(t).toContain('Acme · Cairo');
    expect(t).not.toContain('x.png');
    expect(alertToText(alert, 40)).toMatch(/\[truncated\]$/);
  });

  it('queries the label since the watermark, stores each email once, advances the watermark', async () => {
    const g = new FakeGmail();
    g.messages.set('a1', alert);
    const r1 = await collectAlerts({ gmail: g, db, cfg, now: NOW, log });
    expect(g.searches[0]).toBe(
      `label:"job-alerts" after:${String(Math.floor((NOW.getTime() - 24 * 3_600_000) / 1000))}`,
    );
    expect(r1.inserted).toBe(1);
    const r2 = await collectAlerts({
      gmail: g,
      db,
      cfg,
      now: new Date(NOW.getTime() + 3_600_000),
      log,
    });
    expect(r2.inserted).toBe(0); // L0: same message id
    expect(
      db.prepare("SELECT last_success_at FROM source_state WHERE source = 'alerts'").pluck().get(),
    ).toBe(new Date(NOW.getTime() + 3_600_000).toISOString());
  });
});

function seedApplication(
  db: Db,
  title: string,
  to: string,
  createdAt: string,
  extra: Record<string, unknown> = {},
) {
  const raw = db
    .prepare(
      `INSERT INTO raw_items (source, source_ref, posted_at, collected_at, content_hash) VALUES ('whatsapp', ?, ?, ?, 'h')`,
    )
    .run(`r-${title}-${createdAt}`, createdAt, createdAt).lastInsertRowid;
  const job = db
    .prepare(
      `INSERT INTO jobs (raw_item_id, title, title_norm, apply_channel, apply_email, fingerprint, status, created_at, updated_at)
       VALUES (?, ?, ?, 'email', ?, 'fp', 'ready', ?, ?)`,
    )
    .run(raw, title, title.toLowerCase(), to, createdAt, createdAt).lastInsertRowid;
  db.prepare(
    `INSERT INTO applications (job_id, channel, to_email, mode, created_at, gmail_draft_id, gmail_thread_id, sent_at)
     VALUES (?, 'email', ?, 'draft', ?, ?, ?, ?)`,
  ).run(job, to, createdAt, extra['draft'] ?? null, extra['thread'] ?? null, extra['sent'] ?? null);
  return Number(job);
}

describe('L4 application guard', () => {
  let db: Db;
  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
  });

  it('skips the same role to the same address within the cooldown', async () => {
    seedApplication(db, 'DevOps Engineer', 'hr@acme.example', '2026-11-10T00:00:00Z');
    const r = await applicationGuard(db, null, cfg, {
      to: 'HR@acme.example',
      title: 'Senior DevOps Engineer',
      now: NOW,
    });
    expect(r).toMatchObject({ ok: false, status: 'skipped', reason: 'already_applied' });
  });

  it('sends a different role to a recent recruiter to review, not as a second email', async () => {
    seedApplication(
      db,
      'Linux System Administrator',
      'mona@talent.example',
      '2026-11-20T00:00:00Z',
    );
    const r = await applicationGuard(db, null, cfg, {
      to: 'mona@talent.example',
      title: 'Cloud Support Engineer',
      now: NOW,
    });
    expect(r).toMatchObject({ ok: false, status: 'needs_review', reason: 'same_recruiter' });
  });

  it('catches addresses Ahmed emailed by hand (Gmail Sent check)', async () => {
    const g = new FakeGmail();
    g.sentTo.add('jobs@old.example');
    const r = await applicationGuard(db, g, cfg, {
      to: 'jobs@old.example',
      title: 'DevOps Engineer',
      now: NOW,
    });
    expect(r).toMatchObject({ ok: false, reason: 'contacted_before' });
    expect(g.searches[0]).toBe('in:sent to:jobs@old.example newer_than:60d');
    expect(
      await applicationGuard(db, g, cfg, {
        to: 'new@co.example',
        title: 'DevOps Engineer',
        now: NOW,
      }),
    ).toEqual({ ok: true });
  });
});

describe('sync:gmail and digest', () => {
  let db: Db;
  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
  });

  it('marks a sent draft as applied and flags a later reply', async () => {
    const job = seedApplication(db, 'DevOps Engineer', 'hr@acme.example', '2026-11-21T00:00:00Z', {
      draft: 'd1',
      thread: 't1',
    });
    const g = new FakeGmail();
    g.threads.set('t1', [
      {
        id: 'm1',
        labelIds: ['SENT'],
        from: 'Ahmed <me@example.com>',
        internalDate: '2026-11-21T09:00:00.000Z',
      },
    ]);
    expect(await syncGmail(db, g, NOW)).toEqual({ sent: 1, replies: 0 });
    expect(db.prepare('SELECT status FROM jobs WHERE id = ?').pluck().get(job)).toBe('applied');
    expect(db.prepare('SELECT by FROM status_history WHERE job_id = ?').pluck().get(job)).toBe(
      'sync',
    );

    g.threads.get('t1')?.push({
      id: 'm2',
      labelIds: ['INBOX'],
      from: 'HR <hr@acme.example>',
      internalDate: '2026-11-22T08:00:00.000Z',
    });
    expect(await syncGmail(db, g, NOW)).toEqual({ sent: 0, replies: 1 });
    expect(db.prepare('SELECT has_reply FROM jobs WHERE id = ?').pluck().get(job)).toBe(1);
  });

  it('a draft that still exists is left alone; a deleted, unsent one is not "applied"', async () => {
    seedApplication(db, 'A', 'a@x.example', '2026-11-21T00:00:00Z', { draft: 'd1', thread: 't1' });
    seedApplication(db, 'B', 'b@x.example', '2026-11-21T00:00:00Z', { draft: 'd2', thread: 't2' });
    const g = new FakeGmail();
    g.drafts.add('d1');
    g.threads.set('t2', [
      { id: 'm', labelIds: ['DRAFT'], from: 'me', internalDate: '2026-11-21T00:00:00Z' },
    ]);
    expect(await syncGmail(db, g, NOW)).toEqual({ sent: 0, replies: 0 });
  });

  it('builds a digest and refuses to send it to anyone but the Gmail account owner', async () => {
    seedApplication(db, 'DevOps Engineer', 'hr@acme.example', '2026-11-22T06:00:00Z');
    const d = buildDigest(db, '2026-11-21T12:00:00Z', '2026-11-22');
    expect(d.subject).toBe('Job agent — 1 ready, 0 need review (2026-11-22)');
    const g = new FakeGmail();
    await sendDigest(g, cfg, d);
    expect(g.sent).toHaveLength(1);
    await expect(sendDigest(new FakeGmail('someone-else@example.com'), cfg, d)).rejects.toThrow(
      /own Gmail address/,
    );
  });
});

describe('expired or revoked Gmail authorization', () => {
  it('turns invalid_grant into one clear instruction', () => {
    const err = Object.assign(new Error('invalid_grant'), {
      response: { data: { error: 'invalid_grant' } },
    });
    expect(() => explainGmailError(err)).toThrow(GmailAuthError);
    expect(() => explainGmailError(err)).toThrow(/gmail:auth/);
    expect(() => explainGmailError(Object.assign(new Error('x'), { code: 401 }))).toThrow(
      /expired or was revoked/,
    );
  });

  it('explains a disabled Gmail API with the link to enable it', () => {
    const url =
      'https://console.developers.google.com/apis/api/gmail.googleapis.com/overview?project=640217805034';
    const err = Object.assign(
      new Error(
        `Gmail API has not been used in project 640217805034 before or it is disabled. Enable it by visiting ${url} then retry.`,
      ),
      {
        code: 403,
        response: {
          data: {
            error: {
              code: 403,
              status: 'PERMISSION_DENIED',
              details: [{ reason: 'SERVICE_DISABLED' }],
            },
          },
        },
      },
    );
    expect(() => explainGmailError(err)).toThrow(GmailAuthError);
    expect(() => explainGmailError(err)).toThrow(url);
  });

  it('passes other errors through unchanged (e.g. a 404 for a sent draft)', () => {
    const notFound = Object.assign(new Error('Not Found'), { code: 404 });
    expect(() => explainGmailError(notFound)).toThrow(notFound);
  });
});
