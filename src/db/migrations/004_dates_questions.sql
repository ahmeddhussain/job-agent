-- 004: when the job itself was posted (alerts recommend old jobs; D34), and the form
-- questions the profile couldn't answer, so each one is asked of Ahmed once (D35).
ALTER TABLE jobs ADD COLUMN job_posted_at TEXT;   -- from the job page / feed; NULL = unknown

CREATE TABLE form_questions (
  id            INTEGER PRIMARY KEY,
  question      TEXT NOT NULL,                     -- as the form showed it
  question_norm TEXT NOT NULL UNIQUE,              -- lowercase, no '*' or punctuation
  times         INTEGER NOT NULL DEFAULT 1,
  first_seen    TEXT NOT NULL,
  last_seen     TEXT NOT NULL,
  last_job_id   INTEGER REFERENCES jobs(id),
  answer_key    TEXT                               -- application_answers key once answered
);
