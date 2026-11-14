#!/bin/bash
# The office AVS's enquiry watcher (owner, 14 Nov 2026: "While we click on the refresh button or fetch the emails, it
# should trigger the AVS on my office PC"). launchd runs this every minute. It asks CI Plant whether someone pressed
# "Fetch from mail" - the answer is only yes or no, and needs no key. No: exit at once (no Claude). Yes: start ONE
# Claude run in this folder, where the guard (.claude/hooks/avs-office-guard.py) lets it only read the company mailbox
# and file through the avs functions. One run at a time; a Claude not signed in is reported once, then tried every 30 min.
export PATH="$HOME/.local/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin"
DIR="$(cd "$(dirname "$0")" && pwd)"
LOG="$DIR/watch.log"
LOCK="$DIR/run.lock"
NOLOGIN="$DIR/not-signed-in"

w=$(curl -s -m 15 "https://motionci.in/api/enquiry-desk/waiting?mailbox=business") || exit 0
case "$w" in *'"waiting":true'*) ;; *) exit 0 ;; esac
if [ -f "$NOLOGIN" ] && [ -z "$(find "$NOLOGIN" -mmin +30)" ]; then exit 0; fi
if [ -d "$LOCK" ] && [ -z "$(find "$LOCK" -maxdepth 0 -mmin +45)" ]; then exit 0; fi
rm -rf "$LOCK"; mkdir "$LOCK" || exit 0
trap 'rm -rf "$LOCK"' EXIT

# Keep the log small.
if [ -f "$LOG" ] && [ "$(wc -c < "$LOG")" -gt 1000000 ]; then tail -n 2000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"; fi
echo "$(date '+%F %T') a Fetch is waiting - starting Claude" >> "$LOG"
out=$(cd "$DIR" && claude -p "$(cat "$DIR/run-prompt.txt")" --permission-mode bypassPermissions --output-format text 2>&1)
code=$?
printf '%s\n' "$out" | tail -n 40 >> "$LOG"
if printf '%s' "$out" | grep -qiE 'not logged in|please run /login'; then
  [ -f "$NOLOGIN" ] || echo "$(date '+%F %T') Claude is not signed in on this computer. Open Terminal, run: claude   then type: /login" >> "$LOG"
  touch "$NOLOGIN"
else
  rm -f "$NOLOGIN"
fi
echo "$(date '+%F %T') run finished ($code)" >> "$LOG"
