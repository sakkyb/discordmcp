// One-time WhatsApp Web login for the Playwright sender. Opens web.whatsapp.com
// in a headed Chrome window using a dedicated persistent profile; scan the QR
// with your phone (WhatsApp → Linked Devices → Link a Device). The session then
// persists in whatsapp-web-profile/ and is reused by scheduled sends.
import { openWhatsAppWeb } from './lib/whatsapp-web.js';

const ctx = await openWhatsAppWeb();
const page = ctx.pages()[0] ?? await ctx.newPage();
await page.goto('https://web.whatsapp.com/', { waitUntil: 'domcontentloaded', timeout: 60_000 });

console.log('Opened WhatsApp Web. Scan the QR code with your phone now.');
console.log('Waiting for login (up to 3 minutes)... the QR showing is expected until you scan.');

// Wait specifically for the logged-in chat list to appear — the QR being
// visible beforehand is normal, not a failure.
const chatList = page.locator('div[aria-label="Chat list"], #pane-side');
try {
  await chatList.first().waitFor({ state: 'visible', timeout: 180_000 });
  console.log('✅ Logged in. Session saved to whatsapp-web-profile/. You can close this.');
  await ctx.close();
  process.exit(0);
} catch {
  console.error('❌ Not logged in within 3 minutes (QR not scanned). Re-run to try again.');
  await ctx.close();
  process.exit(1);
}
