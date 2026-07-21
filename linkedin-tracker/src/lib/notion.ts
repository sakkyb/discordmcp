import { config } from './config.js';
import type { LinkedInPost } from './linkedin.js';

const NOTION_VERSION = '2022-06-28';

async function notionFetch(path: string, method: string, body?: unknown): Promise<any> {
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

function postProperties(post: LinkedInPost) {
  const title = post.text.split('\n')[0].slice(0, 100) || post.urn;
  return {
    Name: { title: [{ text: { content: title } }] },
    URL: { url: post.url },
    URN: { rich_text: [{ text: { content: post.urn } }] },
    Posted: { date: { start: new Date().toISOString().slice(0, 10) } },
    Reactions: { number: post.reactions },
    Comments: { number: post.comments },
    Reposts: { number: post.reposts },
    'Last Checked': { date: { start: new Date().toISOString() } },
  };
}

export async function findPageByUrn(urn: string): Promise<string | null> {
  const data = await notionFetch(`/databases/${config.notionDatabaseId}/query`, 'POST', {
    filter: { property: 'URN', rich_text: { equals: urn } },
    page_size: 1,
  });
  return data.results?.[0]?.id ?? null;
}

export async function addPost(post: LinkedInPost): Promise<string> {
  const page = await notionFetch('/pages', 'POST', {
    parent: { database_id: config.notionDatabaseId },
    properties: postProperties(post),
    children: post.text
      ? [{
          object: 'block',
          type: 'paragraph',
          paragraph: { rich_text: [{ text: { content: post.text.slice(0, 1900) } }] },
        }]
      : [],
  });
  return page.url;
}

export async function updateEngagement(pageId: string, post: LinkedInPost): Promise<void> {
  await notionFetch(`/pages/${pageId}`, 'PATCH', {
    properties: {
      Reactions: { number: post.reactions },
      Comments: { number: post.comments },
      Reposts: { number: post.reposts },
      'Last Checked': { date: { start: new Date().toISOString() } },
    },
  });
}
