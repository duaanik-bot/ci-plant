#!/bin/bash
# Double-click this file to start Colour Impressions Plant ERP.
# Keep the Terminal window open while using the app. Press Ctrl+C to stop.
cd "$(dirname "$0")"

echo "──────────────────────────────────────────────"
echo "  COLOUR IMPRESSIONS — Plant ERP"
echo "──────────────────────────────────────────────"

if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "❌ Node.js is not installed."
  echo "   Opening nodejs.org — install the LTS version, then double-click this file again."
  open "https://nodejs.org"
  read -r -p "Press Enter to close…"
  exit 1
fi

echo "Node $(node -v) found."

if [ ! -d node_modules ]; then
  echo ""
  echo "First-time setup — installing packages (1–2 minutes)…"
  npm install || { echo ""; echo "❌ Install failed — send the message above to Claude."; read -r -p "Press Enter to close…"; exit 1; }
fi

echo ""
echo "Starting… the app will open in your browser automatically."
echo "Sign in: the seeder prints the admin address and password on first run."
echo ""

( sleep 14 && open "http://localhost:5173" ) &
npm run dev
