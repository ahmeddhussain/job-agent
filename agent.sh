#!/usr/bin/env bash
# agent.sh: the daily commands for the job agent (docs/runbooks/daily-use.md).
#   ./agent.sh run            collect, score, prepare, draft emails, submit forms
#   ./agent.sh dashboard      open the tracker in the browser (Ctrl-C stops it)
#   ./agent.sh apply          finish the "apply yourself" jobs in a pre-filled window
#   ./agent.sh send           send every reviewed email draft (asks once)
#   ./agent.sh skipped [days] list what was skipped, with reasons and links
#   ./agent.sh help           everything else
set -euo pipefail

cd "$(dirname "$(readlink -f "$0")")"
PORT="${DASHBOARD_PORT:-8080}"

agent() { npm run -s agent -- "$@"; }

die() {
  echo "agent.sh: $*" >&2
  exit 1
}

# A visible browser (apply, dashboard) needs the desktop session. From a terminal on the
# desktop these are set already; from SSH or an IDE terminal they may be missing.
use_desktop() {
  if [[ -z "${DISPLAY:-}" && -z "${WAYLAND_DISPLAY:-}" ]]; then
    if [[ -S /tmp/.X11-unix/X0 ]]; then
      export DISPLAY=:0
      local auth
      auth="$(find "/run/user/$(id -u)" -maxdepth 1 -name '.mutter-Xwaylandauth.*' 2>/dev/null | head -n 1)"
      if [[ -n "$auth" ]]; then export XAUTHORITY="$auth"; fi
    else
      die "no desktop session found: run this from a terminal on the VM's desktop"
    fi
  fi
}

# Warn before a run if Gmail will refuse (Testing mode tokens expire after 7 days).
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
  use_desktop
  if command -v xdg-open >/dev/null; then
    xdg-open "$1" >/dev/null 2>&1 &
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
  run)
    gmail_hint
    agent run "$@"
    echo
    echo "Next: ./agent.sh dashboard (review), ./agent.sh apply (finish the rest), ./agent.sh send (send drafts)"
    ;;
  dry-run) agent run --dry-run "$@" ;;
  dashboard) dashboard "/" ;;
  apply)
    use_desktop
    agent assist "$@"
    ;;
  send) agent send-drafts "$@" ;;
  skipped)
    days="${1:-7}"
    [[ "$days" =~ ^[0-9]+$ ]] || die "usage: ./agent.sh skipped [days]"
    agent skipped --days "$days"
    echo "In the dashboard: ./agent.sh dashboard, then the Skipped filter."
    ;;
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
  help | -h | --help)
    cat <<'HELP'
Daily
  ./agent.sh run              collect WhatsApp, alerts and company boards; score; prepare CVs;
                              draft emails; submit web forms (failures go to "Apply yourself")
  ./agent.sh dashboard        tracker in the browser (http://127.0.0.1:8080)
  ./agent.sh apply            open each "apply yourself" job pre-filled (incl. LinkedIn Easy Apply)
  ./agent.sh send             send all reviewed email drafts (asks once)
  ./agent.sh skipped [days]   skipped jobs with reasons and links (default 7 days)

Sometimes
  ./agent.sh dry-run          a full run on a copy of the database: nothing is sent or submitted
  ./agent.sh redo <id>        prepare a job again (e.g. one you rescued from "skipped")
  ./agent.sh add <file>       add a post by hand (an old post, a forwarded email)
  ./agent.sh status           config, Gmail token age, polled companies
  ./agent.sh gmail-auth       re-authorize Gmail (weekly while the app is in Testing mode)
  ./agent.sh whatsapp-login   link WhatsApp again (QR code)

Everything else: npm run agent -- --help
HELP
    ;;
  *) die "unknown command '$cmd' (./agent.sh help)" ;;
esac
