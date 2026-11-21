# Security

Threat model and controls for `job-agent` (requirement R19). Status values:
**done** = in code and tested; **planned (Pn)** = specified, built in that phase;
**manual** = a host or account setting Ahmed applies himself.

---

## 1. What we protect

| Asset | Why it matters | Where it lives |
|---|---|---|
| Claude subscription token (`CLAUDE_CODE_OAUTH_TOKEN`) | Anyone holding it can spend Ahmed's Pro usage for a year | `.env` (600, gitignored) |
| Gmail OAuth token | Read mail, create drafts and send as Ahmed | `secrets/` (P5, 700, gitignored) |
| WhatsApp session | Equivalent to a logged-in WhatsApp on the business number | `data/wa-session/` (P4, 700, gitignored) |
| The VM | Holds all of the above plus SSH keys, AWS profiles and a GitHub token | Ahmed's RHEL 10 workstation VM |
| Private phone number | Ahmed keeps one number out of public view | `profile/master_profile.yaml` (gitignored) and `.secrets-blocklist` |

## 2. Where an attack could come from

1. **Job posts** (WhatsApp, alert emails, ATS feeds): untrusted text, written by anyone. The main risk is **prompt injection**: a post that tells the model to run commands, change recipients or leak data.
2. **Links in posts:** fetching them could reach internal addresses (SSRF), for example `169.254.169.254` if the agent ever runs on EC2.
3. **The local dashboard:** a malicious web page in Ahmed's browser could try to reach `127.0.0.1:8080` (CSRF, DNS rebinding).
4. **Dependencies:** a compromised npm package or CLI version.
5. **Git:** a secret or the private number committed to the public repo.
6. **The host:** exposed services, missing patches, weak SSH settings.

---

## 3. Controls in the agent

| # | Control | Stops | Status |
|---|---|---|---|
| A1 | Every model call runs `claude -p` with **`--tools ""`**, an empty working directory, `--strict-mcp-config`, `--no-session-persistence` and stdin closed | Prompt injection has nothing to execute: no shell, no file access, no MCP | done (P2), tested with a fake CLI; flags verified on the real CLI |
| A2 | The CLI child process gets an **environment allowlist** (`PATH`, `HOME`, `CLAUDE_CODE_OAUTH_TOKEN`), not the agent's whole environment | Other secrets never reach the CLI | done (P2), tested |
| A3 | **Refuse to start if `ANTHROPIC_API_KEY` is set**; preflight call must report `apiKeySource: "none"`; never `--bare` | Silent API billing; broken auth going unnoticed | done (P2), tested; live preflight passes |
| A4 | CLI called by **absolute path** with a pinned version | PATH hijacking; untested CLI updates | config done; image pin planned (P9) |
| A5 | Model output validated twice (`--json-schema`, then zod); the model can't choose files, paths or extra recipients; `apply_email`, `apply_url` and `apply_phone` must appear literally in the post | Injected "send it to attacker@…" or path tricks | extraction checks done (P2, tested); recipients/attachments in P5 |
| A6 | `.env` is read into a private object, not exported to `process.env`; pino redacts token fields | Token in logs, crash dumps or child processes | done (P2): `.env` loader + redaction |
| A7 | **Text posts only**: no media is downloaded | Malicious image/PDF parsers; storing third-party files | done (P4): captions read, nothing downloaded |
| A8 | URL fetching guard: https only, DNS resolved and private/link-local/metadata ranges refused, no cookies, timeouts, size cap, redirects re-checked | SSRF | planned (P2 shorteners, P6 ATS) |
| A9 | PDF rendering with **JavaScript disabled and all network requests blocked** in Puppeteer; templates escape every value | Script execution or data exfiltration through the CV template | done (P3), tested: a script in the page does not run |
| A10 | Gmail scopes `gmail.readonly` + `gmail.compose` only; `draft` mode by default | A bug or injection sending mail | planned (P5) |
| A11 | Dashboard on 127.0.0.1 only, `Host` header allowlist, `Origin` check on writes, files served by DB id only | CSRF, DNS rebinding, path traversal | planned (P8) |
| A12 | Container: non-root, read-only root filesystem, `cap_drop: [ALL]`, `no-new-privileges`, secrets mounted read-only, **never the Docker socket** | Escape from the container to the host | planned (P9) |
| A13 | Exact dependency versions, lockfile, `npm ci`; `npm audit` and Trivy in CI; Dependabot | Supply-chain drift | partly done (pins); CI planned (P10) |
| A14 | WhatsApp `ReadOnlyWhatsApp` facade + a grep test for write calls | The agent ever sending or reacting on WhatsApp | done (P4): facade + tests over all of `src/` |

