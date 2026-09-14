# Twitter weekly bangers

A weekly job on the Mac that finds last week's X posts with **50,000+ likes and
at least one image**, posts up to 50 relevant posts it has not reported before to Discord
`#twitter-weekly-bangers`, and saves the same 20 as tweet embeds on a new Notion
page in the Content schedule table (its "content ideas" view).

## How it works

- **Search**: Playwright opens the Top tab of X search in a logged-in Chrome
  profile with `min_faves:50000 filter:images since:<7 days ago>` and scrolls
  until it has 100 tweets or X stops returning results (Top tab). Tweets are read from
  the `SearchTimeline` JSON the page loads, not scraped from the DOM, so like
  counts are exact and image detection is reliable. Retweets are dropped.
- **Relevance filter**: the unseen tweets go to Claude (Sonnet 5 by default)
  in batches of 10 with their first image, judged against `rubric.md`. Each
  gets a category, a 1 to 5 score and a one-line reason; score 3+ survives
  (`MIN_SCORE`). Edit `rubric.md` to change taste, no code needed. If the
  classifier fails the run posts the unfiltered list with a warning, then
  exits non-zero so `#errors-sakky` hears about it.
- **New vs seen**: `state.json` records every tweet id any run has fetched.
  "New" means not in that file. The 7-day window overlaps week to week; the id
  set absorbs the duplicates.
- **Notion**: one page per run, titled `Twitter bangers — week of 13 Sep 2026`,
  with a caption line and an embed block per tweet.
- **Discord**: one compact ranked message (author, likes, category, first line, reason, link) with
  link previews suppressed, ending in "Saved in Notion". A week with nothing
  new still posts a "no new bangers" line. Failures alert `#errors-sakky`.
- **Schedule**: launchd, Saturday 05:00 local time. The Mac must be awake.

State is written only after the Discord post succeeds, so a run that fails
midway is retried cleanly next time without losing tweets.

## Setup

Use the arm64 Homebrew node (`/opt/homebrew/bin/node`); the x64 build at
`/usr/local/bin/node` runs Chrome under Rosetta.

```bash
cd twitter-bangers
export PATH=/opt/homebrew/bin:$PATH
npm install
npm run build
cp .env.example .env        # then set DISCORD_TOKEN, NOTION_TOKEN and ANTHROPIC_API_KEY
                            # (all three can be copied from linkedin-tracker/.env)
npm run login:x             # [HUMAN] log into X in the Chrome window that opens
DRY_RUN=true node build/weekly-bangers.js   # prints the report, posts nothing
node build/weekly-bangers.js                # live run
scripts/setup-mac.sh        # installs the Saturday 05:00 launchd job
```

The X session lives in `chrome-profile/` (its own profile, separate from the
LinkedIn tracker's). If X logs the session out, the run fails with a hint to
run `npm run login:x` again and posts an alert to `#errors-sakky`.

### Notion target

Pages are rows of the "Content schedule" database, created under its data
source (`NOTION_CONTENT_IDEAS_DATA_SOURCE_ID`, default set in code) with the
title in `Post name` and the run date in `Date`. Override the column names
with `NOTION_TITLE_PROPERTY` / `NOTION_DATE_PROPERTY` if the table changes.

## Settings

All optional, with defaults in `src/lib/config.ts`: `MIN_FAVES` (50000),
`MAX_POSTS` (100), `REPORT_COUNT` (50), `LOOKBACK_DAYS` (7), `MIN_SCORE` (3),
`CLASSIFIER_MODEL` (claude-sonnet-5), `CLASSIFY` (true), `DISCORD_CHANNEL_ID`,
`DISCORD_ALERT_CHANNEL_ID`, `HEADLESS`, `DRY_RUN`.

## Tests

```bash
npm test    # builds, then runs node --test on the pure modules
```

Covers the query date maths, parsing a SearchTimeline fixture, filtering and
ranking, the seen-set diff/merge, Discord message formatting and splitting,
the Notion block builder, and the classifier's batching, parsing and
image-failure retry (with a fake model call).

## Operations

```bash
tail -f logs/bangers.out.log
launchctl list | grep twitter-bangers
scripts/uninstall-mac.sh
```

To reset what counts as "seen", delete `state.json`; the next run treats
everything it fetches as new.
