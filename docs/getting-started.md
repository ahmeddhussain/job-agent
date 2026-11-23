# Getting started

From a fresh clone to your first applications, in about 20 minutes. The only account you
need is a **Claude subscription** (Pro or Max). Gmail and WhatsApp are optional and can be
added later ([sources.md](sources.md)).

Tested on RHEL 10 and Ubuntu 24.04 with a desktop. macOS should work (not tested yet);
on Windows use WSL2 with WSLg (not tested yet).

---

## 1. Install the requirements

| Tool | Why | Install |
|---|---|---|
| Node.js 22.12+ | runs the agent | <https://nodejs.org>, or `sudo dnf install nodejs` / NodeSource on Ubuntu / `brew install node` |
| poppler | checks every CV PDF (one page, fonts, readable text) | `sudo dnf install poppler-utils` · `sudo apt install poppler-utils` · `brew install poppler` |
| Claude Code | writes and scores, on your subscription | `npm install -g @anthropic-ai/claude-code`, then run `claude` once and sign in |
| git | to clone | your package manager |
| unzip (optional) | reads a CV in `.docx` | your package manager |
| wl-clipboard or xclip (optional) | puts the cover letter on the clipboard for Easy Apply | your package manager |

## 2. Clone and install

```bash
git clone https://github.com/ahmeddhussain/job-agent.git && cd job-agent
```
```bash
./install.sh
```

`install.sh` checks the tools above and says exactly what is missing. Then it runs `npm ci`,
which also downloads a private Chrome used for PDFs and forms. It installs nothing
system-wide.

**Check:** it ends with `Installed. Next: ./agent.sh init`.

## 3. Create your profile

```bash
./agent.sh init
```

It asks for:

- a **profile name** (lowercase, e.g. your first name);
- the **country** you look for jobs in, your **city**, and your **time zone**;
- the path to your current **CV** (PDF, DOCX, TXT or Markdown).

Claude reads the CV and drafts three things in `profiles/<name>/`:

| File | What it is |
|---|---|
| `profile.yaml` | Your facts: contact details, education, certifications, experience, projects, skills (each linked to the experience that shows it), languages, and your **specialisms** (how you present yourself for different kinds of jobs) |
| `titles.yaml` | The job titles you want most (`p1`), adjacent ones (`p2`) and never (`exclude`) |
| `config.yaml` | Only your settings: location, the titles to search, the years of experience you can match |

No CV at hand? `./agent.sh init --from-example` starts from the fictional example
(Mona Adel), and you replace her facts with yours.

## 4. Review it (required)

Every CV and cover letter the agent sends is built **only** from `profile.yaml`, so check
it before the first run:

1. Open `profiles/<name>/.review-pending`: the checklist, plus anything Claude was unsure about.
2. Correct `profile.yaml`:
   - every fact must be true and nothing important missing;
   - put anything you must never claim in `not_held`;
   - fill `application_answers` (notice period, expected salary, and so on).
3. Check `titles.yaml` and the search titles in `config.yaml`.

Edit the files in any editor, or in the dashboard (Profile → Edit profile files; it opens
read/write even before the review). [profiles.md](profiles.md) explains every part.

When it's right:

```bash
./agent.sh reviewed
```

**Check:** `profile and titles are valid: runs can use this profile now`. Runs refuse a
profile until this passes.

## 5. A dry run

```bash
./agent.sh dry-run
```

This is a full run on a copy of the database: it searches, scores and writes CVs, but
nothing is drafted, sent or submitted. Read the summary it prints, then open a few of the
generated CVs (`profiles/<name>/output/dry-run/<date>/`).

If a CV says something untrue or weak, fix `profile.yaml`, not the CV.

**Check:** the first lines show `preflight: claude …, apiKeySource=none (subscription)`.
That means your subscription is used, never API credits.

## 6. The real run and the dashboard

```bash
./agent.sh run
```
```bash
./agent.sh dashboard
```

The dashboard opens at <http://127.0.0.1:8080>. The daily routine is in
[daily-use.md](daily-use.md).

## 7. Optional: more sources

| Source | Needs | Guide |
|---|---|---|
| LinkedIn public job search | nothing (on by default) | [sources.md](sources.md#linkedin-search) |
| Company job boards (Greenhouse, Lever, Ashby…) | nothing (on by default) | [sources.md](sources.md#company-boards) |
| WhatsApp job groups and channels | your WhatsApp, linked read-only | [sources.md](sources.md#whatsapp) |
| Gmail: email applications as drafts, job-alert emails, a digest | a free Google Cloud project | [gmail-setup.md](gmail-setup.md) |

Without Gmail, jobs that ask for an email application come out as **Apply yourself**, with
the email already written. **Write the email** opens your mail app with it filled in; you
attach the CV.

---

## Coming from the old single-user layout

Did your checkout keep `config/config.yaml` and `profile/master_profile.yaml` at the root
(before profiles)? Then stop the agent and the dashboard, and move everything into a
profile once:

```bash
scripts/migrate-to-profile.sh <name>
```

It copies the database first, moves `data/`, `output/`, `secrets/` and `.env` into
`profiles/<name>/`, and reduces your config to the settings that differ from the defaults.
Old backups go to `profiles/<name>/archive/`.
