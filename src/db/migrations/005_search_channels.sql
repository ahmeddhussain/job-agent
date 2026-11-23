-- rebuild: raw_items gains the sources 'whatsapp_channel' (D37) and 'linkedin' (D38).
-- 005: also discards with reasons (D39), interview prep (D41) and follow-ups (D40).
CREATE TABLE raw_items_new (
  id            INTEGER PRIMARY KEY,
  source        TEXT NOT NULL CHECK (source IN ('whatsapp', 'whatsapp_channel', 'alert_email', 'ats', 'html', 'whatsapp_export', 'manual', 'linkedin')),
  source_ref    TEXT NOT NULL,
  source_name   TEXT,
  author        TEXT,
  posted_at     TEXT NOT NULL,
  collected_at  TEXT NOT NULL,
  text          TEXT,
  media_path    TEXT,
  content_hash  TEXT NOT NULL,
  simhash       TEXT,
  run_id        INTEGER REFERENCES runs(id),
  processed_at  TEXT,
  process_error TEXT,
  UNIQUE (source, source_ref)
);
INSERT INTO raw_items_new SELECT id, source, source_ref, source_name, author, posted_at, collected_at,
  text, media_path, content_hash, simhash, run_id, processed_at, process_error FROM raw_items;
DROP TABLE raw_items;
ALTER TABLE raw_items_new RENAME TO raw_items;
CREATE INDEX raw_items_content_hash ON raw_items(content_hash);
CREATE INDEX raw_items_posted_at ON raw_items(posted_at);
CREATE INDEX raw_items_unprocessed ON raw_items(processed_at) WHERE processed_at IS NULL;

-- "Not a fit": Ahmed's verdict on a job, with a reason; the source of rule suggestions.
CREATE TABLE discards (
  id      INTEGER PRIMARY KEY,
  job_id  INTEGER NOT NULL UNIQUE REFERENCES jobs(id),
  reason  TEXT NOT NULL CHECK (reason IN ('wrong_field', 'too_senior', 'company', 'location', 'already_applied', 'other')),
  note    TEXT,
  at      TEXT NOT NULL
);
-- Suggestions Ahmed dismissed, so they aren't shown again.
CREATE TABLE dismissed_suggestions (
  key TEXT PRIMARY KEY,
  at  TEXT NOT NULL
);

ALTER TABLE jobs ADD COLUMN interview_prep TEXT;           -- JSON, made on demand (D41)
ALTER TABLE applications ADD COLUMN followup_draft_id TEXT; -- D40
ALTER TABLE applications ADD COLUMN followup_at TEXT;
