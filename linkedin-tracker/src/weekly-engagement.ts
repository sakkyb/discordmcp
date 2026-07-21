// Scheduled job (Sundays 8:00): refresh reaction/comment/repost counts for
// recent posts and sync them into the Notion database.
import { openBrowser, getRecentPosts } from './lib/linkedin.js';
import { addPost, findExistingPage, updateEngagement } from './lib/notion.js';
import { validateConfig } from './lib/config.js';

validateConfig();

console.log(`[${new Date().toISOString()}] Weekly engagement sync starting...`);

const browser = await openBrowser();
let posts;
try {
  const page = browser.pages()[0] ?? await browser.newPage();
  posts = await getRecentPosts(page, 15);
} finally {
  await browser.close();
}

console.log(`Syncing engagement for ${posts.length} posts...`);

let updated = 0;
let created = 0;
for (const post of posts) {
  try {
    const pageId = await findExistingPage(post);
    if (pageId) {
      await updateEngagement(pageId, post);
      updated++;
    } else {
      await addPost(post);
      created++;
    }
  } catch (error) {
    console.error(`Failed to sync ${post.urn}:`, error);
  }
}

console.log(`Done: ${updated} updated, ${created} newly added to Notion.`);
process.exit(0);
