#!/bin/zsh
# COA Register auto-sync — installs the background job on the Mac that holds the
# mppchd Google Drive, so the COA Register on motionci.in follows the Drive by
# itself (scripts/coa-register-sync.mjs --auto, every 3 minutes and whenever the
# COA folder changes).
#
#   scripts/coa-sync/install.sh             install or update (keeps the saved database link)
#   scripts/coa-sync/install.sh --uninstall stop it and remove it
#
# What it puts where:
#   ~/.config/ci-erp/coa-sync/app/           its own copy of the sync and the two files it
#                                            reads, with pg + exceljs — so tidying a git
#                                            worktree or switching a branch can't break it
#   ~/.config/ci-erp/coa-sync.env            DATABASE_URL of the live plant (chmod 600),
#                                            pulled from Vercel's production settings
#   ~/Library/LaunchAgents/in.motionci.coa-sync.plist
#   ~/Library/Logs/ci-erp-coa-sync.log       one line per sync that did something
set -euo pipefail

LABEL=in.motionci.coa-sync
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
HOME_DIR="$HOME/.config/ci-erp/coa-sync"
APP="$HOME_DIR/app"
ENV_FILE="$HOME/.config/ci-erp/coa-sync.env"
LOG="$HOME/Library/Logs/ci-erp-coa-sync.log"
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
NODE="$(command -v node)"
DRIVE_DIR="$HOME/Library/CloudStorage/GoogleDrive-mppchd@gmail.com/Other computers/CARTON PC MAIN/COLOUR IMPRESSION/COA"

if [[ "${1:-}" == "--uninstall" ]]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  rm -rf "$HOME_DIR"
  echo "Removed the COA auto-sync. (Kept $ENV_FILE and $LOG.)"
  exit 0
fi

# 1. Its own copy of the code, laid out as in the repo so the imports resolve.
mkdir -p "$APP/scripts" "$APP/server/src" "$APP/client/src"
cp "$REPO/scripts/coa-register-sync.mjs" "$APP/scripts/"
cp "$REPO/server/src/coa-register.js" "$APP/server/src/"
cp "$REPO/client/src/modules.js" "$APP/client/src/"
cat > "$APP/package.json" <<'JSON'
{ "name": "ci-erp-coa-sync", "private": true, "type": "module",
  "dependencies": { "pg": "^8.13.1", "exceljs": "^4.4.0" } }
JSON
(cd "$APP" && npm install --silent --no-audit --no-fund >/dev/null)

# 2. The live plant's database link, from Vercel's production settings.
if [[ ! -s "$ENV_FILE" ]]; then
  TMP="$(mktemp)"
  # vercel needs a folder linked to the ci-plant project; a fresh worktree is not.
  LINKED="$REPO"; [[ -f "$LINKED/.vercel/project.json" ]] || LINKED="$HOME/Documents/CI ERP FInal/ci-erp"
  (cd "$LINKED" && vercel env pull "$TMP" --environment production --yes ${VERCEL_TOKEN:+--token "$VERCEL_TOKEN"} >/dev/null)
  URL="$(grep '^DATABASE_URL=' "$TMP" | sed -E 's/^DATABASE_URL=//; s/^"//; s/"$//; s/\\n$//')"
  rm -f "$TMP"
  [[ "$URL" == *ylbfeptgefzimcqnwphy* ]] || { echo "The production DATABASE_URL is not colour-impressions-prod — stopping."; exit 1; }
  umask 077
  printf "DATABASE_URL='%s'\n" "$URL" > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
fi

# 3. The background job: every 3 minutes, at login, and when the COA folder changes.
mkdir -p "$(dirname "$PLIST")" "$(dirname "$LOG")"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string><string>-c</string>
    <string>set -a; source "$ENV_FILE"; set +a; exec "$NODE" "$APP/scripts/coa-register-sync.mjs" --auto</string>
  </array>
  <key>WorkingDirectory</key><string>$APP</string>
  <key>StartInterval</key><integer>180</integer>
  <key>WatchPaths</key><array><string>$DRIVE_DIR</string></array>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
PL

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "COA auto-sync installed and running. Log: $LOG"
