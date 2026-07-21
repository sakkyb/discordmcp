// Scheduled job: detect a new post on the profile and fan out notifications.
// Runs at the times defined in scripts/com.sakky.linkedin-tracker.plist.template.
// Re-runs are naturally idempotent: a post already in state.json is ignored,
// so the 30/60-minute retry slots simply no-op once the post has been caught.
import { openBrowser, getRecentPosts } from './lib/linkedin.js';
import { loadState, saveState } from './lib/state.js';
import { addPost, findExistingPage, updateEngagement } from './lib/notion.js';
import { sendToGroup } from './lib/whatsapp.js';
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
// the profile without notifying, otherwise old posts would spam Notion/WhatsApp.
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
    // Reuse the existing "Content schedule" row if this post already has one
    // (e.g. it was planned there) — update its analytics in place rather than
    // creating a duplicate. Otherwise add a fresh row.
    const existingId = await findExistingPage(post);
    if (existingId) {
      notionUrl = await updateEngagement(existingId, post);
      console.log(`  → Updated existing Notion row: ${notionUrl}`);
    } else {
      notionUrl = await addPost(post);
      console.log(`  → Added to Notion: ${notionUrl}`);
    }
  } catch (error) {
    console.error('  → Notion write failed:', error);
  }

  if (config.whatsappGroupName) {
    try {
      const preview = post.text.length > 200 ? post.text.slice(0, 200) + '…' : post.text;
      await sendToGroup(
        config.whatsappGroupName,
        `🔔 New LinkedIn post from Sakky\n\n${preview}\n\n${post.url}${notionUrl ? `\n📝 Notion: ${notionUrl}` : ''}`
      );
      console.log('  → Sent to WhatsApp group.');
    } catch (error) {
      console.error('  → WhatsApp send failed:', error);
    }
  }

  // Mark as seen even if a notification failed — we'd rather miss one
  // notification than re-spam the group on every retry slot.
  state.knownUrns.push(post.urn);
  saveState(state);
}

console.log('Done.');
process.exit(0);
