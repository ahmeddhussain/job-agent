#!/usr/bin/env bash
# install.sh: checks what the job agent needs, installs its Node dependencies, and says
# what to do next. It installs nothing system-wide: missing system tools are listed with
# the command to install them. Safe to run again. docs/getting-started.md explains each step.
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"

ok() { printf '  ok       %s\n' "$*"; }
miss() {
  printf '  MISSING  %s\n' "$*"
  missing=$((missing + 1))
}
missing=0

echo "Checking requirements"

# Node.js 22.12 or newer (the agent is TypeScript run by Node).
if command -v node >/dev/null; then
  v="$(node -p 'process.versions.node')"
  IFS=. read -r major minor _ <<<"$v"
  if ((major > 22 || (major == 22 && minor >= 12))); then ok "Node.js $v"; else miss "Node.js 22.12+ (found $v): https://nodejs.org"; fi
else
  miss "Node.js 22.12+: https://nodejs.org (or your package manager: dnf/apt/brew install nodejs)"
fi
if command -v npm >/dev/null; then ok "npm"; else miss "npm (comes with Node.js)"; fi

# Poppler: checks every CV PDF (one page, fonts embedded, text readable by ATS software).
if command -v pdftotext >/dev/null && command -v pdfinfo >/dev/null && command -v pdffonts >/dev/null; then
  ok "poppler (pdftotext, pdfinfo, pdffonts)"
else
  miss "poppler: sudo dnf install poppler-utils | sudo apt install poppler-utils | brew install poppler"
fi
if command -v unzip >/dev/null; then
  ok "unzip (reads a .docx CV)"
else
  echo "  optional unzip: only needed to read a CV in .docx format"
fi

# Claude Code: the only service the agent uses, on your Claude subscription.
if command -v claude >/dev/null; then
  ok "Claude Code $(claude --version 2>/dev/null | head -n 1)"
else
  miss "Claude Code: npm install -g @anthropic-ai/claude-code, then run 'claude' once and sign in with your Claude subscription"
fi

if ((missing > 0)); then
  echo
  echo "Install the $missing missing item(s) above, then run ./install.sh again."
  exit 1
fi

echo
echo "Installing Node dependencies (npm ci; downloads a private Chrome for PDFs and forms)"
npm ci --no-fund --no-audit

# The secrets scan runs before every commit in this checkout (docs/privacy-security.md).
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git config core.hooksPath .githooks
  echo "  ok       pre-commit secrets scan enabled"
fi
mkdir -p profiles

echo
echo "Installed. Next:"
echo "  ./agent.sh init        create your profile from your CV"
echo "  ./agent.sh help        all commands"
