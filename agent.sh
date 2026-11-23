#!/usr/bin/env bash
# agent.sh: the everyday commands for the job agent (docs/daily-use.md).
#   ./agent.sh init            create your profile (from your CV, with Claude)
#   ./agent.sh run             collect, score, prepare CVs and letters, apply
#   ./agent.sh dashboard       open the tracker in the browser (Ctrl-C stops it)
#   ./agent.sh apply           finish the "apply yourself" jobs in a pre-filled window
#   ./agent.sh send            send every reviewed email draft (asks once)
#   ./agent.sh help            everything else
# Any command can take a profile first: ./agent.sh --profile <name> run
set -euo pipefail

# Paths the user types (./agent.sh add post.txt) are relative to where they typed them.
export JOB_AGENT_CALLER_CWD="$PWD"
cd "$(dirname "$(readlink -f "$0")")"
PORT="${DASHBOARD_PORT:-8080}"

die() {
  echo "agent.sh: $*" >&2
  exit 1
}

if [[ "${1:-}" == "--profile" || "${1:-}" == "-p" ]]; then
  [[ -n "${2:-}" ]] || die "--profile needs a name"
  export JOB_AGENT_PROFILE="$2"
  shift 2
fi

[[ -d node_modules ]] || die "not installed yet: run ./install.sh"

agent() { npm run -s agent -- "$@"; }

# A visible browser (apply, dashboard) needs the desktop session. From a terminal on the
# desktop these are set already; from SSH or an IDE terminal they may be missing.
# With "soft", a missing desktop is not an error (the dashboard works without it).
use_desktop() {
  if [[ -z "${DISPLAY:-}" && -z "${WAYLAND_DISPLAY:-}" ]]; then
    if [[ -S /tmp/.X11-unix/X0 ]]; then
      export DISPLAY=:0
      local auth
      auth="$(find "/run/user/$(id -u)" -maxdepth 1 -name '.mutter-Xwaylandauth.*' 2>/dev/null | head -n 1)"
      if [[ -n "$auth" ]]; then export XAUTHORITY="$auth"; fi
    elif [[ "${1:-}" != soft ]]; then
      die "no desktop session found: run this from a terminal on your desktop"
    fi
  fi
}

# Warn before a run if Gmail is on but will refuse (Testing-mode tokens expire after 7 days).
gmail_hint() {
  local out
  if ! out="$(agent gmail:check 2>&1)"; then
    echo "WARNING: Gmail is not usable: ${out##*$'\n'}" >&2
    echo "         fix: ./agent.sh gmail-auth   (alerts and email drafts are skipped until then)" >&2
  elif grep -q "run gmail:auth now" <<<"$out"; then
    echo "WARNING: the Gmail token is about to expire: run ./agent.sh gmail-auth after this run" >&2
  fi
}

open_url() {
  use_desktop soft
  if command -v xdg-open >/dev/null && [[ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]]; then
    xdg-open "$1" >/dev/null 2>&1 &
  elif command -v open >/dev/null; then
    open "$1"
  else
    echo "open $1 in your browser"
  fi
}

dashboard() {
  local path="${1:-/}"
  if curl -fsS "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1; then
    echo "dashboard already running"
    open_url "http://127.0.0.1:${PORT}${path}"
    return
  fi
  # The dashboard's "Open pre-filled" needs the desktop for its browser window.
  use_desktop soft
  agent dashboard &
  local pid=$!
  trap 'kill "$pid" 2>/dev/null || true' EXIT INT TERM
  for _ in $(seq 1 40); do
    if curl -fsS "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1; then break; fi
    sleep 0.25
  done
  open_url "http://127.0.0.1:${PORT}${path}"
  wait "$pid"
}

