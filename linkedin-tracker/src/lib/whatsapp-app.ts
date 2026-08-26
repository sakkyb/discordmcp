// Sends via the macOS WhatsApp app (AppleScript/System Events) instead of
// driving WhatsApp Web with Playwright.
//
// Why the switch: WhatsApp Web sends failed every day because a cold-start
// modal intercepted the click on the search box, and a fresh browser per send
// paid that modal on every run. WhatsApp then refused to link the automated
// Chrome profile at all ("Couldn't link device"), so the Web path was a dead
// end. The desktop app is already linked and needs no browser, no profile
// directory and no QR flow.
//
// The send is three steps rather than one, because the destination has to be
// verified between focusing the composer and typing into it:
//
//   1. prepare  — activate, focus the composer, return the window bounds
//   2. verify   — OCR the chat header and confirm it names the expected group
//   3. send     — type and press Return
//
// Step 2 exists because WhatsApp's accessibility tree exposes roles but no
// text, so the script can tell that a composer has focus but not WHICH chat it
// belongs to. That was the one remaining way this could post to the wrong
// group. Vision (on-device OCR) closes it; there is no API-level alternative.
//
// Requirements: the Mac stays logged in with the WhatsApp app running and
// parked on the target chat. The send steals focus for ~2s.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { PACKAGE_ROOT, config } from './config.js';
import { parseProbe, describeProbe, type ProbeRecord } from './wa-probe.js';
import type { DiscordFile } from './discord.js';

const execFileAsync = promisify(execFile);
const SEND_SCRIPT = path.join(PACKAGE_ROOT, 'scripts', 'wa-send.applescript');
const OCR_SCRIPT = path.join(PACKAGE_ROOT, 'scripts', 'ocr-chat-header.py');
const DISPLAY_SCRIPT = path.join(PACKAGE_ROOT, 'scripts', 'display-count.py');
const OCR_SCREEN_SCRIPT = path.join(PACKAGE_ROOT, 'scripts', 'ocr-screen.py');
// Absolute path: /usr/sbin is NOT on the PATH launchd gives this job, so a bare
// 'screencapture' resolves from a shell but raises ENOENT under launchd.
const SCREENCAPTURE = '/usr/sbin/screencapture';

// Set WHATSAPP_SKIP_CHAT_VERIFY=true to send without the OCR check — an escape
// hatch for a machine without the Screen Recording grant, at the cost of the
// only safeguard against posting to the wrong chat.
const SKIP_VERIFY = process.env.WHATSAPP_SKIP_CHAT_VERIFY === 'true';

function reason(error: unknown, timeoutMs: number): string {
  // The cause lives on error.stderr, NOT error.message — the latter is only
  // "Command failed: <the whole command>", which for these scripts is a long
  // path plus the post URL and says nothing. The first production failure
  // reported exactly that and was undiagnosable.
  const e = error as { stderr?: string; code?: number; killed?: boolean };
  // Keep the TAIL, not the head. A Python traceback puts the actual exception
  // type and message on its LAST line, so head-truncation discarded exactly the
  // useful part: a screencapture ENOENT was reported for two runs as
  // "... with Popen(*popenargs, **kwargs) as proc" and nothing more.
  const trim = (s: string, n: number) => (s.length <= n ? s : `…${s.slice(-n)}`);
  return [
    trim((e.stderr ?? '').trim().replace(/\s+/g, ' '), 700) || '(no stderr)',
    e.killed ? `killed after ${timeoutMs / 1000}s timeout` : '',
    e.code != null ? `exit ${e.code}` : '',
  ].filter(Boolean).join(' · ');
}

// Collect everything needed to identify a send failure, at the moment it fails.
// Entirely best-effort: a diagnostic that throws would mask the real error.
//
// Before this existed, every failure produced the same sentence and no state, so
// five production failures in a row identified nothing.
export interface WhatsAppEvidence {
  summary: string;
  files: DiscordFile[];
  // The structured readings behind `summary`. The recovery loop decides from
  // these; `summary` is only the human rendering of the same facts.
  probe: ProbeRecord;
  displays: number | null;
  screenText: string;
}

