// Opens jobs in the user's own browser. Cloudflare's check and Google's sign-in refuse a
// browser that software controls, even when a person is using it, and the agent never
// disguises one to get past that (D46, troubleshooting #38).
import { spawn } from 'node:child_process';

/** Opens a web page in the user's browser. False when that isn't possible here. */
export function openInOwnBrowser(url: string, browser: string | null = null): Promise<boolean> {
  const command = browser ?? (process.platform === 'darwin' ? 'open' : 'xdg-open');
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return Promise.resolve(false);
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return Promise.resolve(false);
  return new Promise((resolve) => {
    const child = spawn(command, [u.href], { stdio: 'ignore', detached: true });
    child.once('error', () => {
      resolve(false);
    });
    // A failing opener exits at once; a working one may stay as long as the browser.
    child.once('exit', (code) => {
      resolve(code === 0);
    });
    setTimeout(() => {
      child.unref();
      resolve(true);
    }, 2000).unref();
  });
}
