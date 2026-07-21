// Weekly analytics sync. launchd fires this at 01:00 on Sundays; the job then
// waits a random slice (up to ~4h) so the real start drifts across the 1–6am
// window each week, and paces the per-post analytics reads 60–180s apart —
// both to keep the automation from looking machine-timed. For each of the most
// recent posts it reads the full analytics page and writes every metric to the
// post's Notion row (matching by activity id), creating a row if none exists.
import { openBrowser, getRecentPosts, getPostAnalytics } from './lib/linkedin.js';
import { addPostWithAnalytics, findExistingPage, updateAnalytics } from './lib/notion.js';
import { validateConfig } from './lib/config.js';

validateConfig();

const POST_LIMIT = 15;
const MAX_START_DELAY_MS = 4 * 60 * 60 * 1000; // random 0–4h after the 01:00 launch → ~1–5am start
const MIN_GAP_MS = 60_000;   // 60s
const MAX_GAP_MS = 180_000;  // 180s
const rand = (max: number) => Math.floor(Math.random() * max);

// Random start within the window (SKIP_START_JITTER=true runs immediately — for manual runs).
if (process.env.SKIP_START_JITTER !== 'true') {
  const delay = rand(MAX_START_DELAY_MS);
  console.log(`[${new Date().toISOString()}] Sleeping ${(delay / 60000).toFixed(0)} min for a random 1–6am start...`);
  await new Promise(resolve => setTimeout(resolve, delay));
}

console.log(`[${new Date().toISOString()}] Weekly analytics sync starting...`);

const browser = await openBrowser();
try {
  const page = browser.pages()[0] ?? await browser.newPage();
  const posts = await getRecentPosts(page, POST_LIMIT);
  console.log(`Syncing analytics for ${posts.length} posts...`);

  let updated = 0, created = 0, failed = 0;
  for (let i = 0; i < posts.length; i++) {
    const post = posts[i];
    if (i > 0) {
      const gap = MIN_GAP_MS + rand(MAX_GAP_MS - MIN_GAP_MS);
      console.log(`  …waiting ${(gap / 1000).toFixed(0)}s before next post`);
      await page.waitForTimeout(gap);
    }
    const activityId = post.urn.split(':').pop() ?? post.urn;
    try {
      const analytics = await getPostAnalytics(page, activityId);
      const existingId = await findExistingPage(post);
      if (existingId) {
        await updateAnalytics(existingId, analytics);
        updated++;
        console.log(`  ✓ updated ${activityId} (impressions ${analytics.impressions}, reactions ${analytics.reactions})`);
      } else {
        await addPostWithAnalytics(post, analytics);
        created++;
        console.log(`  ✓ created ${activityId} (impressions ${analytics.impressions}, reactions ${analytics.reactions})`);
      }
    } catch (error) {
      failed++;
      console.error(`  ✗ ${activityId}:`, error instanceof Error ? error.message : error);
    }
  }
  console.log(`Done: ${updated} updated, ${created} created, ${failed} failed.`);
} finally {
  await browser.close();
}
process.exit(0);