## 4. Controls in Git

| # | Control | Status |
|---|---|---|
| G1 | `.gitignore` covers `.env*` (except `.env.example`), `secrets/`, `data/`, `output/`, `backups/`, the real profile and config, and `.secrets-blocklist` | done |
| G2 | `scripts/check-secrets.sh`: blocks forbidden paths, token/key patterns (Claude, AWS, GitHub, Google OAuth, private keys) and every literal in the gitignored `.secrets-blocklist` (the private number, also when formatted with spaces or dashes). Prints the file and rule, never the value | done, 8 tests |
| G3 | Pre-commit hook `.githooks/pre-commit` runs G2 on every commit | **manual:** enable once per clone (below) |
| G4 | Full-history scan: `scripts/check-secrets.sh --history` | done: clean on 2026-11-20 |
| G5 | GitHub secret scanning and push protection on the repo | **manual** (below) |
| G6 | Secret scan in CI on every push | planned (P10) |

Enable the hook (one time, in `~/job-agent`):

```bash
git config core.hooksPath .githooks
```

---

## 5. Host and account checklist (manual)

Findings from a read-only check of the VM on 2026-11-20. Nothing on the host was
changed except `chmod 600 .env`.

| # | Finding | Risk | Fix |
|---|---|---|---|
| H1 | Kernel from June, no automatic updates (`dnf-automatic.timer` not found); the `c-ares` partial update broke Node | Known vulnerabilities stay open | `sudo dnf upgrade --refresh`, reboot; then enable automatic **security** updates (find the package with `dnf search automatic`, set `upgrade_type = security`, enable its timer) |
| H2 | Cockpit listening on `*:9090` | A web login to the VM exposed to the network | If unused: `sudo systemctl disable --now cockpit.socket` |
| H3 | Something listens on `0.0.0.0:80` | Unknown exposed service | Identify: `sudo ss -tlnp 'sport = :80'`; stop it if not needed |
| H4 | Old nginx container published on `0.0.0.0:8090` (BARQ assessment) | Docker-published ports bypass firewalld zones | Stop the stack (`docker compose down` in its folder) or publish on `127.0.0.1:8090` |
| H5 | `sshd` settings unreadable without root | Can't confirm password login is off | `sudo sshd -T \| grep -Ei '^(passwordauthentication\|permitrootlogin\|kbdinteractiveauthentication) '`; expect `no`, `no`, `no` |
| H6 | User `ahmed` is in the `docker` group | Equivalent to root: anyone with this account owns the VM | Keep the account strong (key-only SSH, screen lock); consider rootless Docker or `sudo docker` |
| H7 | `~/.git-credentials` holds a GitHub token in plain text | Account compromise = push access to every repo | Replace it with a **fine-grained** token limited to your repos with an expiry date, or SSH with a passphrase-protected key |
| H8 | No disk encryption on the VM | A copied VM disk exposes every token | Make sure the host laptop's disk is encrypted (the VM files live there) |
| H9 | GitHub account | Repo takeover | 2FA on; in `job-agent` → Settings → Code security: enable **Secret scanning** and **Push protection** |
| H11 | VM clock 18 h slow; chrony not stepping (`makestep 1.0 3`) | Breaks AWS signatures, OAuth token validity, TLS checks, and WhatsApp collection windows | `sudo chronyc makestep`; permanent: `makestep 1.0 -1` in `/etc/chrony.conf`, restart chronyd |
| H10 | Claude account | Subscription takeover | Protect the login email (Gmail 2FA), since Claude sign-in goes through it |

## 6. If something leaks

| Leaked | Do this first |
|---|---|
| Claude token | Run `claude setup-token` again and replace the value in `.env`; then sign out other sessions / revoke the old token from your Claude account settings (check claude.ai settings for where long-lived tokens are listed; this wasn't verified) |
| GitHub token | github.com → Settings → Developer settings → tokens → revoke; create a new fine-grained one |
| Gmail token (P5) | myaccount.google.com → Security → Third-party access → remove the app; delete `secrets/gmail_token.json` |
| WhatsApp session (P4) | Phone → WhatsApp → Linked devices → log out the device; delete `data/wa-session/` |
| Committed secret | Rotate it first (history rewrites don't un-leak a public value), then remove it from history |
