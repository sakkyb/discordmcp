import { chromium, BrowserContext, Page } from 'playwright';
import { CHROME_PROFILE_DIR, config } from './config.js';

export interface LinkedInPost {
  urn: string; // e.g. urn:li:activity:7215...
  url: string;
  text: string;
  reactions: number;
  comments: number;
  reposts: number;
}

// Full per-post metrics from the private analytics page (owner-only).
export interface PostAnalytics {
  impressions: number;
  profileViews: number;
  followersGained: number;
  reactions: number;
  comments: number;
  reposts: number;
  saves: number;
  sends: number;
}

// Uses the system-installed Google Chrome (channel: 'chrome') with a
// persistent profile directory, so the LinkedIn login done once via
// `npm run login:linkedin` is reused on every scheduled run.
export async function openBrowser(): Promise<BrowserContext> {
  return chromium.launchPersistentContext(CHROME_PROFILE_DIR, {
    channel: 'chrome',
    headless: config.headless,
    viewport: { width: 1280, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  });
}

function parseCount(text: string | null | undefined): number {
  if (!text) return 0;
  const cleaned = text.replace(/,/g, '').trim();
  const match = cleaned.match(/([\d.]+)\s*([KkMm])?/);
  if (!match) return 0;
  let n = parseFloat(match[1]);
  if (/k/i.test(match[2] ?? '')) n *= 1_000;
  if (/m/i.test(match[2] ?? '')) n *= 1_000_000;
  return Math.round(n);
}

export async function assertLoggedIn(page: Page): Promise<void> {
  // If the session has expired LinkedIn bounces to a login/authwall page.
  const url = page.url();
  if (/\/(login|authwall|checkpoint|uas\/login)/.test(url)) {
    throw new Error(
      `LinkedIn session is not logged in (landed on ${url}). ` +
      `Run 'npm run login:linkedin' on the Mac Mini to log in again.`
    );
  }
}

// Scrape the user's own recent posts from their profile activity feed.
// Selectors here WILL eventually break when LinkedIn ships new markup —
// each extraction has fallbacks and the function fails loudly rather than
// silently returning nothing when the page structure is unrecognizable.
export async function getRecentPosts(page: Page, limit = 10): Promise<LinkedInPost[]> {
  const activityUrl = `${config.linkedinProfileUrl}/recent-activity/all/`;
  await page.goto(activityUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await assertLoggedIn(page);

  // Let the feed hydrate; LinkedIn renders post cards client-side.
  try {
    await page.waitForSelector('[data-urn^="urn:li:activity:"]', { timeout: 30_000 });
  } catch {
    throw new Error(
      'No post cards found on the activity page within 30s. Either there are no posts, ' +
      'the session is limited, or LinkedIn changed its markup (selector: [data-urn^="urn:li:activity:"]).'
    );
  }

  // Scroll a little to load a few more cards beyond the first screen.
  for (let i = 0; i < 3; i++) {
    await page.mouse.wheel(0, 1500);
    await page.waitForTimeout(1200);
  }

  const posts = await page.evaluate((max: number) => {
    const results: Array<{
      urn: string; text: string; reactions: string; comments: string; reposts: string; isRepost: boolean;
    }> = [];
    const cards = document.querySelectorAll<HTMLElement>('[data-urn^="urn:li:activity:"]');
    for (const card of Array.from(cards)) {
      if (results.length >= max) break;
      const urn = card.getAttribute('data-urn') ?? '';
      if (!urn) continue;

      // Skip reposts/likes/comments surfaced in the activity feed — we only
      // want original posts authored by the profile owner.
      const header = card.querySelector('.update-components-header')?.textContent ?? '';
      const isRepost = /reposted|likes this|commented on/i.test(header);

      const text =
        card.querySelector('.update-components-text')?.textContent?.trim() ??
        card.querySelector('.feed-shared-inline-show-more-text')?.textContent?.trim() ??
        '';

      // The reactions count lives in the reactions <li>; LinkedIn exposes it as a
      // "social proof fallback number" (e.g. "20" for "You and 19 others"). The
      // older `__reactions-count` class is gone, and a plain [aria-label*="reaction"]
      // match hits the "Open reactions menu" button (no digits) — so scope to the
      // reactions item and read the number, with the item's own text as a fallback.
      const reactions =
        card.querySelector('.social-details-social-counts__reactions .social-details-social-counts__social-proof-fallback-number')?.textContent ??
        card.querySelector('.social-details-social-counts__social-proof-fallback-number')?.textContent ??
        card.querySelector('.social-details-social-counts__reactions')?.textContent ??
        '';

      let comments = '';
      let reposts = '';
      for (const li of Array.from(card.querySelectorAll('.social-details-social-counts__item, li'))) {
        const t = li.textContent ?? '';
        if (/comment/i.test(t) && !comments) comments = t;
        if (/repost/i.test(t) && !reposts) reposts = t;
      }

      results.push({ urn, text, reactions, comments, reposts, isRepost });
    }
    return results;
  }, limit);

  return posts
    .filter(p => !p.isRepost)
    .map(p => ({
      urn: p.urn,
      url: `https://www.linkedin.com/feed/update/${p.urn}/`,
      text: p.text,
      reactions: parseCount(p.reactions),
      comments: parseCount(p.comments),
      reposts: parseCount(p.reposts),
    }));
}

// Read one post's full analytics from its owner-only analytics page. LinkedIn
// lays the metrics out as number/label pairs: Discovery & Profile metrics put
// the number BEFORE the label, Engagement metrics put it AFTER, so we look on
// the correct side (anchored to the section heading to avoid matching a label
// that also appears elsewhere on the page). Fails loudly on unrecognized markup.
export async function getPostAnalytics(page: Page, activityId: string): Promise<PostAnalytics> {
  const url = `https://www.linkedin.com/analytics/post-summary/urn:li:activity:${activityId}/`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await assertLoggedIn(page);

  try {
    await page.waitForFunction(() => /Impressions/.test(document.body?.innerText ?? ''), { timeout: 30_000 });
  } catch {
    throw new Error(
      `Analytics page for ${activityId} never showed "Impressions" within 30s ` +
      `(post has no analytics, or LinkedIn changed the markup).`
    );
  }
  await page.waitForTimeout(2500); // let remaining widgets settle

  const raw = await page.evaluate(() => {
    const lines = (document.body.innerText || '').split('\n').map(l => l.trim()).filter(Boolean);
    const toNum = (s: string): number | null => {
      const m = (s || '').replace(/,/g, '').match(/^([\d.]+)\s*([KkMm])?$/);
      if (!m) return null;
      let n = parseFloat(m[1]);
      if (/k/i.test(m[2] ?? '')) n *= 1_000;
      if (/m/i.test(m[2] ?? '')) n *= 1_000_000;
      return Math.round(n);
    };
    // Find `label`; read the number on the given side. `anchor`, if present,
    // restricts the search to lines after that section heading.
    const read = (label: string, dir: 'before' | 'after', anchor?: string): number | null => {
      let start = 0;
      if (anchor) { const ai = lines.indexOf(anchor); if (ai >= 0) start = ai; }
      for (let i = start; i < lines.length; i++) {
        if (lines[i] === label) {
          const n = toNum((dir === 'before' ? lines[i - 1] : lines[i + 1]) ?? '');
          if (n != null) return n;
        }
      }
      return null;
    };
    return {
      impressions: read('Impressions', 'before', 'Discovery'),
      profileViews: read('Profile viewers from this post', 'before'),
      followersGained: read('Followers gained from this post', 'before'),
      reactions: read('Reactions', 'after', 'Engagement'),
      comments: read('Comments', 'after', 'Engagement'),
      reposts: read('Reposts', 'after', 'Engagement'),
      saves: read('Saves', 'after', 'Engagement'),
      sends: read('Sends on LinkedIn', 'after', 'Engagement'),
    };
  });

  if (raw.impressions == null) {
    throw new Error(`Could not parse Impressions on the analytics page for ${activityId} (markup changed?).`);
  }
  // A metric LinkedIn omits (e.g. 0 saves may not render) defaults to 0.
  return {
    impressions: raw.impressions ?? 0,
    profileViews: raw.profileViews ?? 0,
    followersGained: raw.followersGained ?? 0,
    reactions: raw.reactions ?? 0,
    comments: raw.comments ?? 0,
    reposts: raw.reposts ?? 0,
    saves: raw.saves ?? 0,
    sends: raw.sends ?? 0,
  };
}
