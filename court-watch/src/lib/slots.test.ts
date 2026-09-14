import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import type { VenueSessionsResponse } from './clubspark.js';
import {
  parseSlots,
  inWindow,
  diffNew,
  mergeAdjacent,
  reportableRanges,
  slotKey,
  isWeekend,
  type Slot,
} from './slots.js';

const fixture = (name: string): VenueSessionsResponse =>
  JSON.parse(fs.readFileSync(new URL(`./fixtures/${name}-2026-09-19-20.json`, import.meta.url), 'utf-8'));

const kennington = fixture('kennington');
const burgess = fixture('burgess');
const gmh = fixture('gmh');

test('parseSlots: Kennington yields only the priced category-0 (available) sessions on tennis courts', () => {
  const slots = parseSlots('kenningtonpark', kennington);
  // The capture (a busy weekend) has exactly one available cell: Court 4,
  // Sunday 08:00, scheme "Default", £8. Everything labelled "Booking"
  // (category 1000) is an existing booking and must not appear.
  assert.equal(slots.length, 1);
  const [only] = slots;
  assert.equal(only.venue, 'kenningtonpark');
  assert.equal(only.court, 'Court 4');
  assert.equal(only.date, '2026-09-20');
  assert.equal(only.start, 480);
  assert.equal(only.end, 540);
  assert.equal(only.cost, 8);
  assert.equal(only.lit, true);
  assert.equal(only.resourceId, '48ce242f-d10d-43d7-ad21-92009296bd20');
  // Court 1 Saturday is "Booking" 08:00 in the capture: booked, so absent.
  assert.ok(!slots.some((s) => s.court === 'Court 1'));
  // Cricket nets are never included even when they have category-0 sessions.
  assert.ok(!slots.some((s) => s.court.startsWith('Cricket')));
});

test('parseSlots: Burgess has 30 available blocks = 127 half-hour units, court 7 unlit; GMH weekend is fully booked', () => {
  const b = parseSlots('BurgessParkSouthwark', burgess);
  assert.equal(b.length, 127);
  // Block Crt 1 Sat 18:30–22:00 (interval 30) becomes seven consecutive units
  const late = b.filter((s) => s.court === 'Crt 1' && s.date === '2026-09-19' && s.start >= 1110).map((s) => [s.start, s.end]);
  assert.deepEqual(late, [
    [1110, 1140],
    [1140, 1170],
    [1170, 1200],
    [1200, 1230],
    [1230, 1260],
    [1260, 1290],
    [1290, 1320],
  ]);
  assert.ok(b.every((s) => s.end - s.start === 30 && s.cost > 0));
  const first = b.find((s) => s.court === 'Crt 1' && s.date === '2026-09-19');
  assert.ok(first);
  assert.equal(first.start, 720);
  assert.equal(first.cost, 5.2);
  assert.ok(b.some((s) => s.court.startsWith('Crt 7') && !s.lit));
  // Every session in the GMH capture is a booking or coaching: nothing free.
  assert.equal(parseSlots('GeraldineMaryHarmsworth', gmh).length, 0);
});

test('parseSlots: unpriced category-0 sessions are skipped', () => {
  const data = {
    TimeZone: 'Europe/London',
    Resources: [
      {
        ID: 'r1',
        ResourceGroupID: 'g',
        Name: 'Court 1',
        Category: 1,
        Lighting: 1,
        Days: [
          {
            Date: '2026-09-19T00:00:00',
            Sessions: [
              { ID: 'a', Category: 0, SubCategory: 0, Name: 'Default', StartTime: 480, EndTime: 540, Interval: 60, CourtCost: 0 },
              { ID: 'b', Category: 0, SubCategory: 0, Name: 'Default', StartTime: 540, EndTime: 600, Interval: 60, CourtCost: 8 },
              { ID: 'c', Category: 1000, SubCategory: 0, Name: 'Booking', StartTime: 600, EndTime: 660, Interval: 60, CourtCost: 8 },
            ],
          },
        ],
      },
    ],
  };
  assert.deepEqual(
    parseSlots('v', data).map((s) => s.start),
    [540],
  );
});

test('isWeekend', () => {
  assert.ok(isWeekend('2026-09-19')); // Sat
  assert.ok(isWeekend('2026-09-20')); // Sun
  assert.ok(!isWeekend('2026-09-14')); // Mon
});

const base: Omit<Slot, 'date' | 'start' | 'end'> = {
  venue: 'v',
  resourceId: 'r',
  court: 'C',
  lit: true,
  cost: 0,
};
const at = (date: string, startH: number, len = 60): Slot => ({
  ...base,
  date,
  start: startH * 60,
  end: startH * 60 + len,
});

const rule = { horizonDays: 7, releaseMinutes: 20 * 60 };

