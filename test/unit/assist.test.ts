// "Open to apply" opens the job in the user's own browser (D46), and WhatsApp applications
// (D51): the number, and a message that fits under a document.
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { waMessage, waNumber } from '../../src/apply/wa-message.js';
import { parseConfig } from '../../src/config.js';
import { AssistSession } from '../../src/dashboard/assist.js';
import { companyForm } from '../../src/dashboard/ext.js';
import { migrate, openDb } from '../../src/db/index.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

it('opens forms, boards and WhatsApp chats in the configured browser', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'assist-'));
  const browser = join(dir, 'my-browser');
  writeFileSync(browser, `#!/bin/sh\necho "$1" > ${dir}/opened\n`);
  chmodSync(browser, 0o755);
  vi.stubEnv('PATH', '/usr/bin:/bin');
  vi.stubEnv('DISPLAY', ':99');
  const raw = parse(readFileSync('config/defaults.yaml', 'utf8')) as Record<
    string,
    Record<string, unknown>
  >;
  raw['forms'] = { ...raw['forms'], browser };
  const cfg = parseConfig(raw);
  const db = openDb(':memory:');
  migrate(db);
  db.prepare(
    `INSERT INTO raw_items (id, source, source_ref, posted_at, collected_at, text, content_hash)
     VALUES (1, 'manual', 'm1', '2026-11-24', '2026-11-24', 't', 'h')`,
  ).run();
  const add = (id: number, channel: string, url: string | null, phone: string | null) => {
    db.prepare(
      `INSERT INTO jobs (id, raw_item_id, title, title_norm, apply_channel, apply_url, apply_phone, fingerprint, status, created_at, updated_at)
       VALUES (?, 1, 'DevOps Engineer', 'devops engineer', ?, ?, ?, ?, 'ready', 'now', 'now')`,
    ).run(id, channel, url, phone, `f${String(id)}`);
    db.prepare(
      `INSERT INTO applications (job_id, channel, mode, created_at, cv_pdf) VALUES (?, ?, 'manual', 'now', 'cv.pdf')`,
    ).run(id, channel);
  };
  add(1, 'form', 'https://eg.indeed.com/viewjob?jk=1', null);
  add(2, 'whatsapp_dm', null, '0100 000 0000');
  add(3, 'whatsapp_dm', null, '123');
  const s = new AssistSession(() => cfg, db);
  expect(s.recent(15)).toBeNull();
  const opened = () => readFileSync(join(dir, 'opened'), 'utf8').trim();
  expect((await s.open(1)).url).toBe('https://eg.indeed.com/viewjob?jk=1');
  expect(opened()).toBe('https://eg.indeed.com/viewjob?jk=1');
  await s.open(2);
  expect(opened()).toBe('https://web.whatsapp.com/send?phone=201000000000');
  expect(s.recent(15)).toBe(2);
  await expect(s.open(3)).rejects.toThrow('no link');
  await expect(s.open(99)).rejects.toThrow('no prepared application');
  for (const bad of [
    'https://www.linkedin.com/jobs/view/1',
    'http://careers.acme.example/apply',
    'https://127.0.0.1/apply',
    'https://router.local/apply',
    'https://user:pw@careers.acme.example/',
    'javascript:alert(1)',
  ])
    expect(companyForm(bad, cfg), bad).toBeNull();
  expect(companyForm('https://careers.acme.example/a?id=7', cfg)).toContain('id=7');
  db.close();
});

it('makes WhatsApp numbers international and refuses unusable ones', () => {
  expect(waNumber('010 0000 0000')).toBe('201000000000');
  expect(waNumber('+20 100 000 0000')).toBe('201000000000');
  expect(waNumber('+966 50 000 0000')).toBe('966500000000');
  for (const bad of ['123', '', null, '1'.repeat(16)]) expect(waNumber(bad)).toBeNull();
});

it('keeps the letter’s own paragraphs that fit under a document, in order', () => {
  const p = (w: string, n: number) => `${w} ${'x'.repeat(n)}.`;
  const letter = [
    'Dear Hiring Team,',
    p('Opening', 200),
    p('Middle', 600),
    p('Closing', 200),
    'Best regards,',
    'Mona Adel',
  ].join('\n\n');
  const m = waMessage(letter);
  expect(m.length).toBeLessThanOrEqual(1000);
  expect(m.split('\n\n').map((x) => x.split(' ')[0])).toEqual([
    'Dear',
    'Opening',
    'Closing',
    'Best',
    'Mona',
  ]);
  expect(waMessage('Dear team,\n\nShort.\n\nBest regards,\n\nMona')).toBe(
    'Dear team,\n\nShort.\n\nBest regards,\n\nMona',
  );
  expect(waMessage('')).toBe('');
});
