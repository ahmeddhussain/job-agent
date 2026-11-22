-- rebuild: applications.mode gains 'submitted' (a web form the agent sent) and 'manual'
-- (prepared, waiting for Ahmed's click: captcha, sign-in, open questions). D33.
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
  mode             TEXT NOT NULL CHECK (mode IN ('draft', 'send', 'package', 'submitted', 'manual')),
  created_at       TEXT NOT NULL,
  sent_at          TEXT,
  package_dir      TEXT,
  answers          TEXT,
  form_report      TEXT,                 -- JSON: what was filled, what is missing, screenshots
  manual_reason    TEXT                  -- why Ahmed has to click: captcha, sign-in, open questions
);
INSERT INTO applications_new (id, job_id, channel, to_email, subject, body, cv_pdf, cv_md, cover_pdf,
  cover_text, ats_report, why_this_role, gmail_draft_id, gmail_thread_id, gmail_message_id, mode,
  created_at, sent_at, package_dir, answers)
SELECT id, job_id, channel, to_email, subject, body, cv_pdf, cv_md, cover_pdf, cover_text, ats_report,
  why_this_role, gmail_draft_id, gmail_thread_id, gmail_message_id, mode, created_at, sent_at,
  package_dir, answers FROM applications;
DROP TABLE applications;
ALTER TABLE applications_new RENAME TO applications;
CREATE INDEX applications_to_email ON applications(to_email);
