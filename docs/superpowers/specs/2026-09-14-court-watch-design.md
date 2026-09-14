# Court watch — design

Date: 2026-09-14
Status: approved (ntfy.sh chosen over Discord in the brainstorm)

## Goal

Every 10 minutes during waking hours, check three LTA ClubSpark venues for
tennis court slots that are free on weekends (any time) or weekday evenings
(17:00 onwards), within the 7-day booking window. Push a notification via
ntfy.sh only when a slot has become free since the previous check, so the
user hears about new availability without being spammed.

Venues (ClubSpark URL segments):

| Name | Segment | Courts |
|---|---|---|
| Burgess Park | `BurgessParkSouthwark` | Crt 1–7 (7 unlit), 30-min slots |
| Kennington Park | `kenningtonpark` | Court 1–5 (also cricket nets and netball, ignored), 60-min slots |
| Geraldine Mary Harmsworth | `GeraldineMaryHarmsworth` | Court 1–2, 30-min slots |

## Research findings

- `GET https://clubspark.lta.org.uk/v0/VenueBooking/<segment>/GetVenueSessions?resourceID=&startDate=YYYY-MM-DD&endDate=YYYY-MM-DD&roleId=&_=<ms>`
  returns JSON without authentication for all three venues. It is the call
  the BookByDate page makes. (The guessable `burgesspark` segment is a
  different, empty venue that redirects to sign-in; `BurgessParkSouthwark`
  is the real one, found via the LTA court finder.)
- Response: `Resources[]` (one per court, with `Category` (1 = tennis court,
  9 = cricket net), `Name`, `Lighting`) each holding `Days[]` (`Date`,
  `Sessions[]`). A session has `Category`, `Name`, `StartTime`/`EndTime`
  (minutes from midnight), `Interval`, `CourtCost`.
- Session categories observed: `1000` "Booking" = bookable and free;
  `0` = an existing booking (name is a GUID, "Default" or a scheme name);
  `2000` coaching; `3000` competitions/leagues; `4000` club/social sessions;
  `7000` maintenance; `8000` closed. Only `1000` counts as available.
- Booking horizon is 7 days at all three (day 8 returns no `1000` sessions).
  The LTA page for Burgess Park says the new day is released at 20:00 daily.
- ClubSpark is behind Cloudflare. Node's global `fetch` (undici) gets the
  "Just a moment" challenge (403) on every request; node's `https` module
  and curl with a plain identifying User-Agent get 200. So the job uses a
  small `https`-based `request()` helper (`lib/http.ts`) for both ClubSpark
  and ntfy, with an honest `court-watch/1.0` User-Agent.

## Constraints and decisions

- No browser, no login, no Anthropic key: plain `fetch` of three JSON
  endpoints. One request per venue covering the whole window
  (`startDate=today`, `endDate=today+7`).
