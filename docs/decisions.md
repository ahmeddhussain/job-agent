# Decisions

Each decision: **Choice → Alternatives → Why this one → What production would add**.
D1 to D10 come from `PLAN.md` section 3 (full reasoning there); new decisions are added below them.

---

| ID | Choice | Alternatives | Why | Production would add |
|---|---|---|---|---|
| D1 | TypeScript on Node 22, one codebase | Python + Node WhatsApp sidecar; Go | whatsapp-web.js is Node-only and already ships Chromium, which also renders the PDFs | Separate services per stage behind a queue (SQS) |
| D2 | SQLite (WAL) as the single source of truth | PostgreSQL; Google Sheets; JSON files | One user, one writer, transactional watermarks and dedupe, one-file backup | RDS PostgreSQL, migrations in CI, PITR |
| D3 | whatsapp-web.js, read-only facade, `LocalAuth` | WhatsApp Cloud API (cannot read joined groups); Baileys; manual export | Looks like a normal linked browser once a day; export parser as fallback | — |
| D4 | LinkedIn and job boards via alert emails in Gmail | Scraping LinkedIn with Ahmed's session; paid job APIs | No account risk, no scraping, fully automatic | — |
| D5 | Company sites via public ATS JSON feeds | Scraping every careers page | Stable, legal, cheap; `html` change-detector for the rest | — |
| D6 | Anthropic API: Haiku for extract/score, Sonnet for tailoring; tool use + JSON schemas; prompt caching | One model; `claude -p`; local model | Volume vs quality split; schema-validated output | Per-run budget alerts |
| D7 | HTML template → PDF with Puppeteer | DOCX library; LaTeX/Typst | Chromium already in the image; single-column real-text PDF for ATS | DOCX export |
| D8 | Gmail drafts by default; `send` mode guarded | Always send; always manual | A human check until the outputs earn trust | — |
| D9 | Docker + systemd timer (`Persistent=true`) | cron; ECS/Lambda; GitHub Actions cron | Catches up after the machine was off; pins Chromium and Node | Optional EC2 + SSM deployment |
| D10 | Fastify API + one static HTML dashboard on 127.0.0.1 | Next.js; Streamlit; Grafana; Sheets | A one-person tracker with no build step | Reverse proxy with auth if ever exposed |

---

## D11: Unconfirmed profile facts are excluded by the loader

- **Choice:** every item in `master_profile.yaml` can carry `confirmed: false`; the profile loader drops those items before anything reaches a prompt or the validator's allowed vocabulary.
- **Alternatives:** leave unconfirmed items as `TODO` comments only (nothing stops them reaching a CV); keep them out of the file until confirmed (the drafting work is lost and the questions are forgotten).
- **Why:** the profile was drafted from the CV and the READMEs, and some facts were inferred (for example which repos were internship work). An inferred fact must never reach an application, and the rule is enforced in code rather than by remembering.
- **Production would add:** a `profile:check` command that lists every unconfirmed item and fails CI on a non-example profile.

## D12: Fix the host Node.js instead of developing inside a container

