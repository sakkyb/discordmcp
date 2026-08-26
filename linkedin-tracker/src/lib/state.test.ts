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
