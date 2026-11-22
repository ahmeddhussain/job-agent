# Troubleshooting log

Real issues hit while building `job-agent`, as **Symptom / Diagnosis / Fix**.

---

## 1. `node` crashes on startup: `undefined symbol: ares_query_dnsrec`

**Symptom.** Every Node.js command fails before running anything:

```
node: symbol lookup error: /lib64/libnode.so.127: undefined symbol: ares_query_dnsrec
```

**Diagnosis.**

```bash
rpm -q nodejs nodejs-libs c-ares
# nodejs-22.23.2-1.el10_2.x86_64
# nodejs-libs-22.23.2-1.el10_2.x86_64
# c-ares-1.25.0-6.el10.x86_64
dnf list --available c-ares
# c-ares.x86_64  1.34.6-5.el10_3.2
```

`libnode` from the RHEL 10.2 stream calls `ares_query_dnsrec`, which c-ares added
in 1.28. The installed c-ares is still the 1.25 build from the RHEL 10.0 image. It
was a partial update: Node.js was upgraded, but the library it links against was not.
This is the same image-vs-repo mismatch as the `systemd`/OpenSSL crash in the lab.

**Fix.** Update the library from the configured repos (needs root):

```bash
sudo dnf upgrade -y c-ares
node --version   # expected: v22.23.2
```

**Prevention.** Patch the workstation (`sudo dnf upgrade`) before installing
toolchains, as in the lab.

---

## 2. CLI crashes with `Error: write EPIPE` when piped into `head`

**Symptom.** During the P0 gate:

```
$ node dist/cli.js db:migrate | head -2
database: data/agent.db
applied: none
node:events:497
      throw er; // Unhandled 'error' event
Error: write EPIPE
    at Object.out (file:///home/ahmed/job-agent/dist/cli.js:6:62)
```

**Diagnosis.** `head` exits after two lines and closes the pipe. The CLI's next
`process.stdout.write` then fails with `EPIPE`, which Node emits as an `error`
event on the stdout socket. Nothing listened for it, so it became an uncaught
exception with a stack trace.

**Fix.** `src/cli.ts` listens for `error` on `process.stdout` and exits 0 on
`EPIPE` (a closed reader is a normal end of output). Other stream errors are still
thrown.

```bash
node dist/cli.js db:migrate | head -2; echo "exit=${PIPESTATUS[0]}"
# database: data/agent.db
# applied: none
# exit=0
```

---

## 3. Near-duplicate repost not detected (dedupe L2)

**Symptom.** P1 gate, fixture `06-devops-repost-edited` (fixture 01 reposted with one added line):

```
FAIL  test/unit/dedupe.test.ts > dedupe L0–L3 over the fixtures > 06-devops-repost-edited
AssertionError: expected undefined to be 'L2'
```

**Diagnosis.** Measured with a probe script: Hamming distance 7, Jaccard 0.946. The
token similarity passed; the simhash candidate filter (`≤ 3`, from PLAN 7) rejected
it first. On ~35-token posts one extra line moves 3–7 of 64 bits; unrelated posts
sit 26+ bits apart.

**Fix.** `simhash_max_distance: 10`, keeping the 0.90 Jaccard confirmation (D16). A
new test proves that a repost L2 still misses is caught by L3.

---

## 4. Trailing slash kept on URLs with a query string

**Symptom.**

```
AssertionError: expected 'https://example.com/jobs/1/?a=1&b=2' to be 'https://example.com/jobs/1?a=1&b=2'
```

**Diagnosis.** `canonicalizeUrl` trimmed the trailing `/` from the serialized string
only when there was no query string, so `/jobs/1/?a=1` and `/jobs/1?a=1` produced
different apply targets and would have defeated the L3 fingerprint.

**Fix.** Trim trailing slashes from `url.pathname` before serializing.

---

## 5. `claude -p` waits 3 s for stdin and warns

**Symptom.** First headless test call:

```
Warning: no stdin data received in 3s, proceeding without it. If piping from a slow command, redirect stdin explicitly: < /dev/null to skip, or wait longer.
```

**Diagnosis.** Run from a non-interactive shell, `claude -p` still waits for piped
input. It's the same class of problem as `ssh` in the lab scripts needing a closed stdin.

**Fix.** The LLM wrapper spawns the CLI with stdin closed (`stdio: ['ignore', 'pipe', 'pipe']`);
by hand, add `< /dev/null`. The rerun printed no warning.

---

## 6. Secret scanner printed `BLOCKED` but still reported "clean"

**Symptom.** New tests for `scripts/check-secrets.sh` failed on content rules while
the path rules passed:

```
× blocks a Claude OAuth token and never prints it
AssertionError: expected +0 to be 1
```

