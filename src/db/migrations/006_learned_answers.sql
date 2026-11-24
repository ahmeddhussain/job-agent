-- Answers the user typed (or left as the add-on typed them) on a form they went on with (D50).
-- Only the add-on reuses them, on forms the user reviews; never an automatic submission.
CREATE TABLE learned_answers (
  question_norm TEXT PRIMARY KEY,
  question      TEXT NOT NULL,
  value         TEXT NOT NULL,
  source        TEXT NOT NULL CHECK (source IN ('typed', 'kept')),
  times         INTEGER NOT NULL DEFAULT 1,
  last_job_id   INTEGER REFERENCES jobs(id),
  updated_at    TEXT NOT NULL
);
