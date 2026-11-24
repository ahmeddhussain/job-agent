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

---

## 19. Job-feed responses empty or cut off mid-JSON

**Symptom.** While recording ATS fixtures, the same Lever URL returned in turn:

```
http=000 size=0
http=200 size=17528   -> json.decoder.JSONDecodeError: Unterminated string starting at: line 1 column 17084
http=200 size=40283   -> valid json
```

The same instability showed earlier as a GitHub push timeout and an empty first download.

**Diagnosis.** The VM's connection intermittently drops or truncates responses; the server is
fine (the third try was complete). A collector that trusts the first response would record a
failed run, or silently fewer jobs, at random.

**Fix.** `PoliteHttp.json()` retries network errors and bodies that aren't complete JSON (3 tries,
growing delay). Refusals by the SSRF guard and HTTP 4xx answers are final and not retried. A test
feeds a truncated body first and checks the retry succeeds.

---

## 20. Job-alert links: personal tokens and click-trackers

**Symptom.** Reading the real alert emails for company discovery (2026-11-22):

```
bayt.com/en/egypt/jobs/devops-monitoring-engineer-75445933/?utm_source=…&email_name=j_job_alerts_channels&userToken=v2%3A9240…
jbyxlvy7.r.eu-west-1.awstrack.me/L0/https:%2F%2Fwuzzuf.net%2Fjobs%2Fp%2Fqenpbmle0qpo-junior-system-administrator-…/1/0102…
```

**Diagnosis.** Every Bayt link carries a per-user `userToken`, which the canonicalizer kept, so it
would have been stored in `raw_items`, `jobs.apply_url`, the digest and the tracker. Wuzzuf wraps
every link in an Amazon SES click-tracker (`awstrack.me`), so the job URL was the tracker's, not
Wuzzuf's, and L3 dedupe could not match the same job from two sources.

**Fix.** `canonicalizeUrl` decodes known wrappers offline (`awstrack.me` path, Bayt `target_link`,
Google `/url?q=`, Facebook `l.php?u=`), without a request to the tracker, and strips `userToken` and
`email_name`. Tests use the real link shapes with the token replaced.

---

## 21. LinkedIn's logged-out page no longer shows the company's apply link

**Symptom.** The plan was to read "Apply on company website" links from LinkedIn's public job
page (`<code id="applyUrl">`, as older scrapers do). On four real jobs (2026-11-22):

```
jobs-guest/jobs/api/jobPosting/<id>  http=200  applyUrl: not present   apply-link-offsite: present
jobs/view/<id>                       http=200  applyUrl: not present   apply-link-offsite: present
```

**Diagnosis.** The hypothesis was wrong: LinkedIn now shows the external link only after sign-in.
The logged-out page still has the full description, the company and whether the job is offsite.
Indeed (`401`) and Bayt (`403`) refuse automated requests outright.

**Fix.** The company's own posting is found another way (D30): from the company name, the agent
tries the ATS boards for it and accepts one only if it lists the same title. The description comes
from the LinkedIn page. Indeed and Bayt are never fetched (`enrich.skip_hosts`). Whether a job
without `apply-link-offsite` is always Easy Apply is assumed, not yet seen on a real page.

---

## 22. Stale-lock check took a live process for a dead one

**Symptom.** New test: a lock file holding pid 1 (always alive) was replaced instead of refused.

