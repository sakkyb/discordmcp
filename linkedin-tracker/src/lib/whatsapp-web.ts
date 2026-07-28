import { chromium, BrowserContext, Page } from 'playwright';
import { WHATSAPP_WEB_PROFILE_DIR, config } from './config.js';

const WA_URL = 'https://web.whatsapp.com/';

// WhatsApp Web driven as a real, logged-in browser via Playwright — plain UI
// automation (find group → type → send), NOT the whatsapp-web.js "Store"
// injection that breaks on WhatsApp Web bundle updates. Uses its own persistent
// Chrome profile; log in once with `npm run login:whatsapp-web` (QR scan).
//
// NOTE: these selectors are WhatsApp Web's current markup and WILL drift. Each
// step fails loudly (naming what it looked for) rather than silently no-op'ing,
// so breakage is obvious in the logs and quick to re-point.

export async function openWhatsAppWeb(): Promise<BrowserContext> {
  return chromium.launchPersistentContext(WHATSAPP_WEB_PROFILE_DIR, {
    channel: 'chrome',
    headless: config.headless,
    viewport: { width: 1280, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  });
}

// Resolve once WhatsApp Web is loaded. Returns 'in' if logged in (chat list
// present), 'out' if it's showing the QR / link-device screen.
export async function whatsappState(page: Page, timeoutMs = 60_000): Promise<'in' | 'out'> {
  const chatList = page.locator('div[aria-label="Chat list"], #pane-side');
  const qr = page.locator('canvas[aria-label*="Scan"], [data-ref], div[aria-label*="Log into WhatsApp Web"]');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await chatList.first().isVisible().catch(() => false)) return 'in';
    if (await qr.first().isVisible().catch(() => false)) return 'out';
    await page.waitForTimeout(1000);
  }
  throw new Error('WhatsApp Web did not reach a known state (chat list or QR) within timeout.');
}

export async function sendWhatsAppMessage(group: string, message: string): Promise<void> {
  const ctx = await openWhatsAppWeb();
  try {
    const page = ctx.pages()[0] ?? await ctx.newPage();
    await page.goto(WA_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });

    if ((await whatsappState(page)) === 'out') {
      throw new Error(
        "WhatsApp Web is not logged in. Run 'npm run login:whatsapp-web' on the Mac Mini and scan the QR."
      );
    }

    // Search for the group by name (the search box is an <input>).
    const search = page.locator('input[aria-label="Search or start a new chat"], [data-tab="3"][role="textbox"]').first();
    await search.click({ timeout: 15_000 });
    await search.fill(group);
    await page.waitForTimeout(1500);

    // Open the matching chat (exact title match to avoid opening the wrong one).
    const chat = page.locator(`span[title="${group}"]`).first();
    await chat.click({ timeout: 15_000 }).catch(() => {
      throw new Error(`WhatsApp group "${group}" not found in search results (check the exact name).`);
    });
    await page.waitForTimeout(1000);

    // Type into the message composer and send with Enter.
    const box = page.locator('div[role="textbox"][data-tab="10"], div[aria-placeholder="Type a message"]').first();
    await box.click({ timeout: 15_000 });
    await page.keyboard.type(message, { delay: 10 });
    await page.keyboard.press('Enter');

    // Verify the send didn't error. Detecting a positive "delivered" tick by
    // scraping proved unreliable (both false positives and false negatives), but
    // the FAILURE signal is reliable and distinctive: a degraded session marks
    // the message with the aria-label "Something went wrong…". So we watch the
    // last outgoing message for that error for a few seconds; its absence is our
    // success signal (the error, when it happens, surfaces within seconds).
    const result = await confirmSent(page, 15_000);
    if (!result.sent) {
      throw new Error(
        `WhatsApp reported a send error (${result.reason}). ` +
        `The WhatsApp Web session likely needs re-linking: npm run login:whatsapp-web.`
      );
    }
  } finally {
    await ctx.close();
  }
}

// Watch the last outgoing message for WhatsApp's "Something went wrong" send
// error. Returns sent:false only if that error appears; otherwise sent:true
// (a healthy send never shows it, and reliably detecting the delivered tick
// by scraping is not dependable).
async function confirmSent(page: Page, windowMs: number): Promise<{ sent: boolean; reason?: string }> {
  const deadline = Date.now() + windowMs;
  while (Date.now() < deadline) {
    const errored = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('div[role="row"]'));
      // Last outgoing row (WhatsApp tags outgoing rows with a "You:" aria-label).
      const mine = rows.reverse().find(r =>
        Array.from(r.querySelectorAll('[aria-label]')).some(e => /^you:?$/i.test((e.getAttribute('aria-label') || '').trim())));
      if (!mine) return false;
      return Array.from(mine.querySelectorAll('[aria-label]')).some(e => /something went wrong/i.test(e.getAttribute('aria-label') || ''));
    });
    if (errored) return { sent: false, reason: 'WhatsApp showed "Something went wrong" on the message' };
    await page.waitForTimeout(1500);
  }
  return { sent: true };
}
