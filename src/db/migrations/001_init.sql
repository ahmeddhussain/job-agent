-- 001_init.sql: the data model from PLAN.md section 4.
-- CHECK constraints make invalid states impossible to store, not just unlikely.

CREATE TABLE runs (
  id          INTEGER PRIMARY KEY,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  status      TEXT NOT NULL CHECK (status IN ('running', 'success', 'partial', 'failed')),
  mode        TEXT NOT NULL CHECK (mode IN ('live', 'dry_run')),
  stats       TEXT,                    -- JSON counts per stage + tokens
  error       TEXT
);

-- one row per collected raw item (WhatsApp message, alert email, ATS posting)
CREATE TABLE raw_items (
  id            INTEGER PRIMARY KEY,
  source        TEXT NOT NULL CHECK (source IN ('whatsapp', 'alert_email', 'ats', 'html', 'whatsapp_export')),
  source_ref    TEXT NOT NULL,         -- wa msg id_serialized | gmail msg id | ats job id | url
  source_name   TEXT,                  -- group name | sender | company
  author        TEXT,                  -- WA sender, salted hash only (PLAN 12)
  posted_at     TEXT NOT NULL,         -- ISO-8601 UTC
  collected_at  TEXT NOT NULL,
  text          TEXT,
  media_path    TEXT,
  content_hash  TEXT NOT NULL,
  simhash       TEXT,
  run_id        INTEGER REFERENCES runs(id),
  UNIQUE (source, source_ref)          -- dedupe L0
);
CREATE INDEX raw_items_content_hash ON raw_items(content_hash);
CREATE INDEX raw_items_posted_at ON raw_items(posted_at);

-- one row per job (a raw item can yield several)
CREATE TABLE jobs (
  id             INTEGER PRIMARY KEY,
  raw_item_id    INTEGER NOT NULL REFERENCES raw_items(id),
  title          TEXT NOT NULL,
  title_norm     TEXT NOT NULL,
  company        TEXT,
  company_norm   TEXT,
  location       TEXT,
  work_mode      TEXT NOT NULL DEFAULT 'unknown' CHECK (work_mode IN ('onsite', 'hybrid', 'remote', 'unknown')),
  seniority      TEXT NOT NULL DEFAULT 'unknown' CHECK (seniority IN ('intern', 'junior', 'mid', 'senior', 'lead', 'unknown')),
  years_min      INTEGER,
  requirements   TEXT,                 -- JSON array
  nice_to_have   TEXT,                 -- JSON array
  apply_channel  TEXT NOT NULL CHECK (apply_channel IN ('email', 'form', 'whatsapp_dm', 'unknown')),
  apply_email    TEXT,
  apply_url      TEXT,
  subject_hint   TEXT,
  deadline       TEXT,
  language       TEXT CHECK (language IN ('en', 'ar', 'mixed')),
  fingerprint    TEXT NOT NULL,
  duplicate_of   INTEGER REFERENCES jobs(id),
  priority       INTEGER CHECK (priority IN (1, 2, 3)),
  fit_score      INTEGER CHECK (fit_score BETWEEN 0 AND 100),
  fit_reasons    TEXT,                 -- JSON {matched:[], missing:[], summary:""}
  flags          TEXT,                 -- JSON array
  status         TEXT NOT NULL DEFAULT 'new' CHECK (status IN
                   ('new', 'skipped', 'needs_review', 'ready', 'applied', 'interview', 'offer', 'rejected')),
  skip_reason    TEXT,
  has_reply      INTEGER NOT NULL DEFAULT 0 CHECK (has_reply IN (0, 1)),
  notes          TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX jobs_fingerprint ON jobs(fingerprint);
CREATE INDEX jobs_status ON jobs(status);
CREATE INDEX jobs_raw_item ON jobs(raw_item_id);

CREATE TABLE applications (
  id               INTEGER PRIMARY KEY,
  job_id           INTEGER NOT NULL UNIQUE REFERENCES jobs(id),
  channel          TEXT NOT NULL CHECK (channel IN ('email', 'form', 'whatsapp_dm')),
  to_email         TEXT,
  subject          TEXT,
  body             TEXT,
  cv_pdf           TEXT,
  cv_md            TEXT,
  cover_pdf        TEXT,
  cover_text       TEXT,
  ats_report       TEXT,               -- JSON from the ATS check (PLAN 8.6)
  why_this_role    TEXT,
  gmail_draft_id   TEXT,
  gmail_thread_id  TEXT,
  gmail_message_id TEXT,
  mode             TEXT NOT NULL CHECK (mode IN ('draft', 'send', 'package')),
  created_at       TEXT NOT NULL,
  sent_at          TEXT
);
CREATE INDEX applications_to_email ON applications(to_email);

CREATE TABLE source_state (            -- per-source watermark (R1/R2)
  source          TEXT PRIMARY KEY,    -- whatsapp:<group-id> | alerts | ats:<company>
  last_success_at TEXT NOT NULL
);

CREATE TABLE llm_calls (
  id                INTEGER PRIMARY KEY,
  run_id            INTEGER REFERENCES runs(id),
  job_id            INTEGER REFERENCES jobs(id),
  purpose           TEXT NOT NULL,     -- extract | score | tailor
  model             TEXT NOT NULL,
  input_tokens      INTEGER,
  output_tokens     INTEGER,
  cache_read_tokens INTEGER,
  ok                INTEGER NOT NULL CHECK (ok IN (0, 1)),
  created_at        TEXT NOT NULL
);

CREATE TABLE status_history (
  id          INTEGER PRIMARY KEY,
  job_id      INTEGER NOT NULL REFERENCES jobs(id),
  from_status TEXT,
  to_status   TEXT NOT NULL,
  by          TEXT NOT NULL CHECK (by IN ('agent', 'sync', 'ahmed')),
  at          TEXT NOT NULL
);
CREATE INDEX status_history_job ON status_history(job_id);
