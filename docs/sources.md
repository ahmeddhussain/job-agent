# Sources

Where the agent finds jobs. Two sources work with no account. Two more are optional and
need your own WhatsApp or Gmail.

| Source | Account | On by default | Switch |
|---|---|---|---|
| [LinkedIn search](#linkedin-search) | none (public search, logged out) | yes | `search.linkedin.enabled` |
| [Company boards](#company-boards) | none (public ATS feeds) | yes | `ats.enabled` |
| [WhatsApp groups and channels](#whatsapp) | your WhatsApp, linked read-only | no | `whatsapp.enabled` |
| [Job-alert emails](#job-alert-emails) | your Gmail | no | `gmail.enabled` + `alerts.enabled` |
| [A post by hand](#a-post-by-hand) | none | always | |

Every source can be switched in the dashboard (Settings) or in your profile's
`config.yaml`. The **Sources** page in the dashboard shows, per group, channel, search title,
alert sender and board, how many jobs each one found, matched, prepared and got replies.

---

## LinkedIn search

Every run searches LinkedIn's **public** job search (no login, no cookies) for each title
in `search.linkedin.titles` and each location in `search.linkedin.locations`. It only looks
at jobs posted since that title's last search, at most 24 hours back. That covers both
**Easy Apply** jobs and jobs that apply on the company's site.

- Edit titles in the dashboard: Settings → Job titles.
- LinkedIn sometimes refuses a page (HTTP 429). The agent waits and retries; a search it
  couldn't finish keeps its time window and is completed next run.
- Requests are paced (`search.linkedin.min_interval_seconds`, 6 s by default).

```bash
npm run agent -- collect linkedin --dry-run
```

Expected: one line per title with the jobs listed and how many match your titles.

The agent never signs in to LinkedIn and never submits Easy Apply. Those jobs come out as
**Apply yourself**: `./agent.sh apply` opens each one in a browser where *you* are signed
in, with the cover letter on the clipboard and the CV ready.

## Company boards

Public job feeds of Greenhouse, Lever, Ashby, SmartRecruiters and Workable, plus plain
careers pages (watched for changes). Boards come from two places:

1. **Discovery (automatic):** a job link that leads to a company's ATS adds that board.
   The agent also tries the likely board from a company name, and keeps it only if it
   lists the same title.
2. **`companies.yaml`** in your profile: boards you always want polled. Get the entry for
   a careers page with:

```bash
npm run agent -- ats:detect https://boards.greenhouse.io/careem
```

```bash
npm run agent -- companies
```

`companies` lists every board polled and how each was found. Postings are pre-filtered by
title, location (`ats.keep_locations`) and age (`ats.max_age_days`).

## WhatsApp

Job groups and channels are often the main source in some markets. The agent reads them
through WhatsApp Web, **read-only**: it never sends, reacts, marks as read, or joins
anything (a test fails if the code calls any of those).

1. Link it (scan the QR with your phone: WhatsApp → Linked devices → Link a device):

   ```bash
   ./agent.sh whatsapp-login
   ```

2. List your groups and choose the job groups:

   ```bash
   ./agent.sh whatsapp-groups
   ```

3. Switch it on in your profile's `config.yaml`:

   ```yaml
   whatsapp:
     enabled: true
     groups: [ "Cairo DevOps Jobs", "120363000000000000@g.us" ]   # names or ids
     channels:
       follow_all: true     # also every channel you follow
       exclude: []          # channel names or ids to leave out
   ```

4. Check:

   ```bash
   npm run agent -- collect whatsapp --dry-run
   ```

Only text posts are read. Members are stored as salted hashes, never as numbers. The
session in `data/wa-session` is equivalent to a logged-in phone: keep the profile folder
private, and unlink it from your phone (Linked devices) when you stop using the agent.

An exported chat (`.txt` from WhatsApp's "Export chat") can be imported once:
`npm run agent -- collect whatsapp-export --file chat.txt --group "Group name"`.

## Job-alert emails

Wuzzuf, Indeed, Bayt and others send job alerts by email; their sites refuse automated
search. With Gmail connected ([gmail-setup.md](gmail-setup.md)):

1. Turn on alerts on those sites, with your Gmail.
2. In Gmail, create one filter that puts them under the label `job-alerts`
   (`alerts.gmail_label`).
3. Switch it on:

   ```yaml
   gmail:
     enabled: true
   alerts:
     enabled: true
   ```

LinkedIn's own alert emails are ignored by default (`alerts.skip_from`), because the
LinkedIn search above covers them. Tracking links in alerts are decoded offline, and
personal tokens are stripped before anything is stored.

```bash
npm run agent -- collect alerts --dry-run
```

## A post by hand

An old post, a forwarded email, a screenshot's text:

```bash
./agent.sh add post.txt --name "from a friend"
```

Or paste it in the dashboard (**+ Add**). It is processed by the next run like any other
post.

## Application emails

With Gmail connected, a run can read the emails about your applications. It **adds the jobs
you applied to without the agent** and **updates the ones being tracked**: received, viewed,
assessment, interview, offer, rejected.

```yaml
gmail:
  enabled: true
tracking:
  enabled: true
```

Or Settings → **Application emails**. No new Gmail permission is needed.

- **When:** only in a full live run (`./agent.sh run` or ▶ Run). Not in a dry run, "Process the queue only", or a run of one source. The first run looks 90 days back (`tracking.first_run_days`); the next ones look at what is new.
- **What is read:** emails with application words, CVs you sent as attachments, and mail from the people and companies you applied to. Mail from a private address (Gmail, Outlook…) is read only if you applied to that address, and promotions are left out. Add a sender to `tracking.skip_from` to never read it.
- **What is kept:** for an email about an application, the sender, subject, date and the one sentence that says what happened. For any other email, only its id.
- **What changes:** a status only moves forward, and a status you set after the email stays. Every change needs a sentence that really is in the email. If several applications fit, none is changed.
- **Where you see it:** Needs action → **Answers from companies**, the job panel → **Emails about this application**, the run's output and the digest. Each has **Open in Gmail** and **Undo** (or **Not my application**).
- **Gmail itself is never changed:** nothing is sent, moved, labelled or marked as read.
