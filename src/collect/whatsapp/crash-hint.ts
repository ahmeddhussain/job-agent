// What to do when the WhatsApp library crashes the process (troubleshooting #34). Output
// only: it reads the error and returns the fix to print; it catches and changes nothing.

let loggedOut = false;

/** Remembers why WhatsApp disconnected, so a crash that follows can be explained. */
export function noteDisconnect(reason: string): void {
  if (reason === 'LOGOUT') loggedOut = true;
}

/** The fix to print for an uncaught error, or null if WhatsApp didn't cause it. */
export function whatsAppCrashHint(err: unknown, wasLoggedOut = loggedOut): string | null {
  const stack = err instanceof Error ? (err.stack ?? '') : '';
  if (!stack.includes('whatsapp-web.js')) return null;
  if (wasLoggedOut)
    return [
      'WhatsApp logged this device out, so the run stopped. Nothing was read from WhatsApp.',
      'FIX: ./agent.sh whatsapp-login (scan the QR code), then ./agent.sh run',
    ].join('\n');
  return [
    'WhatsApp Web stopped responding, so the run stopped.',
    'FIX: ./agent.sh run again; if it repeats: ./agent.sh whatsapp-login (scan the QR code), then ./agent.sh run',
  ].join('\n');
}
