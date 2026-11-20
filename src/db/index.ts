// SQLite access: one file, WAL mode, foreign keys on, forward-only SQL migrations.
import Database from 'better-sqlite3';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type Db = Database.Database;

/** Directory holding NNN_name.sql files; copied next to the compiled module by `npm run build`. */
export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

export function openDb(path: string): Db {
  // data/ will also hold the WhatsApp session (a logged-in account): owner-only.
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new Database(path);
  db.pragma('journal_mode = WAL'); // readers (dashboard) don't block the writer (agent run)
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  return db;
}

export interface MigrationResult {
  applied: string[];
  alreadyApplied: string[];
}

/** Applies every migration not yet recorded, each in its own transaction. Idempotent. */
export function migrate(db: Db, dir: string = MIGRATIONS_DIR): MigrationResult {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`);
  const done = new Set(
    db
      .prepare('SELECT version FROM schema_migrations')
      .pluck()
      .all()
      .map((v) => String(v)),
  );
  const files = readdirSync(dir)
    .filter((f) => /^\d{3}_[a-z0-9_]+\.sql$/.test(f))
    .sort();

  const result: MigrationResult = { applied: [], alreadyApplied: [] };
  const record = db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)');
  for (const file of files) {
    if (done.has(file)) {
      result.alreadyApplied.push(file);
      continue;
    }
    const sql = readFileSync(join(dir, file), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      record.run(file, new Date().toISOString());
    })();
    result.applied.push(file);
  }
  return result;
}

export function listTables(db: Db): string[] {
  return db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .pluck()
    .all()
    .map((v) => String(v));
}
