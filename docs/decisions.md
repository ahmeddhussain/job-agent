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
