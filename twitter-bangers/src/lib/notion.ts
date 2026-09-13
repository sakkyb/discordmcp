import { config } from './config.js';
import { weekLabel, formatLikes } from './report.js';
import type { Tweet } from './tweets.js';

// The "Content Master Table" is a multi-source database, which only this API
// version exposes (pages are created under a data_source_id parent).
const NOTION_VERSION = '2025-09-03';

export async function notionFetch(path: string, method: string, body?: unknown): Promise<any> {
  const res = await fetch(`https://api.notion.com/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${config.notionToken}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Notion API ${method} ${path} failed (${res.status}): ${detail}`);
  }
  return res.json();
}

export function pageTitle(runDate: Date): string {
  return `Twitter bangers — week of ${weekLabel(runDate)}`;
}

const para = (content: string, link?: string) => ({
  object: 'block',
  type: 'paragraph',
  paragraph: { rich_text: [{ type: 'text', text: { content, link: link ? { url: link } : null } }] },
});

// A caption line then an embed per tweet. Notion renders x.com embeds as tweet
// cards, so the page can be scanned without leaving Notion.
export function buildPageBlocks(report: Tweet[], query: string): unknown[] {
  const blocks: unknown[] = [
    para(`${report.length} posts with 50k+ likes and images from the last 7 days. Search: ${query}`),
  ];
  report.forEach((t, i) => {
    const tag = t.verdict ? ` · ${t.verdict.category}` : '';
    blocks.push(para(`${i + 1}. @${t.handle} · ${formatLikes(t.likes)} likes${tag}`, t.url));
    if (t.verdict?.reason) blocks.push(para(`↳ ${t.verdict.reason}`));
    blocks.push({ object: 'block', type: 'embed', embed: { url: t.url } });
  });
  return blocks;
}

// Notion accepts at most 100 children per request. A 20-tweet page is 41
// blocks, but the split keeps a larger REPORT_COUNT working.
const BATCH = 100;

export async function createWeeklyPage(runDate: Date, report: Tweet[], query: string): Promise<string> {
  const blocks = buildPageBlocks(report, query);
  const page = await notionFetch('/pages', 'POST', {
    parent: { type: 'data_source_id', data_source_id: config.notionDataSourceId },
    properties: { Name: { title: [{ type: 'text', text: { content: pageTitle(runDate) } }] } },
    children: blocks.slice(0, BATCH),
  });
  for (let i = BATCH; i < blocks.length; i += BATCH) {
    await notionFetch(`/blocks/${page.id}/children`, 'PATCH', { children: blocks.slice(i, i + BATCH) });
  }
  return page.url as string;
}
