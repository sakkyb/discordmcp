#!/usr/bin/env bash
# Removes the LinkedIn tracker launchd jobs installed by setup-mac.sh.
set -euo pipefail

for LABEL in com.sakky.linkedin-tracker com.sakky.linkedin-engagement com.sakky.linkedin-tomorrow-preview; do
  PLIST_DEST="$HOME/Library/LaunchAgents/${LABEL}.plist"
  if [ -f "$PLIST_DEST" ]; then
    launchctl unload "$PLIST_DEST" >/dev/null 2>&1 || true
    rm "$PLIST_DEST"
    echo "Removed $LABEL"
  else
    echo "No launchd job found for $LABEL"
  fi
done
