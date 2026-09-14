#!/usr/bin/env bash
# Removes the court-watch launchd job. Leaves state.json and logs in place.
set -euo pipefail
DEST="$HOME/Library/LaunchAgents/com.sakky.court-watch.plist"
launchctl unload "$DEST" >/dev/null 2>&1 || true
rm -f "$DEST"
echo "Removed com.sakky.court-watch"
