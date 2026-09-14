import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBatchContent, parseVerdicts, applyVerdicts, classifyTweets, smallImageUrl, systemPrompt } from './classify.js';
import type { Tweet } from './tweets.js';

const tw = (id: string, likes: number, text = `text ${id}`, imageUrls = [`https://pbs.twimg.com/media/${id}.jpg`]): Tweet => ({
  id, url: `https://x.com/u/status/${id}`, handle: 'u', name: 'U', text, likes, createdAt: '', imageCount: imageUrls.length, imageUrls,
});

test('smallImageUrl asks pbs for the small variant', () => {
  assert.equal(smallImageUrl('https://pbs.twimg.com/media/A.jpg'), 'https://pbs.twimg.com/media/A.jpg?name=small');
  assert.equal(smallImageUrl('https://pbs.twimg.com/media/A?format=png'), 'https://pbs.twimg.com/media/A?format=png&name=small');
});

test('systemPrompt embeds the rubric', () => {
  assert.match(systemPrompt('# My rubric\nkeep UX'), /^# My rubric\nkeep UX\n/);
});

test('buildBatchContent interleaves text and first image, and can go text-only', () => {
  const blocks = buildBatchContent([tw('1', 5), tw('2', 6, '', [])], true);
  assert.equal(blocks.length, 4); // post1 text, post1 image, post2 text (no image), trailer
  assert.equal(blocks[0].type, 'text');
  assert.match((blocks[0] as { text: string }).text, /id: 1\nauthor: @u \(U\)\nlikes: 5\ntext: text 1/);
  assert.equal(blocks[1].type, 'image');
  assert.match((blocks[2] as { text: string }).text, /\(no text, image only\)/);
  assert.equal(buildBatchContent([tw('1', 5)], false).some((b) => b.type === 'image'), false);
});

test('parseVerdicts keeps asked ids, clamps score, derives relevant', () => {
  const raw = { verdicts: [
    { id: '1', relevant: false, category: 'Everyday UX', score: 9, reason: ' great ' },
    { id: '2', relevant: true, category: 'Off-topic', score: 1, reason: 'no' },
    { id: '3', relevant: true, category: 'Off-topic', score: 5, reason: 'not asked' },
    'garbage',
  ] };
  const v = parseVerdicts(raw, ['1', '2']);
  assert.deepEqual(v, [
    { id: '1', relevant: true, category: 'Everyday UX', score: 5, reason: 'great' },
    { id: '2', relevant: false, category: 'Off-topic', score: 1, reason: 'no' },
  ]);
  assert.deepEqual(parseVerdicts(null, ['1']), []);
  assert.deepEqual(parseVerdicts({ verdicts: 'nope' }, ['1']), []);
});

test('applyVerdicts keeps score >= minScore, attaches verdict, ranks by likes', () => {
  const tweets = [tw('a', 10), tw('b', 50), tw('c', 30), tw('d', 99)];
  const verdicts = parseVerdicts({ verdicts: [
    { id: 'a', relevant: true, category: 'Everyday UX', score: 4, reason: 'r-a' },
    { id: 'b', relevant: true, category: 'AI at work', score: 3, reason: 'r-b' },
    { id: 'c', relevant: false, category: 'Off-topic', score: 2, reason: 'r-c' },
  ] }, ['a', 'b', 'c', 'd']);
  const kept = applyVerdicts(tweets, verdicts, 3);
  assert.deepEqual(kept.map((t) => t.id), ['b', 'a']); // d had no verdict, c scored 2
  assert.equal(kept[0].verdict?.reason, 'r-b');
});

test('classifyTweets batches, retries a failed batch without images', async () => {
  const tweets = Array.from({ length: 12 }, (_, i) => tw(String(i + 1), i));
  const calls: { n: number; images: number }[] = [];
  let failedOnce = false;
  const fake = async (_system: string, content: { type: string }[]) => {
    const images = content.filter((b) => b.type === 'image').length;
    const ids = content.filter((b) => b.type === 'text').map((b) => (b as unknown as { text: string }).text.match(/id: (\d+)/)?.[1]).filter(Boolean) as string[];
    calls.push({ n: ids.length, images });
    if (images > 0 && !failedOnce) { failedOnce = true; throw new Error('image fetch failed'); }
    return { verdicts: ids.map((id) => ({ id, relevant: true, category: 'Work culture', score: 3, reason: 'ok' })) };
  };
  const verdicts = await classifyTweets(tweets, 'rubric', fake, 5);
  assert.equal(verdicts.length, 12);
  assert.deepEqual(calls.map((c) => c.n), [5, 5, 5, 2]); // batch 1 with images (fails), batch 1 text-only, batch 2, batch 3
  assert.deepEqual(calls.map((c) => c.images), [5, 0, 5, 2]);
});
