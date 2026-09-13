# Twitter weekly bangers — design

Date: 2026-09-13
Status: approved

## Goal

Every Saturday at 05:00 (Europe/London) find tweets from the last seven days that
have at least 50,000 likes and at least one image. Post the 20 highest-liked
tweets not seen in a previous run to the Discord channel
`#twitter-weekly-bangers`, and save the same 20 as tweet embeds on a new Notion
page so they can be scanned without opening X.

## Constraints and decisions

- Search runs through the X web UI in a logged-in Chrome profile (the user's
  main X account), driven by Playwright. The paid X API was rejected on cost.
- Search scope: last 7 days, any language, `min_faves:50000 filter:images`,
  Latest tab. Cap 100 tweets per run.
- Notion target: the **Content Master Table** database inside the LinkedIn page
  (`27e01c06-49d0-804c-99d3-c908aa98e26c`), whose "content ideas" view the user
  uses. It is a multi-source database, so pages are created with
  `parent.data_source_id` on Notion API version `2025-09-03`. Both data sources
  are empty and the API cannot say which one the view shows, so the id is an
  env setting defaulting to the first source
  (`27e01c06-49d0-808b-b355-000b53e20a3f`); the seed run confirms it.
- One Notion page per run, tweets as `embed` blocks inside it (not one row per
  tweet).
- Discord: one compact ranked message, links wrapped in `<>` to suppress
  previews. Channel `#twitter-weekly-bangers` (`1548630846737490041`) in the
  LinkedIn Maxxing server, posted as the existing `claudius` bot. Failures go
  to `#errors-sakky` (`1537381914543915048`).
- The seed run today fills the seen-set with up to 100 tweets AND posts the top
  20 to Discord and Notion, so the whole path is verified and this week's list
  is delivered. Later runs report only tweets not in the seen-set.
- Code lives in a new package `discordmcp/twitter-bangers/`, a sibling of
  `linkedin-tracker/`, reusing its patterns (persistent Chrome profile,
  Discord REST as the bot, Notion REST, launchd plist template + install
  script). Shipped on a feature branch with a PR.

## Architecture

```
launchd (Sat 05:00)  ->  build/weekly-bangers.js
                            |
                            +-- lib/config.ts     env + defaults, paths
                            +-- lib/x-search.ts   Playwright: open search, scroll,
                            |                     capture SearchTimeline JSON
                            +-- lib/tweets.ts     pure: parse JSON -> Tweet[],
                            |                     filter, rank, query builder
                            +-- lib/state.ts      seen tweet ids on disk
                            +-- lib/notion.ts     create weekly page with embeds
                            +-- lib/discord.ts    post list / no-news / alert
                            +-- lib/report.ts     pure: Discord message text
```

`login-x.ts` is the one-time interactive login (mirrors `login-linkedin.ts`).

### Data flow (one run)

1. Build query: `min_faves:50000 filter:images since:<run date - 7 days>`.
2. Open `https://x.com/search?q=<query>&src=typed_query&f=live` in the
   persistent Chrome profile. Assert logged in (a redirect to `/i/flow/login`
   or `/login` fails the run with a "run npm run login:x" hint).
3. Listen for responses whose URL matches `/i/api/graphql/*/SearchTimeline`.
   Parse each body into tweets. Scroll to the bottom repeatedly until the
   collected set reaches `MAX_POSTS` (100), no new tweets arrive after three
   consecutive scrolls, or a hard time limit (3 minutes) passes.
4. Filter: `favorite_count >= MIN_FAVES` and at least one `photo` in
   `extended_entities.media`. Drop retweets (`retweeted_status_result`) so the
   original tweet is what gets saved. Deduplicate by tweet id. Sort by likes
   descending. Keep the first 100.
5. Diff against `state.json`. `newTweets` = fetched tweets whose id is not in
   `seen`. Report set = top `REPORT_COUNT` (20) of `newTweets` by likes.
6. Notion: create the weekly page (title `Twitter bangers — week of <D Mon YYYY>`)
   with an intro paragraph and, per tweet, a paragraph
   (`@handle · 123,456 likes`) followed by an `embed` block of the tweet URL.
   If the report set is empty, no page is created.
