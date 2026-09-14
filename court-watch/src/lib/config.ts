import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseHm } from './time.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Everything lives relative to the court-watch/ package root, regardless of
// the cwd launchd happens to use.
export const PACKAGE_ROOT = path.resolve(__dirname, '..', '..');

dotenv.config({ path: path.join(PACKAGE_ROOT, '.env') });

export const STATE_FILE = path.join(PACKAGE_ROOT, 'state.json');
export const TIME_ZONE = 'Europe/London';

export interface Venue {
  segment: string; // ClubSpark URL segment, case-sensitive in the booking page URL
  name: string;
}

export const ALL_VENUES: Venue[] = [
  { segment: 'BurgessParkSouthwark', name: 'Burgess Park' },
  { segment: 'kenningtonpark', name: 'Kennington Park' },
  { segment: 'GeraldineMaryHarmsworth', name: 'Geraldine Mary Harmsworth' },
];

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`❌ ${name} is not set (see .env.example)`);
    process.exit(1);
  }
  return value;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    console.error(`❌ ${name} must be a non-negative number, got ${raw}`);
    process.exit(1);
  }
  return n;
}

function hm(name: string, fallback: string): number {
  try {
    return parseHm(process.env[name] || fallback);
  } catch (err) {
    console.error(`❌ ${name}: ${(err as Error).message}`);
    process.exit(1);
  }
}

// "07:00-23:00" -> [420, 1380]
function hours(name: string, fallback: string): [number, number] {
  const raw = process.env[name] || fallback;
  const [a, b, ...rest] = raw.split('-');
  try {
    if (!a || !b || rest.length) throw new Error('expected HH:MM-HH:MM');
    const start = parseHm(a);
    const end = parseHm(b);
    if (end <= start) throw new Error('end must be after start');
    return [start, end];
  } catch (err) {
    console.error(`❌ ${name}: ${(err as Error).message}, got "${raw}"`);
    process.exit(1);
  }
}

export const config = {
  get ntfyTopic(): string {
    return required('NTFY_TOPIC');
  },
  get ntfyServer(): string {
    return (process.env.NTFY_SERVER || 'https://ntfy.sh').replace(/\/+$/, '');
  },
  // Weekday slots count from this time (minutes since midnight).
  get eveningStart(): number {
    return hm('EVENING_START', '17:00');
  },
  // Outside this window a run exits at once.
  get activeHours(): [number, number] {
    return hours('ACTIVE_HOURS', '07:00-23:00');
  },
  // ClubSpark's Guest role books up to this many days ahead
  // (GetSettings.Roles[].AdvancedBookingPeriod, 7 at all three venues) ...
  get horizonDays(): number {
    return num('HORIZON_DAYS', 7);
  },
  // ... and the furthest day opens at this time the day it comes into range
  // (GetSettings.NewDayBookingAvailabilityTime, 1200 = 20:00 at all three).
  get releaseTime(): number {
    return hm('RELEASE_TIME', '20:00');
  },
  // Contiguous free time shorter than this is not worth a notification.
  get minSlotMinutes(): number {
    return num('MIN_SLOT_MINUTES', 60);
  },
  // Unlit courts (Burgess Park "Crt 7 (No lights)") are useless after dark,
  // which is when most of the window falls, so they are out by default.
  get includeUnlit(): boolean {
    return process.env.INCLUDE_UNLIT === 'true';
  },
  get venues(): Venue[] {
    const raw = process.env.VENUES;
    if (!raw) return ALL_VENUES;
    const wanted = raw
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    const picked = ALL_VENUES.filter((v) => wanted.includes(v.segment.toLowerCase()));
    if (picked.length === 0) {
      console.error(`❌ VENUES matched nothing. Known: ${ALL_VENUES.map((v) => v.segment).join(', ')}`);
      process.exit(1);
    }
    return picked;
  },
  get dryRun(): boolean {
    return process.env.DRY_RUN === 'true';
  },
};

// Fail fast on bad configuration before touching the network. A dry run
// never publishes, so it needs no topic.
export function validateConfig(): void {
  void config.eveningStart;
  void config.activeHours;
  void config.horizonDays;
  void config.releaseTime;
  void config.minSlotMinutes;
  void config.venues;
  if (!config.dryRun) void config.ntfyTopic;
}
