-- rebuild: raw_items gains 'application_mail' and applications.mode gains 'external' (D53).
-- 007: application emails read in live runs (D53), and deleting skipped jobs (D54).
CREATE TABLE raw_items_new (
  id            INTEGER PRIMARY KEY,
  source        TEXT NOT NULL CHECK (source IN ('whatsapp', 'whatsapp_channel', 'alert_email', 'ats', 'html', 'whatsapp_export', 'manual', 'linkedin', 'application_mail')),
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

CREATE TABLE applications_new (
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
  ats_report       TEXT,
  why_this_role    TEXT,
  gmail_draft_id   TEXT,
  gmail_thread_id  TEXT,
  gmail_message_id TEXT,
  mode             TEXT NOT NULL CHECK (mode IN ('draft', 'send', 'package', 'submitted', 'manual', 'external')),
  created_at       TEXT NOT NULL,
  sent_at          TEXT,
  package_dir      TEXT,
  answers          TEXT,
  form_report      TEXT,
  manual_reason    TEXT,
  followup_draft_id TEXT,
  followup_at      TEXT
);
INSERT INTO applications_new (id, job_id, channel, to_email, subject, body, cv_pdf, cv_md, cover_pdf,
  cover_text, ats_report, why_this_role, gmail_draft_id, gmail_thread_id, gmail_message_id, mode,
  created_at, sent_at, package_dir, answers, form_report, manual_reason, followup_draft_id, followup_at)
SELECT id, job_id, channel, to_email, subject, body, cv_pdf, cv_md, cover_pdf, cover_text, ats_report,
  why_this_role, gmail_draft_id, gmail_thread_id, gmail_message_id, mode, created_at, sent_at,
  package_dir, answers, form_report, manual_reason, followup_draft_id, followup_at FROM applications;
DROP TABLE applications;
ALTER TABLE applications_new RENAME TO applications;
CREATE INDEX applications_to_email ON applications(to_email);

-- A deleted job is hidden, not removed: dedupe needs it, or the next run would bring it back.
ALTER TABLE jobs ADD COLUMN deleted_at TEXT;

-- One row per email looked at. Mail that isn't about an application keeps only its id, so it
-- is never read again and nothing of it is stored.
CREATE TABLE application_mail (
  message_id  TEXT PRIMARY KEY,
  thread_id   TEXT,
  kind        TEXT NOT NULL CHECK (kind IN ('none', 'applied', 'viewed', 'assessment', 'interview', 'offer', 'rejected', 'other')),
  job_id      INTEGER REFERENCES jobs(id),
  company     TEXT,
  title       TEXT,
  quote       TEXT,                    -- the sentence the kind rests on, copied from the email
  sender      TEXT,
  subject     TEXT,
  at          TEXT NOT NULL,           -- when the email arrived or was sent
  from_status TEXT,                    -- what this email changed (NULL = nothing)
  to_status   TEXT,
  created_job INTEGER NOT NULL DEFAULT 0 CHECK (created_job IN (0, 1)),
  seen_at     TEXT,
  run_id      INTEGER REFERENCES runs(id)
);
CREATE INDEX application_mail_thread ON application_mail(thread_id);
CREATE INDEX application_mail_job ON application_mail(job_id);