7. Discord: post the ranked message to `#twitter-weekly-bangers` including the
   Notion page URL, or a "no new bangers this week" line when the report set is
   empty.
8. Persist: add every fetched tweet id to `seen` with likes, url and the date
   first seen; record `lastRun`. Written only after Discord succeeds, so a
   failed run is retried cleanly next time without losing tweets.
9. Any thrown error: log, post an alert to `#errors-sakky`, exit non-zero.

### Tweet shape

```ts
interface Tweet {
  id: string;          // rest_id
  url: string;         // https://x.com/<handle>/status/<id>
  handle: string;      // screen_name
  name: string;        // display name
  text: string;        // full_text, t.co media links stripped
  likes: number;       // favorite_count
  createdAt: string;   // ISO
  imageCount: number;  // photos in extended_entities.media
}
```

Parsing walks the SearchTimeline response generically: every object with
`__typename: "Tweet"` (or a `tweet` wrapper for `TweetWithVisibilityResults`)
and a `legacy` block is a candidate. This avoids depending on the exact
instruction/entry nesting, which X changes more often than the tweet object.

### State file

`twitter-bangers/state.json` (git-ignored):

```json
{
  "lastRun": "2026-09-13T10:00:00.000Z",
  "seen": {
    "1965...": { "likes": 81234, "url": "https://x.com/a/status/1965...", "firstSeen": "2026-09-13" }
  }
}
```

### Discord message

```
**Twitter weekly bangers — week of 13 Sep 2026**
12 new posts with 50k+ likes and images (of 87 checked).

1. @handle — 123.4K likes
   First line of the tweet, trimmed to ~110 chars…
   <https://x.com/handle/status/…>
2. …

Saved in Notion: <notion page url>
```

Entries are appended until the next one would pass 1,900 characters; the rest
go in a follow-up message. The "Saved in Notion" line is always in the last
message.

### Configuration (`.env`)

| Var | Default | Notes |
|---|---|---|
| `DISCORD_TOKEN` | required | same bot token as repo root |
| `NOTION_TOKEN` | required | same integration as the tracker |
| `NOTION_CONTENT_IDEAS_DATA_SOURCE_ID` | `27e01c06-49d0-808b-b355-000b53e20a3f` | switch if the page lands outside the view |
| `DISCORD_CHANNEL_ID` | `1548630846737490041` | #twitter-weekly-bangers |
| `DISCORD_ALERT_CHANNEL_ID` | `1537381914543915048` | #errors-sakky |
| `MIN_FAVES` | `50000` | |
| `MAX_POSTS` | `100` | cap per run |
| `REPORT_COUNT` | `20` | |
| `LOOKBACK_DAYS` | `7` | |
| `HEADLESS` | `false` | headed looks like normal browsing |
| `DRY_RUN` | unset | `true` = fetch and print, no Discord/Notion/state writes |

### Schedule

`scripts/com.sakky.twitter-bangers.plist.template`: `StartCalendarInterval`
Weekday 6, Hour 5, Minute 0. `scripts/setup-mac.sh` renders it with the node
path and package dir and loads it. Logs to `logs/bangers.{out,err}.log`.

### Error handling

- Not logged in: fail fast with the login hint; alert to `#errors-sakky`.
- Zero tweets parsed from a page that did load: treated as a failure (X likely
  changed the response shape), not as "nothing new".
- Discord alert text is truncated to 2,000 chars (reuse tracker's `fit`).
- Notion failure: the run still posts to Discord with a note that the Notion
  save failed, then exits non-zero and alerts. State is still written, since
  the tweets were reported.

### Testing

Unit tests with `node --test` on the pure modules, using a fixture captured
from a real SearchTimeline response with text trimmed:

- `tweets.test.ts`: query/since-date maths across month boundaries; parsing the
  fixture yields the expected ids, likes, image counts; retweets dropped;
  filter and rank; cap.
- `state.test.ts`: diff new vs seen; merge preserves earliest `firstSeen`.
- `report.test.ts`: message format, `<url>` wrapping, split under 2,000 chars,
  Notion link on the last chunk, empty-report text.
- `notion.test.ts`: block builder produces paragraph + embed per tweet, title
  format.

Integration: the seed run today, `DRY_RUN=true` first, then live.
