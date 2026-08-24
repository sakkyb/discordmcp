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

// LinkedIn activity ids embed the creation time in their high bits (the low 22
// are a sequence counter), so a post can be dated without scraping a timestamp:
// milliseconds since epoch = id >> 22.
export function postCreatedAt(urn: string): Date {
  const id = urn.split(':').pop() ?? '';
  return new Date(Number(BigInt(id) >> 22n));
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
    // Playwright passes --no-sandbox unless this is explicitly true, which is
    // both a needless privilege escalation and one more way this profile looks
    // unlike an ordinary browser. The elfried-samba tracker already sets it.
    chromiumSandbox: true,
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

const LOGGED_OUT_HINT = `Run 'npm run login:linkedin' on the Mac Mini to log in again.`;

export async function assertLoggedIn(page: Page): Promise<void> {
  // If the session has expired LinkedIn bounces to a login/authwall page.
  const url = page.url();
  if (/\/(login|authwall|checkpoint|uas\/login)/.test(url)) {
    throw new Error(`LinkedIn session is not logged in (landed on ${url}). ${LOGGED_OUT_HINT}`);
  }

  // LinkedIn also serves a logged-out "guest wall" at the *requested* URL — HTTP
  // 200, no redirect — showing a cookie banner and a Join/Sign in form. The URL
  // check above cannot see that, so an expired session used to sail past here
  // and fail much later as a bogus "no post cards / markup changed" error.
  // Detect it from the page: the join form is present and the authenticated
  // global nav is not.
  // Detect it from the sign-in/join form itself. An earlier version of this
  // check also required the authenticated nav to be *absent*, testing for the
  // word "Notifications" — but the logged-out page says "0 notifications", so
  // that clause matched and suppressed the whole check. Credential inputs and
  // join copy exist only when logged out, so test for those alone.
  const guestWall = await page
    .evaluate(() => {
      if (document.querySelector('input[name="session_password"], input[name="session_key"], input#password')) return true;
      const text = document.body?.innerText ?? '';
      return /Agree & Join|Join LinkedIn|New to LinkedIn\?/i.test(text);
    })
    .catch(() => false);

  if (guestWall) {
    throw new Error(
      `LinkedIn served its logged-out guest wall at ${url} (HTTP 200, no redirect), ` +
      `so the saved session has expired. ${LOGGED_OUT_HINT}`
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

  // Let the feed hydrate; LinkedIn renders post cards client-side. The feed
  // sometimes loads slowly or returns an empty shell, so wait generously and
  // reload once before giving up (this was the intermittent "No post cards"
  // failure).
  // The feed is markedly slower to hydrate under automation than in an ordinary
  // Chrome window — 120s, not 45s, is what it actually needs.
  const CARD_TIMEOUT_MS = 120_000;
  const cardSelector = '[data-urn^="urn:li:activity:"]';
  try {
    await page.waitForSelector(cardSelector, { timeout: CARD_TIMEOUT_MS });
  } catch {
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
    await assertLoggedIn(page);
    try {
      await page.waitForSelector(cardSelector, { timeout: CARD_TIMEOUT_MS });
    } catch {
      throw new Error(
        `No post cards found on the activity page within ${CARD_TIMEOUT_MS / 1000}s (after one reload). Either there are ` +
        'no posts, the session is limited/rate-limited, or LinkedIn changed its markup (selector: ' +
        cardSelector + ').'
      );
    }
  }

  // Scroll to load more cards beyond the first screen — more scrolls when a
  // larger set is requested (e.g. a multi-week window).
  const scrolls = Math.max(3, Math.ceil(limit / 4));
  for (let i = 0; i < scrolls; i++) {
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

// ---------------------------------------------------------------------------
// Scheduled (not yet published) posts
// ---------------------------------------------------------------------------

export interface ScheduledPost {
  shareUrn: string;      // urn:li:share:7495...
  scheduledAt: Date;
  text: string;
  imageUrl: string | null; // highest-resolution variant LinkedIn offers
  label: string;           // LinkedIn's own wording, e.g. "Posting Wed, Aug 26 at 8:45 AM"
}

// Read the queue of scheduled posts.
//
// Every other LinkedIn surface in this file is reached with goto() + DOM
// scraping, but scheduled posts have no page of their own: /feed/scheduled-posts/
// and /feed/scheduled/ both render LinkedIn's "This page doesn't exist", and the
// only UI is the composer modal, which does NOT open under Playwright (verified
// with a good session, navigator.webdriver false, real and synthetic clicks
// alike). So this calls the same internal GraphQL query the modal uses, from
// inside the page so the session cookies and csrf token come along for free.
export async function getScheduledPosts(page: Page, count = 10): Promise<ScheduledPost[]> {
  // The fetch is same-origin, so we must already be on linkedin.com.
  if (!/^https:\/\/www\.linkedin\.com\//.test(page.url())) {
    await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: 60_000 });
  }
  await assertLoggedIn(page);

  const res = await page.evaluate(
    async ({ queryId, count }: { queryId: string; count: number }) => {
      const jsessionid = (document.cookie.match(/JSESSIONID=([^;]+)/) ?? [])[1] ?? '';
      const url =
        `/voyager/api/graphql?includeWebMetadata=true` +
        `&variables=(shareLifeCycleState:SCHEDULED,start:0,count:${count})` +
        `&queryId=${queryId}`;
      const r = await fetch(url, {
        headers: {
          accept: 'application/vnd.linkedin.normalized+json+2.1',
          'csrf-token': jsessionid.replace(/"/g, ''),
          'x-restli-protocol-version': '2.0.0',
          'x-li-lang': 'en_US',
        },
        credentials: 'include',
      });
      return { status: r.status, body: await r.text() };
    },
    { queryId: config.scheduledQueryId, count },
  );

  if (res.status !== 200) {
    throw new Error(
      `Scheduled-posts query failed (HTTP ${res.status}). The queryId is version-stamped and ` +
      `rotates with LinkedIn's frontend — re-capture it from DevTools and set ` +
      `LINKEDIN_SCHEDULED_QUERY_ID. Current: ${config.scheduledQueryId}`,
    );
  }

  let json: any;
  try {
    json = JSON.parse(res.body);
  } catch {
    throw new Error('Scheduled-posts query returned a 200 that was not JSON (logged out mid-request?).');
  }

  const elements =
    json?.data?.data?.contentcreationDashSharePreviewsByShareLifeCycleState?.elements;
  if (!Array.isArray(elements)) {
    throw new Error(
      'Could not find scheduled-post elements in the GraphQL response (LinkedIn changed the ' +
      'response shape?). Expected data.data.contentcreationDashSharePreviewsByShareLifeCycleState.elements.',
    );
  }

  // The post body/image live in `included`, keyed by the entityUrn that each
  // element points at via its *miniUpdate reference.
  const included: any[] = Array.isArray(json.included) ? json.included : [];
  const byUrn = new Map<string, any>(
    included.filter((e) => e?.entityUrn).map((e) => [e.entityUrn as string, e]),
  );

  return elements.map((el: any) => {
    const miniUpdate = byUrn.get(el?.['*miniUpdate']);
    const commentary = miniUpdate?.commentary;
    return {
      shareUrn: miniUpdate?.metadata?.backendUrn ?? el?.['*miniUpdate'] ?? '',
      scheduledAt: new Date(Number(el?.scheduledAt)),
      text: commentary?.commentaryText?.text ?? '',
      imageUrl: bestImageUrl(commentary?.image?.attributes?.[0]?.detailData?.vectorImage),
      label: el?.contextualDescription?.text ?? '',
    };
  });
}

// LinkedIn returns one image as several pre-rendered sizes; take the widest so
// the preview screenshot is sharp. Each artifact's path segment is appended to
// the shared rootUrl.
function bestImageUrl(vectorImage: any): string | null {
  const root = vectorImage?.rootUrl;
  const artifacts = vectorImage?.artifacts;
  if (typeof root !== 'string' || !Array.isArray(artifacts) || artifacts.length === 0) return null;
  const widest = artifacts.reduce((a: any, b: any) => ((b?.width ?? 0) > (a?.width ?? 0) ? b : a));
  const segment = widest?.fileIdentifyingUrlPathSegment;
  return typeof segment === 'string' ? root + segment : null;
}

// Pick the post scheduled for a given local calendar day, or null if that day is
// empty. Compares local Y/M/D rather than a 24-hour window, so "tomorrow" means
// the calendar day regardless of what time the job runs.
export function findPostForDay(posts: ScheduledPost[], day: Date): ScheduledPost | null {
  const same = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  return posts.find((p) => same(p.scheduledAt, day)) ?? null;
}
