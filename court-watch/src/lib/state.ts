import fs from 'fs';
import { STATE_FILE } from './config.js';
import { slotKey, type Slot } from './slots.js';

export interface FreeEntry {
  court: string;
  cost: number;
}

// The last snapshot of free slots in the user's window, keyed by slotKey.
// "New" on the next run means absent from here, so a slot that gets booked
// and later cancelled is announced again.
export interface WatchState {
  lastRun: string | null;
  lastAlertAt: string | null;
  free: Record<string, FreeEntry>;
}

export const EMPTY_STATE: WatchState = { lastRun: null, lastAlertAt: null, free: {} };

export function loadState(file: string = STATE_FILE): WatchState {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return {
      lastRun: typeof raw.lastRun === 'string' ? raw.lastRun : null,
      lastAlertAt: typeof raw.lastAlertAt === 'string' ? raw.lastAlertAt : null,
      free: raw.free && typeof raw.free === 'object' && !Array.isArray(raw.free) ? raw.free : {},
    };
  } catch {
    return { ...EMPTY_STATE, free: {} };
  }
}

export function saveState(state: WatchState, file: string = STATE_FILE): void {
  fs.writeFileSync(file, JSON.stringify(state, null, 2));
}

// Returns a new state whose snapshot for `venue` is exactly `slots`; other
// venues are untouched, so a venue that failed to fetch keeps its last one.
export function replaceVenueSnapshot(state: WatchState, venue: string, slots: Slot[]): WatchState {
  const prefix = `${venue}|`;
  const free: Record<string, FreeEntry> = {};
  for (const [k, v] of Object.entries(state.free)) {
    if (!k.startsWith(prefix)) free[k] = v;
  }
  for (const s of slots) free[slotKey(s)] = { court: s.court, cost: s.cost };
  return { ...state, free };
}

// At most one alert per minGapMs, so an outage does not fire every 10 minutes.
export function shouldAlert(state: WatchState, nowIso: string, minGapMs = 3_600_000): boolean {
  if (!state.lastAlertAt) return true;
  return Date.parse(nowIso) - Date.parse(state.lastAlertAt) >= minGapMs;
}
