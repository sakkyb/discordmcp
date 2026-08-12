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
// Requirements: the Mac stays logged in with the WhatsApp app running and
// parked on the target chat. The send steals focus for ~1s.
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { PACKAGE_ROOT } from './config.js';

const execFileAsync = promisify(execFile);
const SCRIPT = path.join(PACKAGE_ROOT, 'scripts', 'wa-send.applescript');

export async function sendViaWhatsAppApp(message: string, timeoutMs = 60_000): Promise<void> {
  try {
    // The message goes through argv, so it needs no AppleScript string escaping
    // — important, since it contains a URL.
    const { stdout } = await execFileAsync('osascript', [SCRIPT, message], { timeout: timeoutMs });
    if (!stdout.includes('sent')) {
      throw new Error(`unexpected result from wa-send.applescript: ${stdout.trim().slice(0, 200)}`);
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    // osascript puts the AppleScript `error` text on stderr, which execFile
    // surfaces here — including the "not parked on a chat" refusal, which is
    // the one a human needs to act on.
    throw new Error(`WhatsApp app send failed: ${detail.replace(/\s+/g, ' ').slice(0, 400)}`);
  }
}
