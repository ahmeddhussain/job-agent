# Runbook: setting the agent up (for a new person or a new machine)

From an empty Linux machine to the first run. About an hour, most of it in the Google Cloud
console. Every step has a check; don't go on until it passes.

**What the new person needs:** a Linux machine with a desktop (Fedora/RHEL 10 or Ubuntu 24.04
tested on RHEL 10), a Claude Pro or Max subscription, a Gmail account, a WhatsApp account
that is in the job groups, and their own CV facts.

---

## 1. Tools

| Tool | Version | Check |
|---|---|---|
| Node.js | 22.12 or newer | `node --version` |
| npm | comes with Node | `npm --version` |
| poppler-utils (`pdfinfo`, `pdftotext`, `pdffonts`, `pdfimages`) | any | `pdfinfo -v` |
| git | any | `git --version` |
| Claude Code CLI | the version in `config.yaml` → `llm.cli.pinned_version` | `claude --version` |
| Clipboard tool (optional, for Easy Apply) | `wl-clipboard` (Wayland) or `xclip` | `wl-copy --version` |

```bash
sudo dnf install -y nodejs poppler-utils git wl-clipboard     # RHEL / Fedora
```
```bash
sudo apt install -y nodejs npm poppler-utils git wl-clipboard  # Ubuntu (use NodeSource for Node 22)
```

Claude Code: install it from https://docs.anthropic.com (native installer), then pin the version the
agent was tested with.

---

## 2. Code and dependencies

```bash
git clone https://github.com/ahmeddhussain/job-agent.git ~/job-agent
```
```bash
cd ~/job-agent && npm ci
```
```bash
git config core.hooksPath .githooks
```

`npm ci` also downloads the Chrome that puppeteer uses (for PDFs and forms).
The hook blocks commits that contain secrets or private data.

**Check:** `npm test` → all tests pass (they need no accounts).

---

## 3. Private files (never committed; `.gitignore` covers them)

```bash
cp .env.example .env && chmod 600 .env
```
```bash
cp config/config.example.yaml config/config.yaml
```
```bash
cp config/companies.example.yaml config/companies.yaml
```
```bash
cp profile/master_profile.example.yaml profile/master_profile.yaml
```

| File | What to put in it |
|---|---|
| `.env` | `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token` (section 4). Never set `ANTHROPIC_API_KEY` |
| `config/config.yaml` | `digest.to`: your Gmail address. `filters.countries`, `filters.max_years_required`. Every `TODO` value must be replaced (the agent refuses to start otherwise) |
| `config/companies.yaml` | Optional: companies to watch from day one. Others are discovered automatically from job links |
| `profile/master_profile.yaml` | **Your facts only**: contact, education, certifications, experience, projects with real numbers, skills, `not_held` (things you must never claim), `application_answers` (notice period, expected salary, current salary if you want it used, military status, relocation). The CV and every answer are built from this file and checked against it |
| `.secrets-blocklist` | Optional: one private value per line (e.g. a private phone number); the commit hook refuses any file containing them |

**Check:** `npm run agent -- config:check` → `config OK`.

---

## 4. Claude (the subscription, not the API)

```bash
claude setup-token
```

Copy the token into `.env` as `CLAUDE_CODE_OAUTH_TOKEN=…`. The agent runs `claude -p` with no
tools, in an empty folder, and checks before every run that the subscription is used
(`apiKeySource=none`).

**Check:** `./agent.sh dry-run --no-collect` prints `preflight: claude …, apiKeySource=none (subscription)`.

---

## 5. Gmail (job alerts in, drafts out)

Follow `docs/gmail-setup.md` step by step:

1. A Google Cloud project with the Gmail API on.
2. The OAuth consent screen (External, your address as a test user; Testing mode means a weekly re-authorization).
3. A **Desktop** OAuth client; save its JSON as `secrets/gmail_client.json` (`chmod 600`).
4. Turn on job alerts (LinkedIn, Indeed, Wuzzuf, Bayt) and one Gmail filter that labels them `job-alerts`.
5. Authorize: `./agent.sh gmail-auth` (a browser opens; allow the two scopes).

**Check:** `./agent.sh status` → `scopes: gmail.readonly + gmail.compose (ok)` and a count for the `job-alerts` label.

---

## 6. WhatsApp (read-only)

```bash
./agent.sh whatsapp-login
```

Scan the QR from the phone (WhatsApp → Linked devices → Link a device). Then list the groups and
copy the job groups' ids into `config.yaml` → `whatsapp.groups`:

```bash
npm run agent -- wa:groups
```

It also reads **every WhatsApp channel the account follows** (follow job channels from the phone; leave any out in the dashboard Settings). The agent only reads those groups and channels. It never sends, reacts, marks as read or joins anything
(a test enforces it). The session lives in `data/wa-session`: treat it like a logged-in phone.

**Check:** `npm run agent -- collect whatsapp --dry-run` counts recent posts per group.

---

## 6b. Job titles to search on LinkedIn

No account is needed: the agent uses LinkedIn's public job search. Set your titles in the dashboard
(Settings → Job titles), or in `config/config.yaml` → `search.linkedin.titles`. Check them with:

```bash
npm run agent -- collect linkedin --dry-run
```

---

## 7. First run

```bash
./agent.sh dry-run
```

A full run on a copy of the database: nothing is drafted, sent or submitted. Read the digest it
prints and a few files in `output/dry-run/<date>/` (CV PDF, `cover_letter.txt`, `apply.md`).
If a CV says anything that isn't true, fix the profile, not the CV.

Then the real one:

```bash
./agent.sh run
```

and the daily routine in `docs/runbooks/daily-use.md`.

---

## 8. Security checklist for the machine

`docs/security.md` section 5 (H1–H12): updates, no exposed ports, key-only SSH, disk encryption on
the host, 2FA on Gmail and GitHub. The sessions in `data/` (WhatsApp, the assisted browser's
LinkedIn sign-in) and the tokens in `.env` and `secrets/` are equivalent to being logged in: they never
leave the machine and are never committed.

---

## 9. Handing over or removing

- **Revoke Gmail:** https://myaccount.google.com/permissions → the app → Remove access; delete `secrets/gmail_token.json`.
- **Unlink WhatsApp:** phone → Linked devices → log out the agent; delete `data/wa-session`.
- **Claude token:** revoke it in your Claude account settings; remove it from `.env`.
- **LinkedIn (assisted browser):** delete `data/browser-profile`.
- **Data:** `data/agent.db` (every job and application) and `output/` (CVs) are personal; delete or archive them.
