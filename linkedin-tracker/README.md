# LinkedIn Tracker

Scheduled jobs on the Mac Mini that watch Sakky's LinkedIn profile for new posts and sync engagement stats. When a new post is detected it is logged to a Notion database and announced in a WhatsApp group.

## How it works

- **Post checker** (`check-new-post.js`): opens LinkedIn in a real, logged-in Chrome profile via Playwright, reads the profile's activity feed, and compares post URNs against `state.json`. New post → Notion row + WhatsApp message. No new post → exits quietly.
- **Engagement sync** (`weekly-engagement.js`): once a week, refreshes reaction/comment/repost counts for the ~15 most recent posts and updates their Notion rows.
- **Schedules** (local time, via `launchd`):
  - Mon–Fri: 09:00, with retry slots at 09:30 and 10:00
  - Sat: 10:30, retries 11:00 and 11:30
  - Sun: 17:30, retries 18:00 and 18:30
  - Engagement sync: Sun 08:00

Retry slots need no special logic — every run is the same idempotent check, and once a post is recorded in `state.json` the later slots find nothing new and exit.

The first ever run records all existing posts as a baseline **without notifying**, so it won't spam the group with your back catalogue.

## Setup on the Mac Mini

All commands run inside `linkedin-tracker/`.

Prerequisite: **Google Chrome** must be installed (the scraper drives the real Chrome via Playwright's `channel: 'chrome'` — no separate browser download needed).

1. Install dependencies and build:
   ```bash
   npm install
   npm run build
   ```

2. Configure:
   ```bash
   cp .env.example .env   # then fill it in
   ```

3. Create the Notion database (a table with these exact property names/types), share it with your integration, and put its ID in `.env`:
   | Property | Type |
   |---|---|
   | Name | Title |
   | URL | URL |
   | URN | Rich text |
   | Posted | Date |
   | Reactions | Number |
   | Comments | Number |
   | Reposts | Number |
   | Last Checked | Date |

4. Log into LinkedIn once (opens a Chrome window; complete any 2FA):
   ```bash
   npm run login:linkedin
   ```

5. Link WhatsApp once (prints a QR code; scan via WhatsApp → Settings → Linked Devices). It then prints your group names — copy the exact one into `WHATSAPP_GROUP_NAME` in `.env`:
   ```bash
   npm run login:whatsapp
   ```

6. Do a manual test run (this records the baseline of existing posts):
   ```bash
   node build/check-new-post.js
   ```

7. Install the schedules:
   ```bash
   ./scripts/setup-mac.sh
   ```

## Operations

```bash
node build/check-new-post.js               # manual check now
node build/weekly-engagement.js            # manual engagement sync now
tail -f logs/tracker.out.log               # checker logs
tail -f logs/engagement.out.log            # engagement logs
launchctl list | grep com.sakky.linkedin   # confirm jobs loaded
./scripts/uninstall-mac.sh                 # remove the schedules
```

## Things worth knowing

- **Sessions expire.** If LinkedIn logs the profile out, runs fail with a clear "run npm run login:linkedin" error in `logs/tracker.err.log`. Same for WhatsApp (`npm run login:whatsapp`). Re-linking takes a minute.
- **Selectors will rot.** LinkedIn changes its markup periodically. The scraper fails loudly (with the selector it was looking for) rather than silently reporting "no posts" — if the error log shows markup errors, the selectors in `src/lib/linkedin.ts` need updating.
- **Keep the frequency low.** The schedule is deliberately a handful of checks per day at human-plausible times. LinkedIn's ToS prohibits scraping and automated access, and even benign automation against your own profile carries some risk of account restriction if it looks bot-like — resist turning this into a constant poller.
- **WhatsApp uses whatsapp-web.js**, an unofficial WhatsApp Web automation library — the official API cannot post to group chats. Same class of ToS risk as above: it's your own account, low volume, but not zero risk.
- **The Mac must be awake** at the scheduled times (already handled — the Discord bot setup disables sleep) and the user must be logged in (launchd LaunchAgents run in the user session, which headed Chrome needs).
