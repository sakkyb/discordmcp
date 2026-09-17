// Scheduled job: every evening, show what is going out tomorrow.
//
// Reads tomorrow's scheduled (unpublished) posts from LinkedIn, renders each one
// in the portfolio-20k /linkedin-preview phone mock, and posts one screenshot
// per post to Discord #content-upcoming, in posting order. This is the "does it
// actually look right" check the night before, rather than the morning of.
//
// Runs at the time defined in scripts/com.sakky.linkedin-tomorrow-preview.plist.template.
// Safe to re-run: it only reads from LinkedIn and posts to Discord, so a repeat
// run just re-sends the same previews.
import { spawn, type ChildProcess } from 'child_process';
import { chromium, type Page } from 'playwright';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { openBrowser, getScheduledPosts, findPostsForDay, type ScheduledPost } from './lib/linkedin.js';
import { notifyTomorrowPreview, notifyNothingScheduled } from './lib/discord.js';
import { sendDiscordAlert } from './lib/discord.js';
import { config } from './lib/config.js';

// Fail fast on the config this job actually needs, before launching Chrome.
void config.discordToken;
void config.linkedinProfileUrl;
void config.portfolio20kDir;

// Which day to preview. Defaults to tomorrow; TARGET_DATE=YYYY-MM-DD overrides it
// so the job can be tested against a day that actually has something queued.
function targetDay(): Date {
  const override = process.env.TARGET_DATE;
  if (override) {
    const [y, m, d] = override.split('-').map(Number);
    if (!y || !m || !d) throw new Error(`TARGET_DATE must be YYYY-MM-DD, got "${override}"`);
    return new Date(y, m - 1, d);
  }
  const t = new Date();
  t.setDate(t.getDate() + 1);
  return t;
}

const DRY_RUN = process.env.DRY_RUN === 'true';
const day = targetDay();
const dayLabel = day.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });

console.log(`[${new Date().toISOString()}] Checking LinkedIn's scheduled queue for ${dayLabel}...`);
if (DRY_RUN) console.log('DRY RUN — no Discord messages will be sent.');

// ---------------------------------------------------------------------------
// 1. Read the scheduled queue from LinkedIn
// ---------------------------------------------------------------------------
// A post plus its downloaded image (if it has one), so everything the preview
// needs is in hand before the LinkedIn browser closes.
interface Queued { post: ScheduledPost; imageBytes: Buffer | null }

let queued: Queued[] = [];
const browser = await openBrowser();
try {
  const page = browser.pages()[0] ?? await browser.newPage();
  const scheduled = await getScheduledPosts(page, 10);
  console.log(`Found ${scheduled.length} scheduled post(s):`);
  for (const s of scheduled) console.log(`  - ${s.label || s.scheduledAt.toISOString()}`);

  const posts = findPostsForDay(scheduled, day);

  // Download the images while the authenticated context is still open: the CDN
  // URLs are signed and expire, so fetching later (or from another browser) can
  // 403. Playwright's request context shares the session cookies.
  for (const post of posts) {
    let imageBytes: Buffer | null = null;
    if (post.imageUrl) {
      const res = await page.context().request.get(post.imageUrl, { timeout: 60_000 });
      if (!res.ok()) throw new Error(`Could not download the image for "${post.label}" (HTTP ${res.status()}).`);
      imageBytes = await res.body();
      console.log(`  → Downloaded image for "${post.label}" (${Math.round(imageBytes.length / 1024)} KB).`);
    }
    queued.push({ post, imageBytes });
  }
} finally {
  await browser.close();
}

if (queued.length === 0) {
  console.log(`Nothing scheduled for ${dayLabel}.`);
  if (!DRY_RUN) await notifyNothingScheduled(dayLabel);
  process.exit(0);
}

console.log(`${queued.length} post(s) to preview for ${dayLabel}:`);
for (const { post } of queued) console.log(`  - ${post.label}`);

// ---------------------------------------------------------------------------
// 2. Serve portfolio-20k locally, just long enough to render the previews
// ---------------------------------------------------------------------------
const PORT = config.previewPort;
const BASE = `http://localhost:${PORT}`;

// `next start` needs a production build; fall back to `next dev`, which compiles
// on demand, so a missing build degrades to "slower" rather than "broken".
const hasBuild = fs.existsSync(path.join(config.portfolio20kDir, '.next', 'BUILD_ID'));
const mode = hasBuild ? 'start' : 'dev';
console.log(`Starting portfolio-20k (next ${mode}) on ${BASE}...`);

let server: ChildProcess | null = null;
const tmpImagePaths: string[] = [];
// Screenshots in the same order as `queued`, so the Discord messages go out in
// posting order (morning slot first).
const screenshots: Buffer[] = [];

