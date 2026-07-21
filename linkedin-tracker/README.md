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

This section is written so it can be followed end-to-end by a human **or handed to an agent/LLM running on the Mini**. Steps marked **[HUMAN]** need a person (logins, QR scan, Notion UI) — an agent should do everything else, pause at those, and ask.

Prerequisites (verify before starting):

```bash
node --version    # need v20+
ls "/Applications/Google Chrome.app" >/dev/null && echo "Chrome OK"   # scraper drives real Chrome
```

All remaining commands run inside `linkedin-tracker/` within the cloned repo (pull latest `main` first: `git pull origin main`).

1. Install dependencies and build:
   ```bash
   npm install
   npm run build
   ```
   Verify: `ls build/check-new-post.js` exists.

2. Create the config file:
   ```bash
   cp .env.example .env
   ```
   You will fill in the values over the next steps. `LINKEDIN_PROFILE_URL` can be set immediately (e.g. `https://www.linkedin.com/in/your-slug`, no trailing slash). `NOTION_TOKEN` can be copied from the Discord bot's `.env` in the repo root if already set up there.

3. **[HUMAN]** Create the Notion database:
   1. In Notion, create a new page containing a **table (full-page database)**, named e.g. "LinkedIn Posts".
   2. Give it these exact property names and types (delete any default extras like Tags):
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
   3. Share it with the Notion integration: ••• menu → Connections → add the integration that owns `NOTION_TOKEN`.
   4. Copy the database ID — it's the 32-char hex segment in the database URL, `notion.so/<workspace>/<DATABASE_ID>?v=...` — into `NOTION_LINKEDIN_DATABASE_ID` in `.env`.

4. **[HUMAN]** Log into LinkedIn once — this opens a Chrome window; complete the login and any 2FA. The session persists in `chrome-profile/` and is reused by all scheduled runs:
   ```bash
   npm run login:linkedin
   ```
   Success looks like: `✅ Logged in. Session saved to chrome-profile/`.

5. **[HUMAN]** Link WhatsApp once — this prints a QR code in the terminal; scan it with WhatsApp on the phone (Settings → Linked Devices → Link a Device). On success it prints the list of group names this account can post to:
   ```bash
   npm run login:whatsapp
   ```
   Copy the exact group name (case and spacing matter) into `WHATSAPP_GROUP_NAME` in `.env`.

6. Manual test run — this records existing posts as a baseline and sends **no** notifications:
   ```bash
   node build/check-new-post.js
   ```
   Success looks like: `First run: recorded N existing posts as baseline.` If it errors, the message names the fix (expired login, missing env var, or changed LinkedIn markup).

7. Install the schedules:
   ```bash
   ./scripts/setup-mac.sh
   ```
   Verify: `launchctl list | grep com.sakky.linkedin` shows both `com.sakky.linkedin-tracker` and `com.sakky.linkedin-engagement`.

8. End-to-end verification (optional but recommended): temporarily remove the last URN from `state.json`'s `knownUrns` array, run `node build/check-new-post.js` again, and confirm the most recent post appears in Notion and the WhatsApp group. (This re-sends one notification for an old post — expected.)

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
