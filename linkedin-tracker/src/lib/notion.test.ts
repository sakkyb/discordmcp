import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyticsUrlFor, activityIdFromUrl, dateWindow, chunkText } from './notion.js';

test('analyticsUrlFor builds the owner-only analytics URL from a urn', () => {
  assert.equal(
    analyticsUrlFor('urn:li:activity:7433622785099771904'),
    'https://www.linkedin.com/analytics/post-summary/urn:li:activity:7433622785099771904/',
  );
});

test('activityIdFromUrl reads the id from a /feed/update/ URL', () => {
  assert.equal(
    activityIdFromUrl('https://www.linkedin.com/feed/update/urn:li:activity:7433622785099771904/'),
    '7433622785099771904',
  );
});

test('activityIdFromUrl reads the id from a /posts/ slug URL', () => {
  assert.equal(
    activityIdFromUrl('https://www.linkedin.com/posts/sakkybaral_design-ux-activity-7433622785099771904-Ab1c'),
    '7433622785099771904',
  );
});

test('activityIdFromUrl returns null when there is no activity id', () => {
  assert.equal(activityIdFromUrl('https://www.linkedin.com/in/sakkybaral'), null);
});

test('dateWindow spans N days either side of the post date', () => {
  assert.deepEqual(dateWindow(new Date(2026, 7, 9), 14), { start: '2026-07-26', end: '2026-08-23' });
});

test('chunkText leaves short text as a single chunk', () => {
  assert.deepEqual(chunkText('hello world', 1900), ['hello world']);
});

test('chunkText splits long text on a newline boundary', () => {
  const chunks = chunkText('a'.repeat(1000) + '\n' + 'b'.repeat(1000), 1100);
  assert.deepEqual(chunks, ['a'.repeat(1000), 'b'.repeat(1000)]);
});

test('chunkText returns nothing for empty text', () => {
  assert.deepEqual(chunkText('   '), []);
});
