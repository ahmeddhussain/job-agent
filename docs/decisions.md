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
