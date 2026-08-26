import fs from 'fs';
import { STATE_FILE } from './config.js';

// A post whose Discord announcement succeeded but whose WhatsApp send did not.
// Tracked separately from knownUrns so the tracker's :30/:00 retry slots can
// retry the WhatsApp send WITHOUT re-announcing in Discord — previously the URN
// was marked known regardless, so those slots no-opped and nothing ever retried.
export interface PendingWhatsApp {
  urn: string;
  url: string;
  attempts: number;
}

// Three attempts spans roughly an hour across the tracker's slots, which is the
// useful lifetime of a "Today's post is now live" message.
export const MAX_WHATSAPP_ATTEMPTS = 3;

export interface TrackerState {
  // URNs of posts we've already seen/notified about
  knownUrns: string[];
  pendingWhatsApp: PendingWhatsApp[];
  // Names of the preflight checks that failed on the last self-check run. Kept
  // so the job can announce CHANGES only — see selfCheckAnnouncement().
  failingChecks: string[];
}

export function loadState(): TrackerState {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    return {
      knownUrns: Array.isArray(raw.knownUrns) ? raw.knownUrns : [],
      // Absent on state files written before this field existed.
      pendingWhatsApp: Array.isArray(raw.pendingWhatsApp) ? raw.pendingWhatsApp : [],
      failingChecks: Array.isArray(raw.failingChecks) ? raw.failingChecks : [],
    };
  } catch {
    return { knownUrns: [], pendingWhatsApp: [], failingChecks: [] };
  }
}

export function saveState(state: TrackerState): void {
  // Keep the file bounded; we only ever compare against recent posts.
  const trimmed = {
    knownUrns: state.knownUrns.slice(-200),
    pendingWhatsApp: state.pendingWhatsApp.slice(-20),
    failingChecks: state.failingChecks,
  };
  fs.writeFileSync(STATE_FILE, JSON.stringify(trimmed, null, 2));
}

export function recordWhatsAppFailure(list: PendingWhatsApp[], urn: string, url: string): PendingWhatsApp[] {
  const existing = list.find((p) => p.urn === urn);
  if (existing) return list.map((p) => (p.urn === urn ? { ...p, attempts: p.attempts + 1 } : p));
  return [...list, { urn, url, attempts: 1 }];
}

export function clearWhatsAppPending(list: PendingWhatsApp[], urn: string): PendingWhatsApp[] {
  return list.filter((p) => p.urn !== urn);
}

// Entries still worth retrying: under the attempt cap and still recent enough
// to be worth announcing at all.
export function duePending(list: PendingWhatsApp[], isFresh: (urn: string) => boolean): PendingWhatsApp[] {
  return list.filter((p) => p.attempts < MAX_WHATSAPP_ATTEMPTS && isFresh(p.urn));
}

// Whether the latest self-check is worth a Discord message, and which kind.
//
// The preflight runs before every post slot. Announcing every run would bury
// #errors-sakky in "all fine" and train everyone to scroll past it, so only a
// change in the set of failures earns a message:
//   broke     — something is failing that was not failing before
//   recovered — everything that was failing has cleared
//   null      — no change; stay quiet
export function selfCheckAnnouncement(
  previous: string[],
  current: string[],
): 'broke' | 'recovered' | null {
  const before = new Set(previous);
  // A NEW name matters even when an old one is still failing, otherwise a
  // second, unrelated break hides behind the first.
  if (current.some((c) => !before.has(c))) return 'broke';
  if (previous.length && current.length === 0) return 'recovered';
  return null;
}
