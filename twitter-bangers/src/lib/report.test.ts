import { test } from 'node:test';
import assert from 'node:assert/strict';
import { weekLabel, formatLikes, buildReportMessages } from './report.js';
import type { Tweet } from './tweets.js';

const tw = (i: number, likes = 60_000): Tweet => ({
  id: String(i),
  url: `https://x.com/user${i}/status/${i}`,
  handle: `user${i}`,
  name: `User ${i}`,
  text: `Line one of tweet ${i}\nSecond line that must not appear`,
  likes,
  createdAt: '',
  imageCount: 1,
  imageUrls: [],
});
const run = new Date(2026, 8, 13, 5, 0);

test('weekLabel and formatLikes', () => {
  assert.equal(weekLabel(run), '13 Sep 2026');
  assert.equal(formatLikes(999), '999');
  assert.equal(formatLikes(123_456), '123.5K');
  assert.equal(formatLikes(50_000), '50K');
  assert.equal(formatLikes(2_100_000), '2.1M');
});

test('a report lists entries with suppressed links and ends with the Notion line', () => {
  const msgs = buildReportMessages({
    runDate: run,
    report: [tw(1, 81_234), tw(2)],
    checked: 40,
    notionUrl: 'https://notion.so/p',
  });
  assert.equal(msgs.length, 1);
  const msg = msgs[0];
  assert.match(msg, /^\*\*Twitter weekly bangers — week of 13 Sep 2026\*\*\n/);
  assert.match(msg, /2 relevant new posts \(from 40 unseen of 40 with 50k\+ likes and images\)/);
  assert.match(msg, /1\. @user1 — 81\.2K likes\n {3}Line one of tweet 1\n {3}<https:\/\/x\.com\/user1\/status\/1>/);
  assert.doesNotMatch(msg, /Second line/);
  assert.match(msg, /\nSaved in Notion: <https:\/\/notion\.so\/p>$/);
});

test('an empty report says so', () => {
  const msgs = buildReportMessages({ runDate: run, report: [], checked: 12, unseen: 4, notionUrl: null });
  assert.equal(msgs.length, 1);
  assert.match(msgs[0], /No new bangers this week \(4 unseen of 12 checked, none relevant\)/);
});

test('a classified entry shows its category and reason; a classifier failure is flagged', () => {
  const t = { ...tw(1, 70_000), verdict: { id: '1', relevant: true, category: 'Everyday UX', score: 5, reason: 'a shelf that slides' } };
  const [msg] = buildReportMessages({ runDate: run, report: [t], checked: 100, unseen: 30, notionUrl: null });
  assert.match(msg, /1 relevant new posts \(from 30 unseen of 100/);
  assert.match(msg, /1\. @user1 — 70K likes · Everyday UX\n {3}Line one of tweet 1\n {3}↳ a shelf that slides\n {3}<https/);
  const [fallback] = buildReportMessages({ runDate: run, report: [tw(1)], checked: 100, unseen: 30, notionUrl: 'https://notion.so/p', classifierError: 'boom' });
  assert.match(fallback, /UNFILTERED \(30 unseen of 100 checked\)/);
  assert.match(fallback, /⚠️ Relevance filter failed.*boom\nSaved in Notion: <https:\/\/notion\.so\/p>$/);
});

test('long reports split under 2000 chars with the Notion line last', () => {
  const report = Array.from({ length: 20 }, (_, i) => ({
    ...tw(i + 1),
    text: `${'A fairly long first line of tweet text that keeps going '.repeat(3)}\nmore`,
  }));
  const msgs = buildReportMessages({ runDate: run, report, checked: 100, notionUrl: 'https://notion.so/p' });
  assert.ok(msgs.length >= 2, `expected a split, got ${msgs.length} chunk(s)`);
  for (const m of msgs) assert.ok(m.length <= 2000, `chunk too long: ${m.length}`);
  assert.match(msgs[msgs.length - 1], /Saved in Notion: <https:\/\/notion\.so\/p>$/);
  assert.equal(msgs.join('\n').match(/^\d+\. @/gm)!.length, 20);
});

test('a Notion failure is reported instead of the link', () => {
  const [msg] = buildReportMessages({ runDate: run, report: [tw(1)], checked: 1, notionUrl: null, notionError: 'boom' });
  assert.match(msg, /Notion save failed: boom/);
  assert.doesNotMatch(msg, /Saved in Notion/);
});
