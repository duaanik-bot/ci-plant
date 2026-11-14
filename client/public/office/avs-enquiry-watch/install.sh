#!/bin/bash
# Installs the office AVS enquiry watcher (owner, 14 Nov 2026). Run once on the office computer, in Terminal:
#   curl -fsSL https://motionci.in/office/avs-enquiry-watch/install.sh | bash
# It makes ~/.config/ci-plant/avs-enquiry-watch (the watcher, its run prompt, its guard) and a launchd job that runs the
# watcher every minute. Running it again updates the files. To remove:  launchctl unload -w ~/Library/LaunchAgents/in.motionci.avs-enquiry-watch.plist
set -e
BASE="https://motionci.in/office/avs-enquiry-watch"
DIR="$HOME/.config/ci-plant/avs-enquiry-watch"
PLIST="$HOME/Library/LaunchAgents/in.motionci.avs-enquiry-watch.plist"
mkdir -p "$DIR/.claude/hooks" "$HOME/Library/LaunchAgents"
curl -fsSL "$BASE/watch.sh" -o "$DIR/watch.sh"
curl -fsSL "$BASE/run-prompt.txt" -o "$DIR/run-prompt.txt"
curl -fsSL "$BASE/settings.json" -o "$DIR/.claude/settings.json"
curl -fsSL "$BASE/avs-office-guard.py" -o "$DIR/.claude/hooks/avs-office-guard.py"
chmod 700 "$DIR/watch.sh" "$DIR/.claude/hooks/avs-office-guard.py"
grep -q 'avs-office-guard' "$DIR/.claude/settings.json" || { echo "The guard settings did not download - stopping."; exit 1; }
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>in.motionci.avs-enquiry-watch</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>$DIR/watch.sh</string></array>
  <key>StartInterval</key><integer>60</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardErrorPath</key><string>$DIR/launchd.err</string>
</dict>
</plist>
PL
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load -w "$PLIST"
echo "Installed: the office computer now answers \"Fetch from mail\" within a minute."
export PATH="$HOME/.local/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"
if ! command -v claude >/dev/null 2>&1; then
  echo "BUT the Claude command line is not on this computer. Install it (https://claude.com/download - Claude Code), then run: claude   and type: /login"
elif claude auth status 2>/dev/null | grep -q '"loggedIn": *true'; then
  echo "Claude is signed in. Nothing else to do."
else
  echo "ONE MORE STEP: Claude is not signed in on this computer. In Terminal run: claude   then type: /login"
fi
