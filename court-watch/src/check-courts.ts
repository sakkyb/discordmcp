// One check: fetch each venue, find free tennis slots in the user's window
// (weekends, weekday evenings), push the ones that were not free last time
// to ntfy, and remember the current set. launchd runs this every 10 minutes.

import { config, validateConfig, TIME_ZONE } from './lib/config.js';
import { fetchVenueSessions } from './lib/clubspark.js';
import { parseSlots, inWindow, diffNew } from './lib/slots.js';
import { loadState, saveState, replaceVenueSnapshot, shouldAlert } from './lib/state.js';
import { buildNotification, type Notification } from './lib/report.js';
import { publish, alert } from './lib/ntfy.js';
import { localNow, addDays, inActiveHours } from './lib/time.js';

async function main(): Promise<void> {
  validateConfig();
  const now = new Date();
  const local = localNow(now, TIME_ZONE);
  const stamp = `${local.date} ${String(Math.floor(local.minutes / 60)).padStart(2, '0')}:${String(local.minutes % 60).padStart(2, '0')}`;

  if (!inActiveHours(local.minutes, config.activeHours)) {
    console.log(`${stamp} outside active hours, nothing to do`);
    return;
  }

  const state = loadState();
  let next = state;
  const failures: string[] = [];
  const toSend: Notification[] = [];
  const endDate = addDays(local.date, config.horizonDays);

  for (const venue of config.venues) {
    try {
      const data = await fetchVenueSessions(venue.segment, local.date, endDate);
      const slots = parseSlots(venue.segment, data).filter((s) =>
        inWindow(s, { eveningStart: config.eveningStart, now: local }),
      );
      const fresh = diffNew(slots, state.free);
      console.log(`${stamp} ${venue.name}: ${slots.length} free in window, ${fresh.length} new`);
      if (fresh.length) toSend.push(buildNotification(venue, fresh));
      next = replaceVenueSnapshot(next, venue.segment, slots);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`${stamp} ${venue.name}: ${msg}`);
      failures.push(`${venue.name}: ${msg}`);
    }
  }

  if (config.dryRun) {
    for (const n of toSend) console.log(`\n[dry run] ${n.title}\n${n.body}\n${n.click}`);
    if (!toSend.length) console.log('[dry run] nothing new');
    console.log('\nDRY_RUN: nothing published, nothing saved.');
    if (failures.length) process.exitCode = 1;
    return;
  }

  const target = { server: config.ntfyServer, topic: config.ntfyTopic };
  for (const n of toSend) {
    await publish(n, target);
    console.log(`${stamp} published: ${n.title}`);
  }

  next = { ...next, lastRun: now.toISOString() };

  if (failures.length) {
    if (shouldAlert(next, now.toISOString())) {
      await alert(failures.join('\n'), target);
      next = { ...next, lastAlertAt: now.toISOString() };
    }
    process.exitCode = 1;
  }

  // Written after publishing, so a failed publish is retried next run.
  saveState(next);
}

main().catch(async (err: Error) => {
  console.error('❌ court-watch failed:', err);
  if (!config.dryRun) {
    try {
      const target = { server: config.ntfyServer, topic: config.ntfyTopic };
      const state = loadState();
      if (shouldAlert(state, new Date().toISOString())) {
        await alert(err.message, target);
        saveState({ ...state, lastAlertAt: new Date().toISOString() });
      }
    } catch (alertErr) {
      console.error('Alert failed:', alertErr);
    }
  }
  process.exit(1);
});
