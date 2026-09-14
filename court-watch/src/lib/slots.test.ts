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

test('parseSlots: Kennington yields only tennis courts and category-1000 sessions', () => {
  const slots = parseSlots('kenningtonpark', kennington);
  assert.deepEqual(
    [...new Set(slots.map((s) => s.court))].sort(),
    ['Court 1', 'Court 2', 'Court 3', 'Court 4', 'Court 5'],
  );
  // 38 one-hour + 13 two-hour "Booking" sessions in the capture
  assert.equal(slots.length, 51);
  const first = slots.find((s) => s.court === 'Court 1' && s.date === '2026-09-19');
  assert.ok(first);
  assert.equal(first.venue, 'kenningtonpark');
  assert.equal(first.start, 480);
  assert.equal(first.end, 540);
  assert.equal(first.cost, 8);
  assert.equal(first.lit, true);
  assert.equal(first.resourceId, '48d10536-b799-4e21-868c-da7fb3fe43e0');
  // Booked (category 0) and closed (8000) sessions never appear
  assert.ok(!slots.some((s) => s.court === 'Court 1' && s.date === '2026-09-19' && s.start === 19 * 60));
});

test('parseSlots: Burgess court 7 is unlit; GMH has 30-minute slots', () => {
  const b = parseSlots('BurgessParkSouthwark', burgess);
  const seven = b.find((s) => s.court.startsWith('Crt 7'));
  assert.ok(seven);
  assert.equal(seven.lit, false);
  assert.equal(b.length, 12 + 1 + 9 + 2 + 9 + 55);
  const g = parseSlots('GeraldineMaryHarmsworth', gmh);
  assert.ok(g.some((s) => s.end - s.start === 30));
  assert.equal(g.length, 4 + 2 + 6 + 34);
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

test('inWindow: weekends all day, weekdays from eveningStart, past slots dropped', () => {
  const opts = { eveningStart: 17 * 60, now: { date: '2026-09-14', minutes: 12 * 60 } }; // Monday noon
  assert.ok(inWindow(at('2026-09-19', 8), opts)); // Sat morning
  assert.ok(inWindow(at('2026-09-20', 14), opts)); // Sun afternoon
  assert.ok(!inWindow(at('2026-09-15', 16), opts)); // Tue 16:00
  assert.ok(inWindow(at('2026-09-15', 17), opts)); // Tue 17:00
  assert.ok(inWindow(at('2026-09-14', 18), opts)); // today evening
  assert.ok(!inWindow(at('2026-09-14', 11), opts)); // already started
  assert.ok(!inWindow(at('2026-09-14', 12), opts)); // starting right now
  assert.ok(!inWindow(at('2026-09-13', 18), opts)); // yesterday
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