A `bash -x` trace showed `report a.md 'blocklisted literal'`, `findings=1`, and then
`check-secrets: clean (staged)`.

**Diagnosis.** The content check ran as the last command of a pipeline
(`git diff ... | sed ... | scan_text`). Bash runs every pipeline stage in a subshell,
so the `findings` counter was incremented in a copy that was thrown away. Path checks
ran in the main shell, which is why they worked. The first `--history` scan's "clean"
result could not be trusted either.

**Fix.** Feed `scan_text` through process substitution (`scan_text "$f" < <(git diff ...)`)
so it runs in the main shell. All 8 tests pass, and the history was re-scanned: clean.

---

## 7. Claude's isolated HOME was created inside the working directory

**Symptom.** After the first live P2 run, `data/claude-home` was empty, and:

```
$ find data/claude-work -maxdepth 3
data/claude-work/data/claude-home/.claude.json
$ stat -c '%A %n' data/claude-work/data/claude-home
drwxr-xr-x data/claude-work/data/claude-home
```

**Diagnosis.** `HOME` was passed to the CLI as the relative path `data/claude-home`,
and the CLI runs with `cwd=data/claude-work`, so the relative path resolved inside the
working directory. Two security properties broke: the "empty" working directory wasn't
empty, and the home was world-readable (`755`, created by the CLI).

**Fix.** `ClaudeCli` resolves `home` and `workdir` to absolute paths once, in the
constructor (a new test runs from another directory with relative paths). The stray
directory was deleted, and `grep` confirmed the token was not written to any file under
`data/`.

---

## 8. Good-fit jobs scored too low on the first live run

**Symptom.** The P2 gate passed, but "Junior DevOps Engineer" scored 30 and "Cloud
Engineer (AWS)" scored 18, so both were skipped as `low_fit`.

**Diagnosis.** The recorded fit outputs showed `matched: []` with the summary "The post
lists no requirements, so no must-haves can be matched", and a years-of-experience
requirement counted as missing even though the hard filter had already allowed it.

**Fix.** Rubric calibration in `prompts/score.md` (D19); same thresholds. Re-recorded:
84 and 75.

---

## 9. Tailored CVs stayed at two pages

**Symptom.** First live P3 gate run:

```
FAIL 01-devops-email-en [devops] pages=2 fill=100% ... ats=fail (pages: 2 (must be 1))
      trimmed: bullet cicd_infra, bullet lab_compliance, bullet lab_ansible, bullet t3_delivery, bullet nexora_gitops, bullet nexora_dr
```

**Diagnosis.** Page 2 held 14 lines: about 7 lines of projects plus Education,
Certifications and Languages. Each trim round removed about 2 lines and the limit
was 6 rounds. Project stack lines took 2 lines each.

**Fix.** `max_trim_rounds: 20` (each round is a local re-render), stack lines capped at
about one line, and the tailor prompt asks for 3 projects with 2–3 bullets. Then the
trim order was changed (D23) after reading the PDF: the first order cut Nexora's best
bullets before a generic experience line.

---

## 10. Validator flagged the word "documentation" as a technology

**Symptom.**

```
needs review: cover_letter: "documentation" is not in the profile
```

**Diagnosis.** The technology vocabulary included every bullet tag from the profile,
and tags hold ordinary words (`documentation`, `troubleshooting`, `reliability`).
The tag existed, but the word never appears in the profile's text, so the check fired.

**Fix.** The vocabulary is built from skill names (split on commas and parentheses)
plus the general tool list, not from tags. Verified: "documentation, troubleshooting,
reliability" are no longer terms; "Azure" still is.

---

## 11. LinkedIn URL wrapped across two lines in the contact line

**Symptom.** After switching to Ahmed's layout, the ATS check failed on all 3 CVs:

```
FAIL 01-devops-email-en [devops] pages=1 fill=99% ... ats=fail (linkedin link not found)
```

**Diagnosis.** The longer contact line (two phones plus three links) wrapped at the
hyphen inside `linkedin.com/in/ahmed-khater2611`. `pdftotext` then gives
`linkedin.com/in/ahmed-` and `khater2611` on separate lines, which is also how a parser
would read it. The check was right.

**Fix.** Contact items are `white-space: nowrap`, so the line breaks only between items.
The ATS check passes on all 3.

---

## 12. Validator rejected Ahmed's own bullet: "CKA" inside "package"

**Symptom.**

```
tailor: still invalid after fallback: bullet lab_drills: mentions "cka" (not held)
```

**Diagnosis.** The not-held check used a plain substring test. `lab_drills` says
"a pa**cka**ge rollback", which contains "cka". Because the untouched profile text
itself failed, the fallback could not repair it and the job crashed.

**Fix.** Not-held phrases match as whole words (spaces and hyphens interchangeable).
A self-check confirmed no profile fact trips any not-held phrase, and a test covers
"package" vs "CKA".

