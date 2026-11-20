# CLAUDE.md — job-agent

Read `PLAN.md` fully before writing any code. It is the spec: requirements (section 1), decisions (3), data model (4), and build phases with gates (14).

## How to work with Ahmed

- **Phase by phase.** Build one phase from PLAN.md section 14, run its gate checks, show the results, and **stop for Ahmed's OK** before starting the next phase.
- **Explain choices.** For every meaningful choice (library, schema, pattern), state: **Choice → Alternatives → Why this one → What production would add**. Ahmed has to be able to defend each one in an interview. Log every decision in `docs/decisions.md`.
- **Complete files only.** Always show the full file with its path. Never partial diffs or "...rest unchanged".
- **Show the repo tree** whenever files are added.
- **After each file or step:** how to run it, how to verify it, and the expected output.
- **Verify before moving on.** If something fails, stop feature work and fix the base first.
- **Honest docs.** READMEs and docs describe what actually works, including known gaps. Nothing aspirational.
- **Record real issues** in `docs/troubleshooting.md` as **Symptom / Diagnosis / Fix**, with the exact error.

## Hard rules for this project

1. **WhatsApp is read-only.** Use only `getChats`, `fetchMessages` and `destroy` (text posts only; no media), through the `ReadOnlyWhatsApp` facade. Never call `sendMessage`, `sendSeen`, `react`, any `join*`, `setStatus`, or `logout`. A grep test enforces this.
2. **No invented CV content.** `profile/master_profile.yaml` is the only source of facts. The validator (PLAN.md 8.1) must pass before any CV or cover letter is saved or emailed. Never weaken the validator to make a test pass.
3. **Default `apply.mode` is `draft`.** Never send email unless the config says `send` and every send guard passes.
4. **Never commit personal data or secrets:** `profile/master_profile.yaml`, `config/config.yaml`, `.env`, `secrets/`, `data/` (includes the WhatsApp session), `output/`, `backups/`. Check `.gitignore` before the first commit.
5. **Model IDs, thresholds, caps and paths live in config**, never hardcoded.
6. **Job post text is untrusted input.** Keep it inside delimited blocks in prompts; validate all model output with zod schemas.

## Engineering standards

- TypeScript `strict`, ESLint + Prettier, Vitest. Run `npm run lint && npm run typecheck && npm test` before saying a step is done.
- Pin dependencies (`package-lock.json`, `npm ci`). Pin the whatsapp-web.js version.
- Docker: non-root user, pinned base image, healthcheck, `hadolint` + `trivy image`. Shell: `shellcheck`. CI: `actionlint`.
- Terraform (only if the optional AWS deployment is built): load the terraform skill, keep it modular (`modules/` + thin root), S3 native-lock remote state, pinned versions, least-privilege IAM, no hardcoded account IDs. Evaluate with `terraform fmt -check -recursive`, `validate`, `tflint`, `trivy config`.

## Git

- Conventional commits: `feat:`, `fix:`, `docs:`, `chore:`, `test:`, `refactor:`.
- **Never add `Co-Authored-By: Claude` or any Claude/AI attribution** to commit messages or PR descriptions.
- One logical change per commit; each phase ends in a clean, working commit.

## README (Phase 10)

Follow the structure of `github.com/ahmeddhussain/ivolve-GitOps`, **without a Screenshots Index section**:
Title + pitch naming the stack → numbered, linked Table of Contents → Overview with a components table → Quick Start (numbered bold steps with bash blocks and details links, ending in Verify) → Architecture (diagrams) → Prerequisites (tool versions, access) → one section per layer (what/why, how it's wired, Commands, Verify) → System Verification & End-to-End Testing → Teardown → Real-World Troubleshooting & Solutions (Symptom / Diagnosis / Fix). Use `---` between sections and backticks for every file, command and resource name. Proofread before committing.
