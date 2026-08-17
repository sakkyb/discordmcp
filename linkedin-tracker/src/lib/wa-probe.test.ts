import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseProbe, describeProbe, classifyScreen } from './wa-probe.js';

const FULL = 'waFrontmost=false|frontmostApp=Finder|focusedRole=AXGroup|windowCount=1|bounds=0,0,1400,900';
const FOCUSED = 'waFrontmost=true|frontmostApp=WhatsApp|focusedRole=AXGroup|windowCount=1|bounds=0,0,1400,900';

test('parseProbe reads every field', () => {
  const p = parseProbe(FULL);
  assert.equal(p.waFrontmost, false);
  assert.equal(p.frontmostApp, 'Finder');
  assert.equal(p.focusedRole, 'AXGroup');
  assert.equal(p.windowCount, 1);
  assert.equal(p.bounds, '0,0,1400,900');
});

test('parseProbe survives a truncated or empty record', () => {
  const p = parseProbe('');
  assert.equal(p.waFrontmost, false);
  assert.equal(p.frontmostApp, 'unknown');
  assert.equal(p.windowCount, 0);
});

// The whole point of the probe: name the cause, not the symptom.
test('describeProbe blames a missing display when there are none', () => {
  assert.match(describeProbe(parseProbe(FULL), 0), /no active display/i);
});

test('describeProbe blames the app that held frontmost', () => {
  const msg = describeProbe(parseProbe(FULL), 1);
  assert.match(msg, /Finder/);
  assert.doesNotMatch(msg, /no active display/i);
});

test('describeProbe distinguishes frontmost-but-wrong-focus', () => {
  const msg = describeProbe(parseProbe(FOCUSED), 1);
  assert.match(msg, /AXGroup/);
  assert.match(msg, /composer/i);
});

test('describeProbe says so when nothing is wrong', () => {
  const raw = 'waFrontmost=true|frontmostApp=WhatsApp|focusedRole=AXTextArea|windowCount=1|bounds=0,0,1400,900';
  assert.match(describeProbe(parseProbe(raw), 1), /looks correct/i);
});

// Vision reads what the accessibility tree cannot. WhatsApp's AX tree reports
// every text value as "missing value", so an update prompt or a permission
// dialog is indistinguishable from a normal window — AX sees only "AXGroup".
test('classifyScreen recognises a locked Mac', () => {
  assert.match(classifyScreen('Enter Password  Touch ID or Enter Password')!, /locked/i);
});

test('classifyScreen recognises a blocking WhatsApp update', () => {
  assert.match(classifyScreen('Update WhatsApp | A new version is required to continue')!, /update/i);
});

test('classifyScreen recognises a permission dialog', () => {
  assert.match(classifyScreen('"node" wants access to control "System Events"')!, /permission/i);
});

test('classifyScreen returns null for ordinary screen text', () => {
  assert.equal(classifyScreen('LinkedIn Maxxing | Type a message'), null);
});

// The OCR reading must win: it is direct evidence, where the AX role is inference.
test('describeProbe leads with the screen reading when there is one', () => {
  const msg = describeProbe(parseProbe(FOCUSED), 1, 'Update WhatsApp to continue');
  assert.match(msg, /update/i);
});
