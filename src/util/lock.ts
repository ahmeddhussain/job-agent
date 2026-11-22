// Exclusive pid lock file (PLAN 11 overlap lock): a second concurrent `agent run` exits
// at once. A lock left by a killed process is detected by its pid and replaced.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export class LockedError extends Error {
  override name = 'LockedError';
}

export function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0); // existence check only
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to another user, so it is alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Takes the lock or throws LockedError; returns the release function. */
export function acquireLock(path: string, what: string): () => void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const take = () => {
    writeFileSync(path, String(process.pid), { flag: 'wx', mode: 0o600 });
  };
  try {
    take();
  } catch {
    let pid = NaN;
    try {
      pid = Number(readFileSync(path, 'utf8').trim());
    } catch {
      /* vanished meanwhile */
    }
    if (alive(pid) && pid !== process.pid)
      throw new LockedError(`${what} is already running (pid ${String(pid)})`);
    rmSync(path, { force: true });
    take();
  }
  return () => {
    rmSync(path, { force: true });
  };
}