---

## 13. Support CV at 50% keyword coverage

**Symptom.**

```
FAIL 11-app-support-form [support] ... ats=fail (keyword coverage 50% < 70%)
missing: ['ticket-based change', 'jira']
```

**Diagnosis.** Two bugs. (1) The coverage counted every tool named in the fit's
requirement notes, including "Jira itself not shown", which the profile doesn't have.
(2) "SQL" was hidden because the "already shown" check found it inside "MySQL" as a
substring, and skills the fit cited as evidence ("ticket-based change") weren't added.

**Fix.** Coverage counts only profile-backed keywords; the duplicate check matches whole
words; skills cited as fit evidence are shown. Re-run: 100% on all three CVs.

---

## 14. wa:login showed nothing after the QR scan; a second command "refused"

**Symptom.** Ahmed scanned the QR; `wa:login` printed nothing afterwards. `wa:groups`
in a second terminal refused to start. Later runs crashed with a stack trace or failed:

```
Error: WhatsApp is not linked (QR requested). Run: agent wa:login
    at Client.<anonymous> (src/collect/whatsapp/readonly.ts:70:18)      <- uncaught
command failed Waiting failed: 30000ms exceeded
```

**Diagnosis (with evidence).**
- The session folder held 4 KB: the link never completed or was never saved.
- The "refusal": two processes can't open the same Chrome profile (`data/wa-session/session`), and nothing prevented or explained that.
- The crash: the `ready` promise rejected while `initialize()` was still running and nothing was listening yet → unhandled rejection.
- The 30 s timeout: whatsapp-web.js waits for WhatsApp Web's socket model to leave `OPENING/PAIRING`.
- Ruled out with measurements:
  - **network:** web.whatsapp.com answers in 0.6 s and a websocket handshake returns `101`;
  - **tsx rewriting functions:** the probe works under tsx and the function text is unchanged;
  - **the cached WhatsApp Web build:** live and cached both show a QR in about 10 s.
- Confirmed: the same probe that works on a fresh folder fails with `auth timeout` on the existing `data/wa-session`, and the real command on a fresh folder reaches the QR in 10.8 s and exits cleanly. The interrupted login left a broken session that every later start loaded.
- One earlier fresh run also failed and could not be reproduced (possibly throttling after many QR sessions in a row).

**Fix.**
- **Lock:** an exclusive lock (`data/wa.lock`, stale pid detection) gives a clear "another WhatsApp command is running" message.
- **Clean exits:** the rejection is handled at once, so failures exit cleanly; Ctrl-C/SIGTERM closes the browser so a session isn't left half-written.
- **Progress:** `wa:login` prints `authenticated` → `loading N%` → `ready`.
- **Timeout:** `whatsapp.auth_timeout_seconds: 60`.
- **Clean-up:** the broken session folders were deleted (none were linked).

---

## 15. WhatsApp collection found 0 posts: the VM clock was 18 hours slow

**Symptom.** The P4 dry run fetched messages but kept none:

```
✧Career✧Chance✧: since 2026-11-19T22:28:51Z fetched=15 in-window=0 kept=0 new=0
  [messages 2026-11-20T22:37:57Z .. 2026-11-21T14:26:15Z]
```

**Diagnosis.** Every message was dated after the window's end ("now"), so all of them
looked like they came from the future.

```
VM clock (UTC):   2026-11-20 22:29:03
Google HTTP Date: Sat, 21 Nov 2026 16:37:04 GMT
$ timedatectl     -> System clock synchronized: no   NTP service: active
$ chronyc tracking -> System time : 65280.613281250 seconds slow of NTP time
```

chrony was running and reaching its sources, but RHEL's default `makestep 1.0 3` only
steps the clock during the first three updates; after that it slews, which can't close an
18-hour gap (typical after a VM suspend/resume). The same skew broke AWS signatures in the
lab before (story_ntp).

**Hypothesis disproved:** after the clock was fixed (`chronyc tracking`: Leap status
Normal, offset 0), the `Waiting failed` socket timeouts from WhatsApp Web continued. Their
real cause is #16.

After Ahmed's fix, `timedatectl` still said `synchronized: no` for a few seconds: a
"Forward time jump detected!" made chrony distrust its sources (`^?`) until fresh samples
arrived. It reported `Leap status: Normal` 14 seconds later.

**Fix.**
- **Host (Ahmed, root):** `sudo chronyc makestep` once. To make it permanent on a VM that suspends, set `makestep 1.0 -1` in `/etc/chrony.conf` (step whenever the offset exceeds 1 s) and `sudo systemctl restart chronyd`.
- **Code:** the collector now fetches first and refuses to write anything if the newest message is more than 10 minutes in the future. It reports the measured offset and the fix, so a wrong clock can never again silently produce "0 new posts" (test added).

