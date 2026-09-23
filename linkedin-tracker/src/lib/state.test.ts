import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  recordWhatsAppFailure, clearWhatsAppPending, duePending,
  MAX_WHATSAPP_ATTEMPTS, type PendingWhatsApp,
} from './state.js';

const P = (urn: string, attempts: number): PendingWhatsApp => ({ urn, url: `https://x/${urn}`, attempts });
const fresh = () => true;

test('a first failure is recorded with one attempt', () => {
  const out = recordWhatsAppFailure([], 'a', 'https://x/a');
  assert.deepEqual(out, [{ urn: 'a', url: 'https://x/a', attempts: 1 }]);
});

test('a repeat failure increments rather than duplicating', () => {
  const out = recordWhatsAppFailure([P('a', 1)], 'a', 'https://x/a');
  assert.equal(out.length, 1);
  assert.equal(out[0].attempts, 2);
});

test('success clears the entry', () => {
  assert.deepEqual(clearWhatsAppPending([P('a', 2), P('b', 1)], 'a'), [P('b', 1)]);
});

test('duePending drops entries at the attempt cap', () => {
  const list = [P('a', MAX_WHATSAPP_ATTEMPTS), P('b', 1)];
  assert.deepEqual(duePending(list, fresh).map((p) => p.urn), ['b']);
});

// A day-old "Today's post is now live" is worse than no message.
test('duePending drops entries that are no longer fresh', () => {
  const list = [P('old', 1), P('new', 1)];
  assert.deepEqual(duePending(list, (u) => u === 'new').map((p) => p.urn), ['new']);
});

// --- self-check announcements --------------------------------------------
// The preflight runs before every post slot. Announcing every run would make
// #errors-sakky unreadable and train everyone to ignore it, so only CHANGES
// are worth a message.
import { selfCheckAnnouncement } from './state.js';

test('a first-time failure is announced', () => {
  assert.equal(selfCheckAnnouncement([], ['screencapture']), 'broke');
});

test('the same failure on the next slot is not announced again', () => {
  assert.equal(selfCheckAnnouncement(['screencapture'], ['screencapture']), null);
});

test('a NEW failure alongside an old one is announced', () => {
  // Otherwise a second, unrelated break hides behind the first.
  assert.equal(selfCheckAnnouncement(['screencapture'], ['screencapture', 'display']), 'broke');
});

test('recovery is announced, so nobody chases a fault that already cleared', () => {
  assert.equal(selfCheckAnnouncement(['screencapture'], []), 'recovered');
});

test('a run that was healthy and stays healthy says nothing', () => {
  assert.equal(selfCheckAnnouncement([], []), null);
});

test('a fault clearing while another persists is not called recovery', () => {
  assert.equal(selfCheckAnnouncement(['screencapture', 'display'], ['display']), null);
});

// --- 15-minute polling: day cap, pause and state normalisation -------------
import { postsOnDay, isPaused, endOfLocalDay, normalizeState } from './state.js';

const createdAt = (urn: string) => new Date(Number(urn.replace('t:', '')));

test('postsOnDay counts only posts created on that local calendar day', () => {
  const day = new Date(2026, 8, 23, 10, 15);
  const urns = [
    `t:${new Date(2026, 8, 23, 0, 0, 1).getTime()}`,   // just after midnight today
    `t:${new Date(2026, 8, 23, 17, 0).getTime()}`,     // this evening
    `t:${new Date(2026, 8, 22, 23, 59).getTime()}`,    // last night
    `t:${new Date(2026, 8, 24, 0, 0).getTime()}`,      // tomorrow
  ];
  assert.equal(postsOnDay(urns, day, createdAt), 2);
});

test('postsOnDay is zero for an empty known list', () => {
  assert.equal(postsOnDay([], new Date(), createdAt), 0);
});

test('isPaused is false when no pause has been recorded', () => {
  assert.equal(isPaused(null, new Date()), false);
});

test('isPaused is true while the pause is still in the future', () => {
  const now = new Date(2026, 8, 23, 11, 0);
  assert.equal(isPaused(new Date(2026, 8, 23, 23, 59, 59).toISOString(), now), true);
});

test('isPaused is false once the pause has expired', () => {
  const now = new Date(2026, 8, 24, 8, 47);
  assert.equal(isPaused(new Date(2026, 8, 23, 23, 59, 59).toISOString(), now), false);
});

test('endOfLocalDay is the last millisecond of the same local day', () => {
  const end = endOfLocalDay(new Date(2026, 8, 23, 11, 2));
  assert.deepEqual(
    [end.getFullYear(), end.getMonth(), end.getDate(), end.getHours(), end.getMinutes(), end.getSeconds(), end.getMilliseconds()],
    [2026, 8, 23, 23, 59, 59, 999],
  );
});

test('normalizeState tolerates a state file written before the pause fields existed', () => {
  const s = normalizeState({ knownUrns: ['a'], pendingWhatsApp: [], failingChecks: [] });
  assert.equal(s.pausedUntil, null);
  assert.equal(s.consecutiveScrapeFailures, 0);
  assert.deepEqual(s.knownUrns, ['a']);
});

test('normalizeState keeps recorded pause fields', () => {
  const s = normalizeState({ knownUrns: [], pausedUntil: '2026-09-23T22:59:59.999Z', consecutiveScrapeFailures: 1 });
  assert.equal(s.pausedUntil, '2026-09-23T22:59:59.999Z');
  assert.equal(s.consecutiveScrapeFailures, 1);
});