- Notifications go to ntfy.sh (user's choice). Topic is a secret-ish random
  name in `.env` (`NTFY_TOPIC`); anyone who knows it can read it, which is
  acceptable for court availability. Server overridable (`NTFY_SERVER`).
- One notification per venue per run, only when that venue has newly free
  matching slots. Title `Kennington Park: 3 new slots`, body grouped by date,
  `Click` opens the BookByDate page for the first date listed, and up to
  three "view" action buttons open the pages for the first three dates.
- "New" means: free now and not free at the previous check. The state file
  stores the last snapshot of matching free slots, not a history, so a slot
  that is booked and later cancelled is announced again (it is news again).
- First ever run announces everything currently free (the seed), which is
  the wanted behaviour.
- Matching window: Saturday and Sunday all day; Monday to Friday from
  `EVENING_START` (default `17:00`). Slots whose start time has already
  passed are ignored. All tennis courts are included, lit or not; resources
  whose `Category` is not 1 (cricket nets, netball) are ignored.
- Adjacent free slots on the same court are merged for display only
  (`Crt 3 18:00–19:30 £15.60`); the diff runs on raw sessions so a merge
  boundary moving does not re-announce old slots.
- Schedule: launchd `StartInterval` 600 s. The script exits at once outside
  `ACTIVE_HOURS` (default `07:00-23:00` Europe/London) so nothing runs at
  night. The Mac must be awake; that is already true for the other jobs.
- Errors (fetch failure, unexpected JSON) are pushed to the same ntfy topic
  with high priority and a warning tag, at most once per hour
  (`lastAlertAt` in state) so an outage does not fire 6 alerts an hour.
  A single venue failing does not stop the others from being checked.
- Code lives in `discordmcp/court-watch/`, a sibling package following
  `linkedin-tracker`/`twitter-bangers` conventions: TypeScript, ES modules,
  `node --test`, launchd plist template + `setup-mac.sh` / `uninstall-mac.sh`,
  `.env.example`, README. Shipped on `feat/court-watch` with a PR.

## Architecture

```
launchd (every 10 min)  ->  build/check-courts.js
                               |
                               +-- lib/config.ts     env, defaults, paths, venue list
                               +-- lib/clubspark.ts  fetch GetVenueSessions for a venue
                               +-- lib/slots.ts      pure: JSON -> Slot[], window filter,
                               |                     diff, merge adjacent for display
                               +-- lib/state.ts      last snapshot of free slots on disk
                               +-- lib/ntfy.ts       push notification / alert
                               +-- lib/report.ts     pure: title, body, click URL, actions
```

### Data flow (one run)

1. If now (Europe/London) is outside `ACTIVE_HOURS`, log and exit 0.
2. For each venue, fetch sessions for today..today+`HORIZON_DAYS`.
   A venue that throws is recorded as failed and skipped.
3. Parse into `Slot[]`: one per `Category === 1000` session on a resource
   whose `Category === 1` (tennis court).
4. Keep slots whose day is Sat/Sun, or whose start >= `EVENING_START` on a
   weekday; drop slots that started before now.
5. Load `state.json`. `newSlots = current − previous` by slot key
   `<venue>|<date>|<resourceId>|<start>|<end>`.
6. For each venue with new slots: merge adjacent new slots per court into
   ranges, build the notification, POST to ntfy.
7. Save state: `free` = the full current matching set (for every venue that
   fetched successfully; a failed venue keeps its previous snapshot),
   `lastRun`. Written after the notifications succeed.
8. If any venue failed: log, and if `lastAlertAt` is older than an hour,
   push an alert and record `lastAlertAt`. Exit non-zero.

### Slot shape

```ts
interface Slot {
  venue: string;        // segment, e.g. 'kenningtonpark'
  date: string;         // YYYY-MM-DD
  resourceId: string;
  court: string;        // 'Court 2'
  lit: boolean;
  start: number;        // minutes from midnight
  end: number;
  cost: number;         // CourtCost, GBP
}
```

### State file

`court-watch/state.json` (git-ignored):

```json
{
  "lastRun": "2026-09-14T13:00:00.000Z",
  "lastAlertAt": null,
  "free": { "kenningtonpark|2026-09-19|48d1…|1020|1080": { "court": "Court 1", "cost": 8 } }
}
```

### Notification

```
Title:  Kennington Park: 3 new slots
Tags:   tennis
Click:  https://clubspark.lta.org.uk/kenningtonpark/Booking/BookByDate#?date=2026-09-19&role=guest
Actions: view, Sat 19 Sep, <url>; view, Sun 20 Sep, <url>   (max 3)

Sat 19 Sep — Court 2 17:00–19:00 £16 · Court 5 18:00–19:00 £8
Sun 20 Sep — Court 1 09:00–10:00 £8
```

Body is clipped at 3,500 chars with a trailing `…` (ntfy's message limit is
4,096 bytes).

### Configuration (`.env`)

| Var | Default | Notes |
|---|---|---|
| `NTFY_TOPIC` | required | subscribe to it in the ntfy app |
| `NTFY_SERVER` | `https://ntfy.sh` | |
| `EVENING_START` | `17:00` | weekday slots from this time |
| `ACTIVE_HOURS` | `07:00-23:00` | runs outside this window exit at once |
| `HORIZON_DAYS` | `7` | |
| `VENUES` | all three | comma-separated segments to limit |
| `DRY_RUN` | unset | `true` = fetch, print what would be sent, no ntfy, no state write |

### Schedule

`scripts/com.sakky.court-watch.plist.template`: `StartInterval` 600,
`RunAtLoad` true. `scripts/setup-mac.sh` renders it with the node path and
package dir and loads it. Logs to `logs/court-watch.{out,err}.log`.

### Error handling

- Fetch non-2xx or JSON without `Resources`: that venue fails; others
  proceed. Alert once per hour.
- ntfy POST failure: throw; state is not written, so the next run announces
  the same slots again.
- Unknown session categories are ignored (never treated as free).

### Testing

Unit tests with `node --test` on the pure modules, using the three real
responses captured on 2026-09-14 (`src/lib/fixtures/*.json`, dates
19–20 Sep 2026):

- `slots.test.ts`: parsing each fixture yields the expected court names and
  only category-1000 sessions; Kennington excludes cricket nets; window
  filter (weekend all day, weekday from 17:00, past slots dropped); diff
  new-vs-previous; adjacent merge.
- `state.test.ts`: missing/corrupt file gives empty state; save/load round
  trip; failed venue keeps its previous snapshot.
- `report.test.ts`: title, body grouping and ordering, click URL, action
  buttons capped at three, clipping.
- `ntfy.test.ts`: request headers/body built from a report (against a fake
  fetch).

Integration: `DRY_RUN=true` against the live API, then a live seed run that
should produce one notification per venue on the user's phone.
