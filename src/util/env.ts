// Reads a .env file into a private object. Values are NOT exported to process.env, so
// secrets reach only the child processes that are explicitly given them (security A6).
import { existsSync, readFileSync, statSync } from 'node:fs';

export interface DotEnv {
  values: Record<string, string>;
  /** Non-fatal problems worth logging (never contain values). */
  warnings: string[];
}

export function loadDotEnv(path: string): DotEnv {
  const values: Record<string, string> = {};
  const warnings: string[] = [];
  if (!existsSync(path)) return { values, warnings: [`${path} not found`] };

  const mode = statSync(path).mode & 0o777;
  if (mode & 0o077) {
    warnings.push(
      `${path} is readable by other users (mode ${mode.toString(8)}); run: chmod 600 ${path}`,
    );
  }
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m?.[1]) continue;
    let v = (m[2] ?? '').trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    values[m[1]] = v;
  }
  return { values, warnings };
}
