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
