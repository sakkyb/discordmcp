// Every date/time decision in this job is made in the venue's zone
// (Europe/London), never in the machine's or UTC.

export interface LocalNow {
  date: string; // YYYY-MM-DD
  minutes: number; // minutes since local midnight
}

export function localNow(d: Date, tz: string): LocalNow {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    minutes: Number(get('hour')) * 60 + Number(get('minute')),
  };
}

// Calendar arithmetic on a YYYY-MM-DD string; UTC so DST never shifts a day.
export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

// "17:00" -> 1020
export function parseHm(s: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) throw new Error(`Expected HH:MM, got "${s}"`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) throw new Error(`Expected HH:MM, got "${s}"`);
  return h * 60 + min;
}

// [start, end) in minutes since midnight.
export function inActiveHours(minutes: number, [start, end]: [number, number]): boolean {
  return minutes >= start && minutes < end;
}
