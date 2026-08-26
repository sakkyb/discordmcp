// The loop that acts on wa-recover.ts's decisions: send, and if it fails,
// re-assert the one precondition that is wrong and send again — in this run,
// not 30 minutes from now.
//
// Everything here touches the machine, so the decisions it obeys live in
// wa-recover.ts as pure functions. This file only sequences them.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { PACKAGE_ROOT, config } from './config.js';
import { sendViaWhatsAppApp, gatherWhatsAppEvidence, type WhatsAppEvidence } from './whatsapp-app.js';
import { causeOf, planFor, renderReport, type Attempt, type RemedyAction, type Report } from './wa-recover.js';
import type { DiscordFile } from './discord.js';

const execFileAsync = promisify(execFile);
const SEND_SCRIPT = path.join(PACKAGE_ROOT, 'scripts', 'wa-send.applescript');

// Three passes: enough for a transient window to be dismissed and for the app
// to be relaunched, few enough that a genuinely stuck machine still leaves the
// 30-minute retry slot intact rather than eating it.
const MAX_PASSES = 3;

async function applyRemedy(action: RemedyAction): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('osascript', [SEND_SCRIPT, 'recover', action], { timeout: 45_000 });
    return stdout.trim() === 'ok';
  } catch {
    // A remedy that threw did not work. The caller stops rather than retrying
    // into the same wall, and the report records the ✗.
    return false;
  }
}

// Hand the evidence to Claude and get back one paragraph.
//
// Read-only by construction: the allow-list is Read/Grep/Glob, so Claude can
// open the tracker's logs and source to work out what happened but cannot run a
// command, edit a file or reach the network. The worst a wrong answer can do is
// put a misleading sentence in Discord. That asymmetry is the whole reason the
// SEND path stays deterministic and only the DIAGNOSIS is delegated.
//
// The binary is addressed absolutely. `claude` lives in ~/.local/bin, which is
// not on launchd's PATH — the same trap that broke screencapture.
export async function askClaude(evidence: string, errorMessage: string): Promise<{ says?: string; error?: string }> {
  const bin = config.claudeBin;
  const prompt = [
    'A scheduled macOS job failed to send a WhatsApp message. Its automated recovery ladder',
    'could not fix it. Read the evidence and reply with at most three sentences: the most',
    'likely cause, and the single next action a human should take. No preamble, no lists.',
    `You may read files under ${PACKAGE_ROOT} — logs/tracker.err.log and src/ are the useful ones.`,
    '',
    `ERROR: ${errorMessage}`,
    '',
    'EVIDENCE:',
    evidence,
  ].join('\n');

  try {
    const { stdout } = await execFileAsync(bin, ['-p', prompt, '--allowedTools', 'Read', 'Grep', 'Glob'], {
      timeout: 120_000,
      cwd: PACKAGE_ROOT,
      maxBuffer: 1024 * 1024,
    });
    const says = stdout.trim();
    return says ? { says } : { error: 'claude returned nothing' };
  } catch (error) {
    const e = error as { stderr?: string; stdout?: string; message?: string; killed?: boolean };
    if (e.killed) return { error: 'claude timed out after 120s' };
    // "Not logged in" arrives on stdout, not stderr, and is the failure most
    // likely to hit under launchd: the OAuth token lives in the Keychain.
    const detail = (e.stdout ?? '').trim() || (e.stderr ?? '').trim() || e.message || 'unknown error';
    return { error: detail.replace(/\s+/g, ' ').slice(0, 200) };
  }
}

export interface LoopResult {
  sent: boolean;
  // Absent when the first send succeeded: nothing went wrong, so there is
  // nothing to announce.
  report?: string;
  files: DiscordFile[];
}

// Send, recovering in place from the causes that can be recovered from.
//
// Returns sent:true with no report when it worked first time. Any other outcome
// carries a report for #errors-sakky naming the cause and every remedy tried.
export async function sendWithRecovery(message: string, group: string): Promise<LoopResult> {
  const attempted: Attempt[] = [];
  let lastError = '';
  let evidence: WhatsAppEvidence | null = null;

  for (let pass = 0; pass < MAX_PASSES; pass++) {
    try {
      await sendViaWhatsAppApp(message, group);
      // Nothing to report unless we had to work for it.
      if (!attempted.length) return { sent: true, files: [] };
      return {
        sent: true,
        report: renderReport({
          cause: causeOf(evidence!.probe, evidence!.displays, evidence!.screenText, lastError),
          why: evidence!.summary,
          attempted,
          recovered: true,
        }),
        files: [],
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      evidence = await gatherWhatsAppEvidence();
      const cause = causeOf(evidence.probe, evidence.displays, evidence.screenText, lastError);
      const plan = planFor(cause);
      console.error(`  → send failed (${cause}); ${plan.action ? `trying ${plan.action}` : 'not recoverable here'}`);

      if (!plan.retry || !plan.action) break;

      const ok = await applyRemedy(plan.action);
      attempted.push({ action: plan.action, ok });
      // A remedy that failed means the next send would hit the same wall.
      if (!ok) break;
    }
  }

  // Out of passes, or stopped on a cause no script may fix.
  const cause = causeOf(evidence!.probe, evidence!.displays, evidence!.screenText, lastError);
  const report: Report = {
    cause,
    why: `${evidence!.summary}\n${lastError}`,
    attempted,
    recovered: false,
  };

  if (planFor(cause).escalate) {
    const { says, error } = await askClaude(evidence!.summary, lastError);
    report.claudeSays = says;
    report.claudeError = error;
  }

  return { sent: false, report: renderReport(report), files: evidence!.files };
}
