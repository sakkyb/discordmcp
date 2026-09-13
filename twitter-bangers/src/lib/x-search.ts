import { chromium } from 'playwright';
import type { BrowserContext, Page } from 'playwright';
import { CHROME_PROFILE_DIR, config } from './config.js';
import { parseSearchResponse, type Tweet } from './tweets.js';

// Real system Chrome with a persistent profile: the login done once by hand in
// `npm run login:x` is what every scheduled run reuses.
export async function openBrowser(): Promise<BrowserContext> {
  return chromium.launchPersistentContext(CHROME_PROFILE_DIR, {
    channel: 'chrome',
    headless: config.headless,
    viewport: { width: 1280, height: 900 },
    chromiumSandbox: true,
    args: ['--disable-blink-features=AutomationControlled'],
  });
}

export const LOGGED_OUT_HINT = "Run 'npm run login:x' in twitter-bangers/ to log in again.";

export function assertLoggedIn(page: Page): void {
  const url = page.url();
  if (/x\.com\/(i\/flow\/login|login|account\/access)/.test(url)) {
    throw new Error(`X session is not logged in (landed on ${url}). ${LOGGED_OUT_HINT}`);
  }
}

const SEARCH_API = /\/i\/api\/graphql\/[^/]+\/SearchTimeline/;

export interface Collected {
  tweets: Tweet[];
  responses: number; // SearchTimeline responses seen, for "page loaded but nothing parsed" detection
}

// Open the search page and scroll, harvesting tweets from the SearchTimeline
// JSON the page itself requests rather than scraping the DOM: exact like
// counts and reliable media types. Stops at maxPosts raw tweets, after three
// scrolls that add nothing, or at the time limit.
export async function collectTweets(
  page: Page,
  url: string,
  opts: { maxPosts: number; timeoutMs: number },
): Promise<Collected> {
  const found = new Map<string, Tweet>();
  let responses = 0;
  let pending: Promise<void> = Promise.resolve();

  page.on('response', (res) => {
    if (!SEARCH_API.test(res.url())) return;
    responses += 1;
    pending = pending.then(async () => {
      try {
        const body = await res.json();
        for (const t of parseSearchResponse(body)) if (!found.has(t.id)) found.set(t.id, t);
      } catch (err) {
        console.warn(`Could not parse a SearchTimeline response: ${(err as Error).message}`);
      }
    });
  });

  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);
  assertLoggedIn(page);

  // X only requests the next page when the viewport nears the end of the
  // timeline, so jump to the bottom each time rather than nudging by a screen.
  // A page of 20 image tweets is far taller than a few wheel ticks.
  const deadline = Date.now() + opts.timeoutMs;
  let idleScrolls = 0;
  while (found.size < opts.maxPosts && idleScrolls < 4 && Date.now() < deadline) {
    const before = found.size;
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    // Uneven pauses read as a person scrolling, not a loop.
    await page.waitForTimeout(2000 + Math.random() * 1500);
    await pending;
    idleScrolls = found.size > before ? 0 : idleScrolls + 1;
  }
  await pending;
  return { tweets: [...found.values()], responses };
}
