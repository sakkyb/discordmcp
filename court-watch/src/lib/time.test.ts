import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localNow, addDays, daysBetween, inActiveHours, parseHm } from './time.js';

test('daysBetween counts whole days either way', () => {
  assert.equal(daysBetween('2026-09-14', '2026-09-21'), 7);
  assert.equal(daysBetween('2026-09-14', '2026-09-14'), 0);
  assert.equal(daysBetween('2026-09-14', '2026-09-13'), -1);
  assert.equal(daysBetween('2026-10-25', '2026-10-26'), 1); // DST end
});

test('localNow renders date and minutes in the given zone', () => {
  // 2026-09-14T22:30Z is 23:30 BST
  assert.deepEqual(localNow(new Date('2026-09-14T22:30:00Z'), 'Europe/London'), {
    date: '2026-09-14',
    minutes: 23 * 60 + 30,
  });
  // 2026-09-14T23:30Z is 00:30 on the 15th BST
  assert.deepEqual(localNow(new Date('2026-09-14T23:30:00Z'), 'Europe/London'), {
    date: '2026-09-15',
    minutes: 30,
  });
  // Winter: 2026-12-01T09:05Z is 09:05 GMT
  assert.deepEqual(localNow(new Date('2026-12-01T09:05:00Z'), 'Europe/London'), {
    date: '2026-12-01',
    minutes: 9 * 60 + 5,
  });
});

test('addDays crosses month and year ends', () => {
  assert.equal(addDays('2026-09-28', 7), '2026-10-05');
  assert.equal(addDays('2026-12-30', 3), '2027-01-02');
  assert.equal(addDays('2026-09-14', 0), '2026-09-14');
});

test('parseHm parses HH:MM and rejects nonsense', () => {
  assert.equal(parseHm('17:00'), 1020);
  assert.equal(parseHm('7:05'), 425);
  assert.throws(() => parseHm('25:00'));
  assert.throws(() => parseHm('5pm'));
});

test('inActiveHours is a half-open window', () => {
  assert.ok(inActiveHours(7 * 60, [420, 1380]));
  assert.ok(inActiveHours(1379, [420, 1380]));
  assert.ok(!inActiveHours(1380, [420, 1380]));
  assert.ok(!inActiveHours(100, [420, 1380]));
});
