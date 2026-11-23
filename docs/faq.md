# FAQ

### What do I need?

A Claude subscription (Pro or Max) and a Linux machine with a desktop (macOS should work
but isn't tested yet). LinkedIn search and company boards work with no other account.
WhatsApp and Gmail are optional ([sources.md](sources.md)).

### Does it cost anything besides the subscription?

No. It uses Claude Code on your subscription (the agent refuses to run with an API key),
and Google's Gmail API is free for personal use. A run uses part of your subscription's
usage. When the limit is reached, the run stops cleanly and the next one continues.

### Does it apply on its own?

Partly, and only where it's safe:

| How the job says to apply | What the agent does |
|---|---|
| Email | Writes the email with your CV attached as a **Gmail draft** (you review and send, or `./agent.sh send` sends all reviewed drafts). Without Gmail it writes the email out for you |
| A company form without a captcha | Fills it, uploads the CV and **submits** it (switch off with `forms.auto_submit: false`) |
| A form with a captcha, a sign-in, LinkedIn Easy Apply, Wuzzuf, Bayt, Indeed | Prepares everything; `./agent.sh apply` opens each one pre-filled and you submit |
| WhatsApp | Prepares the CV and message; you send it from your phone |

### Will it lie on my CV?

No. Every CV, letter and answer is checked against your `profile.yaml`: no skill, number,
employer or certification can appear unless it is there. Things you list under `not_held`
can never appear. A job that would need more is skipped or sent to review.

### Is every CV one page?

Yes, always (it isn't configurable upward). It is rendered to PDF with embedded fonts and
checked like an ATS would read it: page count, headings, contact details, and how many of
the job's requirements it covers. A CV that fails isn't used.

### Can I use it for a field other than IT?

Yes. Your specialisms, titles, skills and search titles are all in your profile, not in the
code ([profiles.md](profiles.md)). The CV template's sections (Profile, Education,
Certifications, Experience, Projects, Skills, Languages) fit most fields. The defaults
lean on what it was built for (IT jobs in Egypt), so set your location and titles in
`./agent.sh init`.

### Another country?

Set `filters.countries`, `search.linkedin.locations`, `ats.keep_locations` and
`timezone` in your profile's `config.yaml` (init asks for them). Posts in Arabic are
understood; CVs are written in English (`apply.cv_language`).

### Can two people share one installation?

Yes. Each runs `./agent.sh init` with their own name, and each profile has its own
database, sessions and outputs. Run one profile's dashboard at a time on the default
port, or give each its own `dashboard.port`.

### How does it know what I want?

Your title tiers (`titles.yaml`), the fit score against your profile, and what you tell
it. "Not a fit" on a job, with a reason, makes the agent suggest rules: exclude a title,
block a company, a threshold. You accept or dismiss each suggestion in Settings. It never
changes your rules by itself.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `no profile yet: create yours with ./agent.sh init` | Run `./agent.sh init` (or `--profile example` to try the example) |
| `this profile has not been reviewed yet` | Check `profile.yaml` and `titles.yaml`, then `./agent.sh reviewed` |
| `several profiles (…): choose one` | `./agent.sh use <name>` |
| `ANTHROPIC_API_KEY is set …` | Remove it from your environment and from the profile's `.env` |
| `preflight: authenticated by '…', not the subscription` | Sign in with `claude` (your subscription), or put a `claude setup-token` token in `.env` |
| `Gmail authorization expired or was revoked` | `./agent.sh gmail-auth` (weekly while your Google app is in Testing mode) |
| `no desktop session found` | Run `./agent.sh apply` from a terminal on your desktop, not over SSH |
| LinkedIn refused pages (HTTP 429) | Nothing: the search is retried and finished next run |
| A CV went to "Needs review" | The job panel says why (often an eligibility condition or low keyword coverage). "Prepare anyway" retries it |
| `config is invalid: … mdoe` | A typo in your `config.yaml`: the message names the key |

The development log of real problems and their fixes is
[dev/troubleshooting.md](dev/troubleshooting.md).
