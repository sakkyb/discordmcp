#!/usr/bin/env bash
# Removes the launchd service installed by setup-mac.sh.
set -euo pipefail

LABEL="com.sakky.discordbot"
PLIST_DEST="$HOME/Library/LaunchAgents/${LABEL}.plist"

if [ -f "$PLIST_DEST" ]; then
  launchctl unload "$PLIST_DEST" >/dev/null 2>&1 || true
  rm "$PLIST_DEST"
  echo "Removed $PLIST_DEST"
else
  echo "No launchd service found at $PLIST_DEST"
fi
