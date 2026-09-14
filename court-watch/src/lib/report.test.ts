import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildNotification, formatTime, formatDate, formatCost, clip, BODY_MAX } from './report.js';
import type { Slot } from './slots.js';

const venue = { segment: 'kenningtonpark', name: 'Kennington Park' };
const slot = (date: string, court: string, startH: number, len = 60, cost = 8, lit = true): Slot => ({
  venue: venue.segment,
  date,
  resourceId: `id-${court}`,
  court,
  lit,
  start: startH * 60,
  end: startH * 60 + len,
  cost,
});

test('formatters', () => {
  assert.equal(formatTime(17 * 60), '17:00');
  assert.equal(formatTime(9 * 60 + 30), '09:30');
  assert.equal(formatDate('2026-09-19'), 'Sat 19 Sep');
  assert.equal(formatDate('2026-10-05'), 'Mon 5 Oct');
  assert.equal(formatCost(8), '£8');
  assert.equal(formatCost(15.6), '£15.60');
  assert.equal(formatCost(0), 'free');
});

test('buildNotification groups by date, merges adjacent, links the first date', () => {
  const n = buildNotification(venue, [
    slot('2026-09-20', 'Court 1', 9),
    slot('2026-09-19', 'Court 5', 18),
    slot('2026-09-19', 'Court 2', 18),
    slot('2026-09-19', 'Court 2', 17),
  ]);
  assert.equal(n.title, 'Kennington Park: 3 new slots');
  assert.equal(n.body, 'Sat 19 Sep — Court 2 17:00–19:00 £16 · Court 5 18:00–19:00 £8\nSun 20 Sep — Court 1 09:00–10:00 £8');
  assert.equal(n.click, 'https://clubspark.lta.org.uk/kenningtonpark/Booking/BookByDate#?date=2026-09-19&role=guest');
  assert.deepEqual(n.actions, [
    { label: 'Sat 19 Sep', url: 'https://clubspark.lta.org.uk/kenningtonpark/Booking/BookByDate#?date=2026-09-19&role=guest' },
    { label: 'Sun 20 Sep', url: 'https://clubspark.lta.org.uk/kenningtonpark/Booking/BookByDate#?date=2026-09-20&role=guest' },
  ]);
  assert.deepEqual(n.tags, ['tennis']);
});

test('buildNotification: singular title, unlit court marked', () => {
  const n = buildNotification({ segment: 'BurgessParkSouthwark', name: 'Burgess Park' }, [
    slot('2026-09-19', 'Crt 7 (No lights)', 18, 30, 5.2, false),
  ]);
  assert.equal(n.title, 'Burgess Park: 1 new slot');
  assert.equal(n.body, 'Sat 19 Sep — Crt 7 (No lights) 18:00–18:30 £5.20');
  const unnamed = buildNotification(venue, [slot('2026-09-19', 'Court 9', 18, 60, 8, false)]);
  assert.equal(unnamed.body, 'Sat 19 Sep — Court 9 (no lights) 18:00–19:00 £8');
});

test('buildNotification caps action buttons at three', () => {
  const n = buildNotification(venue, ['2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18'].map((d) => slot(d, 'Court 1', 18)));
  assert.equal(n.actions.length, 3);
  assert.equal(n.actions[0].label, 'Tue 15 Sep');
});

test('clip adds an ellipsis at the limit', () => {
  const long = 'x'.repeat(BODY_MAX + 10);
  assert.equal(clip(long).length, BODY_MAX);
  assert.ok(clip(long).endsWith('…'));
  assert.equal(clip('short'), 'short');
});