export async function gatherWhatsAppEvidence(): Promise<WhatsAppEvidence> {
  let displays: number | null = null;
  let geometry = 'unknown';
  try {
    const { stdout } = await execFileAsync(config.pythonBin, [DISPLAY_SCRIPT], { timeout: 15_000 });
    const n = /displays=(\d+)/.exec(stdout);
    if (n) displays = Number(n[1]);
    geometry = /geometry=(\S+)/.exec(stdout)?.[1] ?? 'unknown';
  } catch { /* leave displays null — "unknown" is itself reported */ }

  let probeRaw = '';
  try {
    const { stdout } = await execFileAsync('osascript', [SEND_SCRIPT, 'probe'], { timeout: 30_000 });
    probeRaw = stdout.trim();
  } catch { /* an unreadable probe still leaves the display count useful */ }

  // What the screen actually SAYS. The accessibility tree cannot answer this —
  // every WhatsApp text value reads as "missing value" — so a blocking update
  // sheet, a permission dialog and a normal chat all look identical to AX.
  let screenText = '';
  try {
    const { stdout } = await execFileAsync(config.pythonBin, [OCR_SCREEN_SCRIPT], { timeout: 30_000 });
    screenText = stdout.trim();
  } catch { /* OCR is a bonus; the probe and display count stand on their own */ }

  const probe = parseProbe(probeRaw);
  const summary = [
    describeProbe(probe, displays, screenText),
    `displays=${displays ?? 'unknown'} geometry=${geometry}`,
    `frontmost=${probe.frontmostApp} waFrontmost=${probe.waFrontmost} focusedRole=${probe.focusedRole} windows=${probe.windowCount} bounds=${probe.bounds || 'none'}`,
    `screen: ${screenText ? screenText.slice(0, 400) : '(OCR unavailable — likely no display, or no Screen Recording grant)'}`,
  ].join('\n');

  // A screenshot with zero displays fails, and that failure corroborates the count.
  //
  // JPEG, not PNG: a 2560x1440 PNG of this screen measured 5MB, and a post can
  // fail three times before giving up. The screenshot is a human sanity-check —
  // the machine-readable text is already in `screen:` above via Vision — so
  // compression costs nothing that matters and saves ~15MB per failed post.
  const files: DiscordFile[] = [];
  const shot = path.join(os.tmpdir(), `wa-failure-${Date.now()}.jpg`);
  try {
    await execFileAsync(SCREENCAPTURE, ['-x', '-t', 'jpg', shot], { timeout: 20_000 });
    files.push({ name: 'whatsapp-at-failure.jpg', data: fs.readFileSync(shot) });
  } catch { /* no screenshot; the summary already says why */ }
  finally { try { fs.unlinkSync(shot); } catch { /* nothing to clean up */ } }

  return { summary, files, probe, displays, screenText };
}

export async function sendViaWhatsAppApp(
  message: string,
  group: string,
  timeoutMs = 60_000,
): Promise<void> {
  // 1. Activate and focus the composer; get the window bounds back.
  let bounds: string;
  try {
    const { stdout } = await execFileAsync('osascript', [SEND_SCRIPT, 'prepare'], { timeout: timeoutMs });
    bounds = stdout.trim();
  } catch (error) {
    throw new Error(`WhatsApp app send failed (prepare): ${reason(error, timeoutMs)}`);
  }

  // 2. Confirm we are looking at the right chat before typing anything.
  if (!SKIP_VERIFY) {
    const [x, y, w, h] = bounds.split(',');
    if (!x || !y || !w || !h) {
      throw new Error(`WhatsApp app send failed: could not read window bounds (got "${bounds}")`);
    }
    try {
      await execFileAsync(config.pythonBin, [OCR_SCRIPT, x, y, w, h, group], { timeout: 30_000 });
    } catch (error) {
      const e = error as { stdout?: string; code?: number };
      // exit 2 = OCR read the header and it is NOT the expected chat.
      if (e.code === 2) {
        throw new Error(
          `WhatsApp app send ABORTED: the open chat does not look like "${group}" — refusing to type. ` +
          `Header read as: ${(e.stdout ?? '').trim().replace(/^NOMATCH /, '').slice(0, 200)}`
        );
      }
      throw new Error(`WhatsApp app send failed (chat verify): ${reason(error, 30_000)}`);
    }
  }

  // 3. Type and send.
  try {
    const { stdout } = await execFileAsync('osascript', [SEND_SCRIPT, 'send', message], { timeout: timeoutMs });
    if (!stdout.includes('sent')) {
      throw new Error(`unexpected result from wa-send.applescript: ${stdout.trim().slice(0, 200)}`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('unexpected result')) throw error;
    throw new Error(`WhatsApp app send failed (send): ${reason(error, timeoutMs)}`);
  }
}