- **Choice:** update `c-ares` on the RHEL 10 workstation so the packaged Node 22 runs (see `docs/troubleshooting.md` #1).
- **Alternatives:** a Node tarball under `~/.local` (no root needed, but outside package management and patching); run every `npm` command in a `node:22` container (works without root, but slow edit-test loops and root-owned files unless `--user` is passed every time).
- **Why:** it fixes the root cause (a partial update) with one package from the configured repos, keeps Node patched by `dnf`, and the container is still built in P9 for the runtime.
- **Production would add:** CI runs in the pinned container image, so the host toolchain never matters for releases.

## D13: Every applied CV is exactly one page

- **Choice:** `cv.max_pages` is the literal `1` in the config schema (a value of 2 fails validation). The renderer trims the lowest-ranked bullets until the PDF is one page and adds bullets if the page is under `cv.min_fill`; a CV that can't reach one page goes to `needs_review`.
- **Alternatives:** "1 preferred, 2 max" (the original plan); a fixed 1-page template with no trimming (overflows on long projects).
- **Why:** Ahmed's requirement (R14). For 0–3 year roles a recruiter reads one page; making it a schema literal means no config edit can quietly relax it.
- **Production would add:** a visual regression test on the rendered page.

## D14: A local ATS check gates every application

- **Choice:** before any draft, send or package, the rendered PDF goes through a local check (PLAN 8.6): text layer, no images, embedded fonts, headings in order, contact fields parseable, one page, keyword coverage of profile-backed requirements. There is no config switch to disable it.
- **Alternatives:** an online ATS scanner such as Jobscan (no API, paid, and it would upload Ahmed's CV to a third party); run the check only for form jobs and ATS-routed email (Ahmed's minimum, but "does this inbox feed an ATS?" can't be detected reliably).
- **Why:** Ahmed's requirement (R15). Running it on every application covers both of his cases with no guessing, and it costs nothing because it is local `pdftotext`/`pdfinfo` work.
- **Production would add:** a second opinion from an open-source résumé parser, and tracking which ATS check scores correlate with replies.

## D15: Toolchain pins for P0

| Choice | Alternatives | Why |
|---|---|---|
| TypeScript **6.0.3** | 7.0 (newest, native compiler) | `typescript-eslint` 8.73 supports `<6.1`; type-aware linting matters more than compiler speed here |
| `commander` 15 | yargs; oclif | Small, typed, subcommands + choices; oclif is a framework for multi-package CLIs |
| `zod` 4 strict objects for config | JSON Schema + ajv; plain TS types | One schema gives runtime validation and the TS type; strict objects catch typos (`mdoe:`); placeholder values starting with `TODO` are rejected |
| `better-sqlite3` + numbered `.sql` migrations in a `schema_migrations` table | Prisma; Drizzle; knex | Synchronous and fast for a single writer; plain SQL keeps the schema readable and matches PLAN section 4 exactly; CHECK constraints make invalid states unstorable |
| `pino` JSON logs on **stderr** | winston; console | Structured logs for the `runs`/observability story; stderr keeps stdout clean for command output and pipes |
| Exit codes: 0 ok, 1 failure, 2 not implemented, 78 bad config (`EX_CONFIG`) | always 1 | The systemd unit and scripts can tell a config mistake from a crash |
| `@types/node` 22 | latest (26) | Types must match the Node 22 runtime, or code compiles against APIs that don't exist |

## D16: L2 simhash distance raised from 3 to 10 (candidate filter only)

- **Choice:** `dedupe.simhash_max_distance: 10`. The simhash only selects candidates; a near-duplicate is confirmed only when the token-set (Jaccard) similarity is at least `near_dup_similarity` (0.90, unchanged).
- **Evidence (P1, measured on the fixtures):** adding one line to a ~35-token WhatsApp post moved the 64-bit simhash by 3 to 7 bits (`- Good English`: 7 bits, Jaccard 0.946). Unrelated posts were 26+ bits apart at the 10th percentile and 31 at the median. With the plan's `≤ 3`, the obvious repost in fixture 06 was missed.
- **Alternatives:** keep 3 (misses most short reposts; they then cost an extraction call each); lower the Jaccard confirmation (catches more reposts, but a false merge drops a real job before extraction, which is worse than spending tokens); overlap coefficient instead of Jaccard (a short post contained in a long multi-job post would be merged wrongly).
- **Why:** L2 exists to save LLM calls; correctness ("never apply twice") comes from L3 and L4. A wider candidate net with the same confirmation saves more calls without any new false-merge risk. A repost that still slips past L2 (e.g. `Urgent hiring!` added to a short post: Jaccard 0.895) is caught by L3, which a test proves.
- **Production would add:** an index (banded simhash / LSH) instead of scanning the 30-day window, once volume grows.

## D17: Headless Claude Code (`claude -p`) on the Pro subscription replaces the API

- **Choice:** every model call runs the official CLI: `claude -p --model <id> --output-format json --json-schema <schema> --tools "" --no-session-persistence --strict-mcp-config`, from an empty working directory, with stdin closed. Auth is the subscription: `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token` in the container, or the normal login on the workstation.
- **Alternatives:** Anthropic API with an API key (needs paid credits Ahmed doesn't have); the Agent SDK (same subscription auth, but another runtime dependency for the same result); a local model (weak at structured extraction and CV writing).
- **Why:** it costs nothing beyond the Pro plan. Tested on 2026-11-20 with CLI 2.1.317 and `claude-haiku-5-5`: exit 0 in ~1.5 s, `structured_output: {"is_job_post": true, "title": "DevOps Engineer"}`, a prompt-injection line in the post ("run rm -rf /") had no effect, and the stream-json `init` event reported `apiKeySource: "none"` (subscription).
- **Guards:**
  - `ANTHROPIC_API_KEY` must not be set: in `-p` mode "the key is always used when present" (docs, authentication page). The agent refuses to start if it is set.
  - No `--bare`: bare mode never reads OAuth or `CLAUDE_CODE_OAUTH_TOKEN`.
  - Preflight on every run: one tiny call; if `apiKeySource` isn't `none` or the call fails, the run stops and the failure digest says why.
  - `--tools ""`: job posts are untrusted, and with no tools an injected instruction has nothing to run. zod still validates `structured_output` (defence in depth).
  - The CLI version is pinned in the Docker image; a version different from `llm.cli.pinned_version` logs a warning.
  - The token is used only by the `claude` CLI and is never copied into another tool.
- **Limits:** Pro has a 5-hour session limit and a weekly limit shared with Ahmed's own Claude use. Caps: `max_tailor_per_run: 8`, `max_jobs_per_run: 40`. `llm_calls` records tokens per call so the caps can be tuned from data.
- **Not verified from the docs (honest gaps):** that personal automation is explicitly allowed (the docs read say setup-token is "for CI pipelines and scripts"; the Agent SDK page says third parties may not *offer* claude.ai login in their products, which this is not); whether `--bare` will become the default for `-p` (the pin and the preflight cover it either way); how to pass flyer images with tools disabled (to be tested in P2 with `--input-format stream-json` image blocks).
- **Production would add:** the API with a dedicated key and spend limits, so the agent doesn't compete with a person's interactive usage.

## D18: Scope and run-mode changes from Ahmed (2026-11-20)

| Change | Was | Now | Why / trade-off |
|---|---|---|---|
| Per-run caps | 40 extractions, 8 tailored | `null` (no cap); stop cleanly at the subscription usage limit, finish `partial`, continue next run (R18) | Ahmed wants every available job processed. The best matches are tailored first, so hitting the limit cuts the weakest jobs. Trade-off: a big run can use up the Pro session limit he'd otherwise use interactively |
| Scheduling | systemd timer at 08:00 | Ahmed starts `agent run` manually once a day; the timer is optional (R10) | He wants control over when his subscription is used. Trade-off: no catch-up if he forgets; the stale-run tile still warns after 36 h |
| Image flyers | Vision extraction of images and PDFs | Text posts only; no media downloaded (R3) | Most of his target posts are text. Removes file parsing and media storage from the attack surface, and the untested image path through `claude -p` |
| Writing model | `claude-sonnet-5-5` for tailoring | Unchanged, and confirmed for all writing: CV, cover letter, email | Haiku stays on extraction and scoring, where volume is high and the task is simple |
| Private data | Whole profile gitignored | Unchanged; additionally, one phone number is blocklisted from Git everywhere (G2) and the rest of the portfolio contact data is not treated as secret | Ahmed's call: everything already public on his portfolio is fine; only one number stays private |

## D19: Fit-score rubric calibrated after the first live run

- **Choice:** the scoring prompt (`prompts/score.md`) tells the model that years of experience are already filtered (never count them as missing), that projects and labs are valid evidence, and that a post with few or no requirements is judged against the core skills its title implies. It also anchors the scale (strong candidate 70–95, adjacent 40–70, unrelated under 30). The thresholds (P1 45, P2 60, P3 75) did not change.
- **Evidence:** the first live run passed the gate, but the scores were wrong for the jobs that matter most:

  | Fixture | Before | After |
  |---|---|---|
  | 04 Junior DevOps Engineer (no requirements listed) | 30, skipped | 84, queued |
  | 23 Cloud Engineer (AWS) (title only) | 18, skipped | 75, queued |
  | 13 Linux System Administrator (2 years) | 55, skipped | 68, queued |
  | 18 Senior Technical Support Specialist (2 years) | 40, skipped | 52, queued |
  | 04 Frontend Developer | 8, skipped | 20, skipped |
  | 20 Data Analyst | 50, skipped | 50, skipped |

  The model's own summaries showed why: "The post lists no requirements, so no must-haves can be matched" and "the 2-year experience requirement is not proven since the only work experience is an internship".
- **Alternatives:** lower the thresholds (would also let unrelated roles through); compute the score in code from matched/missing counts (fails the same way on posts without requirements).
- **Why:** the defect was in what the model was told, not in where the bar sits. Fixing the instructions keeps unrelated roles low while lifting the right ones.
- **Production would add:** a labelled set of real posts with Ahmed's own apply/skip decisions, to measure precision and recall of the score over time.

## D20: Record/replay of model outputs

- **Choice:** `agent run --dry-run --fixtures --record` saves each validated structured output to `test/fixtures/llm/<fixture>.<stage>.json`; `npm test` replays them (`ReplayLlm`) through the real pipeline, against the committed example profile.
- **Alternatives:** mock the model per test (tests the mocks, not the pipeline); call Claude in CI (needs a token in CI, costs usage, and results change run to run).
- **Why:** CI never needs a Claude token and is deterministic, yet still exercises the real prompts' outputs end to end. Re-record after changing a prompt.

## D21: No seniority rules; Egypt-wide; score = skills + experience level (Ahmed, 2026-11-20)

- **Choice:**
  - Seniority words (senior, lead, manager…) no longer exclude a job. Only the years a post asks for do: more than `max_years_required` (3) is skipped.
  - Location: anywhere in `filters.countries` (Egypt) or remote. Extraction now returns `country`; a job with no stated country is kept.
  - Final score = `skills × 0.7 + experience × 0.3`. The model scores skills and domain only (its rubric no longer mentions seniority); code scores experience from the post: fresh/junior/0 years 100, 1 year 90, 2 years 80, 3 years 60, not stated 70. Thresholds (P1 45, P2 60, P3 75) apply to the final score. Both parts are stored in `fit_reasons.scores` and shown in the run table as `skl/exp`.
- **Alternatives:** keep seniority words as a hard rule (drops "Senior X (2 years)" posts that Ahmed can get); let the model weigh experience inside one score (opaque, and it penalized experience inconsistently in D19); add experience as a hard tier (too coarse).
- **Why:** Ahmed wants fresh and 0–2 year roles ranked higher for any role, combined with skills. Splitting the two makes each part testable and tunable in config, and the model can't double-count experience.
- **Effect (live run, 28 fixtures):** Senior DevOps (7 years) → `over_experience`; Riyadh onsite → `location`; Alexandria IT Support (fresh) → 65/100 = 76, queued; fresh Technical Support → 42/100 = 59, queued (it was 78 under the old rubric, because skills are now scored without the experience points).
- **Trade-off:** a "Senior" post with no years stated now gets experience 70 and is applied to when the skills fit. That was Ahmed's call.

## D22: P3 rendering stack and accepted audit findings

- **Choice:** Handlebars templates → headless Chrome PDF via `puppeteer` **24.38.0**, the exact version `whatsapp-web.js` 1.34.8 pins, so P4 reuses the same Chromium (one ~300 MB download, not two). Page count and fill from `pdfinfo` / `pdftotext -bbox` (poppler), which the ATS check uses anyway.
- **Alternatives:** puppeteer 25 (fixes the audit findings below, but a second Chrome next to WhatsApp's); pdf-lib to count pages (another dependency for what poppler already does).
- **Audit:** `npm audit --omit=dev` reported 10 high findings from three roots. `basic-ftp` is pinned to the fixed 6.2.6 with an `overrides` entry. Accepted, with reasons:
  - `extract-zip` ≤ 2.0.1 (symlink path traversal): used only when the browser archive is unpacked at install time, from Google's download servers. Never sees untrusted archives.
  - nested `zod@3` in `chromium-bidi` (memory exhaustion on oversized input): only on the WebDriver BiDi protocol path; puppeteer drives Chrome over CDP. Our own `zod` is 4.6.7, not affected.
  - Revisit when `whatsapp-web.js` moves to puppeteer 25.
- **Rendering security (A9):** JavaScript disabled, every request aborted, Handlebars escapes every value. A test proves a `<script>` doesn't run.

## D23: One-page fitting order

- **Choice:** trim in this order until one page: extra experience bullets (keep the best one per entry) → the lowest-ranked project bullets down to 2 per project → the last project (never fewer than 2) → down to 1 bullet per project → courses → the tail of the skills list. Then fill back with unused bullets of the chosen projects if the page is under `min_fill`. Project stack lines are capped at about one printed line.
- **Alternatives:** trim the last project's bullets first (the first version: it cut Nexora's strongest bullets and kept a generic "completed training" line); shrink the font (hurts readability and ATS parsing below about 10 pt).
- **Why:** projects are the evidence for a junior candidate; experience entries need one strong line each. Measured on the 3 gate CVs: one page each, 96–100% full, no LLM call needed to re-fit.

## D24: The CV follows Ahmed's own CV, on one page

- **Choice:** the template reproduces `Ahmed-Khater-CV.pdf`:
  - **Look:** Carlito (OFL, embedded in `templates/fonts/`), name, bold headline, a contact line where email, GitHub, LinkedIn and portfolio are real hyperlinks showing the address text, underlined section headings separated by grey rules.
  - **Sections in his order:** Profile, Education, Certifications, Experience, Projects, Skills, Languages.
  - **Projects:** linked titles with the italic stack, and his bold-labelled bullets ("Platform & Security: …").
  - **Skills:** every skill in his 16 categories plus Soft Skills.
  - **Profile changes:** his titles, stacks and labelled bullets, with the corrections he confirmed (five FastAPI services + NGINX; no "double-entry"; the DR drill as he states it). The NTI Final Project was added. The DevOps summary is his own Profile paragraph.
- **Fitting to one page, cheapest loss first:** font 10 → 9.5 → 9 pt, extra experience bullets, project bullets beyond 2, projects beyond `min_projects` (4), shorter stack lines, up to `max_skills_dropped` (6) least relevant skills, bullets beyond 1, then more skills. Spacing was tightened slightly (line height 1.18) so the top projects keep both labelled bullets.
- **Alternatives:** the generic template from P3 (rejected by Ahmed: "the first CV I gave you was my best one"); his CV unchanged on two pages (R14 says one); font below 9 pt (too small to read comfortably).
- **Result on the 3 gate jobs:** one page, 97–100% full, 4 projects each. The DevOps CV keeps both Nexora and both lab bullets and drops 3 of 91 skills; the Support and Networking CVs keep all skills. 8 working links per PDF (verified in the PDF's `/URI` annotations); the ATS check passes.

## D25: Ahmed's ATS-first refinements of the CV

- **Choice (Ahmed, 2026-11-20):**
  - **Contact line:** GitHub, LinkedIn and Portfolio are words with the URL behind them, so the line fits on one row. Only one phone (01272132996) is printed; the private number is no longer in the profile at all.
  - **Skills:** each category shows short main titles (`core: true`, e.g. "Linux: RHEL administration, Bash/Shell scripting, FreeIPA, OpenSCAP"), plus any other skill the job asks for, found in the job's text or cited by the fit score as evidence. The job's keywords therefore appear in the CV for the ATS.
  - **Projects:** Nexora and the Linux lab (`featured_projects`) are printed with their labelled bullets. Every other project is title + tech stack only; on networking jobs Packet Tracer also gets its bullet. Freed space goes first to the featured bullets, then to more stack-only projects (up to `max_projects`, 6).
- **ATS check change:** links are now verified as real link targets in the PDF (`/URI` annotations), not as visible text. Keyword coverage counts only keywords the profile backs.
- **Trade-off:** some older parsers read only visible text and won't see the GitHub/LinkedIn URLs behind the words. The URLs are still present as clickable links, and the job keywords now carry more weight. This was Ahmed's call.
- **Result (live, 3 gate jobs):** one page each, ATS pass, keyword coverage 100% on all three (the Support CV was 50% before the keyword fix), 8–9 working links, private number absent.

## D26: WhatsApp collector (P4)

- **Choice:**
  - `ReadOnlyWhatsApp` (`src/collect/whatsapp/readonly.ts`) is the only module that imports `whatsapp-web.js` 1.34.8. It keeps the client private and exposes `getChats`, `fetchMessages` and `destroy`. The rest of the code sees only the `WhatsAppReader` interface.
  - Verified in the library source: `Chat.fetchMessages` only reads (it loads earlier messages; no `sendSeen`), and presence is sent only by `sendPresenceAvailable`, which is never called.
  - Tests fail if any WhatsApp write call appears anywhere in `src/`. The facade is checked with the full list, including generic names such as `delete`, `reply` and `join`.
  - `LocalAuth` in `data/wa-session/` (owner-only); `webVersionCache: local` in `data/wa-web-cache/` pins the WhatsApp Web build that worked.
  - Text posts and media captions only; nothing is downloaded (R3). Short messages without an email or link are dropped before any model call. Other members' ids are stored only as salted SHA-256 hashes (salt in `data/wa-author-salt`, 0600).
- **Watermark semantics (refines PLAN 5.1):** a group's watermark advances in the same transaction that commits its raw items, not after model processing. Once a post is in `raw_items` it is durable, and P7 processes unprocessed raw items, so nothing is lost if a later stage fails, and the collector never re-reads posts it already stored. The 15-minute overlap plus dedupe L0 covers clock edges.
- **Commands:** `agent wa:login` (QR in the terminal, one time), `agent wa:groups` (prints names and ids for the allowlist), `agent collect whatsapp [--dry-run] [--since ISO]`, and the fallback `agent collect whatsapp-export --file chat.txt --group "Name"`, which parses Android and iOS exports in Cairo time (DST-aware).
- **Alternatives:** Baileys (lighter, but reimplements the protocol); official Cloud API (can't read groups you only joined); manual exports only (safe but not automatic). Kept as decided in D3.
- **Audit additions (accepted):** `archiver`/`zip-stream`/`archiver-utils`/`glob`/`minimatch` (moderate) arrive with `whatsapp-web.js`, which uses them only for `RemoteAuth` (zipping a session to remote storage). We use `LocalAuth`, so that code never runs. The high findings remain the two install-time ones from D22.

### D26 addendum: P4 gate result (2026-11-22)

`wa:login` linked the number; `wa:groups` listed 7 groups; group `✧Career✧Chance✧` is
allowlisted by id. The dry run counted 13 posts in the last 24 h (11 kept after the
pre-filter). The real run stored 11 raw items with hashed authors and set the watermark.
An immediate second run stored 0 new posts. Fixes found on the way: lock and clean exits
(#14), refusal on clock skew (#15), auto "Use here" on WhatsApp's conflict screen (#16).

## D27: Gmail integration (P5)

- **Libraries:** `@googleapis/gmail` 22.1.0 (only the Gmail API, not the 190-API `googleapis` bundle), `google-auth-library` 11.3.4 (the same version it depends on, so the types match), `html-to-text` 10.0.1 for alert emails. No new audit findings.
- **Auth:** desktop OAuth client with a loopback redirect on `127.0.0.1:<random port>`, PKCE (S256) and a random `state` that must match. `prompt=consent` + `access_type=offline` so Google always returns a refresh token. The token is written owner-only to `secrets/gmail_token.json` and rewritten when Google rotates it. The consent screen must be **In production** (Testing tokens expire in 7 days).
- **Scopes:** `gmail.readonly` + `gmail.compose` only, checked after the exchange; a missing one fails the authorization.
- **Facade:** `src/gmail/client.ts` is the only importer of `@googleapis/gmail`. It reads, creates drafts and inspects drafts and threads. A test forbids delete, trash, modify, insert/import and any labels, settings or filters call. Sending exists for two callers, enforced by a test: the digest and the apply stage (send mode only).
- **Recipients:** the draft refuses to be created if Gmail is authorized as a different account than the profile's email. The digest can only go to the authorized account itself.
- **Alerts:** one raw item per alert email; HTML becomes text with link targets kept as `text (url)`, images dropped, capped at `gmail.max_alert_chars`. Extraction splits it into jobs; LinkedIn `/comm/jobs/view/<id>` links canonicalize as before. Watermark `alerts` advances with the commit (as in D26).
- **L4 guard:** the same role to the same address within 60 days → skipped. A different role to an address that got an application in the last 14 days → review (one combined email may be better). An address Ahmed emailed by hand (`in:sent to:<addr> newer_than:60d`) → review, not skip, because that email may have been about something else.
- **Alternatives:** IMAP with an app password (wider access than two scopes, and app passwords need 2-step verification changes); the full `googleapis` package (much larger); sending immediately (D8 keeps drafts first).

### D27 addendum: restricted scopes and verification (2026-11-22)

Google classifies `gmail.readonly` and `gmail.compose` as restricted. Verification needs a paid
security assessment, which isn't proportionate for a single-user tool. The agent therefore supports
running unverified: published (lifetime cap of 100 users, warning screen) or Testing (Ahmed as the test
user, token expires every 7 days). For Testing, the token records when it was authorized,
`gmail:check` warns after 6 days, and every Gmail call turns `invalid_grant`/401 into one clear
instruction instead of a raw Google error. Alternative considered: IMAP with an app password (no
expiry, but full-mailbox access instead of two scopes, so less safe). Rejected.
The consent-screen privacy policy is live at https://ahmeddhussain.github.io/privacy.html (portfolio
repo, commit 1769845).

### D27 addendum: P5 gate result (2026-11-22)

- `gmail:check`: account `ahmedkhater2611@gmail.com`, both scopes, Testing mode (7-day token).
- `gmail:test-draft`: a real draft to Ahmed himself. Read back through the API: labels `DRAFT`;
  subject `[TEST] Application – DevOps Engineer – Ahmed Khater` (RFC 2047 round-trips); both PDFs
  attached with byte sizes identical to the files on disk (77,957 and 29,323); signature with the
  public phone only.
- `collect alerts --dry-run --extract`: 5 labelled emails in 24 h. 3 were skipped as not job lists;
  2 real alerts (LinkedIn, Indeed) yielded 20 jobs with titles, companies, locations and apply links.
  One model-altered URL was dropped and flagged `url_unverified` by the post-validation.
- Fixes found on the way: #17 (Gmail API disabled in the project, unreadable errors), #18 (alert
  noise and size).

## D28: The cover letter is the email body (Ahmed, 2026-11-22)

- **Choice:** for email applications, the tailored cover letter (greeting, 3 paragraphs, "Best regards,") is the body of the email, followed by Ahmed's name, public phone and links. Only the CV PDF is attached. No cover-letter PDF is produced. Form jobs get the same letter as `cover_letter.txt` for paste boxes.
- **Removed:** the separate 3–5 line `email_body` field (schema, prompt, validator) and the cover-letter template and PDF.
- **Alternatives:** a short body plus a cover-letter PDF (the original plan; recruiters often don't open a second attachment); both (duplicated text).
- **Why:** the recruiter reads the letter without opening anything, it's one fewer file for an ATS to parse, and the email stays tailored to the job. The truth validator's cover-letter rules (180–250 words, no clichés, facts only) now protect the email body directly.
- **Verified live:** 3 re-tailored fixtures pass (198–220 words); the test draft to Ahmed has the letter as its body and one attachment, the CV, byte-identical (77,484 bytes).

## D29: Company job feeds (P6)

- **Choice:**
  - **Adapters** for Greenhouse, Lever, Ashby, SmartRecruiters (list plus a per-posting details call) and Workable, plus an `html` type for careers pages without an ATS.
  - **Formats verified live** on 2026-11-22: Greenhouse (careem), Lever (palantir), Ashby (thndr), SmartRecruiters (smartrecruiters). Trimmed real responses are kept as test fixtures. Workable's job fields could not be verified (the boards probed had no openings), so every field is optional.
  - **Companies** are listed in `config/companies.yaml` (gitignored; example committed). `ats:detect <url>` recognises the ATS from the URL or the page HTML and proves the feed works before suggesting the entry.
- **What is collected:** every currently open posting whose title is P1/P2, whose location is in `ats.keep_locations` (or that is remote), and that is not older than `ats.max_age_days` (45). There is no 24-hour window for feeds: an opening posted ten days ago is still applicable today. A posting is stored once (L0 on `ats:<board>:<id>`), and details are fetched only for unseen postings. P3 titles are never taken from feeds: big boards would flood the model.
- **html pages:** the page text is one raw item keyed by its content hash, so a new item appears only when the page changes, and extraction then finds the roles.
- **HTTP:**
  - **Guarded fetches** through `PoliteHttp`: https only; DNS-resolved addresses must be public (loopback, RFC 1918, link-local/metadata, CGNAT, multicast and IPv6 private ranges refused), and so must every redirect target; no cookies.
  - **Politeness and limits:** one request per host per `ats.min_interval_seconds`; `Retry-After` honoured once; a 30 s timeout and a 10 MB cap.
  - **Retries** on network errors and truncated JSON (#19).
- **Gate (live):** Thndr (Ashby, 19 open) and Careem (Greenhouse, 11 open). The pre-filter kept 1 (Thndr, Senior DevOps/Infrastructure Engineer, Cairo); the second run stored 0 new.
- **Alternatives:** scraping careers HTML for every company (brittle, slower, closer to the line on terms); a paid jobs API (weak Egypt coverage).

## D30: Companies are discovered from job links (Ahmed, 2026-11-22)

- **Ahmed's requirement:** when an alert (or a group post) says "apply on the company website", the agent finds the company itself, without anyone adding it to `companies.yaml`.
- **Choice: an enrichment stage before scoring** (`src/pipeline/enrich.ts`). It runs for form, WhatsApp and unknown-channel jobs from alerts, groups and hand-added posts whose title isn't excluded:
  1. **Tracking links** are decoded offline: Wuzzuf `awstrack.me`, Bayt `tracklink`, and the Google and Facebook redirectors. Shorteners (bit.ly, lnkd.in, …) are followed through the guard.
  2. **ATS links:** a link to an ATS board (jobs.lever.co/acme/…, jobs.ashbyhq.com/…) gives the board and this posting directly.
  3. **LinkedIn links:** the logged-out page (`jobs-guest`, no cookies, ≤ 1 request / 5 s) gives the full description, the company, and offsite vs Easy Apply. It no longer contains the external link (troubleshooting #21).
  4. **Company pages:** any other page is fetched once. Its schema.org `JobPosting` (Wuzzuf and most careers sites publish one for search engines) or an embedded ATS board gives the details, or else the page text is the description.
  5. **Name probe:** with no board yet, the company name gives up to 3 board tokens (`DXC Technology` → `dxctechnology`, `dxc-technology`, `dxc`), tried on Greenhouse, Lever, Ashby, Workable and SmartRecruiters. **A guessed board is kept only if it lists the same title** (Dice ≥ 0.8). The result, found or not, is cached per company for 14 days.
- **Re-extraction:** when the post listed fewer than 3 requirements, the full description is extracted again (Haiku) and merged. The post's own apply target stays, the description adds requirements, years, work mode and the deadline (`validThrough`). The direct link is stored as `jobs.apply_url_direct`, and the form package leads with it.
- **Dynamic companies:** every board found goes into the `companies` table (`source = discovered`, with its evidence) and is polled by `collect:ats` on every later run, next to `companies.yaml`. A board failing 5 runs in a row is switched off. `agent companies` lists them.
- **Never fetched:** application forms (Google/Microsoft Forms, Typeform…: the form is the application) and hosts that refuse bots (Indeed 401, Bayt 403). The agent **never submits** a form: it prepares the package (PLAN 1, out of scope on purpose: captchas, accounts, terms).
- **Alternatives:** asking Ahmed for every company (what he wanted to avoid); logging into LinkedIn to read the external link (account risk, against its terms); a search engine API to find careers pages (paid, noisy).
- **What production would add:** Workday and SuccessFactors adapters (large employers such as Henkel and DXC use them; not public JSON feeds); a per-company override list.

## D31: The run orchestrator (P7)

- **Collection and processing are decoupled.** Collectors store raw items and advance their watermarks in the same transaction (D26). Processing then reads **every raw item with `processed_at IS NULL`**, oldest first. So the usage limit (R18), a crash or a failed source loses nothing: the next run continues with what is left.
- **Order:**
  1. **Start:** preflight (subscription only), then Gmail sync.
  2. **Collect:** WhatsApp, alerts, ATS, each isolated. A failing source makes the run `partial` and the others continue.
  3. **Per item:** dedupe L1/L2, extract, then for each job L3, enrich (D30) and score. All of an item's jobs are stored in one transaction, so an item stopped half-way leaves nothing half-stored.
  4. **Tailor queue:** priority, then fit, best first. Tailor, one-page CV, ATS check, then apply: an email draft (L4 guard first) or a package folder (`apply.md` with the direct link, the cover letter for paste boxes, screening answers, the CV). Anything that fails a check goes to `needs_review` with the reason.
  5. **End:** the digest, with run health.
- **Errors:**
  - A usage limit stops model calls, and the run ends `partial`.
  - A retryable model error (timeout) leaves the item for the next run.
  - Any other error marks that one item or job and the run goes on.
- **Dry run** (`agent run --dry-run`) works on a copy of the database (`data/dry-run.db`, rebuilt each time) and writes to `output/dry-run/`. Gmail is only read, the digest is printed, and the real database is untouched. Live runs take the pid lock `data/run.lock`.
- **Testing aids:**
  - `agent add [file]` stores a post by hand (an old post, a forwarded email) as source `manual`.
  - `agent run --no-collect` reads only what is stored.
  - `agent reprocess <job> --from score|tailor` redoes one job. An old Gmail draft stays in Drafts, because the agent has no delete permission.
- **Schema (migration 002):** `raw_items` is rebuilt (SQLite's documented procedure: foreign keys off around the transaction, `foreign_key_check` before commit) to add the `manual` source and `processed_at`/`process_error`. It adds `companies`, `company_probes`, the `jobs.apply_phone`/`apply_url_direct`/`apply_note`/`enriched_from`/`company_id` columns and `applications.package_dir`/`answers`.
- **Alternatives:** a job queue (BullMQ, needs Redis: too much for one daily run); watermark-only processing (loses items when the model stops mid-run).

## D32: Tracker dashboard (P8)

- **Choice:** Fastify 5.12.8 serving `dashboard/index.html` and the API of PLAN 10 on `127.0.0.1:8080` (`agent dashboard`). The page shows real jobs, status edits (written to `status_history` as `ahmed`), notes, and links to the CV, the cover letter (plain text), the package and the company site. It also lists the polled boards (config and discovered) and applications per day (from status changes to `applied`).
- **Security:** see `docs/security.md` A11. Loopback only, Host allowlist against DNS rebinding, JSON-only writes with an Origin check against CSRF, a strict CSP, and files by job id and kind only, inside `output/` with symlinks resolved.
- **Alternatives:** Node's `http` module (fewer dependencies but hand-written validation and routing; Fastify's `inject` also makes the API testable without a port); a React app (a build step for a one-person tracker).

## D33: Applying on web forms, and the parts Ahmed finishes (Ahmed, 2026-11-22)

- **Ahmed's requirement:** the agent applies to everything except email jobs by itself. Email drafts are reviewed in Gmail and then sent all at once. Whatever the agent can't finish appears in one place with the link and the documents ready. LinkedIn Easy Apply must still be possible.
- **What real forms look like** (inspected 2026-11-22): Ashby (Thndr) and Greenhouse (Careem) use **reCAPTCHA Enterprise**; Lever (Palantir) uses **hCaptcha**. They exist to stop automated submissions.
- **Choice:**
  1. **Try every eligible form** (https; not a board that needs an account: LinkedIn, Wuzzuf, Indeed, Bayt, Glassdoor). A separate headless Chrome (JavaScript on, a fresh profile per run, downloads off, private addresses blocked) fills the form:
     - **standard fields** (name, email, phone, links, location, the CV upload, cover letter boxes) from the profile in code;
     - **every other question** from one Haiku call that may use only the profile, the ready answers and the cover letter, and must choose from the options shown (options are checked in code);
     - a **required question without a truthful answer** stops the submission. Seen live: Thndr's form asks for the current salary, which the profile doesn't state.
  2. **Submitted** only when the company's confirmation shows (text such as "Thank you for applying", or a move to a thank-you page). Screenshots before and after are kept.
  3. **Everything else becomes "Apply yourself"** (`applications.mode = manual`) with the reason: captcha, sign-in, open questions, or no confirmation. The dashboard section lists these with the link, CV, letter and the filled-form screenshot.
  4. **`agent assist` (`./agent.sh apply`)** opens them one by one in a visible Chrome with a persistent profile (`data/browser-profile`). Company forms come pre-filled for Ahmed to check and submit. LinkedIn Easy Apply and board pages open on the job (signed in once by Ahmed in that profile), with the cover letter on the clipboard and the CV path shown; he clicks Easy Apply.
  5. **`agent send-drafts` (`./agent.sh send`)** lists the email drafts still in Gmail, asks once, and sends them as they are now (his edits kept, deleted ones skipped), pausing `apply.send_all_interval_seconds` between sends.
- **What the agent will not do:**
  - **Solve, bypass or hide from a captcha.** A captcha-protected form is submitted normally, and if the site doesn't confirm, it goes to Apply yourself.
  - **Log in, or drive LinkedIn Easy Apply with Ahmed's account.** Automated use breaks LinkedIn's terms and risks the account; Ahmed clicks there himself.
- **Why:** the agent does all the searching, writing, filling and uploading; Ahmed's part is one click per captcha or Easy Apply job and one confirmation for all emails. Nothing false is sent to an employer, and his accounts aren't put at risk.
- **Alternatives:**
  - Captcha-solving services or a stealth browser: evasion, against the sites' terms, and it risks the email being flagged as spam at that company.
  - The ATS application APIs: they need the employer's API key.
  - Asking Ahmed about every unknown question during the run: it would block the daily run; open questions show in the dashboard instead.
- **Also:** a job Ahmed moves from Skipped back to **New** in the dashboard is prepared on the next run (scored first if it never was); `./agent.sh redo <id>` does it at once.

### D33 addendum: first live run (2026-11-22, run 1)

`./agent.sh run --since 2026-11-15T00:00:00Z`: the WhatsApp group, one week of job alerts, and 2 company boards. 49 minutes; status **SUCCESS**.

| Stage | Result |
|---|---|
| Collected | WhatsApp 15 new posts; 27 alert emails (8 were not job lists: application receipts); boards 0 new; plus 12 stored earlier: **54 items** |
| Read | 54 processed, 3 raw duplicates, 0 failed, 0 left |
| Jobs | **162**:<br>• **skipped 118**: duplicate 42, over 3 years 37, low fit 27, excluded title 9, deadline passed 3<br>• **needs review 19**: eligibility 16, suspicious 3<br>• **ready 25** |
| Enrichment | 72 jobs got the full description (LinkedIn logged-out pages, Wuzzuf schema.org data); 23 on Indeed/Bayt not fetched by design |
| Discovery | 4 company boards found from job links (Overjet and Take In on Ashby; Foodics and Ghanem on Workable), now polled every run. Their jobs this week all asked for more than 3 years, so none was applied to |
| Applications | 25 one-page CVs, all passing the ATS check (keyword coverage 96–100%):<br>• **1 Gmail draft** (IT Specialist, HIG Development);<br>• **24 "Apply yourself"**: 13 LinkedIn "company website", 4 LinkedIn Easy Apply, 6 Indeed/Bayt, 2 Wuzzuf |
| Forms submitted | **0**: no ready job had a company form this week. The filler was verified on Thndr's real Ashby form in fill-only mode instead |
| Model | 216 Claude calls, 0 failed, 446,668 output tokens; the digest emailed to Ahmed |

**Found and fixed from this run** (troubleshooting #27):

- Wuzzuf links kept long tracking parameters.
- A job page's country wasn't used when the alert omitted it.
- The same job twice in one alert was enriched twice.
- Easy Apply jobs skipped the company-board search.
- A duplicate that carried the company's own form link didn't pass it to the original job.

**Open:** whether every LinkedIn page without the "apply on company website" marker is Easy Apply is still an assumption. After about 70 page requests in the run, LinkedIn answered 429 (rate limit) to the check.

## D34: A job's own posting date, and a maximum age (Ahmed, 2026-11-23)

- **Ahmed's finding:** the dashboard showed jobs from about three months ago after the live run.
- **Cause:** the collection window was right (every stored post and alert email was from 15–22 November). But alert emails such as LinkedIn's "New jobs similar to…" recommend jobs posted weeks or months earlier, and the agent dated each job by the email.
- **Choice:**
  - **The real posting date is kept** in `jobs.job_posted_at`. It comes from the job page (LinkedIn's "N days ago", schema.org `datePosted` on Wuzzuf and careers sites) or from the ATS feed.
  - **Older jobs are skipped:** a job older than `filters.max_job_age_days` (30) is skipped as `stale` before any scoring call. Unknown dates are not skipped.
  - **Jobs prepared before this change:** `agent recheck-dates` (`./agent.sh recheck`) read the dates of 37 of them. 9 were older than 30 days (up to 365) and moved to skipped.
- **Alternatives:** trusting the email date (the bug); dropping recommendation emails altogether (they also carry fresh jobs).

## D35: Questions forms ask, answered once (Ahmed, 2026-11-23)

- **Ahmed's requirement:** when a form asks something the profile doesn't hold, warn him, tell him how to add it, and never ask twice.
- **Choice:**
  - **Recorded once:** each required question the filler can't answer truthfully is stored in `form_questions`, normalized and counted.
  - **Warned three ways:**
    - at the end of the run's output ("FORMS ASKED N QUESTIONS YOUR PROFILE DOESN'T ANSWER");
    - in the digest email;
    - in the dashboard (**Needs action** and **Profile**, with a badge).
  - **Answered once:** the answer is written into `profile/master_profile.yaml` → `application_answers` under a readable key (`current_salary`). The YAML file stays the single source of truth: comments are kept, the whole profile is validated first, the old file is kept as `.bak`, and the write is atomic.
  - **Retried:** forms that stopped only on questions answered since are filled and submitted again on the next run (`./agent.sh retry` does it at once).
  - **Edited in the dashboard:** the ready answers themselves (add, change, remove), and the cover letter of any prepared, not yet sent application (saved to the database and the package's `cover_letter.txt`).
- **Not editable from the dashboard:** CV facts, projects and skills. Every CV is checked against them, so they're edited in the profile file on purpose.
- **Alternatives:** a separate answers file (two sources of truth); asking during the run (it would block the daily run).

## D36: Dashboard in sections (Ahmed, 2026-11-23)

- **Sections:**
  - **Today:** what needs you, tiles, last-run health, the funnel from jobs seen to interviews, and applications per day.
  - **Needs action:** questions, email drafts, apply yourself, needs review, queued.
  - **Applied:** a board (Applied → Interview → Offer / Rejected) to drag cards on.
  - **Skipped:** grouped by reason, with "Prepare anyway".
  - **All jobs:** search, filters and sorting.
  - **Profile:** contact, answers, pending questions, CV headlines.
  - **Companies** and **Runs** (history).
- **Job detail panel:** fit breakdown, matched and missing requirements, what the form filler entered, the letter editor, notes, the original post.
- **Security as before (A11):** every text from a post is escaped, links are rendered only for http(s), writes are JSON-only and same-origin. Still one static file, no build step (D10).

## D37: Every WhatsApp channel Ahmed follows (Ahmed, 2026-11-23)

- **Choice:** besides the allowlisted groups, the collector reads every channel the account follows (`whatsapp.channels.follow_all`), minus `channels.exclude` (editable in Settings). Same window, watermark per channel, text posts only; stored as source `whatsapp_channel`.
- **Read-only:** whatsapp-web.js 1.34.8's `getChannels()` lists the followed channels and `Channel.fetchMessages()` only loads earlier messages (no `sendSeen`), both verified in the library source. The facade exposes only these two; follow, unfollow, mute and react stay unreachable, and the grep test still covers `src/`.
- **Verified live:** 2 followed channels found ("IT Support & Jobs", "Communication Engineer") next to the group.

## D38: LinkedIn's public job search replaces LinkedIn's alert emails (Ahmed, 2026-11-23)

- **Measured first (2026-11-23):**
  - **LinkedIn:** the logged-out search (`jobs-guest/jobs/api/seeMoreJobPostings/search`, `f_TPR` = posted within N seconds) returned jobs for all 8 titles. LinkedIn refused about 1 request in 4 (HTTP 429) at 5 s and at 15 s spacing; a refused page succeeded when asked again.
  - **Wuzzuf, Indeed, Bayt:** their search answered **403** to automated requests.
  - **Ahmed's condition** ("drop all alerts if the others' search works and won't be blocked") is therefore met only for LinkedIn. LinkedIn's alert senders are left out of the Gmail query (`alerts.skip_from`); the Wuzzuf, Indeed and Bayt alerts stay.
- **Choice:**
  - **Searches:** each title in `search.linkedin.titles` × each location, page by page (10 jobs a page, at most `max_pages`).
  - **Window:** only jobs posted since that search last succeeded (plus the 15 min overlap), at most 24 h.
  - **Refusals:** one shared, paced client for every LinkedIn request in a run (6 s). A refused page is retried after `retry_wait_seconds` × attempt; a search that still couldn't read every page keeps its old window, so the next run fetches what was missed.
  - **What's stored:** only P1/P2 titles become raw items (source `linkedin`, keyed by the job id). Enrichment then reads the job page, with the same 429 patience, for the description and the company board (D30).
  - **Editable:** the titles and locations, in the dashboard Settings.
- **Verified live:** the 8 titles gave 33 pages, **0 refused** with retries; 16 jobs with priority titles from the last 24 h.
- **Caveats (honest):**
  - Automated use is against LinkedIn's terms. It's logged out, with no account and no cookies, so Ahmed's account isn't involved, but LinkedIn can rate-limit or block the IP. The run then goes on without it (`partial`), and the alerts switch in Settings can bring LinkedIn's alerts back.
  - LinkedIn matches keywords loosely ("IT Engineer" lists many unrelated jobs). The title pre-filter keeps the model from seeing them.
- **Alternatives:**
  - Alerts only: too few, late, and they recommend months-old jobs (D34).
  - A paid jobs API: weak Egypt coverage.
  - Logged-in scraping: account risk.

## D39: Settings, "Not a fit", learned rules and company lists in the dashboard (Ahmed, 2026-11-23)

- **Settings page** writes back to `config/config.yaml` and `config/titles.yaml`. The YAML files stay the source of truth: comments are kept, the whole file is validated (config schema, title patterns compiled) before writing, the old file is kept as `.bak`, and the write is atomic. Editable:
  - search titles and locations;
  - source switches (LinkedIn search, channels plus exclusions, alerts, company boards);
  - the maximum job age and years;
  - the fit thresholds;
  - excluded title patterns;
  - favorite and blocked companies.
- **"Not a fit"** on any job, with a reason (wrong field, too senior, company, location, already applied, other):
  - the job is skipped as `discarded: <reason>`;
  - the agent's own unsent Gmail draft for it is deleted. `GmailFacade.deleteOwnDraft` is the facade's only delete; a test allows `drafts.delete` and nothing else, and requires callers to use ids from `applications.gmail_draft_id`.
- **Learned rules:**
  - **A title word** found in 2+ "wrong field" discards and in no prepared job is suggested as an excluded title.
  - **A company** discarded twice, or once "because of the company", is suggested for the block list.
  - Ahmed applies or dismisses each with one click; dismissed ones don't return.
- **Company lists:** blocked companies are skipped before scoring (`blocked_company`); favorites are prepared even below the fit threshold.
- **Bulk actions** on selected jobs: prepare, mark applied, skip, not a fit.

## D40: Follow-ups

- **Due:** an email application sent `followup.after_days` (7) ago with no reply.
- **Draft:** one click drafts a short, true follow-up in the same Gmail thread ("I applied for X on <date> and wanted to follow up…" plus the signature). Ahmed sends it from Gmail; it's drafted once per application.
- **Forms:** follow-ups for form applications aren't possible by email; those stay a manual reminder.

## D41: Run now, interview prep, sources, CV preview, notifications

- **Run now** in the dashboard starts the same `agent run` (or a dry run) as a child process with a fixed command. Only the dry-run flag comes from the request. The run lock still prevents overlaps. The page shows the live output and, when the run ends, a toast and a desktop notification (browser permission). `./agent.sh run` sends a desktop notification too (`notify-send`).
- **Interview prep** (on demand, Sonnet), saved per job:
  - 8 likely questions, each with answer points from the profile and the profile ids behind them; ids not in the profile are dropped, the same truth check as scoring;
  - honest ways to address gaps;
  - 3 questions to ask.
- **Sources scoreboard:** jobs, matched, prepared, applied and replies per group, channel, search title, alert sender and board.
- **CV preview** inside the job panel. Only `/files/*` may be framed, and only by the dashboard itself (`X-Frame-Options: SAMEORIGIN`, `frame-ancestors 'self'`).
- **Look:** the portfolio's design (monochrome, one blue gradient, glass panels, Space Grotesk / Inter / JetBrains Mono). The fonts (OFL) are served locally from `dashboard/fonts`, so the page loads nothing from outside the VM.

## D42: Title tiers from evidence, and learning from Ahmed's choices (audit 2026-11-23)

- **Source:** `docs/audits/2026-11-23-final-test.md`, an independent re-collection compared with the database. Collection was complete; the errors were in title tiers and in what the agent learned from.
- **Title tiers** (`config/titles.yaml`):
  - **P1:** Kubernetes, DevSecOps, and cloud solutions/platform/administrator. IT support/specialist/administrator and help/service desk also move up (from P2/P3), because those are the jobs Ahmed applies to.
  - **P2:** data center, SOC, back-office engineer, and M365.
- **Learning:** suggestions now come from three signals:
  - "Not a fit" reasons (D39);
  - jobs Ahmed turned down (Rejected or skipped by him) that were **never marked applied**. A job marked applied and then rejected may be a company's rejection, so it isn't counted;
  - his applications to jobs scored under their tier's threshold, which suggest a lower threshold.
- **The senior rule:** "Skip senior titles unless the post asks for ≤ 2 years" (`filters.skip_senior_titles`) is a suggestion he switches on. It reverses his D21 "no seniority rules", so it's his decision, not the agent's.

## D43: Run, apply and send from the dashboard

- **▶ Run menu:** run, process the queue only (`run --no-collect`), dry run, retry waiting forms, recheck posting dates.
- **Send all drafts:** a confirmation dialog listing every draft, then `send-drafts --yes` with live progress.
- **Open pre-filled / Apply next:** the dashboard server opens the job in the assisted browser (visible Chrome, `data/browser-profile`) on Ahmed's desktop. Forms are filled, never submitted; Easy Apply and board pages open on the job with the letter on the clipboard. After Mark applied, Skip or Not a fit, "Apply all" opens the next one. `agent.sh dashboard` passes the desktop session to the server.
- **Fixed commands only:** every job is a fixed agent command chosen by a name from the request (A22), and the run lock prevents overlaps.
- **Dashboard additions** (from common job-tracker features: Huntr, Teal, Simplify):
  - a weekly application goal with a ring;
  - "heard back" and interview rates, counted only over jobs really applied to;
  - a job panel in tabs (Overview with a status timeline, Application, Interview prep, Original post);
  - more fields (years asked, work mode, apply channel, deadline) and filters (posted within, minimum fit);
  - quick add of a pasted post;
  - undo after status changes and "Not a fit";
  - keyboard shortcuts (`/`, `j`/`k`, `Enter`, `1`–`9`, `r`, `?`).
