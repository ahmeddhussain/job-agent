// The WhatsApp Web version loaded from the cache (troubleshooting #35).
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { newestCachedVersion } from '../../src/collect/whatsapp/web-version.js';

it('picks the newest cached version by number, ignoring other files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wa-cache-'));
  for (const f of ['2.3000.999.html', '2.3000.1055.html', 'notes.html', '2.3000.2000.txt'])
    writeFileSync(join(dir, f), '');
  expect(newestCachedVersion(dir)).toBe('2.3000.1055');
});

it('is null for an empty or missing cache', () => {
  expect(newestCachedVersion(mkdtempSync(join(tmpdir(), 'wa-cache-')))).toBeNull();
  expect(newestCachedVersion('/nonexistent/wa-cache')).toBeNull();
});
