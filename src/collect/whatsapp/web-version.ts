// Which WhatsApp Web page to load (troubleshooting #35). Since 2026-11-23 WhatsApp sends a
// browser that isn't linked to /login/, a page whatsapp-web.js 1.34.8 can't read. Loading
// the newest version this profile cached while it worked avoids the redirect.
import { readdirSync } from 'node:fs';

/** The newest cached version (the file names are versions), or null with an empty cache. */
export function newestCachedVersion(dir: string): string | null {
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return null;
  }
  const versions = files
    .map((f) => /^(\d+(?:\.\d+)+)\.html$/.exec(f)?.[1])
    .filter((v): v is string => v !== undefined)
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  return versions.at(-1) ?? null;
}
