import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadState, saveState, diffNew, mergeSeen } from './state.js';
import type { Tweet } from './tweets.js';

const tw = (id: string, likes: number): Tweet => ({
  id,
  url: `https://x.com/u/status/${id}`,
  handle: 'u',
  name: 'U',
  text: '',
  likes,
  createdAt: '',
  imageCount: 1,
  imageUrls: [],
});

test('loadState returns empty state when the file is missing or corrupt', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bangers-'));
  const file = path.join(dir, 'state.json');
  assert.deepEqual(loadState(file), { lastRun: null, seen: {} });
  fs.writeFileSync(file, '{not json');
  assert.deepEqual(loadState(file), { lastRun: null, seen: {} });
});

test('diffNew returns only tweets not in seen', () => {
  const state = { lastRun: null, seen: { '1': { likes: 5, url: '', firstSeen: '2026-09-06' } } };
  assert.deepEqual(diffNew(state, [tw('1', 9), tw('2', 8)]).map((t) => t.id), ['2']);
});

test('mergeSeen keeps earliest firstSeen and the higher like count, without mutating input', () => {
  const state = { lastRun: null, seen: { '1': { likes: 5, url: 'a', firstSeen: '2026-09-06' } } };
  const next = mergeSeen(state, [tw('1', 9), tw('2', 8)], '2026-09-13');
  assert.equal(next.seen['1'].firstSeen, '2026-09-06');
  assert.equal(next.seen['1'].likes, 9);
  assert.equal(next.seen['2'].firstSeen, '2026-09-13');
  assert.ok(next.lastRun);
  assert.equal(state.seen['2' as '1'], undefined);
});

test('saveState then loadState round-trips', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bangers-'));
  const file = path.join(dir, 'state.json');
  const state = mergeSeen({ lastRun: null, seen: {} }, [tw('7', 1)], '2026-09-13');
  saveState(state, file);
  assert.deepEqual(loadState(file), state);
});
