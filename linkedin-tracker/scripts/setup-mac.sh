#!/usr/bin/env bash
# Installs the LinkedIn tracker's three launchd jobs (post checker, weekly
# engagement sync, and the evening tomorrow's-post preview). Run once after:
# npm install, npm run build, and the two login steps (npm run login:linkedin,
# npm run login:whatsapp).
set -euo pipefail

TRACKER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_PATH="$(command -v node)"

if [ -z "$NODE_PATH" ]; then
  echo "node not found on PATH. Install Node.js first." >&2
  exit 1
fi

if [ ! -f "$TRACKER_DIR/build/check-new-post.js" ]; then
  echo "build/check-new-post.js not found. Run 'npm install && npm run build' in linkedin-tracker/ first." >&2
  exit 1
fi

if [ ! -f "$TRACKER_DIR/.env" ]; then
  echo "Warning: linkedin-tracker/.env not found. Copy .env.example to .env and fill it in." >&2
fi

mkdir -p "$TRACKER_DIR/logs"
mkdir -p "$HOME/Library/LaunchAgents"

for LABEL in com.sakky.linkedin-tracker com.sakky.linkedin-engagement com.sakky.linkedin-tomorrow-preview com.sakky.linkedin-wa-selfcheck; do
  PLIST_DEST="$HOME/Library/LaunchAgents/${LABEL}.plist"
  sed -e "s|__NODE_PATH__|${NODE_PATH}|g" \
      -e "s|__TRACKER_DIR__|${TRACKER_DIR}|g" \
      "$TRACKER_DIR/scripts/${LABEL}.plist.template" > "$PLIST_DEST"
  launchctl unload "$PLIST_DEST" >/dev/null 2>&1 || true
  launchctl load "$PLIST_DEST"
  echo "Loaded $LABEL"
done

cat <<EOF

Done. Schedules (local time):
  Post checks:      Mon-Fri 09:00/09:30/10:00 + 18:00/18:30/19:00, Sat 10:30/11:00/11:30, Sun 17:30/18:00/18:30
  Analytics sync:   Sun, random start 1-6am (launchd fires 01:00, job waits a random <=4h)
  Tomorrow preview: every day 20:00 (renders tomorrow's scheduled post, posts it to #content-upcoming)

Useful commands:
  node build/check-new-post.js                           # run a check right now
  DRY_RUN=true node build/check-tomorrow-post.js          # preview tomorrow's post without posting to Discord
  SKIP_START_JITTER=true node build/weekly-engagement.js  # run analytics sync now (skip the wait)
  tail -f logs/tracker.out.log              # follow checker logs
  tail -f logs/engagement.out.log           # follow engagement logs
  launchctl list | grep com.sakky.linkedin  # confirm jobs are loaded
EOF
