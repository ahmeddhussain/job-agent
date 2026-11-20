# Job Application Agent — Build Plan

A daily, read-only job-hunting agent for Ahmed: it collects job posts from WhatsApp groups, LinkedIn / job-board alerts and company career pages, removes duplicates, scores each job against his real profile, tailors a CV and cover letter per job, prepares the application (a Gmail draft for email jobs, a ready-to-submit package for form jobs), and tracks everything on a local dashboard.

Stack: **TypeScript (Node 22) · whatsapp-web.js · Gmail API · Claude (headless Claude Code, `claude -p`, on Ahmed's subscription) · SQLite · Puppeteer (PDF) · Fastify · Docker · systemd timer**.

> **For Claude Code:** read `CLAUDE.md` first. Build phase by phase (section 14). Each phase ends at a **gate**: run the listed checks, show Ahmed the results, and wait for his OK before the next phase. Explain every meaningful choice as **Choice → Alternatives → Why this one → What production would add**.

---

## Table of Contents

1. [Requirements Checklist](#1-requirements-checklist)
2. [Architecture](#2-architecture)
3. [Key Decisions](#3-key-decisions)
4. [Data Model](#4-data-model)
5. [Pipeline Stages](#5-pipeline-stages)
6. [Title Matching & Priority](#6-title-matching--priority)
7. [Deduplication](#7-deduplication)
8. [CV & Cover Letter Tailoring](#8-cv--cover-letter-tailoring)
9. [Applying](#9-applying)
10. [Tracker Dashboard & API](#10-tracker-dashboard--api)
11. [Scheduling & Deployment](#11-scheduling--deployment)
12. [Security, Privacy & Safety](#12-security-privacy--safety)
13. [Best Practices Baked In](#13-best-practices-baked-in)
14. [Build Phases & Gates](#14-build-phases--gates)
15. [Testing Strategy](#15-testing-strategy)
16. [What Ahmed Must Provide](#16-what-ahmed-must-provide)
17. [Repo Layout](#17-repo-layout)

---

## 1. Requirements Checklist

From Ahmed's brief (explicit + implied). Re-check every item before calling the project done.

| # | Requirement | Section |
|---|---|---|
| R1 | **First run** processes every job posted in the **last 24 hours** | 5.1 |
| R2 | Every later run processes everything **since the last successful run** (per source) | 5.1 |
| R3 | Sources: **WhatsApp job groups** (primary), **LinkedIn**, **company websites** (+ Egyptian job boards via alerts). **Text posts only**: image flyers are out of scope (decided 2026-11-20) | 5.1 |
| R4 | Priority titles: DevOps Engineer, Cloud Engineer, IT Engineer, Infrastructure Engineer, Technical Support, Application Support, Platform Engineer, Monitoring Engineer | 6 |
| R5 | Also apply to **any other job he is qualified for** (lower priority) | 6 |
| R6 | **Tailor the CV** per job from his real skills and projects — never invent anything | 8 |
| R7 | **Cover letter** per job, attached with the application | 8 |
| R8 | **Apply through Gmail** for email jobs; prepare packages for form-only jobs (LinkedIn / company sites) | 9 |
| R9 | **Never re-apply** to the same job (cross-group forwards, reposts, cross-source duplicates) | 7 |
| R10 | Runs **once a day, started manually** by Ahmed (`agent run`); the systemd timer is optional | 11 |
| R11 | **Simple tracker dashboard** for all jobs and their status | 10 |
| R12 | WhatsApp is **read-only** — the agent never sends, reacts, marks read, or joins anything | 5.1, 12 |
| R13 | README in the ivolve-GitOps style (no screenshots index), `docs/decisions.md`, troubleshooting log | 14 (P10) |
| R14 | Every applied CV is **exactly one page** | 8.3 |
| R15 | **ATS check** passes before any application is drafted, sent or packaged (always for form jobs and for email that lands in an ATS; the agent runs it on every application) | 8.6 |
| R16 | A **new cover letter is drafted for every application**, never reused | 8.2, 8.4 |
| R17 | CV content is **only facts** from the master profile; commits carry **no AI attribution** | 8.1, CLAUDE.md |
| R18 | **No per-run caps**: a run processes every available job until the Claude subscription's usage limit is reached; what's left continues on the next run | D6, 5.5 |
| R19 | **Security:** the VM, the Claude subscription token, Gmail and WhatsApp sessions can't be taken over through the agent; no secret or private data ever reaches Git | 12, `docs/security.md` |

**Out of scope (on purpose):** automatic form submission on LinkedIn / company sites, logging into LinkedIn with Ahmed's account, sending any WhatsApp message.

---

## 2. Architecture

```
                         ┌──────────────────── daily run (systemd timer → docker compose run agent) ────────────────────┐
                         │                                                                                               │
 WhatsApp groups ──► [collect:whatsapp] ─┐                                                                               │
 (whatsapp-web.js,      text only        │                                                                               │
  allowlisted groups)                    │    ┌──────────┐   ┌─────────┐   ┌────────┐   ┌───────┐   ┌────────┐   ┌──────┐ │
 Gmail label           [collect:alerts] ─┼──► │normalize │──►│ extract │──►│ dedupe │──►│ score │──►│ tailor │──►│apply │ │
 "job-alerts" ───────►  LinkedIn/Wuzzuf/ │    │ + split  │   │ (Haiku) │   │4 layers│   │tiers +│   │(Sonnet)│   │route │ │
 (LinkedIn, Wuzzuf,     Bayt/Indeed      │    └──────────┘   └─────────┘   └────────┘   │  fit  │   │+ PDFs  │   └──┬───┘ │
  Bayt, Indeed)                          │                                              └───────┘   └────────┘      │     │
 Company ATS feeds ──► [collect:ats] ────┘                                                                          │     │
 (Greenhouse, Lever,                                                                                                │     │
  Ashby, Workable…)                                         email job ─► Gmail DRAFT (CV + cover letter attached) ◄─┤     │
                                                            form job  ─► package: PDFs + apply link + answers    ◄──┘     │
                                                            digest    ─► one summary email to Ahmed                       │
                         └───────────────────────────────────────────────┬───────────────────────────────────────────────┘
                                                                         ▼
                                                        SQLite (data/agent.db)  ◄──►  Fastify API + dashboard (127.0.0.1:8080)
                                                                         ▲
                                              [sync:gmail] marks jobs "applied" when Ahmed sends a draft, flags replies
```

| Component | Technology | Responsibility |
|---|---|---|
| `collect:whatsapp` | whatsapp-web.js (headless Chromium) | Read new text messages and captions from allowlisted groups since the watermark (no media download) |
| `collect:alerts` | Gmail API (`gmail.readonly`) | Read job-alert emails under the `job-alerts` label |
| `collect:ats` | HTTPS + public ATS JSON feeds | Pull open roles from target companies |
| `extract` | `claude -p` — `claude-haiku-5-5`, `--json-schema` structured output | Turn raw text/images into structured jobs (one post can hold several jobs) |
| `dedupe` | SQLite + hashing + fuzzy match | Drop forwards, reposts and already-applied jobs |
| `score` | Rules + Haiku fit rubric | Priority tier, fit score, hard filters, scam flags |
| `tailor` | `claude -p` — `claude-sonnet-5-5` + validator | Per-job CV plan + cover letter, checked against the master profile |
| `render` | Handlebars HTML templates → Puppeteer PDF | ATS-friendly CV and cover-letter PDFs |
| `apply` | Gmail API (`gmail.compose`) | Draft (default) or send email applications; build form-job packages |
| `sync:gmail` | Gmail API | Detect sent drafts → `applied`; detect replies → `has_reply` |
| `dashboard` | Fastify + single-file HTML (`dashboard/index.html`) | Tracker UI, status updates, file downloads |
| Storage | SQLite (better-sqlite3), WAL mode | Single source of truth |

---

## 3. Key Decisions

### D1 — One language: TypeScript on Node 22
- **Alternatives:** Python for everything except a Node WhatsApp sidecar; Go.
- **Why:** whatsapp-web.js is Node-only, and it already ships Puppeteer/Chromium — the same browser renders the CV PDFs for free. One language means one container, one dependency tree, one test runner. The Anthropic SDK, the Gmail API client, SQLite and Fastify are all first-class in Node.
- **Production would add:** separate services per stage connected by a queue (SQS), so one source failing never blocks the others.

### D2 — SQLite as the single source of truth
- **Alternatives:** PostgreSQL; Google Sheets; JSON files.
- **Why:** one user, one writer, a few thousand rows a year. SQLite is zero-ops, transactional (needed for watermarks + dedupe), and trivially backed up (one file). Sheets would be nice on the phone but has no transactions and is slow for dedupe lookups.
- **Production would add:** Postgres (RDS) with migrations in CI and point-in-time recovery. Optional later: a one-way sync to a Google Sheet for phone viewing.

### D3 — WhatsApp via whatsapp-web.js, read-only, on Ahmed's established business number
- **Alternatives:** official WhatsApp Cloud API (cannot read groups you join — its Groups API only covers groups the business creates); Baileys (lighter, but reimplements the protocol and is easier to fingerprint); manual chat export (safest, not automatic).
- **Why:** whatsapp-web.js drives the real WhatsApp Web, so it looks like a normal linked browser. It runs once a day, reads, and exits — the same footprint as opening WhatsApp Web each morning.
- **Rules:** never call `sendMessage`, `sendSeen`, `react`, `join*`, `setStatus`, or anything that writes. Use `LocalAuth` so the session persists (no daily QR). Pin the library version and the WhatsApp Web version (`webVersionCache`) — check the current whatsapp-web.js docs for the exact option shape when implementing.
- **Fallback:** a `collect:whatsapp-export` command that parses an exported chat `.txt`, so the pipeline keeps working if the library breaks after a WhatsApp Web update.

### D4 — LinkedIn and job boards through email alerts, not scraping
- **Alternatives:** scraping LinkedIn with Ahmed's session (violates LinkedIn's terms; it puts his main professional account at risk); paid job APIs (cost, weak Egypt coverage).
- **Why:** LinkedIn, Wuzzuf, Bayt and Indeed all send saved-search alert emails. A Gmail filter puts them under one label, and the agent reads that label. Zero account risk, no scraping, fully automatic.
- **Detail fetch:** for LinkedIn alert jobs, optionally fetch the **public, logged-out** job page (`/jobs/view/<id>`) at most 1 request / 5 s with no cookies. If it's blocked, continue with the alert's data and mark the job `low_detail`.
- **Generic parsing:** don't write one brittle HTML parser per site. Convert each alert email to text and let `extract` pull out the job list. Add a dedicated LinkedIn parser only if LLM extraction proves unreliable.

### D5 — Company websites through public ATS feeds
- **Alternatives:** scrape every careers page's HTML; manual checks.
- **Why:** most companies host careers on an applicant tracking system (ATS) with a public JSON feed. That's stable, legal and cheap:
  - Greenhouse `https://boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true`
  - Lever `https://api.lever.co/v0/postings/{company}?mode=json`
  - Ashby `https://api.ashbyhq.com/posting-api/job-board/{name}`
  - SmartRecruiters `https://api.smartrecruiters.com/v1/companies/{id}/postings`
  - Workable: public account widget/jobs endpoint
  - **Verify each endpoint's current shape at implementation time.**
- Careers pages without an ATS feed use type `html`: fetch the page, hash the main content, and run `extract` only when the hash changes.
- Add an `ats:detect <careers-url>` helper that recognises the ATS from the URL/HTML and prints the `companies.yaml` entry.

### D6 — Headless Claude Code (`claude -p`) on Ahmed's subscription, two model tiers
*Revised 2026-11-20 (decision D17 in `docs/decisions.md`): Ahmed is on the Pro plan with no API credits.*
- **Alternatives:** the Anthropic API with an API key (the original choice; needs paid API credits); the Agent SDK (same subscription auth, but a second runtime dependency); a local model (weak on structured extraction and CV writing).
- **Why:** `claude -p` draws from the Pro subscription. Each call is `claude -p --model <id> --output-format json --json-schema <schema> --tools ""` with the job post in a delimited block; the CLI returns the result in `structured_output`, and the code validates it again with zod. `--tools ""` means an injected instruction in a job post has nothing to run. Extraction and scoring → `claude-haiku-5-5`; CV and cover letters → `claude-sonnet-5-5`.
- **Auth guard:** never set `ANTHROPIC_API_KEY` on the machine (in `-p` mode an API key always wins over the subscription). Never use `--bare` (it never reads OAuth). Every run starts with a preflight call; if its `init` event's `apiKeySource` is anything but `none`, or the call fails, the run stops with a failure digest. The CLI version is pinned in the image.
- **Usage limits, no caps (R18):** Pro has a 5-hour session limit and a weekly limit shared with Ahmed's interactive use. Ahmed chose no per-run caps: the run processes everything until the CLI reports the usage limit. Then the run stops calling the model, finishes as `partial`, keeps the unprocessed items `new` (their watermarks don't advance), and the digest says how many are left. The next run continues. Token usage per call is recorded in `llm_calls`.
- Model IDs live in config, never hardcoded.

### D7 — CV rendering: HTML template → PDF with Puppeteer
- **Alternatives:** DOCX via a docx library (editable, but layout is fiddly); LaTeX/Typst (beautiful, extra toolchain).
- **Why:** Chromium is already in the image. HTML/CSS gives full layout control, and the output is a real-text, single-column PDF that ATS parsers read well. Also emit a `.md` copy of each CV for quick review in the dashboard.
- **Production would add:** a DOCX export, since some recruiters ask for Word.

### D8 — Gmail drafts by default, sending optional
- **Alternatives:** always auto-send; always manual.
- **Why:** Ahmed wants the applications done. Drafts give him finished applications that take ~30 seconds each to check and send, and they protect him from the agent's worst failures: a wrong recipient pulled from a messy post, a role he'd never want, or a CV detail he'd want to fix. `apply.mode: send` is one config line and enforces `auto_send_min_score` and `daily_send_cap`. **Recommended:** run in `draft` mode for the first 2 weeks, then turn on `send` for priority-1 jobs above the score threshold once the outputs have earned trust.

### D9 — Daily run: started manually; Docker; systemd timer optional
*Revised 2026-11-20: Ahmed runs the agent himself once a day (`agent run`, or `docker compose run --rm agent run`). The timer below stays available but is not installed by default.*
- **Alternatives:** cron; Windows Task Scheduler; ECS scheduled task / Lambda; GitHub Actions cron.
- **Why:** a systemd timer with `Persistent=true` catches up after the machine was off (cron can't). Docker pins Chromium and Node. ECS/Lambda would need the WhatsApp session on EFS, and Chromium on Lambda is painful. GitHub Actions has no persistent session. The same container runs on the laptop (Linux or WSL2), a VPS, or a `t4g.small` EC2 instance.
- **Windows alternative:** a Task Scheduler task running `docker compose run --rm agent run` (document it in the README).

### D10 — Dashboard: Fastify API + one static HTML file
- **Alternatives:** Next.js/React app; Streamlit; Grafana on SQLite; Google Sheets.
- **Why:** it's a tracker for one person. A static `dashboard/index.html` (already written — see section 10) served by the same codebase has no build step. It binds to `127.0.0.1` only.

---

## 4. Data Model

Migrations live in `src/db/migrations/*.sql` and run on startup. Enable `PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;`.

```sql
-- one row per collected raw item (WhatsApp message, alert email, ATS posting)
CREATE TABLE raw_items (
  id            INTEGER PRIMARY KEY,
  source        TEXT NOT NULL,          -- whatsapp | alert_email | ats | html | whatsapp_export
  source_ref    TEXT NOT NULL,          -- wa msg id_serialized | gmail msg id | ats job id | url
  source_name   TEXT,                   -- group name | sender | company
  author        TEXT,                   -- WA sender (stored hashed — see 12)
  posted_at     TEXT NOT NULL,          -- ISO-8601 UTC
  collected_at  TEXT NOT NULL,
  text          TEXT,
  media_path    TEXT,                   -- data/media/<sha>.jpg|pdf
  content_hash  TEXT NOT NULL,          -- sha256 of normalized text (+ media sha)
  simhash       TEXT,                   -- 64-bit simhash for near-duplicate detection
  run_id        INTEGER REFERENCES runs(id),
  UNIQUE (source, source_ref)
);

-- one row per job (a raw item can yield several)
CREATE TABLE jobs (
  id              INTEGER PRIMARY KEY,
  raw_item_id     INTEGER NOT NULL REFERENCES raw_items(id),
  title           TEXT NOT NULL,
  title_norm      TEXT NOT NULL,
  company         TEXT,                 -- may be null ("a leading company")
  company_norm    TEXT,
  location        TEXT,
  work_mode       TEXT,                 -- onsite | hybrid | remote | unknown
  seniority       TEXT,                 -- intern | junior | mid | senior | lead | unknown
  years_min       INTEGER,
  requirements    TEXT,                 -- JSON array
  nice_to_have    TEXT,                 -- JSON array
  apply_channel   TEXT NOT NULL,        -- email | form | whatsapp_dm | unknown
  apply_email     TEXT,
  apply_url       TEXT,                 -- canonicalized (utm/tracking stripped)
  subject_hint    TEXT,                 -- "use subject: DevOps – REF123"
  deadline        TEXT,
  language        TEXT,                 -- en | ar | mixed
  fingerprint     TEXT NOT NULL,        -- see 7 (L3)
  duplicate_of    INTEGER REFERENCES jobs(id),
  priority        INTEGER,              -- 1 | 2 | 3 (see 6)
  fit_score       INTEGER,              -- 0..100
  fit_reasons     TEXT,                 -- JSON {matched:[], missing:[], summary:""}
  flags           TEXT,                 -- JSON array: suspicious, low_detail, same_recruiter, over_experience, ...
  status          TEXT NOT NULL DEFAULT 'new',
      -- new | skipped | needs_review | ready | applied | interview | offer | rejected
  skip_reason     TEXT,
  has_reply       INTEGER NOT NULL DEFAULT 0,
  notes           TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX jobs_fingerprint ON jobs(fingerprint);
CREATE INDEX jobs_status ON jobs(status);

CREATE TABLE applications (
  id               INTEGER PRIMARY KEY,
  job_id           INTEGER NOT NULL UNIQUE REFERENCES jobs(id),
  channel          TEXT NOT NULL,       -- email | form | whatsapp_dm
  to_email         TEXT,
  subject          TEXT,
  body             TEXT,
  cv_pdf           TEXT,                -- output/<date>/<job_id>/...pdf
  cv_md            TEXT,
  cover_pdf        TEXT,
  cover_text       TEXT,
  ats_report       TEXT,                -- JSON from the ATS check (8.6): score, missing keywords, failures
  why_this_role    TEXT,                -- one-line answer to reuse in interviews
  gmail_draft_id   TEXT,
  gmail_thread_id  TEXT,
  gmail_message_id TEXT,
  mode             TEXT NOT NULL,       -- draft | send | package
  created_at       TEXT NOT NULL,
  sent_at          TEXT                 -- set by sync:gmail or send mode
);

CREATE TABLE source_state (            -- per-source watermark (R1/R2)
  source          TEXT PRIMARY KEY,     -- whatsapp:<group-id> | alerts | ats:<company>
  last_success_at TEXT NOT NULL
);

CREATE TABLE runs (
  id INTEGER PRIMARY KEY, started_at TEXT, finished_at TEXT,
  status TEXT,                          -- running | success | partial | failed
  mode TEXT,                            -- live | dry_run
  stats TEXT,                           -- JSON counts per stage + tokens
  error TEXT
);

CREATE TABLE llm_calls (
  id INTEGER PRIMARY KEY, run_id INTEGER, job_id INTEGER, purpose TEXT,
  model TEXT, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER,
  ok INTEGER, created_at TEXT
);

CREATE TABLE status_history (
  id INTEGER PRIMARY KEY, job_id INTEGER REFERENCES jobs(id),
  from_status TEXT, to_status TEXT, by TEXT, at TEXT   -- by: agent | sync | ahmed
);
```

---

## 5. Pipeline Stages

`agent run` executes the stages in order inside one run record. Each stage is a pure-ish function over the DB, so `agent reprocess <job_id> --from=tailor` can rerun any stage for one job.

### 5.1 Collect (R1, R2, R3, R12)

**Window per source:** `since = source_state.last_success_at - 15 min overlap` or, when no row exists, `now - first_run_lookback_hours (24)`. `until = run start`. The overlap is free because dedupe L0 drops anything already seen. A source's watermark is advanced **only after its items are committed and processed**, so a crashed run is retried on the next run instead of being lost. A `--since 2026-11-19T06:00Z` flag overrides the window.

**WhatsApp (`collect:whatsapp`)**
1. Start the client with `LocalAuth({ dataPath: 'data/wa-session' })`. Wait for `ready`, then a short settle delay so history sync completes (configurable, default 20 s).
2. `getChats()` → keep `isGroup` chats whose name or id is in `whatsapp.groups` (the allowlist; `agent wa:groups` prints all groups with ids so Ahmed can choose).
3. For each group: `chat.fetchMessages({ limit: whatsapp.fetch_limit (500) })` → keep `timestamp` within the window. If the oldest fetched message is still inside the window, log a warning (the limit was too small).
4. Keep text and captions only. Media (images, PDFs, stickers, audio, video) is never downloaded: flyers are out of scope (R3), and not handling files removes a whole class of parser and storage risk. A message with no text is dropped.
5. Pre-filter cheaply before any LLM call: drop messages under 40 characters that have no email/URL (greetings, "thanks", "interested").
6. `client.destroy()` in a `finally` block. Never log out (that would force a new QR).

**Alert emails (`collect:alerts`)**
- Gmail query: `label:job-alerts after:<epoch(since)>`. For each message: HTML → text (keep link targets), store as a raw item, `source_ref = message id`.
- The Gmail filter is set up by Ahmed once (section 16) — e.g. from `jobalerts-noreply@linkedin.com` plus the Wuzzuf/Bayt/Indeed alert senders → apply label `job-alerts`, skip inbox.

**ATS (`collect:ats`)**
- For each entry in `companies.yaml`: fetch the feed, keep postings whose `updated_at`/`created_at` is in the window (or not seen before when the feed has no dates), with a pre-filter on title keywords from section 6 so 500-job boards don't hit the LLM.
- Polite: 1 request/second, a `User-Agent` naming the tool, honor `Retry-After`.

### 5.2 Normalize & split
- Normalize text: Unicode NFKC, strip emoji and decorative symbols, collapse whitespace, lowercase a copy for hashing, keep the original for the LLM.
- Compute `content_hash` (normalized text + media sha) and `simhash`.
- Run **dedupe L1/L2 here, before extraction** — most WhatsApp duplicates are forwards, and catching them before the LLM saves tokens.

### 5.3 Extract (Haiku, tool use)
Input: the original text (text posts only, R3). Output schema (array — one post may list several roles):

```json
{ "is_job_post": true,
  "jobs": [{
    "title": "", "company": null, "location": null, "work_mode": "onsite|hybrid|remote|unknown",
    "seniority": "intern|junior|mid|senior|lead|unknown", "years_min": null,
    "requirements": [], "nice_to_have": [],
    "apply_channel": "email|form|whatsapp_dm|unknown",
    "apply_email": null, "apply_url": null, "subject_hint": null,
    "deadline": null, "language": "en|ar|mixed",
    "eligibility": [], "scam_signals": [] }] }
```

Post-validation (code, not the model):
- `apply_email` must appear **literally** in the source text or image text the model returned, and pass an email regex. Otherwise set it to null and add the flag `email_unverified`.
- Canonicalize `apply_url` (strip `utm_*`, `trk`, `refId`, fragments; resolve known shorteners with a HEAD request).
- `is_job_post: false` → the raw item is kept, and no job is created.

### 5.4 Dedupe — section 7

### 5.5 Score (R4, R5)
1. **Priority tier** from the title — section 6.
2. **Hard filters → `skipped`** with a `skip_reason`: `years_min > profile.max_years_required (3)`; seniority `senior|lead` (unless years_min ≤ 3); location not in `filters.locations` and not remote; deadline passed; an eligibility requirement he doesn't meet (e.g. a language he doesn't speak, military-status or gender restrictions, a specific degree); title on the exclusion list (sales, marketing, accountant…).
3. **Fit score (Haiku, rubric, tool output):** 0–100 from must-have coverage by **profile evidence** (each matched requirement must cite a skill/project id from the master profile), plus nice-to-haves, seniority fit and domain fit. Returns `matched`, `missing`, a one-line `summary`.
4. **Decision:**
   - P1 → tailor if `fit ≥ 45`
   - P2 → tailor if `fit ≥ 60`
   - P3 → tailor if `fit ≥ 75`
   - otherwise `skipped` (`low_fit`). Thresholds live in config.
5. **Scam / safety flags → `needs_review`, never auto-applied:** asks for any fee/deposit/training payment; asks for national ID, bank details or a photo up front; "earn $X/day" or crypto/forex/"investment"; Telegram-only contact; a salary far above market with no company named; a free-mail address plus no company plus vague duties.
6. Order the tailor queue by `priority ASC, fit_score DESC` so the best matches are done first if the usage limit is hit. Optional caps (`llm.max_jobs_per_run`, `llm.max_tailor_per_run`) default to `null` = no cap (R18); jobs not reached stay `new` and are picked up next run.

### 5.6 Tailor & render — section 8
### 5.7 Apply — section 9

### 5.8 Sync & digest
- `sync:gmail` (every run, before collect): for each application with a `gmail_draft_id` and no `sent_at`, check whether the draft still exists and whether its thread now has a `SENT` message → set `sent_at` and status `applied`. For applied threads, detect a newer message not from Ahmed → `has_reply = 1` (shown as a badge; status changes stay manual).
- **Digest email** to Ahmed at the end of every run, subject `Job agent — 9 ready, 3 need review (2026-11-21)`:
  - drafts ready, with title · company · score · a link to Gmail drafts
  - form packages, with apply links
  - needs-review items, with reasons
  - skipped counts by reason
  - run health (sources OK / failed, tokens used)
- If a run **fails**, still send a short failure digest with the error.

---

## 6. Title Matching & Priority

Match on `title_norm` (lowercase, punctuation stripped, Arabic titles translated by `extract`). Implement as data in `config/titles.yaml` with regex lists so Ahmed can edit it without touching code.

| Tier | Meaning | Patterns (regex, case-insensitive) |
|---|---|---|
| **P1** | Ahmed's priority titles | `devops`, `dev ops`, `cloud (engineer\|devops\|operations\|support engineer)`, `\bit engineer\b`, `infrastructure engineer`, `infra engineer`, `technical support`, `tech support`, `application support`, `app(lication)? support`, `production support`, `platform engineer`, `monitoring`, `observability` |
| **P2** | Adjacent roles he's qualified for | `\bsre\b`, `site reliability`, `system(s)? (administrator\|admin\|engineer)`, `sysadmin`, `linux (admin\|engineer)`, `noc`, `network (engineer\|operations\|back.?office)`, `techops`, `cloud operations`, `build (and\|&) release`, `release engineer`, `ci/?cd`, `automation engineer`, `hpc`, `data ?cent(er\|re) engineer`, `integration engineer`, `it (support\|specialist\|administrator)`, `helpdesk`, `service desk` |
| **P3** | Anything else | only if fit ≥ 75 |
| **Exclude** | Never | `sales`, `marketing`, `account manager`, `accountant`, `recruiter`, `teacher\|instructor`, `designer`, `(senior\|sr\.?\|lead\|principal\|staff\|head\|manager\|director)` *(unless `years_min ≤ 3` or the post says junior/entry)* |

**Angle per job** (picks which profile summary and project order to start from): `devops` (DevOps, Cloud, Platform, Infrastructure, SRE, CI/CD), `support` (Technical/Application/Production Support, IT, Helpdesk, TechOps), `monitoring` (Monitoring, Observability, NOC), `networking` (Network*, Back-office), `systems` (SysAdmin, Linux, HPC, Data center).

---

## 7. Deduplication

The WhatsApp groups re-forward the same post many times, and the same job shows up on WhatsApp, LinkedIn and the company site. Five layers, cheapest first:

| Layer | Catches | How | Where |
|---|---|---|---|
| **L0 — source id** | Same message seen twice (run overlap) | `UNIQUE(source, source_ref)` | collect |
| **L1 — exact content** | Forwards across groups | `content_hash` seen in the last 60 days | normalize, before the LLM |
| **L2 — near-duplicate** | Reposts with small edits, an added emoji, a new line | simhash Hamming distance ≤ 10 (candidate filter, D16), then confirm with a token-set similarity ≥ 0.90 against the last 30 days | normalize, before the LLM |
| **L3 — job fingerprint** | The same job from different sources/wording | `sha256(company_norm \| title_norm_canonical \| apply_target)` where `apply_target` = lowercase email or canonical URL; if company is null, use `apply_target \| title`. Plus fuzzy: same `apply_target` and title similarity ≥ 0.85 within 60 days | after extract |
| **L4 — application guard** | Re-applying, including to jobs Ahmed applied to **by hand** before the agent existed | (a) an `applications` row exists for the same `to_email` + similar title within `dedupe.cooldown_days (60)`; (b) **Gmail Sent check:** `in:sent to:<email> newer_than:60d` returns a message | right before apply |

- A duplicate is still stored as a job with `duplicate_of` set and status `skipped` (`duplicate`), so the dashboard can show "seen in 4 groups".
- **Same recruiter, many roles:** if `to_email` already received an application from the agent in the last 14 days for a **different** role → flag `same_recruiter` and set `needs_review` instead of sending a second email. The dashboard shows both roles, so Ahmed can decide to send one combined email.
- Title canonicalization for L3: lowercase, remove seniority words, map synonyms (`sre` → `site reliability engineer`, `sysadmin` → `system administrator`, `dev ops` → `devops`).

---

## 8. CV & Cover Letter Tailoring

### 8.1 The master profile is the only source of truth
`profile/master_profile.yaml` (drafted from Ahmed's history — **he must review it, section 16**) holds every fact: contact info, education, certifications, a `not_held` list, experience, projects (each bullet with an `id`, `tags` and `status: done|in_progress`), skills (each with `id`, category, level, evidence project ids), troubleshooting stories, and per-angle summaries.

**Hard rules (enforced in code, not just in the prompt):**
1. The model **selects and rephrases**; it never adds facts. Its output references skill ids and bullet ids, and code assembles the final CV text from the profile.
2. Rephrased bullets may change wording only. A **validator** checks each rephrased bullet against its source bullet:
   - every number in the rephrase appears in the source
   - every technology term in the rephrase (matched against the profile's skill vocabulary + a tech-term list) appears in the source
   - nothing from `not_held` appears anywhere in the CV or cover letter (e.g. RHCSA, CCNA certification, OpenShift certification)
3. Bullets with `status: in_progress` may appear only phrased as in progress (the validator checks for "in progress"/"ongoing").
4. If validation fails → retry once with the validator errors fed back → if it fails again, fall back to the untouched source bullets. Never ship an unvalidated CV.

### 8.2 Tailor call (Sonnet, one call per job, tool output)
Input: the job JSON, `angle`, `fit_reasons`, and the master profile (cached system block). Output:

```json
{ "headline": "Cloud & DevOps Engineer",
  "summary": "≤ 60 words, built from the angle summary + the job's top 3 requirements",
  "skills": ["skill_id", "..."],                       // 12–18 ids, most relevant first, grouped by category in render
  "projects": [{ "id": "nexora", "bullets": [{ "id": "nexora_gitops", "text": "optional rephrase" }] }],  // 3–4 projects, 2–4 bullets each
  "experience": [{ "id": "ivolve", "bullets": [ ... ] }],
  "include_courses": ["hcia_datacom"],
  "cover_letter": { "greeting": "", "paragraphs": ["", "", ""], "closing": "" },
  "email": { "subject": "", "body": "" },
  "why_this_role": "one sentence linking this role to concrete work he has done" }
```

### 8.3 CV rules
- **Exactly one page** (R14). After rendering, count the PDF pages (`cv.max_pages: 1`); if > 1, drop the lowest-ranked bullet (then the lowest-ranked project) and re-render, up to `cv.max_trim_rounds`. If the page is less than `cv.min_fill` full (measured from the last text line's position), add the next-ranked bullet. A CV that still isn't one page is never applied: the job goes to `needs_review`.
- ATS-friendly: single column; standard headings (Summary, Skills, Experience, Projects, Education, Certifications); no tables, icons, photos or text in images; real text; 10.5–11 pt body; links written out (GitHub, LinkedIn).
- Mirror the job's exact keywords **only where the profile backs them** (e.g. the post says "CI/CD pipelines" and the profile has Jenkins/GitHub Actions → use "CI/CD pipelines (Jenkins, GitHub Actions)").
- Networking-angle jobs follow Ahmed's one-page networking CV shape (Nexora, Linux System Administration Lab, CI/CD Pipeline Engineering, Packet Tracer network design, plus HCIA-Datacom and the CCNA curriculum **as studied, not certified**).
- File names: `{First}_{Last}_CV_{Company}_{Role}.pdf`, `{First}_{Last}_Cover_Letter_{Company}_{Role}.pdf` (sanitized, ≤ 80 chars), under `output/<YYYY-MM-DD>/<job_id>/`.

### 8.4 Cover letter rules
- 180–250 words, 3 paragraphs: (1) the role + where he saw it + a one-line pitch; (2) two of the job's specific requirements, each mapped to a concrete piece of evidence (project + tech + result); (3) why this company/role + call to action.
- No clichés ("I am writing to express my interest", "team player", "passionate about technology"). No generic filler.
- **Never** use "I'm at the start of my career and want to learn" as the reason (a known weak point in Ahmed's interviews). For non-DevOps roles, give a concrete reason: e.g. for support, the troubleshooting he already does daily (the OIDC JWT diagnosis, the NTP clock-skew AuthFailure); for monitoring, the Prometheus/Grafana/Loki work and the canary gating on metrics in Nexora.
- If the company is unknown ("a leading company"), address "Dear Hiring Team" and reference the role and requirements only — don't guess a company name.
- English by default. If the post is in Arabic, still write the CV/letter in English (the Egyptian tech norm); make this configurable.

### 8.6 ATS check (R15)
Ahmed's rule: run the CV through an ATS check before applying to any form job, and to any email job whose mail goes into an ATS. Whether an HR inbox forwards into an ATS can't be detected reliably, so **the agent runs the check on every application** and blocks on failure. It's local, deterministic and free.

The check reads the rendered PDF the way a parser does:
1. **Text layer:** `pdftotext` extracts all text; `pdfimages -list` finds no images; `pdffonts` shows every font embedded.
2. **Structure:** every standard heading (Summary, Skills, Experience, Projects, Education, Certifications) is present, in order, as plain text lines.
3. **Contact parse:** email, both phones, LinkedIn and GitHub URLs are found by regex in the extracted text.
4. **Single column:** extracted reading order matches the template's order (no interleaved lines).
5. **Pages:** `pdfinfo` reports exactly 1 page.
6. **Keyword coverage:** the job's requirements that the profile backs (from `fit_reasons.matched`) appear in the CV text. Coverage below `ats_check.min_keyword_coverage` sends the job back to tailoring once with the missing keywords; requirements the profile doesn't back are reported as gaps, never added.

The result (score, missing keywords, failures) is stored in `applications.ats_report` and shown on the dashboard. On failure after one retry → `needs_review`.

### 8.5 Email rules
- Subject: use `subject_hint` **exactly** when the post specifies one (many Egyptian posts do: "send with the subject: DevOps Engineer"). Otherwise `Application – {Role} – {First} {Last}`.
- Body: 3–5 short lines, attachments named in the text. Signature with phone, LinkedIn, GitHub.

---

## 9. Applying

| Channel | What the agent does | Status after |
|---|---|---|
| `email` | Builds a MIME multipart message (text body + CV PDF + cover-letter PDF), then `users.drafts.create` (mode `draft`) or `users.messages.send` (mode `send`, only when `fit ≥ auto_send_min_score`, priority ≤ `auto_send_max_priority`, no flags, and under `daily_send_cap`) | `ready` (draft) / `applied` (sent) |
| `form` | Builds a package: PDFs, the apply URL, the cover letter as plain text (for paste boxes), draft answers to the common screening questions (years with X, notice period, expected salary, work authorization), filled from `profile.application_answers` | `ready` |
| `whatsapp_dm` | Package only (the agent never sends WhatsApp messages); the dashboard shows the number/link to contact | `ready` |
| `unknown` | — | `needs_review` |

- **Rate limiting** in send mode: ≥ 60 s between sends, `daily_send_cap` default 15.
- **Dry run** (`--dry-run`): everything up to rendering PDFs; no Gmail writes; the digest is printed to stdout.
- **L4 guard** (section 7) and the **ATS check** (8.6) run immediately before every draft, send or package. Each application gets its own freshly drafted cover letter (R16).

---

## 10. Tracker Dashboard & API

`dashboard/index.html` is already written. It calls the API below and falls back to built-in sample data when the API isn't reachable (so it can be previewed by just opening the file). Serve it with `@fastify/static` at `/` and bind to `127.0.0.1:${DASHBOARD_PORT:-8080}`.

| Method | Path | Returns / does |
|---|---|---|
| `GET` | `/api/jobs?status=&source=&priority=&q=&include_duplicates=` | `{ jobs: Job[] }`, newest first |
| `GET` | `/api/stats` | `{ last_run: { status, started_at, finished_at, error }, stale_run_hours, counts: { by_status: {...} }, applied_per_day: [{date, count}] (last 14 days, zero-filled) }` |
| `PATCH` | `/api/jobs/:id` | body `{ status?, notes? }` → writes `status_history` (by = `ahmed`) |
| `GET` | `/files/:job_id/:kind` | `kind` = `cv` \| `cover` \| `cv_md` — streams the file; path resolved from the DB, never from user input |
| `POST` | `/api/jobs/:id/regenerate` | re-runs tailor+render for one job (optional, Phase 8+) |

`Job` JSON shape the dashboard expects:

```json
{ "id": 42, "title": "DevOps Engineer", "company": "Acme", "location": "Cairo", "work_mode": "hybrid",
  "source": "whatsapp", "source_name": "Egypt DevOps Jobs", "seen_count": 3,
  "posted_at": "2026-11-20T07:12:00Z", "priority": 1, "fit_score": 82,
  "apply_channel": "email", "apply_email": "hr@acme.com", "apply_url": null,
  "status": "ready", "flags": ["same_recruiter"], "skip_reason": null, "has_reply": false,
  "gmail_draft_url": "https://mail.google.com/mail/u/0/#drafts?compose=<id>",
  "files": { "cv": "/files/42/cv", "cover": "/files/42/cover" },
  "fit_summary": "Strong on EKS, Terraform, ArgoCD; missing Azure.",
  "notes": "" }
```

---

## 11. Scheduling & Deployment

- **Image:** `node:22-bookworm-slim` + Chromium system deps (or `ghcr.io/puppeteer/puppeteer` pinned by digest), run as a **non-root user**, `tini` as init, `HEALTHCHECK` for the dashboard service. Pin every npm dependency (lockfile, `npm ci`).
- **docker-compose.yml:** two services from the same image:
  - `agent` — one-shot (`command: run`), volumes `./data`, `./output`, `./secrets:ro`, `./profile:ro`, `./config:ro`
  - `dashboard` — `restart: unless-stopped`, `ports: ["127.0.0.1:8080:8080"]`, the same volumes (read-write `./data` for status edits)
- **systemd** (`deploy/systemd/job-agent.service` + `job-agent.timer`):
  ```ini
  # job-agent.timer
  [Timer]
  OnCalendar=*-*-* 08:00:00
  Persistent=true
  RandomizedDelaySec=10min
  [Install]
  WantedBy=timers.target
  ```
  The service runs `docker compose -f /opt/job-agent/docker-compose.yml run --rm agent run` with `TimeoutStartSec=45min`. Set the host timezone to `Africa/Cairo`. **08:00** gives Ahmed drafts to review in the morning, while posts are still fresh.
- **Overlap lock:** the agent takes an exclusive lock file (`data/run.lock`); a second concurrent run exits immediately.
- **WhatsApp linked-device expiry:** linked devices are logged out after ~14 days offline. The dashboard turns the "last run" tile red after 36 h without a successful run, and the digest warns at 7 days.
- **Backups:** `scripts/backup.sh` copies `data/agent.db` (using `sqlite3 .backup`) to `backups/` daily, keeping 14 copies.
- **Optional AWS deployment (portfolio angle):** Terraform modules (`network`, `instance`) for a `t4g.small` EC2 instance in a public subnet with **no inbound rules** (SSM Session Manager for access, the dashboard reached via an SSM port-forward), an encrypted gp3 volume, and IAM limited to SSM. Follow Ahmed's Terraform standards (terraform skill, modular, S3 native locking). Do this **after** the local version works.

---

## 12. Security, Privacy & Safety

> The full threat model, every control with its status, and the host checklist are in **`docs/security.md`** (R19). The points below are the original summary.

- **Secrets:** `.env` (Anthropic key) and `secrets/` (Gmail OAuth client + token) are gitignored and mounted read-only. **`data/wa-session/` is equivalent to a logged-in WhatsApp** — gitignored, `chmod 700`, never copied into images.
- **The repo can be public; the data can't:** `profile/master_profile.yaml` (phone, email), `data/`, `output/` and `config/config.yaml` are gitignored. Commit `*.example.yaml` versions with fake data.
- **Gmail scopes:** `gmail.readonly` + `gmail.compose` only. Set the OAuth consent screen to **"In production"** (unverified is fine for personal use) — apps left in "Testing" get refresh tokens that **expire after 7 days**, which would silently break the daily run.
- **Prompt injection:** job posts are untrusted text. They go in a clearly delimited `<job_post>` block, with system instructions saying it's data. The model's output is schema-validated, recipients must appear literally in the source (5.3), and the model can never choose files, paths or extra recipients.
- **WhatsApp read-only enforcement:** wrap the client in a `ReadOnlyWhatsApp` facade exposing only `getChats`, `fetchMessages`, `destroy` (no media download, R3). A unit test fails if any `send*`/`react`/`join*`/`sendSeen`/`setStatus` call appears in `src/` (grep test).
- **Third-party privacy:** other group members' phone numbers are stored only as salted hashes (`author`), enough to count "same poster" and nothing more. No media is stored.
- **Dashboard:** bound to localhost only. If it's ever exposed, put it behind a reverse proxy with auth — never open the port.

---

## 13. Best Practices Baked In

These go beyond the brief; each one prevents a specific failure:

1. **Truth-checked CVs** (8.1) — one invented certification in an application can end a candidacy. The `not_held` list exists because exactly this kind of mix-up has happened before.
2. **Drafts first, sending later** (D8) — earn trust in the outputs before removing the human check.
3. **Gmail Sent check** (L4) — protects against re-applying to companies Ahmed contacted manually.
4. **Text only, on purpose** — image flyers are out of scope (Ahmed's call, 2026-11-20): most jobs he applies to are text posts, and skipping media removes file parsing and storage from the attack surface.
5. **Multi-job posts are split** — "We're hiring DevOps, QA and Frontend" becomes three jobs; only the relevant one gets an application.
6. **Required subjects honored** — ignoring "use subject X" gets applications auto-filtered by HR.
7. **Scam filter** — job groups always carry some fee-based "training" and fake-job posts; they never get an application.
8. **Early applying** — the 08:00 run plus priority ordering means the best matches are ready first.
9. **A "why this role" line per application** — saved in the tracker so Ahmed has a concrete answer ready if the company calls.
10. **Observability for the agent itself** — the `runs` table, structured JSON logs (pino), the last-run tile, failure digests, and token counts. Optional: export Prometheus metrics (jobs found/applied, run duration, LLM tokens) — a nice talking point for the monitoring roles he's applying to.
11. **Idempotent and restartable** — watermarks advance only on success, every stage can be rerun per job, and dedupe makes overlap harmless.
12. **Follow-up nudges (optional, Phase 10+)** — applied 7 days ago, no reply → the dashboard shows "follow up", with a short drafted follow-up email.

---

## 14. Build Phases & Gates

Logic first, accounts last: phases 1–3 run entirely on fixtures, so WhatsApp and Gmail are touched only once the pipeline is proven. That also means fewer WhatsApp logins while debugging.

| Phase | Build | Gate (must pass before moving on) |
|---|---|---|
| **P0 — Skeleton** | Repo layout (section 17), TypeScript strict, ESLint + Prettier, Vitest, `zod`-validated config loader, SQLite + migrations, `commander` CLI (`run`, `wa:login`, `wa:groups`, `gmail:auth`, `reprocess`, `digest`, `ats:detect`), pino logging, `.gitignore`, `.env.example` | `npm run lint && npm run typecheck && npm test` green; `npx tsx src/cli.ts --help` lists the commands; migrations create every table |
| **P1 — Matching & dedupe** | `titles.yaml` + matcher, normalization, content hash, simhash, L0–L3 dedupe, 20+ fixtures in `test/fixtures/posts/` (section 15) | Unit tests: every fixture gets its expected tier; forwards/reposts are caught; distinct jobs from the same recruiter are **not** merged |
| **P2 — Extract & score** | Anthropic client wrapper (retries, timeouts, token logging, prompt caching), extraction + fit prompts in `prompts/`, post-validation (5.3), hard filters, scam flags | `agent run --dry-run --fixtures` reproduces the expected fields for the fixtures (title, channel, email, multi-job split, scam → needs_review, senior → skipped) |
| **P3 — Tailor & render** | Profile loader + schema, tailor prompt, validator (8.1), HTML templates, Puppeteer PDF, page-count trim, file naming | PDFs for 3 fixture jobs (DevOps, Support, Networking angles) look right and are **exactly one page**; a test that injects "RHCSA" or a fake number **fails** validation; the ATS check (8.6) passes on all 3 and **fails** on a deliberately broken PDF (image-only, two pages, missing heading) |
| **P4 — WhatsApp collector** | `ReadOnlyWhatsApp` facade, `wa:login` (QR in terminal), `wa:groups`, windowed fetch, media download, export-file fallback, grep test for write calls | Ahmed links the number once; `wa:groups` lists his groups; `agent run --dry-run --source whatsapp` collects the last 24 h from the allowlisted groups; the second run collects only new messages |
| **P5 — Gmail** | `gmail:auth` (desktop OAuth, loopback), alerts collector, Sent check, MIME builder, draft creation, `sync:gmail`, digest email | One real draft **addressed to Ahmed himself** with both PDFs attached, opened and checked in Gmail; the alerts collector parses a real LinkedIn alert into jobs |
| **P6 — ATS** | `companies.yaml`, Greenhouse/Lever/Ashby/SmartRecruiters/Workable adapters, `html` change-detector, `ats:detect` | Jobs fetched from 2 real boards; a second run with no changes creates 0 new jobs |
| **P7 — Orchestrator** | `agent run` end to end, per-source watermarks, the lock file, run records, caps, error isolation per source (one source failing → run `partial`, others continue) | **The first real run**: 24 h lookback, `draft` mode. Ahmed reviews every draft; the issues found are fixed before the next run. The second run picks up only new items |
| **P8 — Dashboard & API** | Fastify routes (section 10), static serving, status history, file streaming | The dashboard shows real jobs; a status change persists after reload; CV/cover links open; path traversal on `/files` is rejected (test) |
| **P9 — Container & (optional) timer** | Dockerfile (non-root, pinned, read-only rootfs, no capabilities, healthcheck), compose, `scripts/backup.sh`; systemd units and the Windows task documented as optional | `hadolint Dockerfile` clean; `trivy image` has no HIGH/CRITICAL findings that can be fixed; one manual `docker compose run --rm agent run` succeeds; container security settings verified with `docker inspect` |
| **P10 — Hardening & docs** | README (ivolve-GitOps structure, no screenshots index), `docs/decisions.md` (D1–D10 + any new ones), `docs/troubleshooting.md` (Symptom / Diagnosis / Fix for every real issue hit), GitHub Actions CI (lint → typecheck → test → build → trivy) with `actionlint` | The section 1 checklist re-checked item by item with pass/fail; CI green |

---

## 15. Testing Strategy

- **Fixtures** (`test/fixtures/posts/*.json` — raw text and/or an image plus the expected extraction):
  - an English DevOps post with an email
  - an Arabic post (and a mixed Arabic/English one)
  - a multi-job post
  - the same post forwarded 3× with emoji differences
  - the same job on WhatsApp and in a LinkedIn alert
  - a senior role needing 7 years
  - a fee-based "training + job" scam
  - a support role, a NOC role, a networking back-office role
  - a recruiter email posting two roles
  - a post with a required subject line
  - a form-only (URL) job
  - a non-job message ("anyone know a good course?")
  - an expired deadline
- **Unit:** title matcher, normalization, simhash, fingerprints, URL canonicalization, the email-in-source check, the validator (positive and negative), the page-count trim, MIME builder (attachments present, correct filenames).
- **LLM tests** are tagged `@llm` and run on demand (`npm run test:llm`) with a small budget; the default `npm test` uses recorded responses so CI never needs an API key.
- **Dry runs** before every live change.

---

## 16. What Ahmed Must Provide

1. **Review `profile/master_profile.yaml`** — fill in the `TODO` fields (surname, phone, email, iVolve internship bullets, Solutions Architect level, dates) and correct anything wrong. This file decides what every CV can say.
2. **WhatsApp:** the group names to allowlist (run `agent wa:groups` after linking), and one QR scan with the business number.
3. **Gmail:** a Google Cloud project → OAuth client (Desktop app) → `secrets/gmail_client.json`; the consent screen set to *In production*; a Gmail filter putting alert emails under the label `job-alerts`.
4. **Alerts:** saved searches with daily email alerts on LinkedIn (e.g. "DevOps Engineer — Egypt", "Cloud Engineer — Remote", "Technical Support — Cairo"), Wuzzuf and Bayt.
5. **Companies:** a list of target companies' careers URLs (run `agent ats:detect <url>` on each).
6. **Claude subscription token:** run `claude setup-token` once (one-year OAuth token) and put it in `.env` as `CLAUDE_CODE_OAUTH_TOKEN`. No `ANTHROPIC_API_KEY` anywhere.
7. **Preferences in `config/config.yaml`:** locations he will work in (Ismailia / Cairo / Remote / …), the max years required, `apply.mode`, the send caps, answers to common screening questions (notice period, expected salary range, military status if relevant).

---

## 17. Repo Layout

```
job-agent/
├── CLAUDE.md
├── PLAN.md
├── README.md                       # P10
├── docs/
│   ├── decisions.md
│   └── troubleshooting.md
├── config/
│   ├── config.example.yaml         # committed
│   ├── config.yaml                 # gitignored
│   ├── titles.yaml
│   └── companies.example.yaml
├── profile/
│   ├── master_profile.example.yaml # committed (fake data)
│   └── master_profile.yaml         # gitignored
├── prompts/
│   ├── extract.md
│   ├── score.md
│   └── tailor.md
├── templates/
│   ├── cv.hbs
│   ├── cover_letter.hbs
│   └── styles.css
├── dashboard/
│   └── index.html                  # provided
├── src/
│   ├── cli.ts
│   ├── config.ts
│   ├── db/ (index.ts, migrations/)
│   ├── collect/ (whatsapp.ts, whatsapp-export.ts, alerts.ts, ats/, html.ts)
│   ├── pipeline/ (normalize.ts, extract.ts, dedupe.ts, score.ts, tailor.ts, validate.ts, render.ts, apply.ts, digest.ts, sync.ts)
│   ├── llm/ (client.ts, schemas.ts)
│   ├── gmail/ (auth.ts, client.ts, mime.ts)
│   ├── server/ (index.ts, routes.ts)
│   └── util/ (hash.ts, simhash.ts, text.ts, url.ts, lock.ts, logger.ts)
├── test/ (unit/, fixtures/, llm/)
├── deploy/
│   ├── systemd/ (job-agent.service, job-agent.timer)
│   └── windows/ (register-task.ps1)
├── scripts/ (install-timer.sh, backup.sh)
├── Dockerfile
├── docker-compose.yml
├── .env.example
└── .github/workflows/ci.yml
```