**Diagnosis.** `process.kill(pid, 0)` throws `EPERM` for a live process owned by another user;
the WhatsApp lock (troubleshooting #14) and the new run lock treated every error as "not running".
For the same user it worked, which is why it never showed up.

**Fix.** `EPERM` counts as alive (`src/util/lock.ts`, shared by both locks). Only `ESRCH` (no such
process) frees the lock.

---

## 23. Guessing a company's board took a minute per company

**Symptom.** Live discovery check on three real alert jobs: the Wuzzuf job (company "RayC
Technologies", no ATS board) took 59 s. Timing each probe:

```
404 0.53s   boards-api.greenhouse.io/v1/boards/rayctechnologies/jobs
404 24.08s  api.lever.co/v0/postings/rayctechnologies?mode=json
404 0.53s   api.ashbyhq.com/posting-api/job-board/rayctechnologies
404 0.61s   apply.workable.com/api/v1/widget/accounts/rayctechnologies
200 0.47s   api.smartrecruiters.com/v1/companies/rayctechnologies/postings   {"totalFound":0}
```

**Diagnosis.** Lever answers an unknown board's 404 only after about 24 s, and the probe asked the
ATSs one after another for up to three name variants.

**Fix.** Probes use their own client: an 8 s timeout and one attempt (a timeout counts as "no board").
The five ATS hosts are asked in parallel for each name variant, each host still paced. Same results
on the same three jobs; slowest job 59 s → 8 s. Real boards are still listed through the normal
client with retries (#19).

---

## 24. `ReferenceError: __name is not defined` inside the browser

**Symptom.** Inspecting real application forms with `page.evaluate(() => { … })` run through `tsx`:

```
===== https://jobs.ashbyhq.com/thndr/…/application ERR ReferenceError: __name is not defined
```

**Diagnosis.** esbuild (used by `tsx`) wraps named inner functions in a `__name(...)` helper so
`Function.name` survives. The function is serialized and run inside the page, where that helper
doesn't exist.

**Fix.** Code that runs in the page is a plain JavaScript string (`SCAN` in `src/apply/forms.ts`),
passed to `page.evaluate(string)`. It is the same in `tsx`, the compiled build and Vitest.

---

## 25. A consent checkbox came through as its field name

**Symptom.** Form test: `required questions the profile can't answer: consent`. The real label was
"I agree to the privacy policy".

**Diagnosis.** For an input wrapped in its own `<label>`, the label finder searched *inside* that
label for a heading, found none, and fell back to the `name` attribute.

**Fix.** When the nearest container is the element's own `<label>`, its text is the label.

---

## 26. A page that never confirmed counted as submitted

**Symptom.** Form test: a captcha-protected page that shows nothing after Submit was reported as
`submitted`.

**Diagnosis.** Success also accepted a URL containing `thank|confirm|success|submitted`. The test
page's own address contained `submitted` (its script did), and so can a real careers URL. The
URL had not changed at all.

**Fix.** The URL only counts when it **changed** after the click and is a real page. Confirmation
text on the page remains the main signal.

---

## 27. First live run: links, countries and the company form lost to a duplicate

**Symptom.** Live run 1 (D33 addendum):

```
READY Mid DevOps Engineer · Vertex Technologies · apply yourself: https://wuzzuf.net/jobs/p/vt9q66w4fv2b-…?a=Nancy+Weekly+jobs+Aug26+%2F+Recommended+Jobs…&l=rje&o=1&t=JRrj&v=nwaug26
READY DevOps Engineer - Associate · PwC Brasil · …
READY Senior DevOps/Infrastructure Engineer · Thndr · apply yourself (Easy Apply on LinkedIn …)
enriched "Staff Software Engineer" · OVERJET: company site …   (twice)
```

**Diagnosis.**

- **Wuzzuf links:** Wuzzuf adds its own tracking parameters (`a`, `l`, `o`, `t`, `v`), not `utm_*`, so they survived canonicalization.
- **PwC Brasil:** the alert line gave no country. The job page did ("…, Brazil"), but that was used only when the description was re-extracted.
- **Thndr:** the job was both on LinkedIn (alert) and in Thndr's Ashby feed. The LinkedIn copy was processed first and became the original; the Ashby copy, which has the company form, became its duplicate and was dropped. Also, Easy Apply jobs never searched for a company board.
- **Overjet:** the alert listed the same job twice; L3 only compares with stored jobs, not with jobs from the same item.

**Fix.**

- Wuzzuf and Bayt job URLs keep only their path.
- The job page's country fills a missing country.
- A duplicate from a company feed (or traced to a company form) gives the original its `apply_url_direct`.
- Easy Apply jobs are searched for a company board too.
- Repeated jobs within one item are dropped before enrichment.
- Each change has a test.

---

## 28. CI: tests failed on GitHub but passed on a clean clone

**Symptom.** The first CI run (commit 90a02d5) failed at `npm test`; lint and typecheck passed. A
fresh `git clone` + `npm ci` + `vitest run` on the VM passed (254 passed, 1 skipped).

**Diagnosis.** The run logs need a signed-in GitHub client, so they weren't read. The difference
had to be the runner: `ubuntu-24.04` restricts unprivileged user namespaces through AppArmor, and
Chrome's sandbox (used by the PDF and form tests) needs them. This was a hypothesis until the fix
below made the next run pass.

**Fix.** The workflow sets `kernel.apparmor_restrict_unprivileged_userns=0` before the tests, as
puppeteer documents for CI. It doesn't turn off Chrome's sandbox. Run for fa9acdd: success.

---

## 29. Scoring listed a degree and fluent English as "missing"

**Symptom.** The job detail for Henkel's Platform Engineer (dashboard, 2026-11-23) listed under missing:

```
Fluent English is stated in the profile Languages section but has no citable id, so it is not counted
Bachelor's degree is stated in the Education section but has no citable id, so it is not counted
```

**Diagnosis.** The scoring rule requires every matched requirement to cite a profile id. Education,
certifications and languages were given to the model as plain text without ids, so requirements met
by them could never count, and fit scores came out lower than they should.

**Fix.** The profile shown to the scorer gives them ids (`scu_bsc: …`, the certification ids,
`lang_english`), the evidence check accepts them, and the prompt names them. Scores from earlier runs
are unchanged; new jobs are scored with the ids.

---

## 30. `Retry-After: 0` made the client wait 30 seconds

**Symptom.** New LinkedIn search tests timed out at 20 s; the fake server answered `429` with
`Retry-After: 0`.

**Diagnosis.** `PoliteHttp` read the header as `Number(h) || 30`; `0` is falsy, so "retry now" became
a 30 s wait. Real servers that send `0` were slowed down the same way.

**Fix.** A finite, non-negative header value is used as is; only a missing or unreadable header means 30 s.

---

## 31. LinkedIn refuses about one request in four

**Symptom.** Manual search test of the 8 titles (2026-11-23):

```
DevOps Engineer start=0 -> HTTP 429
IT Engineer start=50 -> HTTP 429
Technical Support start=10 -> HTTP 429
TOTAL 159 jobs, 23 requests, 5 refusals          (5 s apart)
DevOps Engineer start=20 http=429 … Technical Support start=0 http=429   (15 s apart: 3 of 9)
```

**Diagnosis.** It's rate limiting by request pattern, not a block: slower spacing didn't help, and
the same page succeeded when asked again.

**Fix.** One paced LinkedIn client per run (6 s); a refused page is retried after 45 s × attempt
(2 retries); a search that still couldn't read every page keeps its window for the next run (D38).
Live: 33 pages, 0 refused.

---

## 32. A job queued with "Prepare anyway" kept returning to Needs review

**Symptom.** "Technical Support Specialist Level 2 - CA by Broadcom" went new → needs_review four
times (2026-11-23), each time with:

```
documents: ATS check failed: keyword coverage 50% < 70%     keywordsMissing: ["java"]
```

**Diagnosis.**
- **Alternatives treated as a list:** the requirement reads *"one or more of: foundational networking, Linux and Windows, APIs, Tomcat, **Java**, SSL, Oracle and SQL…"*. The check counted each backed term on its own. Java (in the profile only inside one project bullet, not chosen for this CV) was demanded although Linux and SQL already met the requirement.
- **A tiny sample:** only 2 keywords were counted, so one miss gave 50%.
- **No way out:** a keyword-only failure sent the job back to review, so "Prepare anyway" looped.

**Fix.**
- A requirement phrased as alternatives ("one or more of", "any of", "such as", "or …") counts once, covered when any of its terms is in the CV.
- With 3 or fewer keywords one miss is allowed.
- A job Ahmed queued himself goes ahead on a keyword-only failure, flagged `low_keyword_coverage`. Page count, images, fonts, headings and contact checks still block.
- Re-prepared live: ready, CV one page, ATS 100%.

---

## 33. Private backup files were committed

**Symptom.** After the D44 conversion (2026-11-23), `git log --stat` showed
`config/config.yaml.pre-specialisms` (plus the example and titles copies) in the D44 commit. Earlier
settings backups `config/config.yaml.bak` and `config/titles.yaml.bak` were in two
commits before it. They held the Gmail address, the WhatsApp group id and settings; no token and no
blocklisted number.

**Diagnosis.**
- **Pattern gap:** `.gitignore` and `scripts/check-secrets.sh` matched `config/config.yaml` exactly, so a copy with any suffix passed both.
- **Staging gap:** the commits staged everything, without a look at the file list first.

**Fix.**
- **Removed** the files from the tree (85f7528).
- **Blocked** `*.bak`, `*.bak-*` and `*.pre-*` in `.gitignore` and in the secrets scan's forbidden paths, and with D45, every `profiles/<name>/` except `profiles/example/`, with tests (0f6f962).
- **Purged from history** (2026-11-24, owner's decision): the five paths were removed from every commit with `git filter-branch --index-filter`, checked in a copy (same final tree, no remaining path, no group id), then force-pushed. Commit ids from 2026-11-23 on changed. GitHub can still serve an old commit to someone who has its id until it cleans up unreachable objects; its support can do that on request.
- **Lesson:** look at the staged file list before every commit; a file that was public for a day should be treated as seen.

---

## 34. WhatsApp logged out and the run crashed

**Symptom.** 2026-11-24, the first run after the profile migration: `whatsapp conflict screen:
clicked "Use here"`, `whatsapp disconnected`, then `TimeoutError: Waiting failed: 60000ms
exceeded` from `whatsapp-web.js/src/Client.js:139`, exit code 1. Nothing was collected.

**Diagnosis.**
- **Logged out:** `data/wa-session/session` was recreated 22 s after WhatsApp started. The library deletes that folder only in its logout handler, so WhatsApp Web had logged this device out.
- **The crash:** after a logout the library injects itself into the new page from an event handler nobody awaits (`Client.js:564`). That wait never succeeds on WhatsApp's new logged-out page (#35), so it timed out after 60 s, and the unhandled rejection ended the process. The per-source isolation in the orchestrator can't catch it.
- **Not established:** why WhatsApp logged the device out. It happened on the first start from the moved session folder and right after "Use here"; neither is proven to be the cause.

**Fix.**
- **Now:** link again with `./agent.sh whatsapp-login` (this failed too at first: #35), then run again. The stale `run.lock` and `wa.lock` are replaced automatically.
- **Next time:** the output says so. An `uncaughtExceptionMonitor` prints the fix before the stack trace; it only observes, so the run still stops with exit code 1.
- **Alternative not taken (owner's choice):** catching the rejection so the run continues without WhatsApp.

---

## 35. The WhatsApp QR code never appeared

**Symptom.** 2026-11-24, `./agent.sh whatsapp-login` (after #34): no QR code, then `error: Waiting failed: 60000ms exceeded`, and the command didn't exit.

**Diagnosis.**
- **The page changed:** web.whatsapp.com answers a browser that isn't linked with `302 /login/`. In a throwaway profile that page drew its QR code, but `WAWebSocketModel`, which whatsapp-web.js waits for, stayed unresolved for 70 s.
- **Upstream:** wwebjs/whatsapp-web.js issue 201988 (open, from 2026-11-23). 1.34.8 is the newest stable release and has the same code; the proposed fix (PR 201990) has a report against it.
- **The cache was never used:** `web_cache_path` was documented as pinning the version that worked, but `webVersion` was never set.
- **The hang:** the login timeout timer wasn't cleared on failure.

**Fix.**
- **Pin** the newest version in `web_cache_path` for linking only (`src/collect/whatsapp/web-version.ts`); a linked session loads the current page, which also refreshes the cache.
- **Clear** the timer on failure, and name the cause when the page is `/login/`.
- **Alternatives:** wait for upstream (WhatsApp stays off until then); apply the unmerged patch or `2.0.0-alpha.0` (unproven); download old pages from a third party (untrusted code in a logged-in session).
- **Limits:** WhatsApp may refuse the cached version one day. A profile with an empty cache can't link until upstream is fixed. Remove the pin when it is.

---

## 36. WhatsApp authenticated but never became ready

**Symptom.** 2026-11-24, after #35: `whatsapp-groups` and run 7 showed `authenticated`, then `WhatsApp not ready after 120 s`. Run 7 went on without WhatsApp. A dry run 10 minutes earlier had worked.

**Diagnosis.**
- **Not slow:** the page was connected and synced within 10 s, and `ready` still never came.
- **A race:** right after login WhatsApp opens `webtp.whatsapp.net/pdf-viewer` in a frame and closes it about 0.1 s later. `attachEventListeners` is hooking ~18 events into every frame then; when the frame closes mid-hook, `TargetCloseError` is thrown, swallowed inside the page, and `ready` is never emitted.
- **Disproved:** the pinned version of #35 was suspected first; the unpinned page failed too (2 of 4 starts, against 1 of 1 measured with the pin).

**Fix.**
- **Not attached:** the facade reads on demand and uses none of those events, so they are skipped.
- **Retry:** a failed start is tried 3 times, except when the account isn't linked.
- **`whatsapp.required`** (default false): true stops the run when WhatsApp can't be read, so it isn't skipped quietly.
- **Alternatives:** a longer timeout (no help: it never becomes ready); retry alone (it fails about half the time); patching puppeteer (a fork to maintain).

---

## 37. "Connection closed." when opening a job to apply (window since removed: D46)

**Symptom.** 2026-11-24, dashboard → "Open pre-filled": `Connection closed.`, every time.

**Diagnosis.** The dashboard keeps one `FormFiller` for its lifetime, and `page()` only checked that a browser had been started, not that it was still open. The apply window is the user's to close; after that each call used the dead handle. Reproduced by closing the browser in a test.

**Fix.** `page()` starts a new browser when the old one is gone, and retries once if it closes at that moment. `close()` tolerates a browser that is already closed.
**Alternative:** a new browser for every job (slower, and it would close a window still in use).

---

## 38. Cloudflare's "verify you are human" and Google sign-in fail in the apply window

**Symptom.** 2026-11-24: ticking Cloudflare's box never moved on, and "Sign in with Google" was refused, in the window opened by "Open pre-filled".

**Diagnosis.** That window is Chrome controlled by software, which both services refuse whoever is using it. The Workable form (job 298) loads `challenges.cloudflare.com/turnstile`. Its automatic submission had not gone through either: the screenshot shows the form still open, with no confirmation.

**Fix.** D46: every job opens in the user's own browser; the add-on fills it there (D49).

---

## 39. A form field held two answers run together

**Symptom.** 2026-11-24, job 298 (not submitted): Address held two values run together, like `City A, CountryDistrict B, City B`.

**Diagnosis.** The answer typed was the profile's. The other text was already in the field, and the triple click meant to select it didn't. Probably the site wrote it from the uploaded CV (not proven).

**Fix.** Select everything before typing; if the field still holds more than the answer afterwards, select and type once more.

---

## 40. The add-on attached no CV on a Phenom form

**Symptom.** 2026-11-24, an Electrolux Group form (Phenom): the fields were filled, the CV was not attached.

**Diagnosis.** The form has two hidden file inputs without a label. "Upload Resume" is the text of a button next to the first, "Upload Attachments" names the second. With no words of its own for either, and two to choose from, the add-on attached to neither. It also listed the site's job search boxes as form fields.

**Fix.** An upload box without a label takes the words and names of the boxes around it, never as far as another upload box. Search, menu, header and footer boxes are skipped. After attaching, the add-on waits for the page to settle and finds redrawn fields again. Checked on the form itself: the site started its own upload (blocked in the test).

