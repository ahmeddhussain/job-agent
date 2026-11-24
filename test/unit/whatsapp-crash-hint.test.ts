// The fix printed when the WhatsApp library crashes the process (troubleshooting #34).
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { whatsAppCrashHint } from '../../src/collect/whatsapp/crash-hint.js';

const libraryError = (): Error => {
  const err = new Error('Waiting failed: 60000ms exceeded');
  err.stack = `TimeoutError: ${err.message}\n    at Client.inject (/x/node_modules/whatsapp-web.js/src/Client.js:139:55)`;
  return err;
};

describe('whatsAppCrashHint', () => {
  it('after a logout, says to link again', () => {
    const hint = whatsAppCrashHint(libraryError(), true);
    expect(hint).toContain('logged this device out');
    expect(hint).toContain('./agent.sh whatsapp-login');
  });

  it('without a logout, says to run again first', () => {
    expect(whatsAppCrashHint(libraryError(), false)).toContain('FIX: ./agent.sh run again');
  });

  it('says nothing about other errors', () => {
    expect(whatsAppCrashHint(new Error('disk full'), true)).toBeNull();
    expect(whatsAppCrashHint('auth timeout', true)).toBeNull();
  });

  it('printing the hint changes neither the crash, its stack trace nor the exit code', () => {
    const script = `
      import { noteDisconnect, whatsAppCrashHint } from './src/collect/whatsapp/crash-hint.ts';
      process.on('uncaughtExceptionMonitor', (e) => {
        const h = whatsAppCrashHint(e);
        if (h) process.stderr.write(h + '\\n');
      });
      noteDisconnect('LOGOUT');
      const e = new Error('Waiting failed');
      e.stack += '\\n    at Client.inject (/x/node_modules/whatsapp-web.js/src/Client.js:139:55)';
      void Promise.reject(e);
      setTimeout(() => console.log('survived'), 2000);`;
    const r = spawnSync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', script],
      { encoding: 'utf8' },
    );
    expect(r.status).toBe(1);
    expect(r.stdout).not.toContain('survived');
    expect(r.stderr).toContain('FIX: ./agent.sh whatsapp-login');
    expect(r.stderr).toContain('Waiting failed');
  });
});
