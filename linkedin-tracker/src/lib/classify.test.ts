import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt, decide, chooseRow, type Candidate } from './classify.js';

const CANDIDATES: Candidate[] = [
  { id: 'p1', name: 'Munich ramp repost', date: '2026-08-07' },
  { id: 'p2', name: 'Receipt good UX', date: '2026-08-08' },
  { id: 'p3', name: 'New book announcement', date: null },
];

test('buildPrompt numbers candidates from 1 and marks undated ones', () => {
  const prompt = buildPrompt('a post about a ramp', CANDIDATES);
  assert.match(prompt, /1\. Munich ramp repost \(planned for 2026-08-07\)/);
  assert.match(prompt, /3\. New book announcement \(no date set\)/);
});

test('buildPrompt truncates a long post body', () => {
  const prompt = buildPrompt('x'.repeat(1000), CANDIDATES);
  assert.ok(!prompt.includes('x'.repeat(601)));
});

test('decide returns the candidate for a high-confidence match', () => {
  assert.equal(decide({ match: 1, confidence: 'high', reason: '' }, CANDIDATES), CANDIDATES[0]);
});

test('decide rejects a low-confidence match', () => {
  assert.equal(decide({ match: 1, confidence: 'low', reason: '' }, CANDIDATES), null);
});

test('decide rejects the no-match sentinel', () => {
  assert.equal(decide({ match: 0, confidence: 'high', reason: '' }, CANDIDATES), null);
});

test('decide rejects an out-of-range index', () => {
  assert.equal(decide({ match: 9, confidence: 'high', reason: '' }, CANDIDATES), null);
});

test('chooseRow reports none, without calling out, when there are no candidates', async () => {
  const decision = await chooseRow('text', [], async () => {
    throw new Error('classifier should not be called');
  });
  assert.equal(decision.kind, 'none');
});

test('chooseRow reports unavailable when the classifier call fails', async () => {
  const decision = await chooseRow('text', CANDIDATES, async () => null);
  assert.equal(decision.kind, 'unavailable');
});

test('chooseRow returns the matched candidate', async () => {
  const decision = await chooseRow('text', CANDIDATES, async () => ({
    match: 2,
    confidence: 'high' as const,
    reason: 'the post is about a receipt',
  }));
  assert.equal(decision.kind, 'match');
  if (decision.kind === 'match') assert.equal(decision.candidate.id, 'p2');
});

test('chooseRow reports none, carrying the reason, when nothing matches', async () => {
  const decision = await chooseRow('text', CANDIDATES, async () => ({
    match: 0,
    confidence: 'high' as const,
    reason: 'no plan describes this post',
  }));
  assert.equal(decision.kind, 'none');
  if (decision.kind === 'none') assert.equal(decision.reason, 'no plan describes this post');
});
