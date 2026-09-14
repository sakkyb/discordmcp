#!/usr/bin/env bash
# Installs the court-watch launchd job (every 10 minutes, 07:00-23:00 London).
# Run once after: npm install, npm run build, and creating .env.
set -euo pipefail

PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Prefer the arm64 Homebrew node. Override with NODE_PATH_OVERRIDE if needed.
NODE_PATH="${NODE_PATH_OVERRIDE:-/opt/homebrew/bin/node}"
if [ ! -x "$NODE_PATH" ]; then
  NODE_PATH="$(command -v node || true)"
fi
if [ -z "$NODE_PATH" ]; then
  echo "node not found. Install Node.js first." >&2
  exit 1
fi

if [ ! -f "$PKG_DIR/build/check-courts.js" ]; then
  echo "build/check-courts.js not found. Run 'npm install && npm run build' in court-watch/ first." >&2
  exit 1
fi

if [ ! -f "$PKG_DIR/.env" ]; then
  echo "court-watch/.env not found. Copy .env.example to .env and set NTFY_TOPIC." >&2
  exit 1
fi

mkdir -p "$PKG_DIR/logs" "$HOME/Library/LaunchAgents"

LABEL=com.sakky.court-watch
DEST="$HOME/Library/LaunchAgents/$LABEL.plist"
sed -e "s|__NODE_PATH__|${NODE_PATH}|g" \
    -e "s|__PKG_DIR__|${PKG_DIR}|g" \
    "$PKG_DIR/scripts/$LABEL.plist.template" > "$DEST"
launchctl unload "$DEST" >/dev/null 2>&1 || true
launchctl load "$DEST"

cat <<MSG
Loaded $LABEL — runs every 10 minutes with $NODE_PATH

Useful commands (from court-watch/):
  node build/check-courts.js               # run now
  DRY_RUN=true node build/check-courts.js  # fetch and print, publish nothing
  tail -f logs/court-watch.out.log         # follow logs
  launchctl list | grep court-watch        # confirm the job is loaded
MSG
