# Gmail setup (one time, manual)

The agent reads job-alert emails and creates application drafts in your Gmail through the
official Gmail API. Google requires a small "app" in your own Google Cloud account for that.
Nothing here costs money. Menu names in the Google Cloud console change from time to time;
if one differs, look for the closest match.

---

## 1. Google Cloud project and Gmail API

1. Open <https://console.cloud.google.com/> with the Gmail account you apply from.
2. Create a project: top bar → project picker → **New project** → name `job-agent` → Create.
3. **APIs & Services → Library** → search **Gmail API** → **Enable**.

## 2. OAuth consent ("Google Auth Platform")

1. **Google Auth Platform → Branding** (or "OAuth consent screen"). Google requires all of these before it lets you publish:
   - App name: `job-agent`
   - User support email and developer contact: your Gmail
   - App home page: a page you control, e.g. your GitHub Pages site `https://<you>.github.io`
   - Privacy policy: a page on the same site. `docs/consent/privacy.html` is a template: put your name in it and publish it there first
   - Authorized domains: that site's domain, e.g. `<you>.github.io`
   - (Only publishing needs these. In **Testing** mode, step 2 option 2, you can skip them.)
   - Save.
2. **Audience**: user type **External**. Click **Publish app** so the status is **In production**.
   - Why: apps left in "Testing" get refresh tokens that **expire after 7 days**, which would silently break the daily run.
   - "In production" without Google's verification is fine for your own account. You'll see a "Google hasn't verified this app" warning when you authorize; that's expected.
3. **Data access** (or "Scopes"): add exactly these two:
   - `https://www.googleapis.com/auth/gmail.readonly` (read alert emails, check Sent)
   - `https://www.googleapis.com/auth/gmail.compose` (create drafts; send only when you switch `apply.mode` to `send`)

## 3. Desktop OAuth client

1. **Google Auth Platform → Clients → Create client** → Application type **Desktop app** → name `job-agent-desktop` → Create.
2. **Download JSON**, then on the machine that runs the agent:

```bash
mkdir -p ~/job-agent/secrets && chmod 700 ~/job-agent/secrets
```

```bash
mv ~/Downloads/client_secret_*.json ~/job-agent/profiles/<name>/secrets/gmail_client.json && chmod 600 ~/job-agent/profiles/<name>/secrets/gmail_client.json
```

Replace `<name>` with your profile's name. Profile folders are gitignored and blocked by the pre-commit secret scan.

## 4. Job-alert label (Gmail filter)

### 4a. Turn the alerts on first

| Site | How | Frequency |
|---|---|---|
| LinkedIn | Jobs → search a title (e.g. "DevOps Engineer", location Egypt) → **Set alert** → Manage alerts: **Email**, **Daily** | one alert per title: DevOps, Cloud, Platform, Technical Support, Application Support, Linux/System Administrator, NOC/Monitoring, IT Engineer |
| Wuzzuf | search a title → **Get job alerts** / **Save search** with email notifications | daily |
| Bayt | search a title → **Create job alert** → email, daily (max 15 alerts) | daily |
| Indeed (eg.indeed.com) | search a title + "Egypt" → **Get new jobs by email** | daily |
| Glassdoor (optional) | search → **Create job alert** | daily |

### 4b. One filter for all of them

Gmail → Settings → **See all settings → Filters and Blocked Addresses → Create a new filter**.
Paste into **From**:

```
jobalerts-noreply@linkedin.com OR jobs-noreply@linkedin.com OR jobs-listings@linkedin.com OR wuzzuf.net OR bayt.com OR indeed.com OR glassdoor.com
```

→ **Create filter** → tick **Apply the label** → **New label** `job-alerts` → tick **Also apply filter to
matching conversations** → **Create filter**. Leave **Skip the Inbox unticked**: these domains also send
employer messages and application updates you must see.

Why it is shaped this way:
- **LinkedIn by exact address.** linkedin.com also sends messages and notifications that are not jobs.
  `jobalerts-noreply@` is the documented job-alert sender; `jobs-noreply@` and `jobs-listings@` are
  other LinkedIn job senders whose exact use isn't documented, included so job emails aren't missed.
- **Wuzzuf, Bayt, Glassdoor by domain.** They publish no alert sender address, so the whole domain is
  matched (a domain also matches its subdomains, e.g. `mail.wuzzuf.net`). Their newsletters get the
  label too; extraction marks them "not a job post", which costs a few tokens and nothing else.
- **Indeed by its main domain** (`indeed.com`). Indeed also sends from `indeedemail.com` and
  `indeedmail.com`; those are left out because they relay employer messages.

After the first alerts arrive, open one from each site and check **From**. If an address isn't matched,
add it to the filter (edit the filter, then re-apply it to existing mail).

### "You will need to submit your app for verification"

`gmail.readonly` and `gmail.compose` are **restricted** scopes. Verifying an app that uses them
needs a paid third-party security assessment, which isn't worth it for a personal tool. Two ways on,
without verification:

1. **Published but unverified** (if the console lets the status become *In production*): you see
   a "Google hasn't verified this app" screen when you authorize (Advanced → Go to job-agent), and the
   project is capped at 100 users for its lifetime, which is fine for one user. Tokens don't expire weekly.
2. **Testing** (if publishing is blocked): **Audience → Test users → Add users** → your Gmail. Same
   features, but Google expires the authorization after **7 days**, so run `gmail:auth` again weekly.
   `gmail:check` shows the token's age and warns after 6 days. An expired token makes every Gmail step
   stop with: *"Gmail authorization expired or was revoked. Run: npm run agent -- gmail:auth"*.

## 5. Authorize the agent

```bash
cd ~/job-agent && ./agent.sh gmail-auth
```

It prints a Google link. Open it in a browser **on the same machine**, choose your account, accept the
"unverified app" warning (Advanced → Go to job-agent) and allow both permissions. The browser
then shows "Authorized, you can close this tab". The token is saved to
`secrets/gmail_token.json` in your profile folder (owner-only). Then switch Gmail on in your
profile's `config.yaml`:

```yaml
gmail:
  enabled: true
alerts:
  enabled: true # optional: read job-alert emails (step 6 of docs/sources.md)
```

Check:

```bash
cd ~/job-agent && ./agent.sh status
```

Expected: `gmail: on`, your address, the `job-agent` scopes, and how many emails carry the `job-alerts` label.

## Revoking access

<https://myaccount.google.com/permissions> → job-agent → **Remove access**, then delete
`secrets/gmail_token.json` in your profile folder and set `gmail.enabled: false`.
