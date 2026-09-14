# Twitter Weekly Bangers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A weekly launchd job that searches X for tweets with 50k+ likes and images from the last 7 days, posts the top 20 unseen ones to Discord `#twitter-weekly-bangers`, and saves them as embeds on a new Notion page.

**Architecture:** New package `twitter-bangers/` beside `linkedin-tracker/`. Playwright drives a persistent Chrome profile logged into X and captures the `SearchTimeline` GraphQL JSON the page loads while scrolling. Pure modules (parse, filter, rank, diff, message formatting, Notion block building) are unit tested; thin I/O modules (browser, Discord REST, Notion REST, state file) wrap them. One entry script runs the pipeline.

**Tech Stack:** TypeScript 5 (ESM, NodeNext), Node 26 arm64 at `/opt/homebrew/bin/node`, Playwright 1.61.1 with `channel: 'chrome'`, `node --test`, dotenv, launchd.

**Spec:** `docs/superpowers/specs/2026-09-13-twitter-bangers-design.md`

## Global Constraints

- Use `/opt/homebrew/bin/node` and its npm for install, build, tests and the plist (arm64; `/usr/local/bin/node` is x64 and runs Chrome under Rosetta).
- Notion API version `2025-09-03`; pages are created with `parent: { type: 'data_source_id', data_source_id }`.
- Discord messages ≤ 2,000 chars; links wrapped in `<>`.
- Defaults: `MIN_FAVES=50000`, `MAX_POSTS=100`, `REPORT_COUNT=20`, `LOOKBACK_DAYS=7`, channel `1548630846737490041`, alert channel `1537381914543915048`, data source `27e01c06-49d0-808b-b355-000b53e20a3f`.
- Runtime files (`chrome-profile/`, `state.json`, `logs/`, `.env`) are git-ignored.
- Repo rule: work on branch `feat/twitter-bangers`, open a PR, never push to `main`.
- Test command: `npm test` = build + `node --test "build/**/*.test.js"`.

---

## File structure

```
twitter-bangers/
  package.json, tsconfig.json, .env.example, README.md
  src/
    weekly-bangers.ts        entry: run the pipeline (DRY_RUN aware)
    login-x.ts               one-time interactive X login
    lib/
      config.ts              env, defaults, paths
      tweets.ts              Tweet type, buildQuery, sinceDate, parseSearchResponse, selectTweets   (pure)
      tweets.test.ts
      fixtures/search-timeline.json  trimmed real response
      state.ts               load/save state.json, diffNew, mergeSeen
      state.test.ts
      report.ts              Discord message text + splitting                                       (pure)
      report.test.ts
      notion.ts              buildPageBlocks (pure) + createWeeklyPage (I/O)
      notion.test.ts
      discord.ts             postMessage, postReport, sendAlert
      x-search.ts            Playwright: openBrowser, assertLoggedIn, collectTweets
  scripts/
    com.sakky.twitter-bangers.plist.template
    setup-mac.sh
    uninstall-mac.sh
```

---

### Task 1: Package scaffold and config

**Files:**
- Create: `twitter-bangers/package.json`, `twitter-bangers/tsconfig.json`, `twitter-bangers/.env.example`, `twitter-bangers/src/lib/config.ts`
- Modify: `.gitignore` (repo root)

**Interfaces:**
- Produces: `config` object with getters `discordToken`, `notionToken`, `notionDataSourceId`, `discordChannelId`, `discordAlertChannelId`, `minFaves: number`, `maxPosts: number`, `reportCount: number`, `lookbackDays: number`, `headless: boolean`, `dryRun: boolean`; constants `PACKAGE_ROOT`, `CHROME_PROFILE_DIR`, `STATE_FILE`; `validateConfig()`.

- [ ] **Step 1: package.json**

```json
{
  "name": "twitter-bangers",
  "version": "1.0.0",
  "description": "Weekly job: X posts with 50k+ likes and images -> Discord + Notion",
  "type": "module",
  "private": true,
  "scripts": {
    "build": "tsc",
    "test": "npm run build && node --test \"build/**/*.test.js\"",
    "run": "node build/weekly-bangers.js",
    "login:x": "node build/login-x.js"
  },
  "dependencies": {
    "dotenv": "^16.4.7",
    "playwright": "1.61.1"
  },
  "devDependencies": {
    "@types/node": "^20.19.33",
    "typescript": "^5.9.3"
  }
}
```

