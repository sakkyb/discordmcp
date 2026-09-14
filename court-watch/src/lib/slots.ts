import type { VenueSessionsResponse } from './clubspark.js';
import { daysBetween, type LocalNow } from './time.js';

// Verified against the booking page on 2026-09-14: a category-0 session
// carries the pricing scheme's name ("Tennis Change 2026 - 2027", "Default",
// a GUID) and a price, and the page renders it as a bookable cell showing
// that price. Category 1000 "Booking" is an existing booking (the page shows
// "Booked"). The names are misleading the other way round.
export const AVAILABLE_SESSION = 0;
export const BOOKED_SESSION = 1000;
export const TENNIS_COURT = 1;

export interface Slot {
  venue: string; // ClubSpark segment
  date: string; // YYYY-MM-DD
  resourceId: string;
  court: string;
  lit: boolean;
  start: number; // minutes since midnight
  end: number;
  cost: number; // GBP
}

export function slotKey(s: Slot): string {
  return `${s.venue}|${s.date}|${s.resourceId}|${s.start}|${s.end}`;
}

// One Slot per bookable unit on a tennis court. An available session is a
// block (e.g. 09:00–11:00) bookable in `Interval`-minute units, each at
// `CourtCost`; it is split into those units so that a block shrinking when
// someone books part of it never looks like new availability. Every other
// session category (booked, coaching, closed, unknown) is ignored, never
// treated as free. Unpriced sessions are skipped too: a real bookable cell
// always shows a price on the page.
export function parseSlots(venue: string, data: VenueSessionsResponse): Slot[] {
  const slots: Slot[] = [];
  for (const r of data.Resources) {
    if (r.Category !== TENNIS_COURT) continue;
    for (const day of r.Days ?? []) {
      const date = day.Date.slice(0, 10);
      for (const s of day.Sessions ?? []) {
        if (s.Category !== AVAILABLE_SESSION || !(s.CourtCost > 0)) continue;
        const length = s.EndTime - s.StartTime;
        const unit = s.Interval > 0 && s.Interval <= length ? s.Interval : length;
        for (let start = s.StartTime; start + unit <= s.EndTime; start += unit) {
          slots.push({
            venue,
            date,
            resourceId: r.ID,
            court: r.Name,
            lit: r.Lighting === 1,
            start,
            end: start + unit,
            cost: s.CourtCost,
          });
        }
      }
    }
  }
  return slots;
}

export function isWeekend(date: string): boolean {
  const [y, m, d] = date.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return dow === 0 || dow === 6;
}

export interface WindowOptions {
  eveningStart: number; // minutes since midnight, weekdays only
  now: LocalNow;
  // ClubSpark's booking rule (GetSettings: AdvancedBookingPeriod and
  // NewDayBookingAvailabilityTime): a day is bookable up to horizonDays
  // ahead, and day+horizonDays only from releaseMinutes on the release day.
  // The sessions API still returns priced cells for later days; the page
  // greys them out with exactly this rule.
  horizonDays: number;
  releaseMinutes: number;
}

// Bookable now (within the booking window), on a weekend or a weekday from
// eveningStart, and not already started.
export function inWindow(slot: Slot, { eveningStart, now, horizonDays, releaseMinutes }: WindowOptions): boolean {
  const ahead = daysBetween(now.date, slot.date);
  if (ahead < 0 || ahead > horizonDays) return false;
  if (ahead === horizonDays && now.minutes < releaseMinutes) return false;
  if (ahead === 0 && slot.start <= now.minutes) return false;
  return isWeekend(slot.date) || slot.start >= eveningStart;
}

// Slots not present in the previous snapshot (keyed by slotKey).
export function diffNew(current: Slot[], previous: Record<string, unknown>): Slot[] {
  return current.filter((s) => !(slotKey(s) in previous));
}

export interface Range {
  date: string;
  court: string;
  lit: boolean;
  start: number;
  end: number;
  cost: number;
  keys: string[]; // slotKey of every raw session inside the range
}

const byCourt = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

// Touching free sessions on one court become one range (display only; the
// diff always runs on raw slots). Sorted by date, court, start.
export function mergeAdjacent(slots: Slot[]): Range[] {
  const groups = new Map<string, Slot[]>();
  for (const s of slots) {
    const k = `${s.date}|${s.resourceId}`;
    const g = groups.get(k);
    if (g) g.push(s);
    else groups.set(k, [s]);
  }
  const ranges: Range[] = [];
  for (const g of groups.values()) {
    g.sort((a, b) => a.start - b.start);
    let cur: Range | null = null;
    for (const s of g) {
      if (cur && cur.end === s.start) {
        cur.end = s.end;
        cur.cost = round2(cur.cost + s.cost);
        cur.keys.push(slotKey(s));
      } else {
        cur = { date: s.date, court: s.court, lit: s.lit, start: s.start, end: s.end, cost: s.cost, keys: [slotKey(s)] };
        ranges.push(cur);
      }
    }
  }
  return ranges.sort((a, b) => a.date.localeCompare(b.date) || byCourt(a.court, b.court) || a.start - b.start);
}

// The ranges worth announcing: contiguous free time of at least minMinutes
// on one court that contains at least one newly free session. Built from
// ALL current free slots, so a 30-minute gap opening next to an already
// free 30 minutes reports the full hour, while a lone 30-minute gap is
// dropped.
export function reportableRanges(current: Slot[], fresh: Slot[], minMinutes: number): Range[] {
  const freshKeys = new Set(fresh.map(slotKey));
  return mergeAdjacent(current).filter((r) => r.end - r.start >= minMinutes && r.keys.some((k) => freshKeys.has(k)));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