cmd="${1:-help}"
shift || true
case "$cmd" in
  init) agent init "$@" ;;
  use)
    [[ -n "${1:-}" ]] || die "usage: ./agent.sh use <profile>"
    agent profile:use "$1"
    ;;
  profiles) agent profile:list ;;
  reviewed) agent profile:reviewed ;;
  demo) JOB_AGENT_PROFILE=example agent demo:seed ;;
  run)
    gmail_hint
    status=0
    agent run "$@" || status=$?
    # A desktop notification when the run ends (if the desktop session is reachable).
    if command -v notify-send >/dev/null 2>&1; then
      (use_desktop soft && notify-send "Job Agent" "Run finished (exit $status): open ./agent.sh dashboard") || true
    fi
    echo
    echo "Next: ./agent.sh dashboard (review), ./agent.sh apply (finish the rest), ./agent.sh send (send drafts)"
    exit "$status"
    ;;
  dry-run) agent run --dry-run "$@" ;;
  dashboard) dashboard "/#${1:-today}" ;;
  apply)
    use_desktop
    agent assist "$@"
    ;;
  send) agent send-drafts "$@" ;;
  skipped)
    days="${1:-7}"
    [[ "$days" =~ ^[0-9]+$ ]] || die "usage: ./agent.sh skipped [days]"
    agent skipped --days "$days"
    echo "In the dashboard: ./agent.sh dashboard skipped"
    ;;
  retry) agent retry-forms ;;
  recheck) agent recheck-dates ;;
  redo)
    [[ "${1:-}" =~ ^[0-9]+$ ]] || die "usage: ./agent.sh redo <job id>"
    agent reprocess "$1" --from tailor
    ;;
  add)
    [[ -n "${1:-}" ]] || die "usage: ./agent.sh add <file with the post> [--name label]"
    agent add "$@"
    ;;
  status)
    agent config:check
    agent gmail:check || true
    agent companies | tail -n 1
    ;;
  gmail-auth) agent gmail:auth ;;
  whatsapp-login) agent wa:login ;;
  whatsapp-groups) agent wa:groups ;;
  help | -h | --help)
    cat <<'HELP'
Setup
  ./agent.sh init             create your profile: from your CV (via Claude), or the example
  ./agent.sh reviewed         after checking profile.yaml and titles.yaml: allow runs
  ./agent.sh profiles         list profiles (* = active);  ./agent.sh use <name> switches
  ./agent.sh demo             fictional jobs in the example profile, to try the dashboard:
                              then ./agent.sh --profile example dashboard

Daily
  ./agent.sh run              collect jobs from your sources; score; prepare a CV and cover
                              letter for each fit; draft emails; submit web forms
  ./agent.sh dashboard [tab]  tracker in the browser (tabs: today, action, applied, skipped,
                              all, sources, profile, settings)
  ./agent.sh apply            open each "apply yourself" job pre-filled (incl. LinkedIn Easy Apply)
  ./agent.sh send             send all reviewed email drafts (asks once; needs Gmail)
  ./agent.sh skipped [days]   skipped jobs with reasons and links (default 7 days)

Sometimes
  ./agent.sh dry-run          a full run on a copy of the database: nothing is sent or submitted
  ./agent.sh redo <id>        prepare a job again (e.g. one you rescued from "skipped")
  ./agent.sh retry            retry forms that waited for questions you've since answered
  ./agent.sh recheck          read real posting dates of jobs not applied to; skip the stale ones
  ./agent.sh add <file>       add a post by hand (an old post, a forwarded email)
  ./agent.sh status           config, sources, Gmail token age, polled companies

Optional sources (docs/sources.md)
  ./agent.sh gmail-auth       connect Gmail: email drafts, job-alert emails, digest
  ./agent.sh whatsapp-login   link WhatsApp (QR code), read-only
  ./agent.sh whatsapp-groups  list your groups, to choose which ones to read

Any command takes a profile first: ./agent.sh --profile <name> <command>
Everything else: npm run agent -- --help
HELP
    ;;
  *) die "unknown command '$cmd' (./agent.sh help)" ;;
esac
