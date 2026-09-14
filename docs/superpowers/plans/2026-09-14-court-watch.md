# Court watch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A launchd job that polls three ClubSpark venues every 10 minutes and pushes an ntfy.sh notification whenever a tennis slot in the user's window (weekends, weekday evenings) becomes free.

**Architecture:** One TypeScript package `court-watch/` with pure modules (parse, filter, diff, format) tested against captured JSON fixtures, plus thin I/O modules (fetch, ntfy, state file) and a `check-courts.ts` entry point. State is the last snapshot of free matching slots; "new" is set difference against it.

**Tech Stack:** Node 26 (`/opt/homebrew/bin/node`), TypeScript 5 ES modules, `node --test`, `dotenv`, global `fetch`, launchd.

**Spec:** `docs/superpowers/specs/2026-09-14-court-watch-design.md`

## Global Constraints

- Package path `court-watch/` at the repo root, sibling of `linkedin-tracker/`; same `tsconfig.json` as `twitter-bangers` (ES2022, NodeNext, strict, outDir `build`).
- Run everything with `PATH=/opt/homebrew/bin:$PATH` (arm64 node).
- Session category `1000` is the only "free" category; resource category `1` is the only tennis court category.
- Venue segments exactly: `BurgessParkSouthwark`, `kenningtonpark`, `GeraldineMaryHarmsworth`.
- Time zone `Europe/London` for every date/time decision.
- ntfy body clipped at 3,500 characters.
- Alerts at most once per hour.
- Commit messages end with the Co-Authored-By and Claude-Session lines from the session reminder.

---

### Task 1: Package scaffold, config, time helpers

**Files:**
- Create: `court-watch/package.json`, `court-watch/tsconfig.json`, `court-watch/.env.example`, `court-watch/src/lib/config.ts`, `court-watch/src/lib/time.ts`
- Test: `court-watch/src/lib/time.test.ts`
- Modify: `.gitignore` (add `court-watch/state.json`, `court-watch/logs/`)

**Interfaces:**
- Produces: `config` getters (`ntfyTopic`, `ntfyServer`, `eveningStart: number`, `activeHours: [number, number]`, `horizonDays`, `venues: Venue[]`, `dryRun`), `Venue { segment; name }`, `ALL_VENUES`, `STATE_FILE`, `TIME_ZONE`, `validateConfig()`; `time.ts`: `localNow(d, tz): { date: string; minutes: number }`, `addDays(date, n): string`, `inActiveHours(minutes, [start, end]): boolean`, `parseHm('17:00'): number`.

- [ ] **Step 1: package.json, tsconfig, .env.example, .gitignore**

`court-watch/package.json`:
```json
{
  "name": "court-watch",
  "version": "1.0.0",
  "description": "Every 10 min: free tennis slots (weekends + weekday evenings) at three ClubSpark venues -> ntfy.sh",
  "type": "module",
  "private": true,
  "scripts": {
    "build": "tsc && mkdir -p build/lib && cp -R src/lib/fixtures build/lib/",
    "test": "npm run build && node --test \"build/**/*.test.js\"",
    "run": "node build/check-courts.js"
  },
  "dependencies": { "dotenv": "^16.4.7" },
  "devDependencies": { "@types/node": "^20.19.33", "typescript": "^5.9.3" }
}
```
`court-watch/tsconfig.json`: copy of `twitter-bangers/tsconfig.json`.

`.env.example`:
```
# ntfy.sh topic to publish to. Subscribe to it in the ntfy app. Anyone who
# knows the name can read it, so keep it unguessable.
NTFY_TOPIC=
# NTFY_SERVER=https://ntfy.sh

# Weekday slots count from this time; weekends count all day.
# EVENING_START=17:00
# Runs outside this window exit immediately (Europe/London).
# ACTIVE_HOURS=07:00-23:00
# HORIZON_DAYS=7
# VENUES=BurgessParkSouthwark,kenningtonpark,GeraldineMaryHarmsworth
# true = fetch and print what would be sent; no ntfy, no state write
# DRY_RUN=false
```

- [ ] **Step 2: Failing tests for time helpers** (`time.test.ts`)

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localNow, addDays, inActiveHours, parseHm } from './time.js';

