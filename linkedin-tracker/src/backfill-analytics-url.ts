// One-off: fill the Analytics URL column on rows that already have a Post URL.
// The analytics URL is derivable from the activity id inside the post URL, so
// this needs no browser and no LinkedIn request — just Notion reads and writes.
import { notionFetch, PROP, activityIdFromUrl } from './lib/notion.js';
import { config, validateConfig } from './lib/config.js';

validateConfig();
const DRY_RUN = process.env.DRY_RUN === 'true';

let cursor: string | undefined;
let filled = 0, skipped = 0;

do {
  const data: any = await notionFetch(`/databases/${config.notionDatabaseId}/query`, 'POST', {
    filter: {
      and: [
        { property: PROP.url, url: { is_not_empty: true } },
        { property: PROP.analyticsUrl, url: { is_empty: true } },
      ],
    },
    start_cursor: cursor,
    page_size: 100,
  });

  for (const row of data.results ?? []) {
    const postUrl: string = row.properties[PROP.url]?.url ?? '';
    const name = row.properties[PROP.title]?.title?.map((t: any) => t.plain_text).join('') || '(untitled)';
    const id = activityIdFromUrl(postUrl);
    if (!id) {
      skipped++;
      console.warn(`  ? no activity id in "${postUrl}" (${name}) — skipped`);
      continue;
    }
    const analyticsUrl = `https://www.linkedin.com/analytics/post-summary/urn:li:activity:${id}/`;
    if (!DRY_RUN) {
      await notionFetch(`/pages/${row.id}`, 'PATCH', {
        properties: { [PROP.analyticsUrl]: { url: analyticsUrl } },
      });
    }
    filled++;
    console.log(`  ✓ ${name} → ${analyticsUrl}`);
  }

  cursor = data.has_more ? data.next_cursor : undefined;
} while (cursor);

console.log(`${DRY_RUN ? '[dry run] would fill' : 'Filled'} ${filled} rows, skipped ${skipped}.`);
process.exit(0);
