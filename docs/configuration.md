# Configuration

Two layers:

| Layer | File | Who edits it |
|---|---|---|
| Defaults | `config/defaults.yaml` | Nobody (shipped with the code). Read it for every option and its comment |
| Your settings | `profiles/<name>/config.yaml` | You, or the dashboard's Settings page |

Your `config.yaml` holds **only what you change**. It is merged over the defaults key by
key, and a list in your file replaces the default list (it is not appended to). For example:

```yaml
filters:
  countries: [ Jordan ]      # replaces the default list
  max_years_required: 2      # the rest of `filters` keeps its defaults
```

Every load checks the merged result: a typo (`mdoe:`), a wrong type or a placeholder
starting with `TODO` stops the agent with the exact key. Check yours with:

```bash
./agent.sh status
```

Relative paths in config are **inside your profile folder** (`data/agent.db` means
`profiles/<name>/data/agent.db`).

---

## What you are most likely to change

| Setting | Default | Meaning |
|---|---|---|
| `timezone` | `Africa/Cairo` | dates in the dashboard and in deadlines |
| `search.linkedin.titles` | `[]` (set by init) | job titles searched on LinkedIn every run (also in Settings) |
| `search.linkedin.locations` | `[ Egypt ]` | where to search |
| `filters.countries` | `[ Egypt ]` | jobs in these countries are kept (plus remote if `allow_remote`) |
| `filters.max_years_required` | `3` | jobs asking for more years are skipped |
| `filters.max_job_age_days` | `30` | older postings are skipped as stale |
| `filters.skip_senior_titles` | `false` | skip Senior/Lead/Head titles unless the post asks for at most 2 years |
| `scoring.thresholds` | `p1: 45, p2: 60, p3: 75` | the minimum fit score to prepare an application, per title tier |
| `preferences.blocked_companies` / `favorite_companies` | `[]` | never apply / always prepare (also on each job in the dashboard) |
| `ats.keep_locations` | Egyptian cities, Remote, EMEA | company-board postings outside these are dropped |
| `apply.mode` | `draft` | `send` lets the agent send emails itself, under the `auto_send_*` and `daily_send_cap` guards. Stay on `draft` until you trust it |
| `forms.auto_submit` | `true` | submit web forms when every required answer is known; `false` only fills them |
| `cv.min_projects` / `max_projects` | `4` / `6` | projects on each CV |
| `dashboard.port` | `8080` | where the dashboard listens (always 127.0.0.1) |
| `dashboard.weekly_goal` | `15` | the goal ring on Today |

## Optional sources (off until you connect them)

```yaml
whatsapp:
  enabled: true
  required: true                 # stop the run if WhatsApp can't be read (default: go on)
  groups: [ "Some jobs group" ]   # names or ids from ./agent.sh whatsapp-groups
gmail:
  enabled: true                   # after ./agent.sh gmail-auth
alerts:
  enabled: true                   # job-alert emails in Gmail (needs gmail)
digest:
  enabled: true                   # a summary email after each run (needs gmail)
  to: you@gmail.com
```

See [sources.md](sources.md) and [gmail-setup.md](gmail-setup.md).

## Models and limits

`llm.extract_model` and `llm.score_model` (Haiku) read and score posts. `llm.tailor_model`
(Sonnet) writes CVs, cover letters and the init profile. There is no cap by default: a run
continues until your subscription's usage limit and stops cleanly there; the next run picks
up where it stopped. `llm.max_jobs_per_run` / `max_tailor_per_run` set a cap if you want one.

`llm.cli.pinned_version` is the Claude Code version the agent was tested with. Another
version only logs a warning.

## Settings from the dashboard

Settings (job titles, locations, channels, sources on/off, age and experience filters,
thresholds, company lists, excluded titles, weekly goal) are written back into your
`config.yaml` and `titles.yaml`. Your comments are kept, the result is validated before it
is written, and the previous file is kept as `.bak`. They apply from the next run.

## Choosing a profile

Every command uses one profile:

1. `--profile <name>` (`./agent.sh --profile mona run`), else
2. the `JOB_AGENT_PROFILE` environment variable, else
3. the active profile (`./agent.sh use <name>`, stored in `profiles/.active`), else
4. the only profile there is.

`./agent.sh profiles` lists them, with `*` on the one in use.

## Environment variables

| Variable | Meaning |
|---|---|
| `JOB_AGENT_PROFILE` | profile to use (see above) |
| `DASHBOARD_PORT` | port `agent.sh dashboard` waits on and opens (set it if you changed `dashboard.port`) |
| `LOG_LEVEL` | `info` (default), `debug` for full error details |

Private values go in the profile's `.env`, never in the environment of other programs:
`CLAUDE_CODE_OAUTH_TOKEN` (optional: a token from `claude setup-token`, instead of your
signed-in `claude`). Never set `ANTHROPIC_API_KEY`: in `claude -p` mode it would bill API
credits instead of your subscription, so the agent refuses to run with it.
