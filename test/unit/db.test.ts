import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listTables, migrate, openDb, type Db } from '../../src/db/index.js';

const now = '2026-11-20T08:00:00.000Z';

describe('database', () => {
  let db: Db;
  beforeEach(() => {
    db = openDb(':memory:');
  });
  afterEach(() => {
    db.close();
  });

  it('creates every table from PLAN.md section 4', () => {
    const res = migrate(db);
    expect(res.applied).toEqual([
      '001_init.sql',
      '002_run.sql',
      '003_forms.sql',
      '004_dates_questions.sql',
    ]);
    expect(listTables(db)).toEqual([
      'applications',
      'companies',
      'company_probes',
      'form_questions',
      'jobs',
      'llm_calls',
      'raw_items',
      'runs',
      'schema_migrations',
      'source_state',
      'status_history',
    ]);
  });

  it('is idempotent: a second migrate applies nothing', () => {
    migrate(db);
    const second = migrate(db);
    expect(second.applied).toEqual([]);
    expect(second.alreadyApplied).toEqual([
      '001_init.sql',
      '002_run.sql',
      '003_forms.sql',
      '004_dates_questions.sql',
    ]);
  });

  it('has foreign keys enforced', () => {
    migrate(db);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    const insertJob = () =>
      db
        .prepare(
          `INSERT INTO jobs (raw_item_id, title, title_norm, apply_channel, fingerprint, created_at, updated_at)
           VALUES (999, 'x', 'x', 'email', 'fp', ?, ?)`,
        )
        .run(now, now);
    expect(insertJob).toThrow(/FOREIGN KEY/);
  });

  it('rejects an invalid job status (CHECK constraint)', () => {
    migrate(db);
    db.prepare(
      `INSERT INTO raw_items (id, source, source_ref, posted_at, collected_at, content_hash)
       VALUES (1, 'whatsapp', 'm1', ?, ?, 'h')`,
    ).run(now, now);
    const bad = () =>
      db
        .prepare(
          `INSERT INTO jobs (raw_item_id, title, title_norm, apply_channel, fingerprint, status, created_at, updated_at)
           VALUES (1, 'x', 'x', 'email', 'fp', 'sent_maybe', ?, ?)`,
        )
        .run(now, now);
    expect(bad).toThrow(/CHECK/);
  });

  it('dedupe L0: the same source message cannot be stored twice', () => {
    migrate(db);
    const ins = db.prepare(
      `INSERT INTO raw_items (source, source_ref, posted_at, collected_at, content_hash)
       VALUES ('whatsapp', 'same-id', ?, ?, 'h')`,
    );
    ins.run(now, now);
    expect(() => ins.run(now, now)).toThrow(/UNIQUE/);
  });
});
