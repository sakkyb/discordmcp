import { config } from './config.js';
import { postCreatedAt } from './linkedin.js';
import type { LinkedInPost, PostAnalytics } from './linkedin.js';

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
  impressions: 'Impressions',
  profileViews: 'Profile views',
  followersGained: 'Followers gained',
  saves: 'Saves',
  sends: 'Sends',
  analyticsUrl: 'Analytics URL', // url — derived from the activity id, no extra call
  scrapped: 'Scrapped', // checkbox — an abandoned plan; never a match candidate
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

// The owner-only analytics page for a post. Fully derivable from the activity
// id, so filling the column costs no extra request.
export function analyticsUrlFor(urn: string): string {
  return `https://www.linkedin.com/analytics/post-summary/urn:li:activity:${activityId(urn)}/`;
}

// Pull the activity id back out of a stored Post URL. Handles both forms
// LinkedIn uses: `/feed/update/urn:li:activity:7215…/` and the share-link
// `/posts/<slug>-activity-7215…-<hash>`.
export function activityIdFromUrl(url: string): string | null {
  return url.match(/activity[:-](\d{15,25})/)?.[1] ?? null;
}

// Local YYYY-MM-DD bounds N days either side of a date, for the Notion query
// that gathers candidate rows.
export function dateWindow(center: Date, days: number): { start: string; end: string } {
  const fmt = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const start = new Date(center);
  start.setDate(start.getDate() - days);
  const end = new Date(center);
  end.setDate(end.getDate() + days);
  return { start: fmt(start), end: fmt(end) };
}

// Notion caps rich_text content at 2000 characters per block, so long posts are
// split across several paragraphs — preferring a line break, then a space, and
// only cutting mid-word as a last resort.
export function chunkText(text: string, max = 1900): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max * 0.5) cut = rest.lastIndexOf(' ', max);
    if (cut < max * 0.5) cut = max;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

// The post's creation date as a local YYYY-MM-DD string (dated from the
// activity id). Used both to stamp the Date column and to find the planned row
// for a given day.
export function postDateStr(post: LinkedInPost): string {
  const d = postCreatedAt(post.urn);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
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
    [PROP.analyticsUrl]: { url: analyticsUrlFor(post.urn) },
    [PROP.date]: { date: { start: postDateStr(post) } },
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

// All planned rows for a given day (YYYY-MM-DD) that have no Post URL yet.
// The caller stamps only when there's exactly one — with several same-date
// rows there's no reliable way to know which is the actual post (planned names
// don't match content, and created-time doesn't distinguish them), so guessing
// risks stamping the wrong plan.
export async function findDatedRowsNeedingUrl(dateStr: string): Promise<string[]> {
  const data = await notionFetch(`/databases/${config.notionDatabaseId}/query`, 'POST', {
    filter: {
      and: [
        { property: PROP.date, date: { equals: dateStr } },
        { property: PROP.url, url: { is_empty: true } },
      ],
    },
    page_size: 20,
  });
  return (data.results ?? []).map((r: any) => r.id);
}

// Stamp the live post URL (and current engagement) onto an existing row —
// this is what lets Sunday's sync match by URL later. Returns the page URL.
export async function stampPostUrl(pageId: string, post: LinkedInPost): Promise<string> {
  const page = await notionFetch(`/pages/${pageId}`, 'PATCH', {
    properties: {
      [PROP.url]: { url: post.url },
      [PROP.analyticsUrl]: { url: analyticsUrlFor(post.urn) },
      ...engagementProperties(post),
    },
  });
  return page.url;
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

// The full analytics metric set (weekly sync), keyed to the existing columns.
function analyticsProperties(a: PostAnalytics) {
  return {
    [PROP.impressions]: { number: a.impressions },
    [PROP.profileViews]: { number: a.profileViews },
    [PROP.followersGained]: { number: a.followersGained },
    [PROP.reactions]: { number: a.reactions },
    [PROP.comments]: { number: a.comments },
    [PROP.reposts]: { number: a.reposts },
    [PROP.saves]: { number: a.saves },
    [PROP.sends]: { number: a.sends },
  };
}

// Update all analytics columns on an existing row in place. Also (re)writes the
// Analytics URL so rows created before that column was automated self-heal on
// the next weekly run.
export async function updateAnalytics(pageId: string, a: PostAnalytics, urn: string): Promise<string> {
  const page = await notionFetch(`/pages/${pageId}`, 'PATCH', {
    properties: {
      ...analyticsProperties(a),
      [PROP.analyticsUrl]: { url: analyticsUrlFor(urn) },
    },
  });
  return page.url;
}

// Create a new row for a post that has no existing row, with full analytics.
export async function addPostWithAnalytics(post: LinkedInPost, a: PostAnalytics): Promise<string> {
  const title = post.text.split('\n')[0].slice(0, 100) || post.url;
  const page = await notionFetch('/pages', 'POST', {
    parent: { database_id: config.notionDatabaseId },
    properties: {
      [PROP.title]: { title: [{ text: { content: title } }] },
      [PROP.url]: { url: post.url },
      [PROP.analyticsUrl]: { url: analyticsUrlFor(post.urn) },
      [PROP.date]: { date: { start: postDateStr(post) } },
      ...analyticsProperties(a),
    },
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
