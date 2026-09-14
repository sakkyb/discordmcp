# Court watch

A job on the Mac that checks three LTA ClubSpark venues every 10 minutes and
pushes an [ntfy.sh](https://ntfy.sh) notification whenever a tennis court
becomes free **on a weekend (any time) or a weekday evening (17:00 onwards)**
within the 7-day booking window.

| Venue | ClubSpark segment | Courts |
|---|---|---|
| Burgess Park | `BurgessParkSouthwark` | Crt 1–7 (7 unlit), 30-min slots |
| Kennington Park | `kenningtonpark` | Court 1–5 (cricket nets ignored), 60-min slots |
| Geraldine Mary Harmsworth | `GeraldineMaryHarmsworth` | Court 1–2, 30-min slots |

## How it works

- **Fetch**: one unauthenticated GET per venue to the JSON endpoint the
  BookByDate page uses (`/v0/VenueBooking/<segment>/GetVenueSessions`),
  covering today to today + 7. No browser, no login.
- **Free** means a session with category `1000` ("Booking") on a resource of
  category `1` (tennis court). Booked (`0`), coaching (`2000`), club (`4000`),
  maintenance (`7000`) and closed (`8000`) sessions are ignored.
- **Window**: Saturday and Sunday all day; Monday to Friday from
  `EVENING_START`. Slots that have already started are dropped.
- **New vs seen**: `state.json` holds the last snapshot of free slots in the
  window. A slot is announced when it is free now and was not free at the
  previous check. Booked-then-cancelled slots are announced again, since that
  is news. The first run announces everything currently free.
- **Minimum length**: touching free sessions on a court are merged, and only
  blocks of at least `MIN_SLOT_MINUTES` (60) that contain something new are
  reported. A lone 30-minute gap is ignored; a 30-minute gap opening next to
  an already free 30 minutes reports the full hour.
- **Notification**: one per venue per run, only when something is new. Tapping it opens
  the booking page on the first date; up to three buttons open the first
  three dates.

  ```
  Kennington Park: 3 new slots
  Sat 19 Sep — Court 2 17:00–19:00 £16 · Court 5 18:00–19:00 £8
  Sun 20 Sep — Court 1 09:00–10:00 £8
  ```
- **Schedule**: launchd every 10 minutes; the script exits immediately
  outside `ACTIVE_HOURS` (07:00–23:00 London). The Mac must be awake.
- **Failures**: a venue that fails to fetch is skipped and keeps its previous
  snapshot; a high-priority "court-watch failed" push goes to the same topic
  at most once per hour.

State is written only after every notification is published, so a failed
publish is retried on the next run.

## Setup

Use the arm64 Homebrew node (`/opt/homebrew/bin/node`).

```bash
cd court-watch
export PATH=/opt/homebrew/bin:$PATH
npm install
npm run build
cp .env.example .env          # set NTFY_TOPIC to an unguessable name
DRY_RUN=true node build/check-courts.js   # prints what would be sent
node build/check-courts.js                # live: seeds state, pushes everything free now
scripts/setup-mac.sh          # installs the launchd job
```

### Phone

Install the ntfy app (iOS App Store / Google Play / F-Droid), tap **+**, and
subscribe to the topic in `NTFY_TOPIC` on `ntfy.sh`. Anyone who knows the
topic name can read it, so keep it random. The web app at
`https://ntfy.sh/<topic>` works too.

## Settings

All optional, with defaults in `src/lib/config.ts`: `NTFY_SERVER`
(`https://ntfy.sh`), `EVENING_START` (`17:00`), `ACTIVE_HOURS`
(`07:00-23:00`), `HORIZON_DAYS` (`7`), `MIN_SLOT_MINUTES` (`60`), `VENUES`
(all three, comma-separated segments), `DRY_RUN`.

## Tests

```bash
npm test    # builds, then runs node --test on the pure modules
```

Covers parsing the three captured ClubSpark responses in
`src/lib/fixtures/` (dates 19–20 Sep 2026), the weekend/evening window,
the new-vs-seen diff, adjacent-slot merging, state round trips, notification
formatting, and the ntfy request (against a fake fetch).

## Operations

```bash
tail -f logs/court-watch.out.log
launchctl list | grep court-watch
launchctl start com.sakky.court-watch     # run now
scripts/uninstall-mac.sh
```

To re-announce everything currently free, delete `state.json`.
