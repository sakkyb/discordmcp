// Scheduled job: detect a new post on the profile and fan out notifications.
// Runs at the times defined in scripts/com.sakky.linkedin-tracker.plist.template.
// Re-runs are naturally idempotent: a post already in state.json is ignored,
// so the 30/60-minute retry slots simply no-op once the post has been caught.
import { openBrowser, getRecentPosts, postCreatedAt } from './lib/linkedin.js';
import {
  loadState, saveState, recordWhatsAppFailure, clearWhatsAppPending, duePending,
  MAX_WHATSAPP_ATTEMPTS,
} from './lib/state.js';
import {
  addPost, findExistingPage, updateEngagement, findDatedRowsNeedingUrl, stampPostUrl,
  postDateStr, findUnstampedCandidates, replacePageBody,
} from './lib/notion.js';
import { chooseRow, classifyPost } from './lib/classify.js';
import { notifyNewPost, sendDiscordAlert, plainUrl } from './lib/discord.js';
import { sendWithRecovery } from './lib/wa-loop.js';
import { config, validateConfig } from './lib/config.js';

validateConfig();

// Scrape and match, but write nothing — for checking the matcher against the
// real feed before trusting it.
const DRY_RUN = process.env.DRY_RUN === 'true';
if (DRY_RUN) console.log('DRY RUN — no Notion or Discord writes will be made.');

// Only same-day posts get announced; see the guard further down.
const ANNOUNCE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const state = loadState();
const firstRun = state.knownUrns.length === 0;

console.log(`[${new Date().toISOString()}] Checking for new LinkedIn posts...`);

const browser = await openBrowser();
let posts;
try {
  const page = browser.pages()[0] ?? await browser.newPage();
  posts = await getRecentPosts(page, 10);
} finally {
  await browser.close();
}

console.log(`Found ${posts.length} recent posts on the profile.`);

const newPosts = posts.filter(p => !state.knownUrns.includes(p.urn));

// One place that sends, records the outcome and alerts — used by both the
// new-post path and the retry path so they cannot drift apart.
async function trySendWhatsApp(urn: string, url: string): Promise<boolean> {
  if (!config.whatsappWebGroup) return true;

  // sendWithRecovery does not just try once: it names the cause of a failure,
  // re-asserts the one precondition that is wrong and sends again, all inside
  // this run. Only what it cannot fix reaches the code below.
  const { sent, report, files } = await sendWithRecovery(
    `Today's post is now live: ${plainUrl(url)}`,
    config.whatsappWebGroup,
  );

  if (sent) {
    console.log(`  → Sent to WhatsApp group "${config.whatsappWebGroup}".`);
    state.pendingWhatsApp = clearWhatsAppPending(state.pendingWhatsApp, urn);
    // A send that needed recovery still worked, but the reason it needed it is
    // worth knowing before the remedy stops working.
    if (report) {
      try {
        await sendDiscordAlert(report);
      } catch (alertErr) {
        console.error('  → Discord alert failed:', alertErr instanceof Error ? alertErr.message : alertErr);
      }
    }
    return true;
  }

  state.pendingWhatsApp = recordWhatsAppFailure(state.pendingWhatsApp, urn, url);
  const attempts = state.pendingWhatsApp.find((p) => p.urn === urn)?.attempts ?? 1;
  const giveUp = attempts >= MAX_WHATSAPP_ATTEMPTS;
  // Surface the failure in Discord so it's never silent (Discord is reliable),
  // carrying enough state to name the cause rather than restate the symptom.
  try {
    await sendDiscordAlert(
      `WhatsApp notification did NOT send for today's post (${plainUrl(url)}). ` +
      `Attempt ${attempts}/${MAX_WHATSAPP_ATTEMPTS}${giveUp ? ' — giving up.' : ' — will retry next slot.'}\n${report}`,
      files,
    );
  } catch (alertErr) {
    console.error('  → Discord alert also failed:', alertErr instanceof Error ? alertErr.message : alertErr);
  }
  return false;
}

// Retry any WhatsApp sends that failed on an earlier slot. This runs BEFORE the
// no-new-posts exit, because a retry is due whether or not there is a new post —
// putting it after would mean retries only ever ran on days with a new post.
const retries = duePending(state.pendingWhatsApp, (urn) =>
  Date.now() - postCreatedAt(urn).getTime() <= ANNOUNCE_MAX_AGE_MS);
for (const p of retries) {
  console.log(`Retrying WhatsApp for ${p.urn} (attempt ${p.attempts + 1}/${MAX_WHATSAPP_ATTEMPTS})...`);
  await trySendWhatsApp(p.urn, p.url);
}
if (retries.length) saveState(state);

