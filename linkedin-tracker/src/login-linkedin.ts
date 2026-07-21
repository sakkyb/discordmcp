// One-time interactive setup: opens a real Chrome window on the Mac Mini so
// you can log into LinkedIn manually (including any 2FA). The session cookies
// persist in chrome-profile/ and are reused by every scheduled run.
import { openBrowser } from './lib/linkedin.js';

console.log('Opening Chrome — log into LinkedIn in the window that appears.');
console.log('Waiting up to 5 minutes for the feed to load...');

const browser = await openBrowser();
const page = browser.pages()[0] ?? await browser.newPage();
await page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded' });

try {
  await page.waitForURL(/linkedin\.com\/(feed|in)\//, { timeout: 300_000 });
  console.log('✅ Logged in. Session saved to chrome-profile/ — scheduled runs will reuse it.');
} catch {
  console.error('❌ Did not reach the LinkedIn feed within 5 minutes. Run this again.');
  process.exitCode = 1;
} finally {
  await browser.close();
}
