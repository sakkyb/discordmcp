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
  // Circuit breaker (see lib/breaker.ts): ISO time until which the poller skips
  // LinkedIn entirely, or null. Set to end of the local day when a slot lands
  // on a login/challenge page or the feed fails twice running.
  pausedUntil: string | null;
  // Soft scrape failures in a row (empty feed, timeouts). Reset on success.
  consecutiveScrapeFailures: number;
}

// Fields absent on state files written before they existed default rather
// than fail, so a deploy never needs a hand-edit of state.json.
export function normalizeState(raw: any): TrackerState {
  return {
    knownUrns: Array.isArray(raw?.knownUrns) ? raw.knownUrns : [],
    pendingWhatsApp: Array.isArray(raw?.pendingWhatsApp) ? raw.pendingWhatsApp : [],
    failingChecks: Array.isArray(raw?.failingChecks) ? raw.failingChecks : [],
    pausedUntil: typeof raw?.pausedUntil === 'string' ? raw.pausedUntil : null,
    consecutiveScrapeFailures: Number.isInteger(raw?.consecutiveScrapeFailures) ? raw.consecutiveScrapeFailures : 0,
  };
}

export function loadState(): TrackerState {
  try {
    return normalizeState(JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')));
  } catch {
    return normalizeState({});
  }
}

export function saveState(state: TrackerState): void {
  // Keep the file bounded; we only ever compare against recent posts.
  const trimmed = {
    knownUrns: state.knownUrns.slice(-200),
    pendingWhatsApp: state.pendingWhatsApp.slice(-20),
    failingChecks: state.failingChecks,
    pausedUntil: state.pausedUntil,
    consecutiveScrapeFailures: state.consecutiveScrapeFailures,
  };
  fs.writeFileSync(STATE_FILE, JSON.stringify(trimmed, null, 2));
}

// --- 15-minute polling gates ----------------------------------------------

function sameLocalDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

// How many known posts were created on `day` (local calendar day). Drives the
// day cap: once the expected number of posts has landed there is nothing left
// to poll for, so the remaining slots skip LinkedIn.
export function postsOnDay(knownUrns: string[], day: Date, createdAt: (urn: string) => Date): number {
  return knownUrns.filter((urn) => sameLocalDay(createdAt(urn), day)).length;
}

export function isPaused(pausedUntil: string | null, now: Date): boolean {
  if (!pausedUntil) return false;
  const until = new Date(pausedUntil);
  return !Number.isNaN(until.getTime()) && until.getTime() > now.getTime();
}

export function endOfLocalDay(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
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
