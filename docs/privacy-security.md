# Privacy and security

The agent runs on your machine, with your accounts. This page says what it stores, what it
sends where, what it never does, and how to remove its access. The full threat model,
with every control and its test, is [dev/security.md](dev/security.md).

---

## What stays on your machine

Everything in `profiles/<name>/`:

- your profile and settings;
- the database of jobs and applications;
- every CV and letter;
- the WhatsApp session and the browser sign-ins;
- the Gmail token and the optional Claude token.

Nothing is uploaded anywhere by the agent itself. The dashboard listens on `127.0.0.1`
only and loads nothing from the internet.

## What is sent, and to whom

| To | What | When |
|---|---|---|
| **Claude** (Anthropic, through the `claude` CLI on your subscription) | Job-post text; your profile's facts (experience, projects, skills) **without** your email and phone, which are added to the CV in code; application-form questions | Every run: reading, scoring, writing |
| **Claude** | Your CV's full text, contact details included | Once, during `./agent.sh init` |
| **LinkedIn** | Logged-out search requests and job pages, like a browser without cookies | Every run, if LinkedIn search is on |
| **Company job boards** | Public feed requests | Every run, if company boards are on |
| **Gmail** (Google) | Drafts with your CV, the emails you send | Only if you connect Gmail |
| **Application forms** | Your answers and CV, on the company's own form | When a form is submitted |

The model runs with **no tools**: no shell, no files, no web access, in an empty folder. A
job post that tries to instruct it ("ignore your rules and…") has nothing to act with, and
every answer it gives is checked against a schema and against your profile. Your
subscription is used, never API credits: the agent refuses to start if `ANTHROPIC_API_KEY`
is set, and checks `apiKeySource=none` before each run.

## What it never does

- **Never invents facts.** A CV, letter or form answer can only use what is in your
  profile. The validator rejects anything else, and anything in `not_held` can't appear.
- **Never writes on WhatsApp.** It only reads: no sending, reacting, marking as read or
  joining. A test fails if the code calls any of those.
- **Never signs in to job boards or LinkedIn for you**, and never clicks Easy Apply. Those
  jobs are prepared and handed to you.
- **Never solves or bypasses captchas.** A form with a captcha goes to "Apply yourself".
- **Never sends email in the default mode.** `apply.mode: draft` only creates drafts; you
  send them. `send` mode exists, with score, priority and daily-cap guards, and you switch
  it on yourself.
- **Never deletes mail**, except drafts it created itself (for a job you mark "Not a fit").
- **Never applies twice** to the same address and role within 60 days, or to an address
  you already emailed yourself (checked in Gmail Sent when Gmail is connected).

## Secrets and Git

- Profile folders (`profiles/<name>/`), backup files (`*.bak`, `*.pre-*`) and
  `.secrets-blocklist` are in `.gitignore`.
- `./install.sh` enables a pre-commit hook (`scripts/check-secrets.sh`). It blocks:
  - those paths;
  - token patterns (Anthropic, Google, GitHub, AWS, private keys);
  - any value you list in `.secrets-blocklist` (one per line, e.g. a private phone number).
- `.env` is read into the agent privately. Its values are never exported to other programs,
  never logged, and the Claude CLI gets only what it needs.

## Removing access

| What | How |
|---|---|
| Gmail | <https://myaccount.google.com/permissions> → job-agent → Remove access; delete `secrets/gmail_token.json`; set `gmail.enabled: false` |
| WhatsApp | Phone → Linked devices → log out the agent; delete `data/wa-session` |
| LinkedIn (the apply browser) | delete `data/browser-profile` |
| Claude token (if you used one) | revoke it in your Claude account; remove it from `.env` |
| Everything | delete the profile folder `profiles/<name>/` |

## Keeping the machine safe

The profile folder holds sessions that equal being logged in. Keep the machine updated,
use disk encryption, don't expose its ports, and use two-factor authentication on Gmail and
GitHub.
