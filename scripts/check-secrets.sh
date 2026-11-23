#!/usr/bin/env bash
# check-secrets.sh: keep secrets and private data out of Git.
#
#   scripts/check-secrets.sh             # staged changes (run by .githooks/pre-commit)
#   scripts/check-secrets.sh --history   # every commit on every branch
#
# Blocks: forbidden paths (.env, secrets/, data/, the real profile and config, keys),
# token/key patterns, and every literal in the gitignored .secrets-blocklist (e.g. a
# private phone number; digit-only entries also match with spaces/dots/dashes removed).
# Findings name the file and the rule, never the matched value, so the secret isn't
# copied into terminal scrollback or CI logs.
set -euo pipefail

root=$(git rev-parse --show-toplevel)
blocklist="${SECRETS_BLOCKLIST:-$root/.secrets-blocklist}"
mode=${1:-staged}

# name|extended regex
rules=(
  'anthropic-key-or-oauth-token|sk-ant-[A-Za-z0-9_-]{20,}'
  'claude-token-assignment|(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY)[[:space:]]*[=:][[:space:]]*["'"'"']?[A-Za-z0-9_-]{20,}'
  'aws-access-key|(AKIA|ASIA)[0-9A-Z]{16}'
  'github-token|(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})'
  'google-oauth-secret|GOCSPX-[A-Za-z0-9_-]{20,}'
  'oauth-refresh-token|"refresh_token"[[:space:]]*:[[:space:]]*"[^"]{20,}"'
  'private-key|-----BEGIN [A-Z ]*PRIVATE KEY-----'
)

# Also backups of any of these (settings edits and conversions write *.bak / *.pre-*), and
# every personal profile folder except the shipped example (profiles/<name>/).
forbidden_path='(^|/)\.env$|(^|/)\.env\.[^/]+$|^secrets/|^data/|^output/|^backups/|^profile/master_profile\.yaml|^config/config\.yaml|^config/companies\.yaml|\.(pem|key|p12|pfx)$|(^|/)\.secrets-blocklist$|wa-session|\.bak$|\.bak-|\.pre-[a-z]+$|^profiles/[^/]+/|^profiles/\.active$'
allowed_path='(^|/)\.env\.example$|^profiles/example/'

blocked=()
if [[ -f "$blocklist" ]]; then
  while IFS= read -r line; do
    [[ -z "$line" || "$line" == \#* ]] && continue
    blocked+=("$line")
  done <"$blocklist"
fi

findings=0
report() { # file rule
  printf 'BLOCKED  %-45s %s\n' "$1" "$2" >&2
  findings=$((findings + 1))
}

# scan_text <label> : reads added text on stdin
scan_text() {
  local label=$1 text digits rule name re entry
  text=$(cat)
  [[ -z "$text" ]] && return 0
  digits=$(printf '%s' "$text" | tr -d ' .()-')
  for rule in "${rules[@]}"; do
    name=${rule%%|*}
    re=${rule#*|}
    if printf '%s' "$text" | grep -Eq -- "$re"; then report "$label" "$name"; fi
  done
  for entry in "${blocked[@]}"; do
    if printf '%s' "$text" | grep -Fq -- "$entry"; then
      report "$label" "blocklisted literal"
    elif [[ "$entry" =~ ^[0-9]+$ ]] && printf '%s' "$digits" | grep -Fq -- "$entry"; then
      report "$label" "blocklisted number (formatted)"
    fi
  done
}

check_path() {
  if [[ "$1" =~ $forbidden_path && ! "$1" =~ $allowed_path ]]; then
    report "$1" "forbidden path"
  fi
}

case "$mode" in
staged)
  while IFS= read -r -d '' f; do
    check_path "$f"
    # process substitution, not a pipe: a pipe would run scan_text in a subshell and lose `findings`
    scan_text "$f" < <(git diff --cached --no-color -U0 -- "$f" | sed -n 's/^+\([^+]\|$\)/\1/p')
  done < <(git diff --cached --name-only --diff-filter=ACMR -z)
  ;;
--history)
  while IFS= read -r f; do
    [[ -n "$f" ]] && check_path "$f"
  done < <(git log --all --format= --name-only | sort -u)
  while IFS= read -r c; do
    scan_text "commit $c" < <(git show --no-color --format= -U0 "$c" | sed -n 's/^+\([^+]\|$\)/\1/p')
  done < <(git rev-list --all)
  ;;
*)
  echo "usage: $0 [--history]" >&2
  exit 64
  ;;
esac

if ((findings > 0)); then
  printf '\n%d finding(s). Nothing was committed. Remove the value (or unstage the file) and retry.\n' "$findings" >&2
  exit 1
fi
echo "check-secrets: clean (${mode})"
