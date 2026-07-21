import fs from 'fs';
import { STATE_FILE } from './config.js';

export interface TrackerState {
  // URNs of posts we've already seen/notified about
  knownUrns: string[];
}

export function loadState(): TrackerState {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    return { knownUrns: Array.isArray(raw.knownUrns) ? raw.knownUrns : [] };
  } catch {
    return { knownUrns: [] };
  }
}

export function saveState(state: TrackerState): void {
  // Keep the file bounded; we only ever compare against recent posts.
  const trimmed = { knownUrns: state.knownUrns.slice(-200) };
  fs.writeFileSync(STATE_FILE, JSON.stringify(trimmed, null, 2));
}
