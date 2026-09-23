import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findPostsForDay, type ScheduledPost } from './linkedin.js';

function post(scheduledAt: Date, label = ''): ScheduledPost {
  return { shareUrn: `urn:${scheduledAt.getTime()}`, scheduledAt, text: '', imageUrl: null, label };
}

test('findPostsForDay returns every post on that local calendar day, earliest first', () => {
  const day = new Date(2026, 8, 18); // 18 Sep 2026
  const posts = [
    post(new Date(2026, 8, 18, 17, 30), 'evening'),
    post(new Date(2026, 8, 19, 8, 0), 'day after'),
    post(new Date(2026, 8, 18, 8, 45), 'morning'),
    post(new Date(2026, 8, 17, 23, 59), 'night before'),
    post(new Date(2026, 8, 18, 12, 0), 'lunch'),
  ];
  assert.deepEqual(findPostsForDay(posts, day).map((p) => p.label), ['morning', 'lunch', 'evening']);
});

test('findPostsForDay returns an empty list when nothing is queued that day', () => {
  const posts = [post(new Date(2026, 8, 19, 8, 0))];
  assert.deepEqual(findPostsForDay(posts, new Date(2026, 8, 18)), []);
});

// --- polling scrape: scroll only while everything on screen is unknown -----
import { shouldScrollAgain } from './linkedin.js';

const known = new Set(['k1', 'k2']);
const isKnown = (u: string) => known.has(u);

test('no further scroll once a known post is on screen', () => {
  assert.equal(shouldScrollAgain(['new1', 'k1'], isKnown, 0, 3), false);
});

test('scrolls again while every visible post is unknown (catch-up after an outage)', () => {
  assert.equal(shouldScrollAgain(['new1', 'new2'], isKnown, 0, 3), true);
});

test('stops at the scroll cap even if everything is still unknown', () => {
  assert.equal(shouldScrollAgain(['new1', 'new2'], isKnown, 3, 3), false);
});

test('does not scroll an empty screen', () => {
  assert.equal(shouldScrollAgain([], isKnown, 0, 3), false);
});
