# Runbook: daily use

What to do each day, what each command does, and what to do when something looks wrong.
Everything runs from the project folder on the VM, in a terminal **on the VM's desktop**
(the apply window and the dashboard open there).

```bash
cd ~/job-agent
```

---

## 1. The daily routine (about 10 minutes)

| Step | Command | What happens |
|---|---|---|
| 1 | `./agent.sh run` | Reads new posts from the WhatsApp groups, the job-alert emails and the company boards; drops duplicates; scores every job; prepares a one-page CV and a cover letter for each good match; **drafts** email applications in Gmail; **submits** web forms it can finish; emails you a digest |
| 2 | `./agent.sh dashboard` | Opens the tracker at http://127.0.0.1:8080. Two sections at the top: **Apply yourself** and **Email drafts waiting** |
| 3 | Gmail → Drafts | Read each application draft; edit or delete any you don't want |
| 4 | `./agent.sh send` | Lists the drafts still in Gmail, asks once, sends them all (your edits are kept) |
| 5 | `./agent.sh apply` | Opens each "apply yourself" job in a Chrome window, pre-filled. Check it, solve the captcha if one appears, click Submit, press Enter in the terminal |
| 6 (weekly) | `./agent.sh skipped 7` | What the agent skipped and why, with links. Rescue anything it missed (section 4) |

The run takes a while when there are many new posts (each job needs a few Claude calls).
It stops cleanly at your Claude usage limit; the next run continues where it stopped.

**Expected end of `./agent.sh run`:**

```
run 12: SUCCESS
Next: ./agent.sh dashboard (review), ./agent.sh apply (finish the rest), ./agent.sh send (send drafts)
```

`PARTIAL` means a source failed or the usage limit was reached: the digest and the dashboard's
"Last run" tile say which. Nothing is lost; run again later.

---

## 2. What the agent does for each kind of job

| How the job says to apply | What the agent does | What is left for you |
|---|---|---|
| Email ("send your CV to hr@…") | A Gmail **draft**: the cover letter is the body, the CV is attached, the required subject is used | Review in Gmail, then `./agent.sh send` |
| Company form without a captcha (Google Forms, many careers pages) | Fills it, uploads the CV, **submits**, checks the confirmation, keeps screenshots | Nothing: the job shows as Applied |
| Company form with a captcha (Greenhouse, Lever, Ashby) | Tries; if the site doesn't confirm, the job goes to **Apply yourself** | `./agent.sh apply`: the form opens pre-filled; you submit |
| A required question your profile can't answer (e.g. current salary) | Does not guess; **Apply yourself** with the question named | Answer it in the window, or add the answer to `profile/master_profile.yaml` → `application_answers` so it's used next time |
| LinkedIn Easy Apply, Wuzzuf, Bayt, Indeed | Prepares the CV and letter; **Apply yourself** | `./agent.sh apply` opens the job (signed in as you), the letter is on the clipboard: click Easy Apply, attach the CV |
| WhatsApp ("send your CV on WhatsApp") | Prepares the CV and the letter; a wa.me link | Send it from your phone (the agent never sends WhatsApp messages) |

Every application uses a CV that is exactly one page, passed the ATS check, and contains only
facts from your profile.

---

## 3. The dashboard

`./agent.sh dashboard` (Ctrl-C stops it). Only reachable from this VM (127.0.0.1).

- **Apply yourself:** link, CV, letter, the filled-form screenshot, and why the agent stopped. **Mark applied** when done (or `./agent.sh apply` marks it for you).
- **Email drafts waiting:** what `./agent.sh send` would send.
- **Tiles:** matches in the last 24 h, ready, needs review, applied, interviews, response rate, last run health.
- **Job table:** filter by status, source, priority; click a row for the fit summary, the "why this role" line for interviews, the cover letter, notes.
- **Status changes** you make (Interview, Offer, Rejected) are saved with history. Replies to sent applications are detected by the next run (● reply).
- **Company boards polled:** the companies found automatically from job links, and how each was found.

---

## 4. Catching what the agent missed

```bash
./agent.sh skipped 7
```

Lists every skipped job of the last 7 days, grouped by reason, with its id, fit score and link:

| Reason | Meaning |
|---|---|
| `low_fit` | Scored below the threshold for its title tier |
| `excluded_title` | Sales, HR, accounting… (`config/titles.yaml`) |
| `over_experience` | Asks for more than 3 years |
| `location` | Outside Egypt and not remote |
| `deadline_passed` | Past its deadline |
| `duplicate` | Same job seen before (hidden unless `--all`) |

To apply to one anyway:

```bash
./agent.sh redo <id>
```

That prepares it now (CV, letter, draft or form). Or set its status to **New** in the dashboard:
the next run prepares it.

---

## 5. Weekly and occasional tasks

| When | Command | Why |
|---|---|---|
| Every 6 days (Gmail app in Testing mode) | `./agent.sh gmail-auth` | Google expires Testing tokens after 7 days. `./agent.sh run` warns a day before |
| If WhatsApp shows "logged out" | `./agent.sh whatsapp-login` | Scan the QR again (WhatsApp → Linked devices) |
| First `./agent.sh apply` | Sign in to LinkedIn in the window that opens | It remembers you in `data/browser-profile` |
| Before trying a config change | `./agent.sh dry-run` | A full run on a copy of the database; nothing is sent, drafted or submitted |
| An old post or a forwarded email | `./agent.sh add post.txt --name "where it came from"` then `./agent.sh run` | Adds it to the queue |
| A job's CV or letter needs redoing (after a profile edit) | `./agent.sh redo <id>` | Delete the old Gmail draft yourself first (the agent can't delete) |

---

## 6. When something looks wrong

| Symptom | Check | Fix |
|---|---|---|
| `Gmail unavailable` / `invalid_grant` | `./agent.sh status` | `./agent.sh gmail-auth` |
| `agent run is already running (pid …)` | Another `run`, `apply` or `redo` is going | Wait, or stop that process |
| WhatsApp stuck at start | Another WhatsApp command running | One at a time (troubleshooting #14, #16) |
| `usage limit reached` | Your Claude usage limit | Nothing: the next run continues |
| A form job always goes to Apply yourself with the same question | The question in the dashboard reason | Add the answer to `application_answers` in your profile |
| A good job was skipped | `./agent.sh skipped` | `./agent.sh redo <id>`; if it keeps happening, tell the scoring (config `scoring.thresholds`) |

Every real problem and its fix: `docs/troubleshooting.md`.
