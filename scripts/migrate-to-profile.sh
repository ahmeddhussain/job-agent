#!/usr/bin/env bash
# migrate-to-profile.sh: moves a setup from the old single-user layout (config/config.yaml,
# profile/master_profile.yaml, data/, output/, secrets/, .env at the repo root) into
# profiles/<name>/ (D45). Run it once, with the agent and the dashboard stopped:
#   scripts/migrate-to-profile.sh <name>
# Nothing is deleted: old backups and leftovers go to profiles/<name>/archive/, and the
# database is copied first (profiles/<name>/data/agent.db.bak-<date>-profiles).
set -euo pipefail

cd "$(dirname "$(readlink -f "$0")")/.."
name="${1:-}"
[[ "$name" =~ ^[a-z0-9][a-z0-9_-]{0,39}$ ]] || {
  echo "usage: scripts/migrate-to-profile.sh <name>   (lowercase letters, digits, - or _)" >&2
  exit 2
}
dest="profiles/$name"
die() {
  echo "migrate: $*" >&2
  exit 1
}

[[ -f config/config.yaml ]] || die "no config/config.yaml: nothing to migrate (new setup: ./agent.sh init)"
[[ -f profile/master_profile.yaml ]] || die "no profile/master_profile.yaml"
[[ ! -e "$dest/config.yaml" ]] || die "$dest already exists"
# Any agent process of this checkout (its working directory is here). The pattern's [s]
# keeps pgrep from matching this check itself.
here="$(pwd -P)"
for pid in $(pgrep -f "[s]rc/cli.ts|[d]ist/cli.js" || true); do
  cwd="$(readlink "/proc/$pid/cwd" 2>/dev/null || true)"
  if [[ "$cwd" == "$here" || "$cwd" == "$here"/* ]]; then
    die "the agent or its dashboard is running (pid $pid): stop it first (Ctrl-C in its terminal)"
  fi
done

# 1. A consistent copy of the database before anything moves.
stamp="$(date +%F)"
if [[ -f data/agent.db ]]; then
  python3 -I - "data/agent.db" "data/agent.db.bak-${stamp}-profiles" <<'PY'
import sqlite3, sys
src = sqlite3.connect(sys.argv[1])
ok = src.execute("PRAGMA integrity_check").fetchone()[0]
if ok != "ok":
    sys.exit(f"database integrity check failed: {ok}")
dst = sqlite3.connect(sys.argv[2])
src.backup(dst)
dst.close()
src.close()
print(f"database copied to {sys.argv[2]}")
PY
fi

# 2. Which optional sources were in use.
wa=0
gm=0
grep -qE '^\s*groups:\s*\[\s*\]' config/config.yaml || wa=1
[[ -f secrets/gmail_token.json ]] && gm=1

# 3. Move everything that is the user's into the profile folder.
mkdir -p "$dest/archive"
chmod 700 "$dest" "$dest/archive"
for d in data output secrets backups; do
  if [[ -e "$d" ]]; then mv "$d" "$dest/$d"; fi
done
mkdir -p "$dest/data" "$dest/output" "$dest/secrets"
chmod 700 "$dest/data" "$dest/output" "$dest/secrets"
if [[ -f .env ]]; then mv .env "$dest/.env"; fi
mv profile/master_profile.yaml "$dest/profile.yaml"
if [[ -f config/companies.yaml ]]; then
  mv config/companies.yaml "$dest/companies.yaml"
else
  cp profiles/example/companies.yaml "$dest/companies.yaml"
fi
if [[ -f config/titles.yaml ]]; then
  mv config/titles.yaml "$dest/titles.yaml"
else
  # The old tracked titles.yaml now lives on as the test fixture (same content).
  cp test/fixtures/titles.yaml "$dest/titles.yaml"
fi

# 4. config.yaml with only the settings that differ from config/defaults.yaml.
npx tsx src/dev/config-overrides.ts config/config.yaml "$dest/config.yaml" "$wa" "$gm"
mv config/config.yaml "$dest/archive/config.yaml.old-layout"

# 5. Leftovers (settings backups, conversion copies, notes) are kept, out of the way.
shopt -s nullglob
for f in config/*.bak config/*.bak-* config/*.pre-* profile/*.bak profile/*.bak-* profile/*.pre-* profile/*.md; do
  mv "$f" "$dest/archive/"
done
shopt -u nullglob
rmdir profile 2>/dev/null || true
chmod 600 "$dest"/*.yaml "$dest/.env" 2>/dev/null || true

# 6. Make it the active profile and check it loads.
echo "$name" >profiles/.active
chmod 600 profiles/.active
npm run -s agent -- config:check
echo
echo "Done: $dest is your profile (active). Old copies are in $dest/archive/."
echo "Next: ./agent.sh dashboard   (everything should look as before)"
