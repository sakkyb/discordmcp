#!/usr/bin/env bash
# Removes the weekly Twitter bangers launchd job. Leaves chrome-profile/ and
# state.json in place.
set -euo pipefail
DEST="$HOME/Library/LaunchAgents/com.sakky.twitter-bangers.plist"
launchctl unload "$DEST" >/dev/null 2>&1 || true
rm -f "$DEST"
echo "Removed com.sakky.twitter-bangers"
