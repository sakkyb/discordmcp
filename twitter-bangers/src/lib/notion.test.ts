import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pageTitle, buildPageBlocks } from './notion.js';
import type { Tweet } from './tweets.js';

const tw: Tweet = {
  id: '1',
  url: 'https://x.com/a/status/1',
  handle: 'a',
  name: 'A',
  text: 'hi',
  likes: 81_234,
  createdAt: '',
  imageCount: 1,
};

test('pageTitle', () => {
  assert.equal(pageTitle(new Date(2026, 8, 13)), 'Twitter bangers — week of 13 Sep 2026');
});

test('buildPageBlocks: intro paragraph then a caption + embed per tweet', () => {
  const blocks = buildPageBlocks(
    [tw, { ...tw, id: '2', url: 'https://x.com/b/status/2', handle: 'b' }],
    'min_faves:50000 filter:images since:2026-09-06',
  ) as any[];
  assert.equal(blocks.length, 1 + 2 * 2);
  assert.equal(blocks[0].type, 'paragraph');
  assert.match(blocks[0].paragraph.rich_text[0].text.content, /2 posts.*min_faves:50000/);
  assert.equal(blocks[1].type, 'paragraph');
  assert.equal(blocks[1].paragraph.rich_text[0].text.content, '1. @a · 81.2K likes');
  assert.equal(blocks[1].paragraph.rich_text[0].text.link.url, 'https://x.com/a/status/1');
  assert.equal(blocks[2].type, 'embed');
  assert.equal(blocks[2].embed.url, 'https://x.com/a/status/1');
  assert.equal(blocks[4].embed.url, 'https://x.com/b/status/2');
});