if (newPosts.length === 0) {
  console.log('No new posts since last check.');
  process.exit(0);
}

// On the very first run there's no baseline — record everything currently on
// the profile without notifying, otherwise old posts would spam Notion/Discord.
if (firstRun) {
  state.knownUrns.push(...posts.map(p => p.urn));
  saveState(state);
  console.log(`First run: recorded ${posts.length} existing posts as baseline. No notifications sent.`);
  process.exit(0);
}

for (const post of newPosts.reverse()) { // oldest first so ordering reads naturally
  console.log(`New post detected: ${post.urn}`);

  let notionUrl: string | null = null;
  let unmatchedNote: string | null = null;
  try {
    // 1. Already stamped (e.g. a re-run)? Just refresh engagement.
    const already = await findExistingPage(post);
    if (already) {
      notionUrl = DRY_RUN ? '(dry run)' : await updateEngagement(already, post);
      console.log(`  → Row already has this post; refreshed engagement: ${notionUrl}`);
    } else {
      // 2. Match the post to its planned row by what the post is about. Date
      //    alone is unreliable: plans slip days, several posts share a day, and
      //    plans that were never posted sit on their date waiting to absorb the
      //    wrong URL.
      const candidates = await findUnstampedCandidates(postCreatedAt(post.urn));
      const decision = await chooseRow(post.text, candidates, classifyPost);

      if (decision.kind === 'match') {
        console.log(`  → Matched "${decision.candidate.name}" (${decision.reason})`);
        if (DRY_RUN) {
          notionUrl = '(dry run)';
        } else {
          notionUrl = await stampPostUrl(decision.candidate.id, post);
          // Best-effort: the URL and metrics are the load-bearing part, so a
          // failure to swap the drafts out must not fail the stamp.
          try {
            await replacePageBody(decision.candidate.id, post.text);
          } catch (error) {
            console.error('  → Could not replace the page body:', error instanceof Error ? error.message : error);
          }
        }
      } else if (decision.kind === 'none') {
        notionUrl = DRY_RUN ? '(dry run)' : await addPost(post);
        console.log(`  → No planned row matched (${decision.reason}); created a new one: ${notionUrl}`);
        unmatchedNote =
          "By the way — I couldn't match this to a planned row in the Content schedule, so I added a new one" +
          (DRY_RUN ? '.' : `: ${notionUrl}`);
      } else {
        // 3. Classifier unavailable — fall back to the old date-only match so a
        //    missing key or a flaky network degrades rather than breaks.
        const dateStr = postDateStr(post);
        const dated = await findDatedRowsNeedingUrl(dateStr);
        if (dated.length === 1) {
          notionUrl = DRY_RUN ? '(dry run)' : await stampPostUrl(dated[0], post);
          console.log(`  → Classifier unavailable; stamped the only ${dateStr} row: ${notionUrl}`);
        } else {
          notionUrl = DRY_RUN ? '(dry run)' : await addPost(post);
          console.warn(`  → Classifier unavailable and ${dated.length} rows dated ${dateStr} are empty; created a new row: ${notionUrl}`);
        }
      }
    }
  } catch (error) {
    console.error('  → Notion write failed:', error);
  }

  // Announce same-day posts only. After an outage the tracker catches up on
  // everything it missed, and a day-old "Today's post is now live" is worse
  // than no message — the row is still stamped and recorded, just not shouted
  // about.
  const ageMs = Date.now() - postCreatedAt(post.urn).getTime();
  const tooOldToAnnounce = ageMs > ANNOUNCE_MAX_AGE_MS;

  if (DRY_RUN) {
    console.log(`  → (dry run) skipped Discord and WhatsApp.${unmatchedNote ? ` Would have added: "${unmatchedNote}"` : ''}`);
  } else if (tooOldToAnnounce) {
    console.log(`  → Recorded but not announced: post is ${(ageMs / 3_600_000).toFixed(1)}h old (catch-up after an outage).`);
  } else {
    try {
      await notifyNewPost(post.url, unmatchedNote ?? undefined);
      console.log('  → Announced in Discord #content-posted.');
    } catch (error) {
      console.error('  → Discord notify failed:', error);
    }

    // Opt-in extra channel: WhatsApp group via the macOS WhatsApp app. A failure
    // here is recorded for retry on a later slot rather than lost.
    await trySendWhatsApp(post.urn, post.url);

    // Mark as seen even if a notification failed — we'd rather miss one
    // notification than re-spam the channel on every retry slot. Dry runs skip
    // this so they can be re-run.
    state.knownUrns.push(post.urn);
    saveState(state);
  }
}

console.log('Done.');
process.exit(0);