test('localNow renders date and minutes in the given zone', () => {
  // 2026-09-14T22:30Z is 23:30 BST
  const r = localNow(new Date('2026-09-14T22:30:00Z'), 'Europe/London');
  assert.deepEqual(r, { date: '2026-09-14', minutes: 23 * 60 + 30 });
  // 2026-09-14T23:30Z is 00:30 on the 15th BST
  assert.deepEqual(localNow(new Date('2026-09-14T23:30:00Z'), 'Europe/London'), { date: '2026-09-15', minutes: 30 });
});
test('addDays crosses month ends', () => {
  assert.equal(addDays('2026-09-28', 7), '2026-10-05');
});
test('parseHm and inActiveHours', () => {
  assert.equal(parseHm('17:00'), 1020);
  assert.throws(() => parseHm('25:00'));
  assert.ok(inActiveHours(7 * 60, [420, 1380]));
  assert.ok(!inActiveHours(1380, [420, 1380]));
  assert.ok(!inActiveHours(100, [420, 1380]));
});
```

- [ ] **Step 3: Implement `time.ts`**

```ts
export function localNow(d: Date, tz: string): { date: string; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  return { date: `${get('year')}-${get('month')}-${get('day')}`, minutes: Number(get('hour')) * 60 + Number(get('minute')) };
}
export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
export function parseHm(s: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) throw new Error(`Expected HH:MM, got "${s}"`);
  const h = Number(m[1]), min = Number(m[2]);
  if (h > 23 || min > 59) throw new Error(`Expected HH:MM, got "${s}"`);
  return h * 60 + min;
}
export function inActiveHours(minutes: number, [start, end]: [number, number]): boolean {
  return minutes >= start && minutes < end;
}
```

- [ ] **Step 4: Implement `config.ts`** (pattern of `twitter-bangers/src/lib/config.ts`: `PACKAGE_ROOT`, dotenv, `required`, `num`; getters listed in Interfaces; `activeHours` parses `A-B` with `parseHm`; `venues` filters `ALL_VENUES` by case-insensitive segment and exits on an empty result; `validateConfig()` touches every getter and requires `NTFY_TOPIC` unless `dryRun`).

- [ ] **Step 5: `npm install`, `npm test` → time tests pass. Commit** `feat(court-watch): package scaffold, config and time helpers`.

### Task 2: ClubSpark client and slot parsing

**Files:**
- Create: `court-watch/src/lib/clubspark.ts`, `court-watch/src/lib/slots.ts`
- Test: `court-watch/src/lib/slots.test.ts`, `court-watch/src/lib/clubspark.test.ts`

**Interfaces:**
- Produces: `clubspark.ts`: `VenueSessionsResponse`, `sessionsUrl(segment, startDate, endDate, nowMs?)`, `bookingPageUrl(segment, date)`, `fetchVenueSessions(segment, startDate, endDate, fetchFn = fetch)`. `slots.ts`: `Slot`, `slotKey(slot)`, `parseSlots(venue, data)`, `inWindow(slot, { eveningStart, now: { date, minutes } })`, `diffNew(current, previousKeys: Record<string, unknown>)`, `Range`, `mergeAdjacent(slots): Range[]`.

- [ ] **Step 1: Failing tests** (`slots.test.ts`, loading the three fixtures with `fs.readFileSync(new URL('./fixtures/…', import.meta.url))`)

```ts
test('parseSlots: Kennington yields only tennis courts and category-1000 sessions', () => {
  const slots = parseSlots('kenningtonpark', kennington);
  assert.deepEqual([...new Set(slots.map((s) => s.court))], ['Court 1', 'Court 2', 'Court 3', 'Court 4', 'Court 5']);
  assert.equal(slots.length, 51); // 38 one-hour + 13 two-hour "Booking" sessions in the fixture
  const first = slots.find((s) => s.court === 'Court 1' && s.date === '2026-09-19')!;
  assert.equal(first.start, 480); assert.equal(first.end, 540); assert.equal(first.cost, 8); assert.equal(first.lit, true);
});
test('parseSlots: Burgess court 7 is unlit; GMH has 30-minute slots', () => {
  assert.equal(parseSlots('BurgessParkSouthwark', burgess).find((s) => s.court.startsWith('Crt 7'))!.lit, false);
  assert.ok(parseSlots('GeraldineMaryHarmsworth', gmh).some((s) => s.end - s.start === 30));
});
test('inWindow: weekends all day, weekdays from eveningStart, past slots dropped', () => {
  const base = { venue: 'v', resourceId: 'r', court: 'C', lit: true, cost: 0, end: 0 };
  const now = { date: '2026-09-14', minutes: 12 * 60 }; // Monday noon
  const ev = 17 * 60;
  assert.ok(inWindow({ ...base, date: '2026-09-19', start: 8 * 60, end: 9 * 60 }, { eveningStart: ev, now })); // Sat morning
  assert.ok(!inWindow({ ...base, date: '2026-09-15', start: 16 * 60, end: 17 * 60 }, { eveningStart: ev, now })); // Tue 16:00
  assert.ok(inWindow({ ...base, date: '2026-09-15', start: 17 * 60, end: 18 * 60 }, { eveningStart: ev, now }));
  assert.ok(!inWindow({ ...base, date: '2026-09-14', start: 11 * 60, end: 12 * 60 }, { eveningStart: ev, now })); // already started
  assert.ok(!inWindow({ ...base, date: '2026-09-13', start: 18 * 60, end: 19 * 60 }, { eveningStart: ev, now })); // yesterday
});
test('diffNew returns slots whose key is absent from previous', () => { … });
test('mergeAdjacent joins touching sessions on one court and sums cost', () => {
  // 18:00-18:30 £5.2 + 18:30-19:00 £5.2 + 19:30-20:00 → two ranges
});
```

- [ ] **Step 2: Implement `slots.ts` and `clubspark.ts`** as specified. `mergeAdjacent` groups by `date|resourceId`, sorts by `start`, merges when `prev.end === cur.start`, then sorts ranges by date, then court name with `localeCompare(…, undefined, { numeric: true })`, then start. `fetchVenueSessions` throws on `!res.ok` and when `Resources` is not an array.

- [ ] **Step 3: `clubspark.test.ts`**: `sessionsUrl` shape, `bookingPageUrl` shape, `fetchVenueSessions` with a fake fetch returning `{ ok: false, status: 503 }` rejects, and one returning `{}` rejects with "no Resources".

- [ ] **Step 4: `npm test` green. Commit** `feat(court-watch): ClubSpark client and slot parsing`.

### Task 3: State, report, ntfy

**Files:**
- Create: `court-watch/src/lib/state.ts`, `court-watch/src/lib/report.ts`, `court-watch/src/lib/ntfy.ts`
- Test: `state.test.ts`, `report.test.ts`, `ntfy.test.ts`

**Interfaces:**
- Produces: `state.ts`: `WatchState { lastRun; lastAlertAt; free: Record<string, { court; cost }> }`, `loadState(file?)`, `saveState(state, file?)`, `replaceVenueSnapshot(state, venue, slots)`, `shouldAlert(state, nowIso, minGapMs = 3_600_000)`. `report.ts`: `Notification { title; body; click; actions: { label; url }[]; tags: string[]; priority?: number }`, `buildNotification(venue: Venue, newSlots: Slot[])`, `formatTime`, `formatDate`, `formatCost`, `clip`. `ntfy.ts`: `publish(n, { server, topic }, fetchFn = fetch)`, `alert(text, { server, topic }, fetchFn = fetch)` (title `court-watch failed`, priority 4, tags `['warning']`).

- [ ] **Step 1: tests.** state: missing/corrupt file → `{ lastRun: null, lastAlertAt: null, free: {} }`; round trip; `replaceVenueSnapshot` drops only that venue's keys and does not mutate input; `shouldAlert` true when null or older than an hour, false otherwise. report: title pluralisation (`1 new slot` / `3 new slots`, counting merged ranges), body line `Sat 19 Sep — Court 2 17:00–19:00 £16 · Court 5 18:00–19:00 £8`, dates ascending, `click` is the first date's booking page, actions capped at 3, `clip` adds `…` at 3,500. ntfy: fake fetch captures one POST to `${server}/` whose JSON body has `topic`, `title`, `message`, `click`, `tags`, `actions: [{ action: 'view', label, url }]`; non-ok response rejects.

- [ ] **Step 2: implement.** `formatCost`: `£8` for integers, `£15.60` otherwise. `formatDate`: `Sat 19 Sep` via `Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })` on `Date.UTC`. ntfy publishes JSON to the server root (avoids non-ASCII header encoding).

- [ ] **Step 3: `npm test` green. Commit** `feat(court-watch): state snapshot, notification format, ntfy publisher`.

### Task 4: Entry point, launchd, README

**Files:**
- Create: `court-watch/src/check-courts.ts`, `court-watch/scripts/com.sakky.court-watch.plist.template`, `court-watch/scripts/setup-mac.sh`, `court-watch/scripts/uninstall-mac.sh`, `court-watch/README.md`

- [ ] **Step 1: `check-courts.ts`** implementing the spec's data flow: active-hours gate → per-venue try/catch fetch+parse+filter+diff → dry-run print and return → publish → save state (`lastRun`; failed venues keep their snapshot) → alert at most hourly on failures and exit code 1.
- [ ] **Step 2: plist template** with `StartInterval` 600, `RunAtLoad` true, logs to `logs/court-watch.{out,err}.log`, PATH env as in the twitter-bangers template. `setup-mac.sh` / `uninstall-mac.sh` mirror the twitter-bangers scripts with the new label and entry file.
- [ ] **Step 3: README** in the style of `twitter-bangers/README.md` (how it works, setup, settings, tests, operations, ntfy subscription steps).
- [ ] **Step 4: `DRY_RUN=true node build/check-courts.js`** against the live API prints three venues with counts. Commit `feat(court-watch): entry point, launchd job, README`.

### Task 5: Live seed and install

- [ ] `.env` with a random `NTFY_TOPIC` (e.g. `sakky-courts-<8 hex>`), live run, confirm the ntfy topic received one message per venue (check `GET https://ntfy.sh/<topic>/json?poll=1`), `scripts/setup-mac.sh`, `launchctl list | grep court-watch`.
- [ ] Push branch, open PR to `sakkyb/discordmcp`.
