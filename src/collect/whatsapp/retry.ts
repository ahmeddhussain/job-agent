// WhatsApp Web sometimes fails to start once and works on the next try (troubleshooting
// #36). Starting only opens the linked session: it reads and sends nothing.
import type { Logger } from 'pino';

/** The account isn't linked: trying again can't help, the owner has to scan a QR code. */
export class WhatsAppNotLinkedError extends Error {
  override name = 'WhatsAppNotLinkedError';
}

export async function startWithRetry<T>(
  start: () => Promise<T>,
  log: Pick<Logger, 'warn'>,
  attempts = 3,
): Promise<T> {
  for (let n = 1; ; n++) {
    try {
      return await start();
    } catch (err) {
      if (err instanceof WhatsAppNotLinkedError || n >= attempts) throw err;
      log.warn(
        { attempt: n, err: err instanceof Error ? err.message : String(err) },
        `whatsapp did not start, attempt ${String(n)} of ${String(attempts)}: trying again`,
      );
    }
  }
}