---

## 16. WhatsApp Web stuck: "open in another window"

**Symptom.** Intermittent, even with a correct clock and a valid linked session: runs that
worked a minute earlier failed with

```
command failed Waiting failed: 60000ms exceeded
```

and took about 2 minutes to exit.

**Diagnosis.** A probe on the real session printed the page state every 10 s:

```
10s PAGE {"socket":"UNLAUNCHED","text":"WhatsApp End-to-end encrypted Don't close this window. Your messages are downloading."}
20s PAGE {"socket":"UNLAUNCHED","text":"WhatsApp is open in another window. Click \"Use here\" to use WhatsApp in this window. Close"}
...
90s PAGE {"socket":"UNLAUNCHED", ...same...}
98s initialize failed TimeoutError: Waiting failed: 90000ms exceeded
```

WhatsApp still considered an earlier window of the same linked device active (closing the
headless browser isn't seen as a clean disconnect). On the conflict screen the socket never
leaves `UNLAUNCHED`, so whatsapp-web.js waits until its timeout. Its `takeoverOnConflict`
option only reacts after the socket starts, which never happens here. This also explains
Ahmed's first hang: a second command was started while the login was still syncing. The
earlier "broken session" in #14 was most likely this conflict too.

**Fix.** While starting, the facade checks the page every 3 s. On the conflict screen it
clicks "Use here", which only makes this window the active one for the same linked device:
it sends nothing and changes no chat. Verified live on three consecutive runs: each one
logged `whatsapp conflict screen: clicked "Use here"` and completed.

---

## 17. gmail:check: "Gmail API has not been used in project … or it is disabled"

**Symptom.** After `gmail:auth` printed `Authorized`, `gmail:check` failed with a 403 and printed
a huge JSON error object (request config, retry settings, response details) to the terminal:

```
"code":403 ... "reason":"SERVICE_DISABLED" ... "Gmail API has not been used in project 640217805034 before or it is disabled."
```

It still failed 45 minutes later, so it was not the "wait a few minutes" propagation delay.

**Diagnosis.** The OAuth client works (authorization succeeded, token holds both scopes), but the
Gmail API itself was never enabled in the project that owns that client (setup step 1.3, or it was
enabled in a different project). Separately, the CLI logged whole error objects at fatal level:
unreadable, and a risk, since API errors can carry request configuration.

**Fix.**
- Ahmed enables the Gmail API at the activation link for project 640217805034.
- Code: `explainGmailError` maps `SERVICE_DISABLED`/`accessNotConfigured` to one instruction with the link.
- The CLI prints Gmail setup errors as plain messages (exit 77), and any other error as a single `error: <message>` line. Full objects go to the log only at `LOG_LEVEL=debug`.

Verified:

```
The Gmail API is not enabled in the Google Cloud project of your OAuth client. Enable it here, wait a minute, then retry:
  https://console.developers.google.com/apis/api/gmail.googleapis.com/overview?project=640217805034
exit=77
```

Note: the token showed `refresh_token_expires_in: 604799` (7 days), so the app is in Testing mode and
`gmail:auth` must be re-run weekly (D27 addendum).

---

## 18. Real job-alert emails: confirmations labelled as alerts, and truncated text

**Symptom.** First real `collect alerts --dry-run`: 5 emails, including
`Ahmed, your application was sent to HiredBuddy` and two `Your job alert for … is now active`.
Three emails were exactly 20,012 characters, i.e. cut at the 20,000 cap.

**Diagnosis.**
- `jobs-noreply@linkedin.com` also sends application confirmations. Extracting jobs from them would
  prepare applications for jobs Ahmed had already applied to.
- Indeed's activation notices contain no jobs.
- Size: a probe on one Indeed email gave `full length 23803 | urls 31 | url chars 19984`. Every link
  is an opaque click tracker (`engage.indeed.com/f/a/…`) or a ~600-character `rc/clk?…&jk=<id>…`
  link, and the preheader is padded with zero-width characters.

**Fix.**
- `alerts.skip_subjects` (config, regex) skips application-status emails and activation notices.
- Links are canonicalized before the cap: LinkedIn → `linkedin.com/jobs/view/<id>`, Indeed →
  `<host>/viewjob?jk=<id>`. That also makes the same job get the same URL in every alert, which L3
  dedupe needs. Zero-width padding is stripped; the cap is now 60,000 characters.
- Result: LinkedIn alert 20,012 → 10,444 characters, Indeed alert 12,177 → 5,705.
- Still open: opaque `engage.indeed.com` trackers carry no job key. Resolving them needs an HTTP
  request to Indeed (with the SSRF guard, A8), so it is planned for P7.
