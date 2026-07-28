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

    // Verify it ACTUALLY transmitted before tearing down. A WhatsApp Web session
    // that has gone idle between sends shows a cached chat list (so we get this
    // far) but needs time to reconnect and flush; if we close too soon the
    // message stays "pending" and never leaves. Wait for the outgoing status to
    // reach sent/delivered/read; throw if it's still pending so the failure is
    // real and logged rather than a silent false-positive.
    if (!(await waitForSent(page, 60_000))) {
      throw new Error(
        'WhatsApp message did not leave "pending" within 60s — the WhatsApp Web ' +
        'session is likely disconnected. The message was NOT delivered.'
      );
    }
  } finally {
    await ctx.close();
  }
}

// Poll the most recent outgoing message's status until it is sent/delivered/read
// (i.e. it left the "pending"/clock state). Returns false on timeout.
async function waitForSent(page: Page, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const last = await page.evaluate(() => {
      const labels = Array.from(document.querySelectorAll('[aria-label]'))
        .map(e => (e.getAttribute('aria-label') || '').trim())
        .filter(a => /^(Pending|Sent|Delivered|Read)$/i.test(a));
      return labels[labels.length - 1] ?? null;
    });
    if (last && /^(Sent|Delivered|Read)$/i.test(last)) return true;
    await page.waitForTimeout(2000);
  }
  return false;
}
