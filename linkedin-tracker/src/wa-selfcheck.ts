// Preflight for the WhatsApp send: run every precondition WITHOUT sending, and
// say so in #errors-sakky when the answer changes.
//
// Why this exists: on 24 August `screencapture` fell off launchd's PATH, and
// nothing noticed until a real post needed it — then it failed at 08:00 on
// three consecutive mornings and was found by a human reading the channel. Each
// of those failures was detectable at 07:45 with no post involved. Nothing here
// types into WhatsApp; the worst it does is bring the app forward and press
// Escape.
//
//   npm run wa:selfcheck
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { PACKAGE_ROOT, config } from './lib/config.js';
import { parseProbe } from './lib/wa-probe.js';
import { askClaude } from './lib/wa-loop.js';
import { sendDiscordAlert } from './lib/discord.js';
import { loadState, saveState, selfCheckAnnouncement } from './lib/state.js';

const execFileAsync = promisify(execFile);
const SEND_SCRIPT = path.join(PACKAGE_ROOT, 'scripts', 'wa-send.applescript');
const OCR_SCRIPT = path.join(PACKAGE_ROOT, 'scripts', 'ocr-chat-header.py');
const DISPLAY_SCRIPT = path.join(PACKAGE_ROOT, 'scripts', 'display-count.py');
const SCREENCAPTURE = '/usr/sbin/screencapture';

interface Check { name: string; ok: boolean; detail: string }

const results: Check[] = [];
function record(name: string, ok: boolean, detail: string): boolean {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : ` — ${detail}`}`);
  return ok;
}

function why(error: unknown): string {
  const e = error as { stderr?: string; stdout?: string; message?: string };
  const raw = (e.stderr ?? '').trim() || (e.stdout ?? '').trim() || e.message || String(error);
  // Tail, not head: a Python traceback carries its exception on the last line.
  const flat = raw.replace(/\s+/g, ' ');
  return flat.length <= 200 ? flat : `…${flat.slice(-200)}`;
}

console.log(`[${new Date().toISOString()}] WhatsApp preflight`);

// 1. The interpreter the OCR checks run under, and how many displays it sees.
// Everything downstream is meaningless with no display: macOS cannot make any
// app frontmost without one.
let displays: number | null = null;
try {
  const { stdout } = await execFileAsync(config.pythonBin, [DISPLAY_SCRIPT], { timeout: 15_000 });
  displays = Number(/displays=(\d+)/.exec(stdout)?.[1] ?? NaN);
  record('python', true, config.pythonBin);
} catch (error) {
  record('python', false, `${config.pythonBin}: ${why(error)}`);
}
record('display', displays !== null && displays > 0, `displays=${displays ?? 'unreadable'}`);

// 2. The binary whose absence caused the outage this job was written for.
try {
  const shot = path.join(os.tmpdir(), `wa-selfcheck-${process.pid}.jpg`);
  await execFileAsync(SCREENCAPTURE, ['-x', '-t', 'jpg', shot], { timeout: 20_000 });
  const bytes = fs.statSync(shot).size;
  fs.unlinkSync(shot);
  record('screen-capture', bytes > 0, `${SCREENCAPTURE} wrote ${bytes} bytes`);
} catch (error) {
  record('screen-capture', false, `${SCREENCAPTURE}: ${why(error)}`);
}

// 3. WhatsApp itself: running with a window, and able to take composer focus.
let bounds = '';
try {
  const { stdout } = await execFileAsync('osascript', [SEND_SCRIPT, 'probe'], { timeout: 30_000 });
  const probe = parseProbe(stdout.trim());
  bounds = probe.bounds;
  record('whatsapp-running', probe.windowCount > 0, `windows=${probe.windowCount}, frontmost=${probe.frontmostApp}`);
} catch (error) {
  record('whatsapp-running', false, why(error));
}

// `recover escape-then-focus` asserts exactly what the send needs — frontmost,
// on a chat, composer focused — and cannot type anything.
try {
  const { stdout } = await execFileAsync('osascript', [SEND_SCRIPT, 'recover', 'escape-then-focus'], { timeout: 45_000 });
  record('composer', stdout.trim() === 'ok', stdout.trim() || '(no output)');
} catch (error) {
  record('composer', false, why(error));
}

// 4. The safety check: does the open chat still read as the expected group?
// A drifted chat is the one fault that must never be auto-corrected, so finding
// it here — before a post exists — is the only cheap moment to fix it.
const group = config.whatsappWebGroup;
if (!group) {
  record('chat', true, 'WhatsApp notifications are disabled');
} else if (!bounds) {
  record('chat', false, 'no window bounds to read the header from');
} else {
  const [x, y, w, h] = bounds.split(',');
  try {
    const { stdout } = await execFileAsync(config.pythonBin, [OCR_SCRIPT, x, y, w, h, group], { timeout: 30_000 });
    record('chat', true, stdout.trim().slice(0, 120));
  } catch (error) {
    const e = error as { code?: number; stdout?: string };
    const detail = e.code === 2
      ? `the open chat does not read as "${group}": ${(e.stdout ?? '').trim().slice(0, 120)}`
      : why(error);
    record('chat', false, detail);
  }
}

// 5. Whether escalation is reachable at all. `claude` lives in ~/.local/bin,
// which is not on launchd's PATH, and its OAuth token is in the Keychain — so
// this can be broken while everything else is fine. Reported as a check rather
// than assumed, because silence from a diagnostician must not read as "nothing
// to say".
const probe = await askClaude('preflight reachability probe', 'none — this is a connectivity check');
record('claude-escalation', Boolean(probe.says), probe.error ?? 'reachable');

// ---------------------------------------------------------------------------
// Announce only what changed.
// ---------------------------------------------------------------------------
const failing = results.filter((r) => !r.ok).map((r) => r.name);
const state = loadState();
const announcement = selfCheckAnnouncement(state.failingChecks, failing);

state.failingChecks = failing;
saveState(state);

if (!announcement) {
  console.log(failing.length ? `No change — still failing: ${failing.join(', ')}` : 'All checks pass.');
  process.exit(0);
}

if (announcement === 'recovered') {
  await sendDiscordAlert('WhatsApp preflight is GREEN again — every check passes.');
  console.log('Announced recovery.');
  process.exit(0);
}

const detail = results.filter((r) => !r.ok).map((r) => `• ${r.name}: ${r.detail}`).join('\n');
// A failing escalation check means asking Claude about it is pointless.
const claudeUsable = results.find((r) => r.name === 'claude-escalation')?.ok;
const diagnosis = claudeUsable
  ? (await askClaude(`WhatsApp preflight failures:\n${detail}`, 'preflight failed before any post was due')).says
  : undefined;

await sendDiscordAlert(
  [
    `WhatsApp preflight FAILED — ${failing.join(', ')}`,
    detail,
    diagnosis ? `\nClaude says: ${diagnosis.slice(0, 500)}` : '',
  ].filter(Boolean).join('\n'),
);
console.log('Announced failure.');
process.exit(1);
