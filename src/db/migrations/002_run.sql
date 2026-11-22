-- rebuild: raw_items gets the 'manual' source (CHECK constraints can't be altered in place).
-- 002_run.sql: P7 orchestrator, dynamic company discovery (D30, D31), P8 dashboard.

-- raw_items: a processing queue. An item is processed once (processed_at); an item the
-- model never reached (usage limit) stays NULL and is picked up by the next run.
CREATE TABLE raw_items_new (
  id            INTEGER PRIMARY KEY,
  source        TEXT NOT NULL CHECK (source IN ('whatsapp', 'alert_email', 'ats', 'html', 'whatsapp_export', 'manual')),
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
INSERT INTO raw_items_new (id, source, source_ref, source_name, author, posted_at, collected_at,
  text, media_path, content_hash, simhash, run_id)
SELECT id, source, source_ref, source_name, author, posted_at, collected_at,
  text, media_path, content_hash, simhash, run_id FROM raw_items;
DROP TABLE raw_items;
ALTER TABLE raw_items_new RENAME TO raw_items;
CREATE INDEX raw_items_content_hash ON raw_items(content_hash);
CREATE INDEX raw_items_posted_at ON raw_items(posted_at);
CREATE INDEX raw_items_unprocessed ON raw_items(processed_at) WHERE processed_at IS NULL;

-- Companies: from config/companies.yaml (source 'config', mirrored each run) and found
-- automatically from job links (source 'discovered', D30). collect:ats polls both.
CREATE TABLE companies (
  id              INTEGER PRIMARY KEY,
  name            TEXT NOT NULL,
  ats             TEXT NOT NULL CHECK (ats IN ('greenhouse', 'lever', 'ashby', 'smartrecruiters', 'workable', 'html')),
  board           TEXT,                -- ATS board token; NULL for html
  url             TEXT,                -- html careers page; NULL for ATS boards
  source          TEXT NOT NULL CHECK (source IN ('config', 'discovered')),
  evidence        TEXT,                -- how it was found: the job link, or "title match on <board>"
  discovered_job  INTEGER REFERENCES jobs(id),
  active          INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  fail_count      INTEGER NOT NULL DEFAULT 0,
  added_at        TEXT NOT NULL,
  last_checked_at TEXT,
  UNIQUE (ats, board),
  UNIQUE (url)
);

-- Company names already probed for an ATS board, so a company is not re-probed every run.
CREATE TABLE company_probes (
  company_norm TEXT PRIMARY KEY,
  checked_at   TEXT NOT NULL,
  found        INTEGER REFERENCES companies(id)
);

-- Jobs: where to apply on the company's own site, and how the job was enriched.
ALTER TABLE jobs ADD COLUMN apply_phone TEXT;      -- WhatsApp number, copied from the post
ALTER TABLE jobs ADD COLUMN apply_url_direct TEXT;
ALTER TABLE jobs ADD COLUMN apply_note TEXT;   -- e.g. linkedin_easy_apply, linkedin_offsite
ALTER TABLE jobs ADD COLUMN enriched_from TEXT; -- the page the full description came from
ALTER TABLE jobs ADD COLUMN company_id INTEGER REFERENCES companies(id);

-- Applications: the package folder (form / WhatsApp jobs) and the screening answers.
ALTER TABLE applications ADD COLUMN package_dir TEXT;
ALTER TABLE applications ADD COLUMN answers TEXT; -- JSON {question: answer}
