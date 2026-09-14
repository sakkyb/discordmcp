import fs from 'fs';
import { STATE_FILE } from './config.js';
import type { Tweet } from './tweets.js';

export interface SeenEntry {
  likes: number;
  url: string;
  firstSeen: string; // YYYY-MM-DD of the run that first fetched it
}

export interface BangersState {
  lastRun: string | null;
  // Every tweet id any run has fetched. "New" means absent from here.
  seen: Record<string, SeenEntry>;
}

export function loadState(file: string = STATE_FILE): BangersState {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return {
      lastRun: typeof raw.lastRun === 'string' ? raw.lastRun : null,
      seen: raw.seen && typeof raw.seen === 'object' && !Array.isArray(raw.seen) ? raw.seen : {},
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

// Returns a new state; the caller decides when to persist it (after Discord
// succeeds, so a failed run retries cleanly without losing tweets).
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