- [ ] **Step 2: tsconfig.json** (copy of linkedin-tracker's)

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "build",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 3: .env.example**

```
# Discord bot token (same as repo-root .env)
DISCORD_TOKEN=
# Notion integration token (same as linkedin-tracker/.env)
NOTION_TOKEN=
# Data source inside the "Content Master Table" (LinkedIn page) that the
# "content ideas" view shows. Defaults to the first source; switch if the
# weekly page does not appear in that view.
# NOTION_CONTENT_IDEAS_DATA_SOURCE_ID=27e01c06-49d0-808b-b355-000b53e20a3f
# DISCORD_CHANNEL_ID=1548630846737490041        # #twitter-weekly-bangers
# DISCORD_ALERT_CHANNEL_ID=1537381914543915048  # #errors-sakky
# MIN_FAVES=50000
# MAX_POSTS=100
# REPORT_COUNT=20
# LOOKBACK_DAYS=7
# HEADLESS=false
# DRY_RUN=false   # true = search and print, no Discord/Notion/state writes
```

- [ ] **Step 4: src/lib/config.ts**

```ts
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PACKAGE_ROOT = path.resolve(__dirname, '..', '..');
dotenv.config({ path: path.join(PACKAGE_ROOT, '.env') });

export const CHROME_PROFILE_DIR = path.join(PACKAGE_ROOT, 'chrome-profile');
export const STATE_FILE = path.join(PACKAGE_ROOT, 'state.json');

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`❌ ${name} is not set (see .env.example)`);
    process.exit(1);
  }
  return value;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    console.error(`❌ ${name} must be a non-negative number, got ${raw}`);
    process.exit(1);
  }
  return n;
}

export const config = {
  get discordToken(): string { return required('DISCORD_TOKEN'); },
  get notionToken(): string { return required('NOTION_TOKEN'); },
  get notionDataSourceId(): string {
    return process.env.NOTION_CONTENT_IDEAS_DATA_SOURCE_ID || '27e01c06-49d0-808b-b355-000b53e20a3f';
  },
  get discordChannelId(): string { return process.env.DISCORD_CHANNEL_ID || '1548630846737490041'; },
  get discordAlertChannelId(): string { return process.env.DISCORD_ALERT_CHANNEL_ID || '1537381914543915048'; },
  get minFaves(): number { return num('MIN_FAVES', 50_000); },
  get maxPosts(): number { return num('MAX_POSTS', 100); },
  get reportCount(): number { return num('REPORT_COUNT', 20); },
  get lookbackDays(): number { return num('LOOKBACK_DAYS', 7); },
  get headless(): boolean { return process.env.HEADLESS === 'true'; },
  get dryRun(): boolean { return process.env.DRY_RUN === 'true'; },
};

export function validateConfig(): void {
  if (config.dryRun) return;
  void config.discordToken;
  void config.notionToken;
}
```

- [ ] **Step 5: .gitignore** — append:

```
# Twitter bangers runtime data
twitter-bangers/chrome-profile/
twitter-bangers/state.json
twitter-bangers/logs/
```

- [ ] **Step 6: Install and build**

Run: `cd twitter-bangers && PATH=/opt/homebrew/bin:$PATH npm install && PATH=/opt/homebrew/bin:$PATH npm run build`
Expected: `build/lib/config.js` exists, no tsc errors.

- [ ] **Step 7: Commit**

```bash
git add twitter-bangers/package.json twitter-bangers/package-lock.json twitter-bangers/tsconfig.json twitter-bangers/.env.example twitter-bangers/src/lib/config.ts .gitignore
git commit -m "feat(twitter-bangers): package scaffold and config"
```

---

### Task 2: Pure tweet logic (query, parse, select)

**Files:**
- Create: `twitter-bangers/src/lib/tweets.ts`, `twitter-bangers/src/lib/tweets.test.ts`, `twitter-bangers/src/lib/fixtures/search-timeline.json`

**Interfaces:**
- Produces:
  - `interface Tweet { id; url; handle; name; text; likes; createdAt; imageCount }`
  - `sinceDate(runDate: Date, lookbackDays: number): string` → `YYYY-MM-DD` (local date)
  - `buildQuery(minFaves: number, since: string): string` → `min_faves:50000 filter:images since:2026-09-06`
  - `searchUrl(query: string): string` → `https://x.com/search?q=<enc>&src=typed_query&f=live`
  - `parseSearchResponse(body: unknown): Tweet[]` (generic walk; drops retweets; dedupes)
  - `selectTweets(tweets: Tweet[], opts: { minFaves; maxPosts }): Tweet[]` (filter likes ≥ minFaves and imageCount ≥ 1, dedupe by id, sort likes desc, cap)

- [ ] **Step 1: Fixture** — a hand-built but shape-accurate SearchTimeline body (the real capture replaces it in Task 6 if the shape differs):

```json
{
  "data": { "search_by_raw_query": { "search_timeline": { "timeline": { "instructions": [
    { "type": "TimelineAddEntries", "entries": [
      { "entryId": "tweet-1001", "content": { "entryType": "TimelineTimelineItem", "itemContent": { "itemType": "TimelineTweet", "tweet_results": { "result": {
        "__typename": "Tweet", "rest_id": "1001",
        "core": { "user_results": { "result": { "__typename": "User", "core": { "screen_name": "alice", "name": "Alice" }, "legacy": { "screen_name": "alice", "name": "Alice" } } } },
        "legacy": { "full_text": "First banger https://t.co/abc", "favorite_count": 81234, "created_at": "Wed Sep 09 12:00:00 +0000 2026",
          "entities": { "media": [ { "type": "photo", "url": "https://t.co/abc" } ] },
          "extended_entities": { "media": [ { "type": "photo", "url": "https://t.co/abc" }, { "type": "photo", "url": "https://t.co/abc" } ] } }
      } } } } },
      { "entryId": "tweet-1002", "content": { "entryType": "TimelineTimelineItem", "itemContent": { "itemType": "TimelineTweet", "tweet_results": { "result": {
        "__typename": "TweetWithVisibilityResults", "tweet": {
          "rest_id": "1002",
          "core": { "user_results": { "result": { "core": { "screen_name": "bob", "name": "Bob" } } } },
          "legacy": { "full_text": "Video only", "favorite_count": 99000, "created_at": "Thu Sep 10 12:00:00 +0000 2026",
            "extended_entities": { "media": [ { "type": "video", "url": "https://t.co/vid" } ] } }
        } } } } } },
      { "entryId": "tweet-1003", "content": { "entryType": "TimelineTimelineItem", "itemContent": { "itemType": "TimelineTweet", "tweet_results": { "result": {
        "__typename": "Tweet", "rest_id": "1003",
        "core": { "user_results": { "result": { "legacy": { "screen_name": "carol", "name": "Carol" } } } },
        "legacy": { "full_text": "RT @alice: First banger https://t.co/abc", "favorite_count": 0, "created_at": "Thu Sep 10 13:00:00 +0000 2026",
          "retweeted_status_result": { "result": { "__typename": "Tweet", "rest_id": "1001",
            "core": { "user_results": { "result": { "core": { "screen_name": "alice", "name": "Alice" } } } },
            "legacy": { "full_text": "First banger https://t.co/abc", "favorite_count": 81234, "created_at": "Wed Sep 09 12:00:00 +0000 2026",
              "extended_entities": { "media": [ { "type": "photo", "url": "https://t.co/abc" } ] } } } } }
      } } } } },
      { "entryId": "tweet-1004", "content": { "entryType": "TimelineTimelineItem", "itemContent": { "itemType": "TimelineTweet", "tweet_results": { "result": {
        "__typename": "Tweet", "rest_id": "1004",
        "core": { "user_results": { "result": { "core": { "screen_name": "dave", "name": "Dave" } } } },
        "legacy": { "full_text": "Small one", "favorite_count": 12000, "created_at": "Fri Sep 11 12:00:00 +0000 2026",
          "extended_entities": { "media": [ { "type": "photo", "url": "https://t.co/x" } ] } }
      } } } } },
      { "entryId": "cursor-bottom-1", "content": { "entryType": "TimelineTimelineCursor", "cursorType": "Bottom", "value": "scroll:abc" } }
    ] }
  ] } } } }
}
```

- [ ] **Step 2: Failing tests** `src/lib/tweets.test.ts`

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { sinceDate, buildQuery, searchUrl, parseSearchResponse, selectTweets } from './tweets.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'search-timeline.json'), 'utf-8'));

test('sinceDate subtracts lookback days across a month boundary', () => {
  assert.equal(sinceDate(new Date(2026, 8, 13, 5, 0), 7), '2026-09-06');
  assert.equal(sinceDate(new Date(2026, 9, 3, 5, 0), 7), '2026-09-26');
  assert.equal(sinceDate(new Date(2026, 0, 2, 5, 0), 7), '2025-12-26');
});

test('buildQuery and searchUrl', () => {
  const q = buildQuery(50_000, '2026-09-06');
  assert.equal(q, 'min_faves:50000 filter:images since:2026-09-06');
  assert.equal(searchUrl(q), 'https://x.com/search?q=min_faves%3A50000%20filter%3Aimages%20since%3A2026-09-06&src=typed_query&f=live');
});

test('parseSearchResponse extracts tweets, unwraps visibility results, drops retweets', () => {
  const tweets = parseSearchResponse(fixture);
  assert.deepEqual(tweets.map((t) => t.id).sort(), ['1001', '1002', '1004']);
  const a = tweets.find((t) => t.id === '1001')!;
  assert.equal(a.handle, 'alice');
  assert.equal(a.name, 'Alice');
  assert.equal(a.likes, 81234);
  assert.equal(a.imageCount, 2);
  assert.equal(a.text, 'First banger');
  assert.equal(a.url, 'https://x.com/alice/status/1001');
  assert.equal(a.createdAt, '2026-09-09T12:00:00.000Z');
  const b = tweets.find((t) => t.id === '1002')!;
  assert.equal(b.handle, 'bob');
  assert.equal(b.imageCount, 0);
});

test('parseSearchResponse tolerates garbage', () => {
  assert.deepEqual(parseSearchResponse(null), []);
  assert.deepEqual(parseSearchResponse({ data: {} }), []);
  assert.deepEqual(parseSearchResponse('nope'), []);
});

test('selectTweets filters by likes and images, sorts, dedupes and caps', () => {
  const tweets = parseSearchResponse(fixture);
  const doubled = [...tweets, ...tweets];
  const picked = selectTweets(doubled, { minFaves: 50_000, maxPosts: 100 });
  assert.deepEqual(picked.map((t) => t.id), ['1001']);
  const loose = selectTweets(doubled, { minFaves: 1, maxPosts: 100 });
  assert.deepEqual(loose.map((t) => t.id), ['1001', '1004']);
  const capped = selectTweets(doubled, { minFaves: 1, maxPosts: 1 });
  assert.deepEqual(capped.map((t) => t.id), ['1001']);
});
```

- [ ] **Step 3: Run tests, expect failure**

Run: `PATH=/opt/homebrew/bin:$PATH npm test`
Expected: tsc error `Cannot find module './tweets.js'`.

- [ ] **Step 4: Implement** `src/lib/tweets.ts`

```ts
export interface Tweet {
  id: string;
  url: string;
  handle: string;
  name: string;
  text: string;
  likes: number;
  createdAt: string;
  imageCount: number;
}

// Local calendar date N days before runDate, formatted for X's since: operator.
export function sinceDate(runDate: Date, lookbackDays: number): string {
  const d = new Date(runDate.getFullYear(), runDate.getMonth(), runDate.getDate() - lookbackDays);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

export function buildQuery(minFaves: number, since: string): string {
  return `min_faves:${minFaves} filter:images since:${since}`;
}

// f=live is the "Latest" tab: newest first, no ranking games.
export function searchUrl(query: string): string {
  return `https://x.com/search?q=${encodeURIComponent(query)}&src=typed_query&f=live`;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

// A tweet object as it appears in X's GraphQL responses. Newer payloads put the
// handle at core.user_results.result.core.screen_name, older ones at
// ...result.legacy.screen_name; both are read.
function toTweet(node: Obj): Tweet | null {
  const legacy = node.legacy;
  if (!isObj(legacy)) return null;
  if (isObj(legacy.retweeted_status_result)) return null; // a retweet; the original shows up on its own
  const id = typeof node.rest_id === 'string' ? node.rest_id : typeof legacy.id_str === 'string' ? legacy.id_str : null;
  if (!id) return null;

  const userResult = (((node.core as Obj | undefined)?.user_results as Obj | undefined)?.result as Obj | undefined) ?? {};
  const userCore = isObj(userResult.core) ? userResult.core : {};
  const userLegacy = isObj(userResult.legacy) ? userResult.legacy : {};
  const handle = String(userCore.screen_name ?? userLegacy.screen_name ?? '');
  const name = String(userCore.name ?? userLegacy.name ?? handle);

  const media = isObj(legacy.extended_entities) && Array.isArray(legacy.extended_entities.media)
    ? (legacy.extended_entities.media as unknown[])
    : isObj(legacy.entities) && Array.isArray(legacy.entities.media)
      ? (legacy.entities.media as unknown[])
      : [];
  const imageCount = media.filter((m) => isObj(m) && m.type === 'photo').length;

  const rawText = typeof legacy.full_text === 'string' ? legacy.full_text : '';
  const text = rawText.replace(/\s*https:\/\/t\.co\/\w+/g, '').trim();
  const created = typeof legacy.created_at === 'string' ? new Date(legacy.created_at) : new Date(NaN);
  const likes = typeof legacy.favorite_count === 'number' ? legacy.favorite_count : Number(legacy.favorite_count) || 0;

  return {
    id,
    url: `https://x.com/${handle || 'i'}/status/${id}`,
    handle,
    name,
    text,
    likes,
    createdAt: Number.isNaN(created.getTime()) ? '' : created.toISOString(),
    imageCount,
  };
}

// Walk the whole response rather than the instruction/entry nesting, which X
// reshapes more often than the tweet object itself. Any object with a `legacy`
// block and a rest_id is a tweet; TweetWithVisibilityResults wraps it in `tweet`.
export function parseSearchResponse(body: unknown): Tweet[] {
  const found = new Map<string, Tweet>();
  const stack: unknown[] = [body];
  while (stack.length) {
    const cur = stack.pop();
    if (Array.isArray(cur)) { stack.push(...cur); continue; }
    if (!isObj(cur)) continue;
    if (cur.__typename === 'TweetWithVisibilityResults' && isObj(cur.tweet)) { stack.push(cur.tweet); continue; }
    if (isObj(cur.legacy) && typeof (cur.legacy as Obj).full_text === 'string') {
      const t = toTweet(cur);
      if (t && !found.has(t.id)) found.set(t.id, t);
      continue; // do not descend into a tweet: quoted/retweeted tweets are handled by their own entries
    }
    stack.push(...Object.values(cur));
  }
  return [...found.values()];
}

export function selectTweets(tweets: Tweet[], opts: { minFaves: number; maxPosts: number }): Tweet[] {
  const byId = new Map<string, Tweet>();
  for (const t of tweets) {
    if (t.likes < opts.minFaves || t.imageCount < 1) continue;
    const prev = byId.get(t.id);
    if (!prev || t.likes > prev.likes) byId.set(t.id, t);
  }
  return [...byId.values()].sort((a, b) => b.likes - a.likes).slice(0, opts.maxPosts);
}
```

- [ ] **Step 5: Run tests, expect pass.** `PATH=/opt/homebrew/bin:$PATH npm test` → all `tweets.test` cases pass. Note: `build/lib/fixtures/*.json` is not copied by tsc; the test reads from `build/lib/fixtures`, so add `"cp -R src/lib/fixtures build/lib/"` to the build script: `"build": "tsc && mkdir -p build/lib && cp -R src/lib/fixtures build/lib/"`.

- [ ] **Step 6: Commit** `git add twitter-bangers/src/lib/tweets.ts twitter-bangers/src/lib/tweets.test.ts twitter-bangers/src/lib/fixtures twitter-bangers/package.json && git commit -m "feat(twitter-bangers): parse, filter and rank search results"`

---

### Task 3: State file

**Files:**
- Create: `twitter-bangers/src/lib/state.ts`, `twitter-bangers/src/lib/state.test.ts`

**Interfaces:**
- Consumes: `Tweet` from tweets.ts, `STATE_FILE` from config.ts.
- Produces: `interface SeenEntry { likes; url; firstSeen }`, `interface BangersState { lastRun: string | null; seen: Record<string, SeenEntry> }`, `loadState(file?): BangersState`, `saveState(state, file?)`, `diffNew(state, tweets): Tweet[]` (pure), `mergeSeen(state, tweets, today: string): BangersState` (pure; keeps earliest firstSeen, updates likes upward).

- [ ] **Step 1: Failing tests**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadState, saveState, diffNew, mergeSeen } from './state.js';
import type { Tweet } from './tweets.js';

const tw = (id: string, likes: number): Tweet => ({ id, url: `https://x.com/u/status/${id}`, handle: 'u', name: 'U', text: '', likes, createdAt: '', imageCount: 1 });

test('loadState returns empty state when the file is missing or corrupt', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bangers-'));
  const file = path.join(dir, 'state.json');
  assert.deepEqual(loadState(file), { lastRun: null, seen: {} });
  fs.writeFileSync(file, '{not json');
  assert.deepEqual(loadState(file), { lastRun: null, seen: {} });
});

test('diffNew returns only tweets not in seen', () => {
  const state = { lastRun: null, seen: { '1': { likes: 5, url: '', firstSeen: '2026-09-06' } } };
  assert.deepEqual(diffNew(state, [tw('1', 9), tw('2', 8)]).map((t) => t.id), ['2']);
});

test('mergeSeen keeps earliest firstSeen and the higher like count', () => {
  const state = { lastRun: null, seen: { '1': { likes: 5, url: 'a', firstSeen: '2026-09-06' } } };
  const next = mergeSeen(state, [tw('1', 9), tw('2', 8)], '2026-09-13');
  assert.equal(next.seen['1'].firstSeen, '2026-09-06');
  assert.equal(next.seen['1'].likes, 9);
  assert.equal(next.seen['2'].firstSeen, '2026-09-13');
  assert.equal(next.lastRun !== null, true);
  assert.equal(state.seen['2'], undefined); // input not mutated
});

test('saveState then loadState round-trips', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bangers-'));
  const file = path.join(dir, 'state.json');
  const state = mergeSeen({ lastRun: null, seen: {} }, [tw('7', 1)], '2026-09-13');
  saveState(state, file);
  assert.deepEqual(loadState(file), state);
});
```

- [ ] **Step 2: Run, expect failure** (`Cannot find module './state.js'`).

- [ ] **Step 3: Implement** `src/lib/state.ts`

```ts
import fs from 'fs';
import { STATE_FILE } from './config.js';
import type { Tweet } from './tweets.js';

export interface SeenEntry { likes: number; url: string; firstSeen: string }
export interface BangersState { lastRun: string | null; seen: Record<string, SeenEntry> }

export function loadState(file: string = STATE_FILE): BangersState {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return {
      lastRun: typeof raw.lastRun === 'string' ? raw.lastRun : null,
      seen: raw.seen && typeof raw.seen === 'object' ? raw.seen : {},
    };
  } catch {
    return { lastRun: null, seen: {} };
  }
}

export function saveState(state: BangersState, file: string = STATE_FILE): void {
  fs.writeFileSync(file, JSON.stringify(state, null, 2));
}

export function diffNew(state: BangersState, tweets: Tweet[]): Tweet[] {
  return tweets.filter((t) => !(t.id in state.seen));
}

export function mergeSeen(state: BangersState, tweets: Tweet[], today: string): BangersState {
  const seen = { ...state.seen };
  for (const t of tweets) {
    const prev = seen[t.id];
    seen[t.id] = prev
      ? { ...prev, likes: Math.max(prev.likes, t.likes), url: t.url }
      : { likes: t.likes, url: t.url, firstSeen: today };
  }
  return { lastRun: new Date().toISOString(), seen };
}
```

- [ ] **Step 4: Run, expect pass.** - [ ] **Step 5: Commit** `git commit -m "feat(twitter-bangers): seen-tweet state file"`

---

### Task 4: Discord report text and posting

**Files:**
- Create: `twitter-bangers/src/lib/report.ts`, `twitter-bangers/src/lib/report.test.ts`, `twitter-bangers/src/lib/discord.ts`

**Interfaces:**
- Consumes: `Tweet`, `config`.
- Produces (report.ts, pure): `weekLabel(date: Date): string` → `13 Sep 2026`; `formatLikes(n): string` → `123.4K` / `2.1M` / `999`; `buildReportMessages(opts: { runDate: Date; report: Tweet[]; checked: number; notionUrl: string | null; notionError?: string }): string[]`.
- Produces (discord.ts): `postMessage(channelId, content)`, `postReport(messages: string[])` (sequential to the report channel), `sendAlert(text)`.

- [ ] **Step 1: Failing tests** `report.test.ts`

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { weekLabel, formatLikes, buildReportMessages } from './report.js';
import type { Tweet } from './tweets.js';

const tw = (i: number, likes = 60_000): Tweet => ({
  id: String(i), url: `https://x.com/user${i}/status/${i}`, handle: `user${i}`, name: `User ${i}`,
  text: `Line one of tweet ${i}\nSecond line that must not appear`, likes, createdAt: '', imageCount: 1,
});
const run = new Date(2026, 8, 13, 5, 0);

test('weekLabel and formatLikes', () => {
  assert.equal(weekLabel(run), '13 Sep 2026');
  assert.equal(formatLikes(999), '999');
  assert.equal(formatLikes(123_456), '123.5K');
  assert.equal(formatLikes(50_000), '50K');
  assert.equal(formatLikes(2_100_000), '2.1M');
});

test('a report lists entries with suppressed links and ends with the Notion line', () => {
  const [msg] = buildReportMessages({ runDate: run, report: [tw(1, 81_234), tw(2)], checked: 40, notionUrl: 'https://notion.so/p' });
  assert.match(msg, /^\*\*Twitter weekly bangers — week of 13 Sep 2026\*\*\n/);
  assert.match(msg, /2 new posts with 50k\+ likes and images \(of 40 checked\)/);
  assert.match(msg, /1\. @user1 — 81\.2K likes\n {3}Line one of tweet 1\n {3}<https:\/\/x\.com\/user1\/status\/1>/);
  assert.doesNotMatch(msg, /Second line/);
  assert.match(msg, /\nSaved in Notion: <https:\/\/notion\.so\/p>$/);
});

test('an empty report says so and still mentions nothing was saved', () => {
  const msgs = buildReportMessages({ runDate: run, report: [], checked: 12, notionUrl: null });
  assert.equal(msgs.length, 1);
  assert.match(msgs[0], /No new bangers this week/);
  assert.match(msgs[0], /12 checked/);
});

test('long reports split under 2000 chars with the Notion line last', () => {
  const report = Array.from({ length: 20 }, (_, i) => tw(i + 1));
  const msgs = buildReportMessages({ runDate: run, report, checked: 100, notionUrl: 'https://notion.so/p' });
  assert.ok(msgs.length >= 2);
  for (const m of msgs) assert.ok(m.length <= 2000, `chunk too long: ${m.length}`);
  assert.match(msgs[msgs.length - 1], /Saved in Notion: <https:\/\/notion\.so\/p>$/);
  assert.equal(msgs.join('\n').match(/^\d+\. @/gm)!.length, 20);
});

test('a Notion failure is reported instead of the link', () => {
  const [msg] = buildReportMessages({ runDate: run, report: [tw(1)], checked: 1, notionUrl: null, notionError: 'boom' });
  assert.match(msg, /Notion save failed: boom/);
});
```

- [ ] **Step 2: Run, expect failure.**

- [ ] **Step 3: Implement** `report.ts`

```ts
import type { Tweet } from './tweets.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function weekLabel(date: Date): string {
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

export function formatLikes(n: number): string {
  const short = (v: number, s: string) => `${Number.isInteger(v) ? v : v.toFixed(1)}${s}`;
  if (n >= 1_000_000) return short(Math.round(n / 100_000) / 10, 'M');
  if (n >= 1_000) return short(Math.round(n / 100) / 10, 'K');
  return String(n);
}

const LIMIT = 1900; // headroom under Discord's 2000
const SNIPPET = 110;

function snippet(text: string): string {
  const line = text.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  return line.length > SNIPPET ? `${line.slice(0, SNIPPET - 1)}…` : line;
}

function entry(i: number, t: Tweet): string {
  const s = snippet(t.text);
  return `${i}. @${t.handle} — ${formatLikes(t.likes)} likes\n${s ? `   ${s}\n` : ''}   <${t.url}>`;
}

export function buildReportMessages(opts: {
  runDate: Date; report: Tweet[]; checked: number; notionUrl: string | null; notionError?: string;
}): string[] {
  const header = `**Twitter weekly bangers — week of ${weekLabel(opts.runDate)}**`;
  const footer = opts.notionError
    ? `Notion save failed: ${opts.notionError}`
    : opts.notionUrl
      ? `Saved in Notion: <${opts.notionUrl}>`
      : '';

  if (opts.report.length === 0) {
    return [`${header}\nNo new bangers this week (${opts.checked} checked, none unseen).${footer ? `\n\n${footer}` : ''}`];
  }

  const intro = `${header}\n${opts.report.length} new posts with 50k+ likes and images (of ${opts.checked} checked).\n`;
  const chunks: string[] = [];
  let cur = intro;
  opts.report.forEach((t, i) => {
    const e = `\n${entry(i + 1, t)}`;
    if (cur.length + e.length > LIMIT) { chunks.push(cur); cur = ''; }
    cur += e;
  });
  if (footer) {
    const f = `\n\n${footer}`;
    if (cur.length + f.length > LIMIT) { chunks.push(cur); cur = footer; } else cur += f;
  }
  chunks.push(cur);
  return chunks;
}
```

- [ ] **Step 4: Implement** `discord.ts`

```ts
import { config } from './config.js';

const API = 'https://discord.com/api/v10';
const DISCORD_MAX = 2000;
const fit = (s: string) => (s.length <= DISCORD_MAX ? s : `${s.slice(0, DISCORD_MAX - 3)}...`);

export async function postMessage(channelId: string, content: string): Promise<void> {
  const res = await fetch(`${API}/channels/${channelId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bot ${config.discordToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: fit(content) }),
  });
  if (!res.ok) throw new Error(`Discord message failed (${res.status}): ${await res.text()}`);
}

// Chunks go out in order so the list reads top to bottom.
export async function postReport(messages: string[]): Promise<void> {
  for (const m of messages) await postMessage(config.discordChannelId, m);
}

export async function sendAlert(text: string): Promise<void> {
  await postMessage(config.discordAlertChannelId, `⚠️ twitter-bangers: ${text}`);
}
```

- [ ] **Step 5: Run tests, expect pass.** - [ ] **Step 6: Commit** `git commit -m "feat(twitter-bangers): Discord report formatting and posting"`

---

### Task 5: Notion weekly page

**Files:**
- Create: `twitter-bangers/src/lib/notion.ts`, `twitter-bangers/src/lib/notion.test.ts`

**Interfaces:**
- Consumes: `Tweet`, `config`, `weekLabel`, `formatLikes`.
- Produces: `pageTitle(runDate): string` → `Twitter bangers — week of 13 Sep 2026`; `buildPageBlocks(report: Tweet[], query: string): unknown[]` (pure); `createWeeklyPage(runDate, report, query): Promise<string>` returning the page URL.

- [ ] **Step 1: Failing tests**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pageTitle, buildPageBlocks } from './notion.js';
import type { Tweet } from './tweets.js';

const tw: Tweet = { id: '1', url: 'https://x.com/a/status/1', handle: 'a', name: 'A', text: 'hi', likes: 81_234, createdAt: '', imageCount: 1 };

test('pageTitle', () => {
  assert.equal(pageTitle(new Date(2026, 8, 13)), 'Twitter bangers — week of 13 Sep 2026');
});

test('buildPageBlocks: intro paragraph then a caption + embed per tweet', () => {
  const blocks = buildPageBlocks([tw, { ...tw, id: '2', url: 'https://x.com/b/status/2', handle: 'b' }], 'min_faves:50000 filter:images since:2026-09-06') as any[];
  assert.equal(blocks.length, 1 + 2 * 2);
  assert.equal(blocks[0].type, 'paragraph');
  assert.match(blocks[0].paragraph.rich_text[0].text.content, /2 posts.*min_faves:50000/);
  assert.equal(blocks[1].type, 'paragraph');
  assert.equal(blocks[1].paragraph.rich_text[0].text.content, '1. @a · 81.2K likes');
  assert.equal(blocks[1].paragraph.rich_text[0].text.link.url, 'https://x.com/a/status/1');
  assert.equal(blocks[2].type, 'embed');
  assert.equal(blocks[2].embed.url, 'https://x.com/a/status/1');
  assert.equal(blocks[4].embed.url, 'https://x.com/b/status/2');
});
```

- [ ] **Step 2: Run, expect failure.** - [ ] **Step 3: Implement**

```ts
import { config } from './config.js';
import { weekLabel, formatLikes } from './report.js';
import type { Tweet } from './tweets.js';

const NOTION_VERSION = '2025-09-03'; // needed for multi-source databases (data_source_id parents)

export async function notionFetch(path: string, method: string, body?: unknown): Promise<any> {
  const res = await fetch(`https://api.notion.com/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${config.notionToken}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`Notion API ${method} ${path} failed (${res.status}): ${await res.text()}`);
  return res.json();
}

export function pageTitle(runDate: Date): string {
  return `Twitter bangers — week of ${weekLabel(runDate)}`;
}

const para = (content: string, link?: string) => ({
  object: 'block', type: 'paragraph',
  paragraph: { rich_text: [{ type: 'text', text: { content, link: link ? { url: link } : null } }] },
});

// A caption line then an embed per tweet. Notion renders x.com embeds as tweet
// cards, so the page can be scanned without leaving Notion.
export function buildPageBlocks(report: Tweet[], query: string): unknown[] {
  const blocks: unknown[] = [para(`${report.length} posts with 50k+ likes and images from the last 7 days. Search: ${query}`)];
  report.forEach((t, i) => {
    blocks.push(para(`${i + 1}. @${t.handle} · ${formatLikes(t.likes)} likes`, t.url));
    blocks.push({ object: 'block', type: 'embed', embed: { url: t.url } });
  });
  return blocks;
}

// Notion accepts at most 100 children on page creation; a 20-tweet page is 41
// blocks, but keep the split so a larger REPORT_COUNT still works.
export async function createWeeklyPage(runDate: Date, report: Tweet[], query: string): Promise<string> {
  const blocks = buildPageBlocks(report, query);
  const page = await notionFetch('/pages', 'POST', {
    parent: { type: 'data_source_id', data_source_id: config.notionDataSourceId },
    properties: { Name: { title: [{ type: 'text', text: { content: pageTitle(runDate) } }] } },
    children: blocks.slice(0, 100),
  });
  for (let i = 100; i < blocks.length; i += 100) {
    await notionFetch(`/blocks/${page.id}/children`, 'PATCH', { children: blocks.slice(i, i + 100) });
  }
  return page.url as string;
}
```

- [ ] **Step 4: Run tests, expect pass.** - [ ] **Step 5: Commit** `git commit -m "feat(twitter-bangers): Notion weekly page with tweet embeds"`

---

### Task 6: X search via Playwright, login script, entry point

**Files:**
- Create: `twitter-bangers/src/lib/x-search.ts`, `twitter-bangers/src/login-x.ts`, `twitter-bangers/src/weekly-bangers.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: `openBrowser(): Promise<BrowserContext>`, `collectTweets(page, url, opts: { maxPosts; timeoutMs }): Promise<{ tweets: Tweet[]; responses: number }>`.

- [ ] **Step 1: x-search.ts**

```ts
import { chromium } from 'playwright';
import type { BrowserContext, Page } from 'playwright';
import { CHROME_PROFILE_DIR, config } from './config.js';
import { parseSearchResponse, type Tweet } from './tweets.js';

export async function openBrowser(): Promise<BrowserContext> {
  return chromium.launchPersistentContext(CHROME_PROFILE_DIR, {
    channel: 'chrome',
    headless: config.headless,
    viewport: { width: 1280, height: 900 },
    chromiumSandbox: true,
    args: ['--disable-blink-features=AutomationControlled'],
  });
}

export const LOGGED_OUT_HINT = "Run 'npm run login:x' in twitter-bangers/ to log in again.";

export function assertLoggedIn(page: Page): void {
  const url = page.url();
  if (/\/(i\/flow\/login|login|account\/access)/.test(url)) {
    throw new Error(`X session is not logged in (landed on ${url}). ${LOGGED_OUT_HINT}`);
  }
}

const SEARCH_API = /\/i\/api\/graphql\/[^/]+\/SearchTimeline/;

// Open the search page and scroll, harvesting tweets from the SearchTimeline
// JSON the page itself requests. Stops at maxPosts raw tweets, after three
// scrolls that add nothing, or at the time limit.
export async function collectTweets(
  page: Page,
  url: string,
  opts: { maxPosts: number; timeoutMs: number },
): Promise<{ tweets: Tweet[]; responses: number }> {
  const found = new Map<string, Tweet>();
  let responses = 0;
  let pending: Promise<void> = Promise.resolve();

  page.on('response', (res) => {
    if (!SEARCH_API.test(res.url())) return;
    responses += 1;
    pending = pending.then(async () => {
      try {
        const body = await res.json();
        for (const t of parseSearchResponse(body)) if (!found.has(t.id)) found.set(t.id, t);
      } catch (err) {
        console.warn(`Could not parse a SearchTimeline response: ${(err as Error).message}`);
      }
    });
  });

  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);
  assertLoggedIn(page);

  const deadline = Date.now() + opts.timeoutMs;
  let idleScrolls = 0;
  while (found.size < opts.maxPosts && idleScrolls < 3 && Date.now() < deadline) {
    const before = found.size;
    await page.mouse.wheel(0, 2500);
    await page.waitForTimeout(1500 + Math.random() * 1500);
    await pending;
    idleScrolls = found.size > before ? 0 : idleScrolls + 1;
  }
  await pending;
  return { tweets: [...found.values()], responses };
}
```

- [ ] **Step 2: login-x.ts**

```ts
import { openBrowser } from './lib/x-search.js';

console.log('Opening Chrome — log into X in the window that appears (up to 5 minutes).');
const browser = await openBrowser();
const page = browser.pages()[0] ?? (await browser.newPage());
await page.goto('https://x.com/login', { waitUntil: 'domcontentloaded' });
try {
  await page.waitForURL((u) => /x\.com\/(home|explore)/.test(u.toString()), { timeout: 300_000 });
  console.log('✅ Logged in. Session saved to chrome-profile/ — scheduled runs will reuse it.');
} catch {
  console.error('❌ Did not reach the X home feed within 5 minutes. Run this again.');
  process.exitCode = 1;
} finally {
  await browser.close();
}
```

- [ ] **Step 3: weekly-bangers.ts**

```ts
import { config, validateConfig } from './lib/config.js';
import { buildQuery, searchUrl, selectTweets, sinceDate } from './lib/tweets.js';
import { diffNew, loadState, mergeSeen, saveState } from './lib/state.js';
import { buildReportMessages } from './lib/report.js';
import { postReport, sendAlert } from './lib/discord.js';
import { createWeeklyPage } from './lib/notion.js';
import { collectTweets, openBrowser } from './lib/x-search.js';

async function main(): Promise<void> {
  validateConfig();
  const runDate = new Date();
  const since = sinceDate(runDate, config.lookbackDays);
  const query = buildQuery(config.minFaves, since);
  const url = searchUrl(query);
  console.log(`[${runDate.toISOString()}] Searching: ${query}`);

  const browser = await openBrowser();
  let raw;
  try {
    const page = browser.pages()[0] ?? (await browser.newPage());
    raw = await collectTweets(page, url, { maxPosts: config.maxPosts, timeoutMs: 180_000 });
  } finally {
    await browser.close();
  }
  console.log(`Captured ${raw.tweets.length} tweets from ${raw.responses} search responses.`);
  if (raw.responses > 0 && raw.tweets.length === 0) {
    throw new Error('Search responses arrived but no tweets were parsed — X may have changed its response shape.');
  }
  if (raw.responses === 0) {
    throw new Error('No SearchTimeline responses were captured — the search page did not load results.');
  }

  const fetched = selectTweets(raw.tweets, { minFaves: config.minFaves, maxPosts: config.maxPosts });
  const state = loadState();
  const fresh = diffNew(state, fetched);
  const report = fresh.slice(0, config.reportCount);
  console.log(`${fetched.length} qualify, ${fresh.length} unseen, reporting ${report.length}.`);

  if (config.dryRun) {
    for (const m of buildReportMessages({ runDate, report, checked: fetched.length, notionUrl: '(dry run)' })) console.log(`\n${m}`);
    console.log('\nDRY_RUN: nothing posted, nothing saved.');
    return;
  }

  let notionUrl: string | null = null;
  let notionError: string | undefined;
  if (report.length > 0) {
    try {
      notionUrl = await createWeeklyPage(runDate, report, query);
      console.log(`Notion page: ${notionUrl}`);
    } catch (err) {
      notionError = (err as Error).message;
      console.error(`Notion save failed: ${notionError}`);
    }
  }

  await postReport(buildReportMessages({ runDate, report, checked: fetched.length, notionUrl, notionError }));
  saveState(mergeSeen(state, fetched, since.length ? runDate.toISOString().slice(0, 10) : ''));
  console.log('Posted to Discord and saved state.');
  if (notionError) throw new Error(`Notion save failed: ${notionError}`);
}

main().catch(async (err: Error) => {
  console.error(`❌ ${err.stack ?? err.message}`);
  if (!config.dryRun) {
    try { await sendAlert(err.message); } catch (e) { console.error(`Alert failed too: ${(e as Error).message}`); }
  }
  process.exit(1);
});
```

- [ ] **Step 4: Build.** `PATH=/opt/homebrew/bin:$PATH npm run build` → clean.

- [ ] **Step 5: Log in.** Create `.env` from the example with the two tokens copied from `linkedin-tracker/.env`. Run `PATH=/opt/homebrew/bin:$PATH npm run login:x`; the user logs into X in the window. **[HUMAN]**

- [ ] **Step 6: Dry run.** `DRY_RUN=true PATH=/opt/homebrew/bin:$PATH node build/weekly-bangers.js`. Expected: a printed report of up to 20 tweets. If parsing fails, save one real SearchTimeline body (trimmed) as the fixture and fix `parseSearchResponse` against it.

- [ ] **Step 7: Commit** `git commit -m "feat(twitter-bangers): X search via Playwright, login script and weekly entry point"`

---

### Task 7: launchd schedule, README, live seed run, PR

**Files:**
- Create: `twitter-bangers/scripts/com.sakky.twitter-bangers.plist.template`, `twitter-bangers/scripts/setup-mac.sh`, `twitter-bangers/scripts/uninstall-mac.sh`, `twitter-bangers/README.md`

- [ ] **Step 1: plist template**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.sakky.twitter-bangers</string>
    <key>ProgramArguments</key>
    <array>
        <string>__NODE_PATH__</string>
        <string>__PKG_DIR__/build/weekly-bangers.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>__PKG_DIR__</string>
    <!-- Saturday 05:00 local time -->
    <key>StartCalendarInterval</key>
    <array>
        <dict><key>Weekday</key><integer>6</integer><key>Hour</key><integer>5</integer><key>Minute</key><integer>0</integer></dict>
    </array>
    <key>StandardOutPath</key>
    <string>__PKG_DIR__/logs/bangers.out.log</string>
    <key>StandardErrorPath</key>
    <string>__PKG_DIR__/logs/bangers.err.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    </dict>
</dict>
</plist>
```

- [ ] **Step 2: setup-mac.sh**

```bash
#!/usr/bin/env bash
# Installs the weekly Twitter bangers launchd job (Saturday 05:00 local).
# Run once after: npm install, npm run build, npm run login:x.
set -euo pipefail
PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_PATH="${NODE_PATH_OVERRIDE:-/opt/homebrew/bin/node}"
[ -x "$NODE_PATH" ] || NODE_PATH="$(command -v node)"
[ -n "$NODE_PATH" ] || { echo "node not found" >&2; exit 1; }
[ -f "$PKG_DIR/build/weekly-bangers.js" ] || { echo "build/weekly-bangers.js missing — run npm install && npm run build" >&2; exit 1; }
[ -f "$PKG_DIR/.env" ] || echo "Warning: $PKG_DIR/.env not found." >&2
mkdir -p "$PKG_DIR/logs" "$HOME/Library/LaunchAgents"
LABEL=com.sakky.twitter-bangers
DEST="$HOME/Library/LaunchAgents/$LABEL.plist"
sed -e "s|__NODE_PATH__|$NODE_PATH|g" -e "s|__PKG_DIR__|$PKG_DIR|g" "$PKG_DIR/scripts/$LABEL.plist.template" > "$DEST"
launchctl unload "$DEST" >/dev/null 2>&1 || true
launchctl load "$DEST"
echo "Loaded $LABEL (Saturday 05:00 local). node: $NODE_PATH"
echo "Run now:   node build/weekly-bangers.js"
echo "Dry run:   DRY_RUN=true node build/weekly-bangers.js"
echo "Logs:      tail -f logs/bangers.out.log"
```

- [ ] **Step 3: uninstall-mac.sh**

```bash
#!/usr/bin/env bash
set -euo pipefail
DEST="$HOME/Library/LaunchAgents/com.sakky.twitter-bangers.plist"
launchctl unload "$DEST" >/dev/null 2>&1 || true
rm -f "$DEST"
echo "Removed com.sakky.twitter-bangers"
```

- [ ] **Step 4: README.md** — what it does, the query, setup steps (install, build, .env, login:x, setup-mac.sh), how to switch the Notion data source, how to run/dry-run, logs, and how the seen-set works.

- [ ] **Step 5: Install the schedule.** `chmod +x scripts/*.sh && scripts/setup-mac.sh`; verify `launchctl list | grep twitter-bangers`.

- [ ] **Step 6: Live seed run.** `PATH=/opt/homebrew/bin:$PATH node build/weekly-bangers.js`. Verify: message in `#twitter-weekly-bangers` (fetch the last message via the Discord API), Notion page exists and the user confirms it appears in the "content ideas" view (else switch `NOTION_CONTENT_IDEAS_DATA_SOURCE_ID` to `3a301c06-49d0-8026-aca1-000bbd95c126`, delete the stray page, rerun with state cleared), `state.json` has up to 100 ids.

- [ ] **Step 7: Commit, push, PR.**

```bash
git add twitter-bangers/scripts twitter-bangers/README.md docs/superpowers/plans
git commit -m "feat(twitter-bangers): launchd schedule, setup scripts and README"
git push -u origin feat/twitter-bangers
gh pr create --repo sakkyb/discordmcp --base main --title "feat: weekly Twitter bangers job (X search -> Discord + Notion)" --body "..."
```
