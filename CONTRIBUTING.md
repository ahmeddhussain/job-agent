# Contributing

Thanks for helping. The agent applies for jobs in people's names, so two things matter more
than features: it must never state anything untrue, and it must never leak anyone's data.

## Setup

```bash
./install.sh
```

```bash
npm run lint && npm run typecheck && npm test
```

The tests need no accounts and make no Claude calls: model outputs are recorded in
`test/fixtures/llm` and replayed. Real PDF rendering needs poppler, and Chrome comes with
`npm ci`.

## Rules

1. **Truthfulness:** never weaken the validator (`src/tailor/validate.ts`) to make a test
   or a CV pass. A CV may only use facts from the profile.
2. **Read-only WhatsApp:** only `getChats`, `fetchMessages` and `destroy`, through
   `ReadOnlyWhatsApp`. A test scans `src/` for write calls.
3. **No personal data:** commit nothing from a real profile. Profile folders are gitignored
   except the fictional `profiles/example/`, and `install.sh` enables the secrets scan as a
   pre-commit hook (`scripts/check-secrets.sh`). Use the example profile or
   `test/fixtures/` in tests and screenshots.
4. **Config, not code:** model IDs, thresholds, paths, titles and anything about one person
   belong in `config/defaults.yaml` or the profile, never in code.
5. **Untrusted input:** job posts and web pages go into prompts inside delimited blocks, and
   every model output is validated with a zod schema.

## Changes

- One logical change per pull request, with tests.
- Conventional commits: `feat:`, `fix:`, `docs:`, `chore:`, `test:`, `refactor:`.
- A design choice with real alternatives gets an entry in `docs/dev/decisions.md`
  (choice, alternatives, why). A real problem you diagnosed gets one in
  `docs/dev/troubleshooting.md` (symptom, diagnosis, fix).
- User-facing behaviour changes update the docs in `docs/`.

## Changing a prompt or the test profile

The recorded outputs in `test/fixtures/llm` match the prompts and `test/fixtures/profile.yaml`.
After changing either, record again, with a signed-in `claude`:

```bash
npm run agent -- --profile example run --dry-run --fixtures --record
```

```bash
npm run agent -- --profile example tailor:fixtures --record
```

Then check the diff of `test/fixtures/llm` before committing.
