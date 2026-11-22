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
   - App home page: `https://ahmeddhussain.github.io`
   - Privacy policy: `https://ahmeddhussain.github.io/privacy.html` (the page is `docs/consent/privacy.html`; publish it on the portfolio site first)
   - Authorized domains: `ahmeddhussain.github.io`
   - Save.
2. **Audience**: user type **External**. Click **Publish app** so the status is **In production**.
   - Why: apps left in "Testing" get refresh tokens that **expire after 7 days**, which would silently break the daily run.
   - "In production" without Google's verification is fine for your own account. You'll see a "Google hasn't verified this app" warning when you authorize; that's expected.
3. **Data access** (or "Scopes"): add exactly these two:
   - `https://www.googleapis.com/auth/gmail.readonly` (read alert emails, check Sent)
   - `https://www.googleapis.com/auth/gmail.compose` (create drafts; send only when you switch `apply.mode` to `send`)

## 3. Desktop OAuth client

1. **Google Auth Platform → Clients → Create client** → Application type **Desktop app** → name `job-agent-desktop` → Create.
2. **Download JSON**, then on the VM:

```bash
mkdir -p ~/job-agent/secrets && chmod 700 ~/job-agent/secrets
```

```bash
mv ~/Downloads/client_secret_*.json ~/job-agent/secrets/gmail_client.json && chmod 600 ~/job-agent/secrets/gmail_client.json
```

`secrets/` is gitignored and blocked by the pre-commit secret scan.

## 4. Job-alert label (Gmail filter)

1. In Gmail, open one LinkedIn job-alert email and note the sender (usually `jobalerts-noreply@linkedin.com`). Do the same for Wuzzuf, Bayt and Indeed alerts if you use them.
2. Gmail → Settings (gear) → **See all settings → Filters and Blocked Addresses → Create a new filter**.
3. **From:** the senders joined with `OR`, for example:
   `jobalerts-noreply@linkedin.com OR jobs-noreply@linkedin.com`
4. **Create filter** → tick **Apply the label** → **New label** `job-alerts` → tick **Also apply filter to matching conversations** → Create. ("Skip the Inbox" is optional.)
5. On LinkedIn: search for a role (for example "DevOps Engineer", location Egypt), then **Set alert → Daily**. Repeat for "Cloud Engineer", "Technical Support", "Linux Administrator".

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
cd ~/job-agent && npm run agent -- gmail:auth
```

It prints a Google link. Open it in a browser **on the VM**, choose your account, accept the
"unverified app" warning (Advanced → Go to job-agent) and allow both permissions. The browser
then shows "Authorized, you can close this tab". The token is saved to
`secrets/gmail_token.json` (owner-only).

Check:

```bash
cd ~/job-agent && npm run agent -- gmail:check
```

Expected: your address, the `job-agent` scopes, and how many emails carry the `job-alerts` label.

## Revoking access

<https://myaccount.google.com/permissions> → job-agent → **Remove access**, then delete
`secrets/gmail_token.json`.
