import { bookingPageUrl } from './clubspark.js';
import type { Venue } from './config.js';
import type { Range } from './slots.js';

// ntfy caps a message at 4,096 bytes; £ and – are multi-byte, so clip well under.
export const BODY_MAX = 3500;
const MAX_ACTIONS = 3; // ntfy allows up to three action buttons

export interface Action {
  label: string;
  url: string;
}

export interface Notification {
  title: string;
  body: string;
  click: string;
  actions: Action[];
  tags: string[];
  priority?: number; // ntfy 1..5, default 3
}

export function formatTime(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// Fixed tables rather than Intl: en-GB renders September as "Sept".
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// "2026-09-19" -> "Sat 19 Sep"
export function formatDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${DAYS[dow]} ${d} ${MONTHS[m - 1]}`;
}

// £8, £15.60, free
export function formatCost(cost: number): string {
  if (cost === 0) return 'free';
  return Number.isInteger(cost) ? `£${cost}` : `£${cost.toFixed(2)}`;
}

export function clip(s: string, max = BODY_MAX): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function describe(r: Range): string {
  // Burgess Park already names its unlit court "Crt 7 (No lights)".
  const lights = r.lit || /light/i.test(r.court) ? '' : ' (no lights)';
  return `${r.court}${lights} ${formatTime(r.start)}–${formatTime(r.end)} ${formatCost(r.cost)}`;
}

// One notification per venue: ranges grouped by date, first date clickable,
// up to three date buttons. Null when there is nothing to say.
export function buildNotification(venue: Venue, ranges: Range[]): Notification | null {
  if (ranges.length === 0) return null;
  const byDate = new Map<string, Range[]>();
  for (const r of ranges) {
    const g = byDate.get(r.date);
    if (g) g.push(r);
    else byDate.set(r.date, [r]);
  }
  const dates = [...byDate.keys()].sort();
  const lines = dates.map((d) => `${formatDate(d)} — ${byDate.get(d)!.map(describe).join(' · ')}`);
  const n = ranges.length;
  return {
    title: `${venue.name}: ${n} new slot${n === 1 ? '' : 's'}`,
    body: clip(lines.join('\n')),
    click: bookingPageUrl(venue.segment, dates[0]),
    actions: dates.slice(0, MAX_ACTIONS).map((d) => ({ label: formatDate(d), url: bookingPageUrl(venue.segment, d) })),
    tags: ['tennis'],
  };
}
