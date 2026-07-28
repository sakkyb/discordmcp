// Scheduled job: detect a new post on the profile and fan out notifications.
// Runs at the times defined in scripts/com.sakky.linkedin-tracker.plist.template.
// Re-runs are naturally idempotent: a post already in state.json is ignored,
// so the 30/60-minute retry slots simply no-op once the post has been caught.
import { openBrowser, getRecentPosts } from './lib/linkedin.js';
import { loadState, saveState } from './lib/state.js';
import { addPost, findExistingPage, updateEngagement, findDatedRowsNeedingUrl, stampPostUrl, postDateStr } from './lib/notion.js';
import { notifyNewPost, plainUrl } from './lib/discord.js';
import { sendWhatsAppMessage } from './lib/whatsapp-web.js';
import { config, validateConfig } from './lib/config.js';

validateConfig();

const state = loadState();
const firstRun = state.knownUrns.length === 0;

console.log(`[${new Date().toISOString()}] Checking for new LinkedIn posts...`);

const browser = await openBrowser();
let posts;
try {
  const page = browser.pages()[0] ?? await browser.newPage();
  posts = await getRecentPosts(page, 10);
} finally {
  await browser.close();
}

console.log(`Found ${posts.length} recent posts on the profile.`);

const newPosts = posts.filter(p => !state.knownUrns.includes(p.urn));

if (newPosts.length === 0) {
  console.log('No new posts since last check.');
  process.exit(0);
}

// On the very first run there's no baseline — record everything currently on
// the profile without notifying, otherwise old posts would spam Notion/Discord.
if (firstRun) {
  state.knownUrns.push(...posts.map(p => p.urn));
  saveState(state);
  console.log(`First run: recorded ${posts.length} existing posts as baseline. No notifications sent.`);
  process.exit(0);
}

for (const post of newPosts.reverse()) { // oldest first so ordering reads naturally
  console.log(`New post detected: ${post.urn}`);

  let notionUrl: string | null = null;
  try {
    // 1. Already stamped (e.g. a re-run)? Just refresh engagement.
    const already = await findExistingPage(post);
    if (already) {
      notionUrl = await updateEngagement(already, post);
      console.log(`  → Row already has this post; refreshed engagement: ${notionUrl}`);
    } else {
      // 2. Stamp the live URL onto the planned row for the post's day (the row
      //    with a matching Date and no Post URL yet). This is what lets Sunday's
      //    sync match by URL instead of failing and duplicating. Handles multiple
      //    posts/day: each claims the next still-empty row for that date.
      const dateStr = postDateStr(post);
      const dated = await findDatedRowsNeedingUrl(dateStr);
      if (dated.length === 1) {
        // Unambiguous — exactly one planned row for that day awaiting a URL.
        notionUrl = await stampPostUrl(dated[0], post);
        console.log(`  → Stamped URL onto the ${dateStr} row: ${notionUrl}`);
      } else {
        // 0 rows, or 2+ (ambiguous). Don't guess which plan is the real post —
        // create a separate row so no existing plan gets the wrong URL.
        notionUrl = await addPost(post);
        if (dated.length > 1) {
          console.warn(`  → ⚠️ ${dated.length} rows dated ${dateStr} have no URL — ambiguous, so created a separate row rather than risk stamping the wrong plan: ${notionUrl}`);
        } else {
          console.log(`  → No empty ${dateStr} row; created a new one: ${notionUrl}`);
        }
      }
    }
  } catch (error) {
    console.error('  → Notion write failed:', error);
  }

  try {
    await notifyNewPost(post.url);
    console.log('  → Announced in Discord #general.');
  } catch (error) {
    console.error('  → Discord notify failed:', error);
  }

  // Opt-in extra channel: WhatsApp group via WhatsApp Web (Playwright).
  if (config.whatsappWebGroup) {
    try {
      await sendWhatsAppMessage(config.whatsappWebGroup, `Today's post is now live: ${plainUrl(post.url)}`);
      console.log(`  → Sent to WhatsApp group "${config.whatsappWebGroup}".`);
    } catch (error) {
      console.error('  → WhatsApp send failed:', error);
    }
  }

  // Mark as seen even if a notification failed — we'd rather miss one
  // notification than re-spam the channel on every retry slot.
  state.knownUrns.push(post.urn);
  saveState(state);
}

console.log('Done.');
process.exit(0);
