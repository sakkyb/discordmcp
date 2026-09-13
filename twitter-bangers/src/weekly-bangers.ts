// Weekly job (launchd, Saturday 05:00): search X for last week's posts with
// 50k+ likes and images, report the top unseen ones to Discord and save them
// as embeds on a new Notion page.
import { config, validateConfig } from './lib/config.js';
import { buildQuery, searchUrl, selectTweets, sinceDate } from './lib/tweets.js';
import { diffNew, loadState, mergeSeen, saveState } from './lib/state.js';
import { buildReportMessages } from './lib/report.js';
import { postReport, sendAlert } from './lib/discord.js';
import { createWeeklyPage } from './lib/notion.js';
import { collectTweets, openBrowser } from './lib/x-search.js';
import type { Collected } from './lib/x-search.js';

async function main(): Promise<void> {
  validateConfig();
  const runDate = new Date();
  const today = sinceDate(runDate, 0);
  const since = sinceDate(runDate, config.lookbackDays);
  const query = buildQuery(config.minFaves, since);
  console.log(`[${runDate.toISOString()}] Searching: ${query}`);

  const browser = await openBrowser();
  let raw: Collected;
  try {
    const page = browser.pages()[0] ?? (await browser.newPage());
    raw = await collectTweets(page, searchUrl(query), { maxPosts: config.maxPosts, timeoutMs: 180_000 });
  } finally {
    await browser.close();
  }
  console.log(`Captured ${raw.tweets.length} tweets from ${raw.responses} search responses.`);
  if (raw.responses === 0) {
    throw new Error('No SearchTimeline responses were captured — the search page did not load results.');
  }
  if (raw.tweets.length === 0) {
    throw new Error('Search responses arrived but no tweets were parsed — X may have changed its response shape.');
  }

  const fetched = selectTweets(raw.tweets, { minFaves: config.minFaves, maxPosts: config.maxPosts });
  const state = loadState();
  const fresh = diffNew(state, fetched);
  const report = fresh.slice(0, config.reportCount);
  console.log(`${fetched.length} qualify, ${fresh.length} unseen, reporting ${report.length}.`);

  if (config.dryRun) {
    const msgs = buildReportMessages({ runDate, report, checked: fetched.length, notionUrl: '(dry run)' });
    for (const m of msgs) console.log(`\n${m}`);
    console.log('\nDRY_RUN: nothing posted, nothing saved.');
    return;
  }

  let notionUrl: string | null = null;
  let notionError: string | undefined;
  if (report.length > 0) {
    try {
      notionUrl = await createWeeklyPage(runDate, report, query);
      console.log(`Notion page: ${notionUrl}`);
    } catch (err) {
      notionError = (err as Error).message;
      console.error(`Notion save failed: ${notionError}`);
    }
  }

  // Discord first, state second: a run that dies before posting is retried
  // next time without losing tweets; one that posted never repeats them.
  await postReport(buildReportMessages({ runDate, report, checked: fetched.length, notionUrl, notionError }));
  saveState(mergeSeen(state, fetched, today));
  console.log('Posted to Discord and saved state.');
  if (notionError) throw new Error(`Notion save failed: ${notionError}`);
}

main().catch(async (err: Error) => {
  console.error(`❌ ${err.stack ?? err.message}`);
  if (!config.dryRun) {
    try {
      await sendAlert(err.message);
    } catch (e) {
      console.error(`Alert failed too: ${(e as Error).message}`);
    }
  }
  process.exit(1);
});
