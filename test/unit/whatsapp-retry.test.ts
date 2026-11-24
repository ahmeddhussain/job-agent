// Starting WhatsApp again after a failed start (troubleshooting #36).
import { pino } from 'pino';
import { expect, it } from 'vitest';
import { startWithRetry, WhatsAppNotLinkedError } from '../../src/collect/whatsapp/retry.js';

const log = pino({ level: 'silent' });

it('tries again after a failed start', async () => {
  let n = 0;
  const start = () => (++n < 3 ? Promise.reject(new Error('not ready')) : Promise.resolve('ok'));
  expect(await startWithRetry(start, log)).toBe('ok');
  expect(n).toBe(3);
});

it('gives up after the last attempt with its error', async () => {
  let n = 0;
  const start = () => Promise.reject(new Error(`not ready ${String(++n)}`));
  await expect(startWithRetry(start, log, 2)).rejects.toThrow('not ready 2');
});

it('does not retry when the account is not linked', async () => {
  let n = 0;
  const start = () => {
    n++;
    return Promise.reject(new WhatsAppNotLinkedError('not linked'));
  };
  await expect(startWithRetry(start, log)).rejects.toThrow('not linked');
  expect(n).toBe(1);
});
