import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findPostsForDay, type ScheduledPost } from './linkedin.js';

function post(scheduledAt: Date, label = ''): ScheduledPost {
  return { shareUrn: `urn:${scheduledAt.getTime()}`, scheduledAt, text: '', imageUrl: null, label };
}

test('findPostsForDay returns every post on that local calendar day, earliest first', () => {
  const day = new Date(2026, 8, 18); // 18 Sep 2026
  const posts = [
    post(new Date(2026, 8, 18, 17, 30), 'evening'),
    post(new Date(2026, 8, 19, 8, 0), 'day after'),
    post(new Date(2026, 8, 18, 8, 45), 'morning'),
    post(new Date(2026, 8, 17, 23, 59), 'night before'),
    post(new Date(2026, 8, 18, 12, 0), 'lunch'),
  ];
  assert.deepEqual(findPostsForDay(posts, day).map((p) => p.label), ['morning', 'lunch', 'evening']);
});

test('findPostsForDay returns an empty list when nothing is queued that day', () => {
  const posts = [post(new Date(2026, 8, 19, 8, 0))];
  assert.deepEqual(findPostsForDay(posts, new Date(2026, 8, 18)), []);
});

// --- polling scrape: scroll only while everything on screen is unknown -----
import { shouldScrollAgain } from './linkedin.js';

const known = new Set(['k1', 'k2']);
const isKnown = (u: string) => known.has(u);

test('no further scroll once a known post is on screen', () => {
  assert.equal(shouldScrollAgain(['new1', 'k1'], isKnown, 0, 3), false);
});

test('scrolls again while every visible post is unknown (catch-up after an outage)', () => {
  assert.equal(shouldScrollAgain(['new1', 'new2'], isKnown, 0, 3), true);
});

test('stops at the scroll cap even if everything is still unknown', () => {
  assert.equal(shouldScrollAgain(['new1', 'new2'], isKnown, 3, 3), false);
});

test('does not scroll an empty screen', () => {
  assert.equal(shouldScrollAgain([], isKnown, 0, 3), false);
});

// --- October 2026 activity-page markup ---------------------------------------
// LinkedIn replaced the activity feed's markup on 2026-10-07: post cards no
// longer carry data-urn or any of the update-components-* / social-details-*
// classes. What remains stable: one role="listitem" per post, an owner-only
// analytics link whose href holds the activity URN, the body text in
// [data-testid="expandable-text-box"], and plain-text social counts.
import { chromium } from 'playwright';
import { extractActivityCards, reactionsFromText } from './linkedin.js';

test('reactionsFromText counts the named reactor plus "N others"', () => {
  assert.equal(reactionsFromText('Aditya Lamichhane and 14 others reacted'), 15);
  assert.equal(reactionsFromText('Sam Jones and 1 other reacted'), 2);
  assert.equal(reactionsFromText('Anna Lee, Ben Ng and 3 others reacted'), 5);
});

test('reactionsFromText handles a lone reactor and no reactions', () => {
  assert.equal(reactionsFromText('Sam Jones reacted'), 1);
  assert.equal(reactionsFromText(''), 0);
});

test('reactionsFromText falls back to a bare count', () => {
  assert.equal(reactionsFromText('1,204 reactions'), 1204);
});

const ACTIVITY_FIXTURE = `<!doctype html><html><body>
<div role="list" data-testid="ProfileRecentActivityAll-someone">
  <div data-lazy-mount-id="a1" style="display: contents;">
    <div role="listitem">
      <div>Feed post</div>
      <div aria-label="Some One Verified Profile You">Some One • You</div>
      <div>Founder @ Somewhere</div><div>1d</div>
      <span data-testid="expandable-text-box">if you hate adobe<br>this might be for you<br>repo link in the comments</span>
      <button data-testid="expandable-text-button">… more</button>
      <div><div>Aditya Lamichhane and 14 others reacted</div><div>Aditya Lamichhane and 14 others</div></div>
      <div role="button"><div>3 comments</div><div>3 comments</div></div>
      <div role="button"><div>3 reposts</div><div>3 reposts</div></div>
      <button aria-label="Reaction button state: no reaction">Like</button><button>Comment</button><button>Repost</button><button>Send</button>
      <div>3,400 impressions</div>
      <a href="https://www.linkedin.com/analytics/post-summary/urn:li:activity:7513585607588069376/">View analytics</a>
    </div>
  </div>
  <div data-lazy-mount-id="a2" style="display: contents;">
    <div role="listitem">
      <div>Some One reposted this</div>
      <div aria-label="Other Person">Other Person</div>
      <span data-testid="expandable-text-box">someone else's post</span>
      <a href="https://www.linkedin.com/analytics/post-summary/urn:li:activity:7513000000000000000/">View analytics</a>
    </div>
  </div>
  <div data-lazy-mount-id="a3" style="display: contents;">
    <div role="listitem">
      <div>Feed post</div>
      <div aria-label="Some One Verified Profile You">Some One • You</div>
      <div>8h</div>
      <span data-testid="expandable-text-box">This is SO smart from American Airlines.</span>
      <button>Like</button><button>Comment</button><button>Repost</button><button>Send</button>
      <div>201 impressions</div>
      <a href="https://www.linkedin.com/analytics/post-summary/urn:li:activity:7513871504888020993/">View analytics</a>
    </div>
  </div>
</div>
</body></html>`;

test('extractActivityCards reads urn, text, counts and repost flag from the new markup', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(ACTIVITY_FIXTURE);
    const cards = await page.evaluate(extractActivityCards, 10);
    assert.deepEqual(cards, [
      {
        urn: 'urn:li:activity:7513585607588069376',
        text: 'if you hate adobe\nthis might be for you\nrepo link in the comments',
        reactions: 'Aditya Lamichhane and 14 others reacted',
        comments: '3 comments',
        reposts: '3 reposts',
        isRepost: false,
      },
      {
        urn: 'urn:li:activity:7513000000000000000',
        text: "someone else's post",
        reactions: '',
        comments: '',
        reposts: '',
        isRepost: true,
      },
      {
        urn: 'urn:li:activity:7513871504888020993',
        text: 'This is SO smart from American Airlines.',
        reactions: '',
        comments: '',
        reposts: '',
        isRepost: false,
      },
    ]);
  } finally {
    await browser.close();
  }
});

test('extractActivityCards honours the limit', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(ACTIVITY_FIXTURE);
    const cards = await page.evaluate(extractActivityCards, 1);
    assert.equal(cards.length, 1);
  } finally {
    await browser.close();
  }
});