test('inWindow: weekends all day, weekdays from eveningStart, past slots dropped', () => {
  const opts = { ...rule, eveningStart: 17 * 60, now: { date: '2026-09-14', minutes: 12 * 60 } }; // Monday noon
  assert.ok(inWindow(at('2026-09-19', 8), opts)); // Sat morning
  assert.ok(inWindow(at('2026-09-20', 14), opts)); // Sun afternoon
  assert.ok(!inWindow(at('2026-09-15', 16), opts)); // Tue 16:00
  assert.ok(inWindow(at('2026-09-15', 17), opts)); // Tue 17:00
  assert.ok(inWindow(at('2026-09-14', 18), opts)); // today evening
  assert.ok(!inWindow(at('2026-09-14', 11), opts)); // already started
  assert.ok(!inWindow(at('2026-09-14', 12), opts)); // starting right now
  assert.ok(!inWindow(at('2026-09-13', 18), opts)); // yesterday
});

test('inWindow: day+7 opens at the release time, day+8 never', () => {
  const before = { ...rule, eveningStart: 17 * 60, now: { date: '2026-09-14', minutes: 13 * 60 } };
  const after = { ...rule, eveningStart: 17 * 60, now: { date: '2026-09-14', minutes: 20 * 60 } };
  assert.ok(inWindow(at('2026-09-20', 18), before)); // day+6 always
  assert.ok(!inWindow(at('2026-09-21', 18), before)); // day+7 before 20:00
  assert.ok(inWindow(at('2026-09-21', 18), after)); // day+7 from 20:00
  assert.ok(!inWindow(at('2026-09-22', 18), after)); // day+8 never
});

test('diffNew returns slots whose key is absent from the previous snapshot', () => {
  const a = at('2026-09-19', 8);
  const b = at('2026-09-19', 9);
  const prev = { [slotKey(a)]: { court: 'C', cost: 0 } };
  assert.deepEqual(diffNew([a, b], prev), [b]);
  assert.deepEqual(diffNew([a, b], {}), [a, b]);
});

test('mergeAdjacent joins touching sessions on one court, sums cost, sorts naturally', () => {
  const s = (court: string, resourceId: string, startMin: number, len: number, cost: number): Slot => ({
    venue: 'v',
    date: '2026-09-19',
    resourceId,
    court,
    lit: true,
    start: startMin,
    end: startMin + len,
    cost,
  });
  const ranges = mergeAdjacent([
    s('Crt 10', 'r10', 18 * 60, 30, 5.2),
    s('Crt 2', 'r2', 19 * 60 + 30, 30, 5.2),
    s('Crt 2', 'r2', 18 * 60 + 30, 30, 5.2),
    s('Crt 2', 'r2', 18 * 60, 30, 5.2),
  ]);
  assert.deepEqual(
    ranges.map((r) => [r.court, r.start, r.end, r.cost]),
    [
      ['Crt 2', 18 * 60, 19 * 60, 10.4],
      ['Crt 2', 19 * 60 + 30, 20 * 60, 5.2],
      ['Crt 10', 18 * 60, 18 * 60 + 30, 5.2],
    ],
  );
});

test('mergeAdjacent records the raw session keys inside each range', () => {
  const a = at('2026-09-19', 18, 30);
  const b = { ...at('2026-09-19', 18, 30), start: 18 * 60 + 30, end: 19 * 60 };
  const [r] = mergeAdjacent([a, b]);
  assert.deepEqual(r.keys, [slotKey(a), slotKey(b)]);
});

test('reportableRanges: drops contiguous free time under the minimum', () => {
  const lone = at('2026-09-19', 18, 30);
  assert.deepEqual(reportableRanges([lone], [lone], 60), []);
  const hour = at('2026-09-19', 19, 60);
  assert.equal(reportableRanges([lone, hour], [lone, hour], 60).length, 1);
});

test('reportableRanges: a new 30 min next to an already free 30 min reports the full hour', () => {
  const old = at('2026-09-19', 18, 30);
  const fresh = { ...old, start: 18 * 60 + 30, end: 19 * 60 };
  const ranges = reportableRanges([old, fresh], [fresh], 60);
  assert.equal(ranges.length, 1);
  assert.equal(ranges[0].start, 18 * 60);
  assert.equal(ranges[0].end, 19 * 60);
});

test('reportableRanges: ranges with nothing new are not reported', () => {
  const old = at('2026-09-19', 18, 60);
  const fresh = at('2026-09-20', 10, 60);
  const ranges = reportableRanges([old, fresh], [fresh], 60);
  assert.deepEqual(
    ranges.map((r) => r.date),
    ['2026-09-20'],
  );
});

test('mergeAdjacent orders by date before court', () => {
  const ranges = mergeAdjacent([at('2026-09-20', 9), { ...at('2026-09-19', 10), court: 'Z' }]);
  assert.deepEqual(
    ranges.map((r) => r.date),
    ['2026-09-19', '2026-09-20'],
  );
});