// Render one post in the phone mock and capture it. The page is reloaded for
// each post so no text or image carries over from the previous one.
async function capturePost(page: Page, { post, imageBytes }: Queued): Promise<Buffer> {
  await page.goto(`${BASE}/linkedin-preview`, { waitUntil: 'networkidle', timeout: 60_000 });

  await page.fill('#post-text', post.text);

  if (imageBytes) {
    // setInputFiles needs a real path, and the page reads the file client-side.
    const tmpImagePath = path.join(os.tmpdir(), `linkedin-tomorrow-${Date.now()}-${tmpImagePaths.length}.png`);
    tmpImagePaths.push(tmpImagePath);
    fs.writeFileSync(tmpImagePath, imageBytes);
    await page.setInputFiles('input[type="file"]', tmpImagePath);
    // The editor measures the image to set its aspect ratio before the feed
    // renders it, so wait for it to actually appear in the phone.
    await page.waitForSelector('[data-testid="phone-preview"] img', { timeout: 30_000 });
  }

  // Scroll the previewed post to the top of the phone's feed. Without this it
  // renders below an example post and the image gets cut off by the frame —
  // the screenshot has to lead with tomorrow's post, not someone else's.
  await page.evaluate(() => {
    const live = document.querySelector('[data-testid="live-post"]') as HTMLElement | null;
    const feed = live?.parentElement;
    if (live && feed) feed.scrollTop = live.offsetTop - feed.offsetTop;
  });

  // Let fonts/layout settle so the screenshot isn't caught mid-reflow.
  await page.waitForTimeout(1_500);

  const phone = page.locator('[data-testid="phone-preview"]');
  if (await phone.count() === 0) {
    throw new Error(
      'Could not find [data-testid="phone-preview"] on the preview page. If portfolio-20k ' +
      'was changed, re-add that attribute to components/linkedin-preview/PhonePreview.tsx.',
    );
  }
  const shot = await phone.screenshot({ timeout: 30_000 });
  console.log(`  → Captured "${post.label}" (${Math.round(shot.length / 1024)} KB).`);
  return shot;
}

try {
  // Run the Next CLI with the same node binary that is running this script,
  // rather than going through `npx`. launchd runs with a minimal PATH, and this
  // way the job does not depend on npx being on it at all.
  const nextCli = path.join(config.portfolio20kDir, 'node_modules', 'next', 'dist', 'bin', 'next');
  if (!fs.existsSync(nextCli)) {
    throw new Error(
      `Next CLI not found at ${nextCli}. Run 'npm install' in ${config.portfolio20kDir} first.`,
    );
  }
  server = spawn(process.execPath, [nextCli, mode, '-p', String(PORT)], {
    cwd: config.portfolio20kDir,
    stdio: 'ignore',
    detached: false,
    env: { ...process.env, NODE_ENV: hasBuild ? 'production' : 'development' },
  });
  server.on('error', (e) => console.error('  → server spawn error:', e.message));

  // Poll until the page answers rather than sleeping a fixed amount; a cold dev
  // compile is much slower than a warm production start.
  const READY_TIMEOUT_MS = 180_000;
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let ready = false;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/linkedin-preview`, { signal: AbortSignal.timeout(5_000) });
      if (r.ok) { ready = true; break; }
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  if (!ready) {
    throw new Error(
      `portfolio-20k did not serve ${BASE}/linkedin-preview within ${READY_TIMEOUT_MS / 1000}s ` +
      `(next ${mode}). Check that its dependencies are installed.`,
    );
  }
  console.log('  → Preview app is up.');

  // ---------------------------------------------------------------------------
  // 3. Fill the preview and screenshot the phone, once per post
  // ---------------------------------------------------------------------------
  // A plain browser, not the LinkedIn profile: this only touches localhost, and
  // keeping the logged-in profile out of it avoids any chance of disturbing it.
  // channel: 'chrome' uses the system Chrome, like openBrowser() does — Playwright's
  // own bundled browsers are not installed on this machine.
  const previewBrowser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await previewBrowser.newPage({ viewport: { width: 1400, height: 1000 } });
    for (const item of queued) screenshots.push(await capturePost(page, item));
  } finally {
    await previewBrowser.close();
  }
} finally {
  // Always reap the server and the temp files, so a failed run leaves nothing
  // holding the port or sitting in /tmp.
  if (server && !server.killed) {
    server.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 1_500));
    if (!server.killed) server.kill('SIGKILL');
    console.log('  → Stopped the preview server.');
  }
  for (const p of tmpImagePaths) if (fs.existsSync(p)) fs.unlinkSync(p);
}

// ---------------------------------------------------------------------------
// 4. Announce in Discord — one message per post, in posting order
// ---------------------------------------------------------------------------
if (screenshots.length !== queued.length) {
  throw new Error(`Expected ${queued.length} screenshot(s) but produced ${screenshots.length}.`);
}

const total = queued.length;
for (let i = 0; i < total; i++) {
  const { post, imageBytes } = queued[i];
  const screenshot = screenshots[i];
  const n = i + 1;

  if (DRY_RUN) {
    const out = path.join(os.tmpdir(), total > 1 ? `tomorrow-post-preview-${n}.png` : 'tomorrow-post-preview.png');
    fs.writeFileSync(out, screenshot);
    console.log(`(dry run) Skipped Discord for post ${n} of ${total}. Screenshot written to ${out}`);
    continue;
  }

  try {
    await notifyTomorrowPreview(
      screenshot,
      post.label || `Posting ${dayLabel}`,
      n,
      total,
      imageBytes ? undefined : '(This post has no image.)',
    );
    console.log(`  → Posted ${n} of ${total} to Discord #content-upcoming.`);
  } catch (error) {
    // One failed send must not swallow the rest: keep going so the other
    // previews still land, and report the miss at the end via the exit code.
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`  → Discord post ${n} of ${total} failed:`, msg);
    // Never fail silently: the whole point is the evening heads-up.
    try {
      await sendDiscordAlert(
        `Tomorrow's-post preview ${n} of ${total} ("${post.label}") could not be posted to #content-upcoming.\n${msg}`,
      );
    } catch { /* alert channel unreachable too — the log is all that's left */ }
    process.exitCode = 1;
  }
}

console.log('Done.');
process.exit(process.exitCode ?? 0);
