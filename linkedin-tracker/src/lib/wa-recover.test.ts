import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseProbe } from './wa-probe.js';
import { causeOf, planFor, renderReport } from './wa-recover.js';

const OK = 'waFrontmost=true|frontmostApp=WhatsApp|focusedRole=AXTextArea|windowCount=1|bounds=0,0,500,835';
const NOT_FRONT = 'waFrontmost=false|frontmostApp=Google Chrome|focusedRole=AXGroup|windowCount=1|bounds=0,0,500,835';
const WRONG_FOCUS = 'waFrontmost=true|frontmostApp=WhatsApp|focusedRole=AXGroup|windowCount=1|bounds=0,0,500,835';
const NO_WINDOW = 'waFrontmost=false|frontmostApp=Finder|focusedRole=none|windowCount=0|bounds=';

function cause(raw: string, opts: { displays?: number | null; screen?: string; error?: string } = {}) {
  return causeOf(parseProbe(raw), opts.displays ?? 1, opts.screen ?? '', opts.error ?? 'send failed');
}

// --- causeOf: which of the known failures is this? ------------------------

test('a refused send names the wrong chat, whatever the probe says', () => {
  // This must win over every other signal: the state can look perfect and the
  // destination still be wrong, which is the one failure we must never retry.
  assert.equal(cause(OK, { error: 'WhatsApp app send ABORTED: the open chat does not look like "X"' }), 'wrong-chat');
});

test('a screen reading beats the accessibility tree', () => {
  assert.equal(cause(OK, { screen: 'Update WhatsApp | A new version is required' }), 'update-prompt');
  assert.equal(cause(OK, { screen: 'Enter Password | Touch ID' }), 'locked');
  assert.equal(cause(OK, { screen: '"node" wants access to control "System Events"' }), 'permission-dialog');
});

test('a missing binary is named as broken tooling, not as bad app state', () => {
  // The week of failures this loop was written for: every probe field was
  // healthy and the only fault was screencapture missing from launchd's PATH.
  // Lumping that in with "state looks fine" hid it for three mornings.
  const enoent = "FileNotFoundError: [Errno 2] No such file or directory: 'screencapture'";
  assert.equal(cause(OK, { error: enoent }), 'tooling-broken');
  assert.equal(cause(OK, { error: 'spawn screencapture ENOENT' }), 'tooling-broken');
});

test('zero displays outranks any app state', () => {
  assert.equal(cause(NOT_FRONT, { displays: 0 }), 'no-display');
});

test('no window at all means the app is not running', () => {
  assert.equal(cause(NO_WINDOW), 'not-running');
});

test('another app holding frontmost is its own cause', () => {
  assert.equal(cause(NOT_FRONT), 'not-frontmost');
});

test('frontmost but focused on the wrong element is its own cause', () => {
  assert.equal(cause(WRONG_FOCUS), 'wrong-focus');
});

test('a healthy probe with no other signal reports state-ok', () => {
  assert.equal(cause(OK), 'state-ok');
});

// --- planFor: fix it, or stop and escalate? -------------------------------

test('the three recoverable causes each have a remedy', () => {
  assert.deepEqual(planFor('not-running').action, 'launch-app');
  assert.deepEqual(planFor('not-frontmost').action, 'activate');
  assert.deepEqual(planFor('wrong-focus').action, 'escape-then-focus');
  for (const c of ['not-running', 'not-frontmost', 'wrong-focus'] as const) {
    assert.equal(planFor(c).retry, true, `${c} should be retried`);
  }
});

test('causes no script may fix stop the loop instead of burning retries', () => {
  // wrong-chat is here on SAFETY grounds, not practicality: silently steering
  // the app to another chat is exactly the accident the OCR check prevents.
  for (const c of ['locked', 'update-prompt', 'permission-dialog', 'offline', 'no-display', 'wrong-chat'] as const) {
    assert.equal(planFor(c).retry, false, `${c} must not be retried`);
    assert.equal(planFor(c).action, null, `${c} must have no remedy`);
  }
});

test('broken tooling and an unexplained failure both escalate', () => {
  for (const c of ['tooling-broken', 'state-ok'] as const) {
    assert.equal(planFor(c).retry, false);
    assert.equal(planFor(c).escalate, true, `${c} should reach Claude`);
  }
});

test('a cause a human must clear does not waste a Claude call', () => {
  // Nothing Claude can say changes a locked Mac or an open permission dialog.
  for (const c of ['locked', 'permission-dialog', 'no-display', 'wrong-chat'] as const) {
    assert.equal(planFor(c).escalate, false, `${c} needs a human, not a diagnosis`);
  }
});

// --- renderReport: what lands in #errors-sakky ----------------------------

test('the report leads with the cause, never with contradicting prose', () => {
  // The probe summary is written by describeProbe, which cannot see a refused
  // send: for a wrong-chat abort it reports "State looks correct". Leading with
  // that flatly contradicts the verdict, so the cause has to come first and the
  // probe reading has to sit underneath it as supporting evidence.
  const msg = renderReport({
    cause: 'wrong-chat',
    why: 'State looks correct (frontmost, composer focused) — the failure is elsewhere in the send.',
    attempted: [],
    recovered: false,
  });
  const headline = msg.split('\n').slice(0, 2).join('\n');
  assert.match(headline, /chat/i);
  assert.doesNotMatch(headline, /state looks correct/i);
});

test('the report lists what was tried', () => {
  const msg = renderReport({
    cause: 'not-frontmost',
    why: 'CAUSE: WhatsApp did not come frontmost — "Google Chrome" held it instead.',
    attempted: [
      { action: 'activate', ok: false },
      { action: 'escape-then-focus', ok: false },
    ],
    recovered: false,
    claudeSays: 'Chrome is running a foreground automation on the tracker profile.',
  });
  assert.match(msg, /CAUSE: WhatsApp did not come frontmost/);
  assert.match(msg, /activate ✗/);
  assert.match(msg, /escape-then-focus ✗/);
  assert.match(msg, /Chrome is running a foreground automation/);
});

test('a recovered send says so and does not read as a failure', () => {
  const msg = renderReport({
    cause: 'not-frontmost',
    why: 'CAUSE: ...',
    attempted: [{ action: 'activate', ok: true }],
    recovered: true,
  });
  assert.match(msg, /recovered/i);
  assert.match(msg, /activate ✓/);
  assert.doesNotMatch(msg, /still failing/i);
});

test('the report says plainly when escalation was unavailable', () => {
  // claude runs from ~/.local/bin, which is NOT on launchd's PATH, and its
  // OAuth token lives in the Keychain. Silence must not read as "no opinion".
  const msg = renderReport({
    cause: 'state-ok',
    why: 'CAUSE: ...',
    attempted: [],
    recovered: false,
    claudeError: 'Not logged in',
  });
  assert.match(msg, /escalation unavailable/i);
  assert.match(msg, /Not logged in/);
});

test('the report fits inside a Discord message', () => {
  const msg = renderReport({
    cause: 'state-ok',
    why: 'CAUSE: ' + 'x'.repeat(3000),
    attempted: [{ action: 'activate', ok: false }],
    recovered: false,
    claudeSays: 'y'.repeat(3000),
  });
  assert.ok(msg.length <= 1500, `report was ${msg.length} chars`);
});
