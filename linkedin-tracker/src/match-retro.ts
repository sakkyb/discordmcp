// Report-only: run the content matcher over recent posts and print what it
// would do. Two uses — checking the matcher's judgement against real history
// before trusting it, and finding rows the old date-only matcher auto-created
// (their title is the raw first line of the post) so they can be merged by hand.
import { openBrowser, getRecentPosts, postCreatedAt } from './lib/linkedin.js';
import { findExistingPage, findUnstampedCandidates, notionFetch, PROP } from './lib/notion.js';
import { chooseRow, classifyPost } from './lib/classify.js';
import { validateConfig } from './lib/config.js';

validateConfig();

const SINCE_DAYS = Number(process.env.SINCE_DAYS ?? 14);
const cutoff = Date.now() - SINCE_DAYS * 24 * 60 * 60 * 1000;

async function rowTitle(pageId: string): Promise<string> {
  const page: any = await notionFetch(`/pages/${pageId}`, 'GET');
  return page.properties[PROP.title]?.title?.map((t: any) => t.plain_text).join('') || '(untitled)';
}

const browser = await openBrowser();
let posts;
try {
  const page = browser.pages()[0] ?? await browser.newPage();
  posts = await getRecentPosts(page, 40);
} finally {
  await browser.close();
}

posts = posts.filter(p => postCreatedAt(p.urn).getTime() >= cutoff);
console.log(`\nChecking ${posts.length} posts from the last ${SINCE_DAYS} days.\n`);

for (const post of posts.reverse()) {
  const date = postCreatedAt(post.urn).toISOString().slice(0, 10);
  const firstLine = post.text.split('\n')[0].slice(0, 60);
  console.log(`${date}  ${firstLine}`);

  const existing = await findExistingPage(post);
  if (existing) {
    const title = await rowTitle(existing);
    // A row the old matcher created titles itself with the post's own first
    // line; a planned row has a short human-written name.
    const autoCreated = title.startsWith(post.text.split('\n')[0].slice(0, 40));
    console.log(`   stamped on: "${title}"${autoCreated ? '   ⚠️  AUTO-CREATED — candidate for merging' : ''}`);
    if (!autoCreated) {
      console.log('');
      continue;
    }
  }

  const candidates = await findUnstampedCandidates(postCreatedAt(post.urn));
  const decision = await chooseRow(post.text, candidates, classifyPost);
  if (decision.kind === 'match') {
    console.log(`   → would match "${decision.candidate.name}" (${decision.reason})`);
  } else if (decision.kind === 'none') {
    console.log(`   → no match (${decision.reason}); would create a new row`);
  } else {
    console.log('   → classifier unavailable');
  }
  console.log('');
}

process.exit(0);
