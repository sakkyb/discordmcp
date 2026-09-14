import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadState, saveState, replaceVenueSnapshot, shouldAlert, type WatchState } from './state.js';
import type { Slot } from './slots.js';

const slot = (venue: string, start: number): Slot => ({
  venue,
  date: '2026-09-19',
  resourceId: 'r',
  court: 'Court 1',
  lit: true,
  start,
  end: start + 60,
  cost: 8,
});

test('loadState returns empty state when the file is missing or corrupt', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'court-watch-'));
  const file = path.join(dir, 'state.json');
  assert.deepEqual(loadState(file), { lastRun: null, lastAlertAt: null, free: {} });
  fs.writeFileSync(file, '{not json');
  assert.deepEqual(loadState(file), { lastRun: null, lastAlertAt: null, free: {} });
  fs.writeFileSync(file, JSON.stringify({ free: [1, 2] }));
  assert.deepEqual(loadState(file).free, {});
});

test('saveState / loadState round trip', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'court-watch-'));
  const file = path.join(dir, 'state.json');
  const state: WatchState = {
    lastRun: '2026-09-14T12:00:00.000Z',
    lastAlertAt: null,
    free: { 'a|2026-09-19|r|480|540': { court: 'Court 1', cost: 8 } },
  };
  saveState(state, file);
  assert.deepEqual(loadState(file), state);
});

test('replaceVenueSnapshot swaps only that venue and does not mutate the input', () => {
  const state = replaceVenueSnapshot(replaceVenueSnapshot({ lastRun: null, lastAlertAt: null, free: {} }, 'a', [slot('a', 480)]), 'b', [
    slot('b', 480),
  ]);
  const next = replaceVenueSnapshot(state, 'a', [slot('a', 540)]);
  assert.deepEqual(Object.keys(next.free).sort(), ['a|2026-09-19|r|540|600', 'b|2026-09-19|r|480|540']);
  assert.deepEqual(Object.keys(state.free).sort(), ['a|2026-09-19|r|480|540', 'b|2026-09-19|r|480|540']);
  assert.deepEqual(next.free['a|2026-09-19|r|540|600'], { court: 'Court 1', cost: 8 });
});

test('shouldAlert: first alert always, then at most hourly', () => {
  const never: WatchState = { lastRun: null, lastAlertAt: null, free: {} };
  assert.ok(shouldAlert(never, '2026-09-14T12:00:00.000Z'));
  const recent: WatchState = { ...never, lastAlertAt: '2026-09-14T11:30:00.000Z' };
  assert.ok(!shouldAlert(recent, '2026-09-14T12:00:00.000Z'));
  assert.ok(shouldAlert(recent, '2026-09-14T12:30:00.000Z'));
});
