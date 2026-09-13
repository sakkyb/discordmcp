import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { sinceDate, buildQuery, searchUrl, parseSearchResponse, selectTweets } from './tweets.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'search-timeline.json'), 'utf-8'));

test('sinceDate subtracts lookback days across month and year boundaries', () => {
  assert.equal(sinceDate(new Date(2026, 8, 13, 5, 0), 7), '2026-09-06');
  assert.equal(sinceDate(new Date(2026, 9, 3, 5, 0), 7), '2026-09-26');
  assert.equal(sinceDate(new Date(2026, 0, 2, 5, 0), 7), '2025-12-26');
});

test('buildQuery and searchUrl', () => {
  const q = buildQuery(50_000, '2026-09-06');
  assert.equal(q, 'min_faves:50000 filter:images since:2026-09-06');
  assert.equal(
    searchUrl(q),
    'https://x.com/search?q=min_faves%3A50000%20filter%3Aimages%20since%3A2026-09-06&src=typed_query',
  );
});

test('parseSearchResponse extracts tweets, unwraps visibility results, drops retweets', () => {
  const tweets = parseSearchResponse(fixture);
  assert.deepEqual(tweets.map((t) => t.id).sort(), ['1001', '1002', '1004']);
  const a = tweets.find((t) => t.id === '1001')!;
  assert.equal(a.handle, 'alice');
  assert.equal(a.name, 'Alice');
  assert.equal(a.likes, 81234);
  assert.equal(a.imageCount, 2);
  assert.equal(a.text, 'First banger');
  assert.equal(a.url, 'https://x.com/alice/status/1001');
  assert.equal(a.createdAt, '2026-09-09T12:00:00.000Z');
  const b = tweets.find((t) => t.id === '1002')!;
  assert.equal(b.handle, 'bob');
  assert.equal(b.imageCount, 0);
  // X HTML-escapes full_text; the caption must read as written.
  const d = tweets.find((t) => t.id === '1004')!;
  assert.equal(d.text, 'Small & <bold> "one" it\'s');
});

test('parseSearchResponse tolerates garbage', () => {
  assert.deepEqual(parseSearchResponse(null), []);
  assert.deepEqual(parseSearchResponse({ data: {} }), []);
  assert.deepEqual(parseSearchResponse('nope'), []);
});

test('selectTweets filters by likes and images, sorts, dedupes and caps', () => {
  const tweets = parseSearchResponse(fixture);
  const doubled = [...tweets, ...tweets];
  const picked = selectTweets(doubled, { minFaves: 50_000, maxPosts: 100 });
  assert.deepEqual(picked.map((t) => t.id), ['1001']);
  const loose = selectTweets(doubled, { minFaves: 1, maxPosts: 100 });
  assert.deepEqual(loose.map((t) => t.id), ['1001', '1004']);
  const capped = selectTweets(doubled, { minFaves: 1, maxPosts: 1 });
  assert.deepEqual(capped.map((t) => t.id), ['1001']);
});
