// Scheduled job: every evening, show what is going out tomorrow.
//
// Reads tomorrow's scheduled (unpublished) post from LinkedIn, renders it in the
// portfolio-20k /linkedin-preview phone mock, and posts a screenshot to Discord
// #content-upcoming. This is the "does it actually look right" check the night
// before, rather than the morning of.
//
// Runs at the time defined in scripts/com.sakky.linkedin-tomorrow-preview.plist.template.
// Safe to re-run: it only reads from LinkedIn and posts to Discord, so a repeat
// run just re-sends the same preview.
import { spawn, type ChildProcess } from 'child_process';
import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { openBrowser, getScheduledPosts, findPostForDay, type ScheduledPost } from './lib/linkedin.js';
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
let scheduled: ScheduledPost[];
const browser = await openBrowser();
let imageBytes: Buffer | null = null;
let post: ScheduledPost | null = null;
try {
  const page = browser.pages()[0] ?? await browser.newPage();
  scheduled = await getScheduledPosts(page, 10);
  console.log(`Found ${scheduled.length} scheduled post(s):`);
  for (const s of scheduled) console.log(`  - ${s.label || s.scheduledAt.toISOString()}`);

  post = findPostForDay(scheduled, day);

  // Download the image while the authenticated context is still open: the CDN
  // URLs are signed and expire, so fetching later (or from another browser) can
  // 403. Playwright's request context shares the session cookies.
  if (post?.imageUrl) {
    const res = await page.context().request.get(post.imageUrl, { timeout: 60_000 });
    if (!res.ok()) throw new Error(`Could not download the post image (HTTP ${res.status()}).`);
    imageBytes = await res.body();
    console.log(`  → Downloaded image (${Math.round(imageBytes.length / 1024)} KB).`);
  }
} finally {
  await browser.close();
}

if (!post) {
  console.log(`Nothing scheduled for ${dayLabel}.`);
  if (!DRY_RUN) await notifyNothingScheduled(dayLabel);
  process.exit(0);
}

console.log(`Previewing: ${post.label}`);

// ---------------------------------------------------------------------------
// 2. Serve portfolio-20k locally, just long enough to render the preview
// ---------------------------------------------------------------------------
const PORT = config.previewPort;
const BASE = `http://localhost:${PORT}`;

// `next start` needs a production build; fall back to `next dev`, which compiles
// on demand, so a missing build degrades to "slower" rather than "broken".
const hasBuild = fs.existsSync(path.join(config.portfolio20kDir, '.next', 'BUILD_ID'));
const mode = hasBuild ? 'start' : 'dev';
console.log(`Starting portfolio-20k (next ${mode}) on ${BASE}...`);

let server: ChildProcess | null = null;
let tmpImagePath: string | null = null;
let screenshot: Buffer | null = null;

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
  // 3. Fill the preview and screenshot the phone
  // ---------------------------------------------------------------------------
  // A plain browser, not the LinkedIn profile: this only touches localhost, and
  // keeping the logged-in profile out of it avoids any chance of disturbing it.
  // channel: 'chrome' uses the system Chrome, like openBrowser() does — Playwright's
  // own bundled browsers are not installed on this machine.
  const previewBrowser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await previewBrowser.newPage({ viewport: { width: 1400, height: 1000 } });
    await page.goto(`${BASE}/linkedin-preview`, { waitUntil: 'networkidle', timeout: 60_000 });

    await page.fill('#post-text', post.text);

    if (imageBytes) {
      // setInputFiles needs a real path, and the page reads the file client-side.
      tmpImagePath = path.join(os.tmpdir(), `linkedin-tomorrow-${Date.now()}.png`);
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
    screenshot = await phone.screenshot({ timeout: 30_000 });
    console.log(`  → Captured preview (${Math.round(screenshot.length / 1024)} KB).`);
  } finally {
    await previewBrowser.close();
  }
} finally {
  // Always reap the server and the temp file, so a failed run leaves nothing
  // holding the port or sitting in /tmp.
  if (server && !server.killed) {
    server.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 1_500));
    if (!server.killed) server.kill('SIGKILL');
    console.log('  → Stopped the preview server.');
  }
  if (tmpImagePath && fs.existsSync(tmpImagePath)) fs.unlinkSync(tmpImagePath);
}

// ---------------------------------------------------------------------------
// 4. Announce in Discord
// ---------------------------------------------------------------------------
if (!screenshot) throw new Error('No screenshot was produced.');

if (DRY_RUN) {
  const out = path.join(os.tmpdir(), 'tomorrow-post-preview.png');
  fs.writeFileSync(out, screenshot);
  console.log(`(dry run) Skipped Discord. Screenshot written to ${out}`);
} else {
  try {
    await notifyTomorrowPreview(
      screenshot,
      post.label || `Posting ${dayLabel}`,
      imageBytes ? undefined : '(This post has no image.)',
    );
    console.log('  → Posted to Discord #content-upcoming.');
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('  → Discord post failed:', msg);
    // Never fail silently: the whole point is the evening heads-up.
    try {
      await sendDiscordAlert(`Tomorrow's-post preview could not be posted to #content-upcoming.\n${msg}`);
    } catch { /* alert channel unreachable too — the log is all that's left */ }
    process.exitCode = 1;
  }
}

console.log('Done.');
process.exit(process.exitCode ?? 0);
