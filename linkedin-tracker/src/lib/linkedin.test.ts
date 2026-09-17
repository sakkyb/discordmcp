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
