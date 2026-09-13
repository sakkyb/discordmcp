#!/usr/bin/env bash
# Installs the weekly Twitter bangers launchd job (Saturday 05:00 local).
# Run once after: npm install, npm run build, npm run login:x.
set -euo pipefail

PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Prefer the arm64 Homebrew node: an x64 build runs Chrome under Rosetta and
# is painfully slow. Override with NODE_PATH_OVERRIDE if needed.
NODE_PATH="${NODE_PATH_OVERRIDE:-/opt/homebrew/bin/node}"
if [ ! -x "$NODE_PATH" ]; then
  NODE_PATH="$(command -v node || true)"
fi
if [ -z "$NODE_PATH" ]; then
  echo "node not found. Install Node.js first." >&2
  exit 1
fi

if [ ! -f "$PKG_DIR/build/weekly-bangers.js" ]; then
  echo "build/weekly-bangers.js not found. Run 'npm install && npm run build' in twitter-bangers/ first." >&2
  exit 1
fi

if [ ! -f "$PKG_DIR/.env" ]; then
  echo "Warning: twitter-bangers/.env not found. Copy .env.example to .env and fill it in." >&2
fi

mkdir -p "$PKG_DIR/logs" "$HOME/Library/LaunchAgents"

LABEL=com.sakky.twitter-bangers
DEST="$HOME/Library/LaunchAgents/$LABEL.plist"
sed -e "s|__NODE_PATH__|${NODE_PATH}|g" \
    -e "s|__PKG_DIR__|${PKG_DIR}|g" \
    "$PKG_DIR/scripts/$LABEL.plist.template" > "$DEST"
launchctl unload "$DEST" >/dev/null 2>&1 || true
launchctl load "$DEST"

cat <<MSG
Loaded $LABEL — runs Saturday 05:00 local time with $NODE_PATH

Useful commands (from twitter-bangers/):
  node build/weekly-bangers.js               # run now
  DRY_RUN=true node build/weekly-bangers.js  # search and print, post nothing
  tail -f logs/bangers.out.log               # follow logs
  launchctl list | grep twitter-bangers      # confirm the job is loaded
MSG
