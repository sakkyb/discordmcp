// One-time interactive setup: opens a real Chrome window so you can log into X
// by hand (including any 2FA). The session persists in chrome-profile/ and is
// reused by every scheduled run.
import { openBrowser } from './lib/x-search.js';

console.log('Opening Chrome — log into X in the window that appears (up to 5 minutes).');
const browser = await openBrowser();
const page = browser.pages()[0] ?? (await browser.newPage());
await page.goto('https://x.com/login', { waitUntil: 'domcontentloaded' });

try {
  await page.waitForURL((u) => /x\.com\/(home|explore)/.test(u.toString()), { timeout: 300_000 });
  console.log('✅ Logged in. Session saved to chrome-profile/ — scheduled runs will reuse it.');
} catch {
  console.error('❌ Did not reach the X home feed within 5 minutes. Run this again.');
  process.exitCode = 1;
} finally {
  await browser.close();
}
