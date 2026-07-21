import { config } from './config.js';
import type { LinkedInPost } from './linkedin.js';

const NOTION_VERSION = '2022-06-28';

// This tracker reuses the existing "Content schedule" database rather than a
// dedicated one, so it reads/writes the columns that already live there.
// If you point it at a different table, update these names to match.
const PROP = {
  title: 'Post name', // title
  url: 'Post URL', // url — matched (by activity id) to find the row for a post
  date: 'Date', // date
  reactions: 'Reactions',
  comments: 'Comments',
  reposts: 'Reposts',
} as const;

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

// The numeric activity id is the one stable key shared by every LinkedIn URL
// form (`/feed/update/urn:li:activity:7215…/` and `/posts/<slug>-activity-7215…`),
// so we match Notion rows on it rather than on an exact URL string.
function activityId(urn: string): string {
  return urn.split(':').pop() ?? urn;
}

// Analytics columns — written on both create and update.
function engagementProperties(post: LinkedInPost) {
  return {
    [PROP.reactions]: { number: post.reactions },
    [PROP.comments]: { number: post.comments },
    [PROP.reposts]: { number: post.reposts },
  };
}

function newPostProperties(post: LinkedInPost) {
  const title = post.text.split('\n')[0].slice(0, 100) || post.url;
  return {
    [PROP.title]: { title: [{ text: { content: title } }] },
    [PROP.url]: { url: post.url },
    [PROP.date]: { date: { start: new Date().toISOString().slice(0, 10) } },
    ...engagementProperties(post),
  };
}

// Find an existing "Content schedule" row for this post by matching the
// activity id anywhere inside its Post URL. Returns the page id, or null.
export async function findExistingPage(post: LinkedInPost): Promise<string | null> {
  const data = await notionFetch(`/databases/${config.notionDatabaseId}/query`, 'POST', {
    filter: { property: PROP.url, url: { contains: activityId(post.urn) } },
    page_size: 1,
  });
  return data.results?.[0]?.id ?? null;
}

export async function addPost(post: LinkedInPost): Promise<string> {
  const page = await notionFetch('/pages', 'POST', {
    parent: { database_id: config.notionDatabaseId },
    properties: newPostProperties(post),
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

// Update engagement counts on an existing row in place and return its page URL.
export async function updateEngagement(pageId: string, post: LinkedInPost): Promise<string> {
  const page = await notionFetch(`/pages/${pageId}`, 'PATCH', {
    properties: engagementProperties(post),
  });
  return page.url;
}
