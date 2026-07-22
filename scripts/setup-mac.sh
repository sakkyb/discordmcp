#!/usr/bin/env bash
# Installs the Discord bot as a launchd service so it runs at boot and
# restarts automatically if it crashes. Run this once after cloning the
# repo, installing dependencies, and building it.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="com.sakky.discordbot"
PLIST_DEST="$HOME/Library/LaunchAgents/${LABEL}.plist"
# Prefer the arm64 Homebrew node on Apple Silicon (running Chrome/JS under
# Rosetta via x64 node is slow, and the launchd jobs are standardised on it).
NODE_PATH="$([ -x /opt/homebrew/bin/node ] && echo /opt/homebrew/bin/node || command -v node)"

if [ -z "$NODE_PATH" ]; then
  echo "node not found on PATH. Install Node.js (e.g. 'brew install node') first." >&2
  exit 1
fi

if [ ! -f "$REPO_DIR/build/bot.js" ]; then
  echo "build/bot.js not found. Run 'npm install && npm run build' first." >&2
  exit 1
fi

if [ ! -f "$REPO_DIR/.env" ]; then
  echo "Warning: .env not found in $REPO_DIR. Copy .env.example to .env and fill in your tokens." >&2
fi

mkdir -p "$REPO_DIR/logs"
mkdir -p "$HOME/Library/LaunchAgents"

sed -e "s|__NODE_PATH__|${NODE_PATH}|g" \
    -e "s|__REPO_DIR__|${REPO_DIR}|g" \
    "$REPO_DIR/scripts/${LABEL}.plist.template" > "$PLIST_DEST"

echo "Wrote $PLIST_DEST"

# Reload if already loaded, so re-running this script picks up changes.
launchctl unload "$PLIST_DEST" >/dev/null 2>&1 || true
launchctl load "$PLIST_DEST"

echo "Loaded launchd service '$LABEL'."

echo "Preventing the Mac from sleeping (requires sudo)..."
sudo pmset -a sleep 0 disablesleep 1

cat <<EOF

Done. The bot will now start automatically at boot and restart if it crashes.

Useful commands:
  launchctl list | grep $LABEL          # check it's running
  tail -f "$REPO_DIR/logs/bot.out.log"  # follow logs
  tail -f "$REPO_DIR/logs/bot.err.log"  # follow error logs
  launchctl unload "$PLIST_DEST"        # stop the service
  launchctl load "$PLIST_DEST"          # start it again
  curl http://localhost:3000/health     # check bot health locally
EOF
