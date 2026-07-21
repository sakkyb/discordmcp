# LinkedIn Tracker

Scheduled jobs on the Mac Mini that watch Sakky's LinkedIn profile for new posts and sync analytics. When a new post is detected it is logged to a Notion database and announced in a Discord channel.

## How it works

- **Post checker** (`check-new-post.js`): opens LinkedIn in a real, logged-in Chrome profile via Playwright, reads the profile's activity feed, and compares post URNs against `state.json`. New post → Notion (see below) + a Discord announcement. No new post → exits quietly.
- **Analytics sync** (`weekly-engagement.js`): once a week, opens each of the ~15 most recent posts' owner-only analytics page and writes the full metric set (Impressions, Profile views, Followers gained, Reactions, Comments, Reposts, Saves, Sends) to Notion.
- **Notion reuses the "Content schedule" database.** For each post the tracker finds the existing row by matching the LinkedIn **activity id** inside the `Post URL` column (robust across the `/feed/update/…` and `/posts/…` URL forms) and updates the metrics in place. If no row matches (an unplanned post), it creates one with `Post name`/`Post URL`/`Date` + metrics — so the table stays in sync whether a post was planned there or not. No `URN`/`Last Checked` columns are needed.
- **Schedules** (local time, via `launchd`):
  - Mon–Fri: 09:00, with retry slots at 09:30 and 10:00
  - Sat: 10:30, retries 11:00 and 11:30
  - Sun: 17:30, retries 18:00 and 18:30
  - Analytics sync: Sunday, random start across **1–6am** (launchd fires at 01:00, the job then waits a random ≤4h). Per-post analytics reads are spaced 60–180s apart — deliberately slow, since it runs overnight, to avoid machine-timed patterns.

Retry slots need no special logic — every run is the same idempotent check, and once a post is recorded in `state.json` the later slots find nothing new and exit.

The first ever run records all existing posts as a baseline **without notifying**, so it won't spam the channel with your back catalogue.

## Setup on the Mac Mini

This section is written so it can be followed end-to-end by a human **or handed to an agent/LLM running on the Mini**. Steps marked **[HUMAN]** need a person (logins, QR scan, Notion UI) — an agent should do everything else, pause at those, and ask.

Prerequisites (verify before starting):

```bash
node --version           # need v20+
node -p process.arch     # on Apple Silicon must be 'arm64' — an x64 build runs Chrome under
                         # Rosetta and is painfully slow. If it prints 'x64', install arm64 node
                         # (e.g. arm64 Homebrew at /opt/homebrew: `/opt/homebrew/bin/brew install node`)
                         # and reinstall deps under it.
ls "/Applications/Google Chrome.app" >/dev/null && echo "Chrome OK"   # the LinkedIn scraper (Playwright)
                         # drives this real system Chrome
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
   You will fill in the values over the next steps. `LINKEDIN_PROFILE_URL` can be set immediately (e.g. `https://www.linkedin.com/in/your-slug`, no trailing slash). `NOTION_TOKEN` and `DISCORD_TOKEN` can both be copied from the Discord bot's `.env` in the repo root if already set up there.

3. **[HUMAN]** Point the tracker at your Notion database. This deployment reuses
   the existing **"Content schedule"** database rather than a dedicated one.
   1. The tracker reads/writes these columns, which already exist there: `Post name`
      (title), `Post URL` (url), `Date` (date), `Reactions`/`Comments`/`Reposts`
      (number). If you point it at a different table, either match these names or
      update the `PROP` map at the top of `src/lib/notion.ts`.
   2. Share the database with the Notion integration that owns `NOTION_TOKEN`:
      ••• menu → Connections → add the integration.
   3. Set `NOTION_LINKEDIN_DATABASE_ID` in `.env` to the **database_id** — the
      32-char hex segment in the database URL, `notion.so/<workspace>/<DATABASE_ID>?v=...`.
      ⚠️ This is the `database_id`, **not** the `data_source_id` some other configs use
      (e.g. `NOTION_DATA_SOURCE_ID` in the repo-root `.env`) — they differ and the
      data-source id will 404 against this API.

4. **[HUMAN]** Log into LinkedIn once — this opens a Chrome window; complete the login and any 2FA. The session persists in `chrome-profile/` and is reused by all scheduled runs:
   ```bash
   npm run login:linkedin
   ```
   Success looks like: `✅ Logged in. Session saved to chrome-profile/`.

5. Configure Discord (no login/QR needed). Set `DISCORD_TOKEN` in `.env` (same bot token as the repo-root `.env`). The bot posts new-post announcements to a channel, tagging a user. The channel and user default in code to the **"LinkedIn Maxxing" #general** channel and **adi.lami**; override with `DISCORD_CHANNEL_ID` / `DISCORD_MENTION_USER_ID` in `.env` if they change. (The bot must be a member of the target guild.)

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

8. End-to-end verification (optional): temporarily remove the last URN from `state.json`'s `knownUrns` array, run `node build/check-new-post.js` again, and confirm the most recent post appears in Notion and is announced in Discord #general. (This re-announces one old post — expected.) For the analytics job, run it on demand with `SKIP_START_JITTER=true node build/weekly-engagement.js` to skip the random 1–6am wait.

## Operations

```bash
node build/check-new-post.js                          # manual check now
SKIP_START_JITTER=true node build/weekly-engagement.js # manual analytics sync now (skip the 1-6am wait)
tail -f logs/tracker.out.log                          # checker logs
tail -f logs/engagement.out.log                       # analytics logs
launchctl list | grep com.sakky.linkedin              # confirm jobs loaded
./scripts/uninstall-mac.sh                            # remove the schedules
```

## Things worth knowing

- **The LinkedIn session expires.** If LinkedIn logs the profile out, runs fail with a clear "run npm run login:linkedin" error in `logs/tracker.err.log`. Re-linking takes a minute.
- **Selectors will rot.** LinkedIn changes its markup periodically — this applies to both the activity feed and the analytics page. The scrapers fail loudly (naming the selector/label they expected) rather than silently reporting zeros; if the error log shows markup errors, update the selectors in `src/lib/linkedin.ts`.
- **Keep the frequency low.** The schedule is deliberately a handful of checks per day at human-plausible times, and the weekly analytics pass is paced 60–180s per post overnight. LinkedIn's ToS prohibits scraping and automated access; even benign automation against your own profile carries some account-restriction risk if it looks bot-like — resist turning this into a constant poller.
- **Discord uses the official bot API** (the same bot as the Discord MCP server) — no unofficial-library fragility. It just needs `DISCORD_TOKEN` set and the bot present in the guild.
- **The Mac must be awake** at the scheduled times (already handled — the Discord bot setup disables sleep) and the user must be logged in (launchd LaunchAgents run in the user session, which headed Chrome needs).
