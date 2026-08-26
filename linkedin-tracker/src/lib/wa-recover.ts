// Turns a WhatsApp send failure into a decision: fix it and retry now, or stop
// and say why.
//
// Before this existed the job named the cause correctly (see wa-probe.ts) and
// then did nothing about it — it waited 30 minutes for the next launchd slot and
// failed the same way, three mornings running, until a human read the channel.
// The classifier was never the weak part; acting on it was missing.
//
// The split here is deliberate: everything in this file is a pure function of
// the evidence, so the decisions can be tested without a Mac, a display or a
// WhatsApp window. The loop that actually clicks things lives in wa-loop.ts.
import { classifyScreen, type ProbeRecord } from './wa-probe.js';

export type CauseCode =
  | 'wrong-chat'
  | 'locked'
  | 'update-prompt'
  | 'permission-dialog'
  | 'offline'
  | 'no-display'
  | 'not-running'
  | 'not-frontmost'
  | 'wrong-focus'
  | 'tooling-broken'
  | 'state-ok';

export type RemedyAction = 'launch-app' | 'activate' | 'escape-then-focus';

export interface Plan {
  action: RemedyAction | null;
  // Retry the send in this run, rather than waiting for the next launchd slot.
  retry: boolean;
  // Ask Claude to read the evidence. Only worth it where a human reading the
  // channel could not tell at a glance what to do.
  escalate: boolean;
}

// Which screen readings map to which cause. classifyScreen() returns prose for
// the human; this recovers the code from it, so the two cannot drift apart.
const SCREEN_CAUSES: [RegExp, CauseCode][] = [
  [/locked/i, 'locked'],
  [/update/i, 'update-prompt'],
  [/permission/i, 'permission-dialog'],
  [/disconnected/i, 'offline'],
];

// A command that could not be found is an environment fault, not app state.
// Naming it separately matters: for a week every probe field was healthy and
// the only fault was `screencapture` missing from launchd's PATH, which read as
// "state looks correct" and pointed the reader at WhatsApp instead of at PATH.
const MISSING_BINARY = /ENOENT|FileNotFoundError|No such file or directory/i;

export function causeOf(
  probe: ProbeRecord,
  displays: number | null,
  screenText: string,
  errorMessage: string,
): CauseCode {
  // The send refused on purpose. This outranks everything — the state can look
  // perfect and the destination still be wrong.
  if (/ABORTED/.test(errorMessage)) return 'wrong-chat';

  // What Vision read off the screen is direct evidence; an accessibility role
  // is only inference, so the screen wins wherever it says anything at all.
  const seen = classifyScreen(screenText);
  if (seen) {
    for (const [re, code] of SCREEN_CAUSES) if (re.test(seen)) return code;
  }

  if (MISSING_BINARY.test(errorMessage)) return 'tooling-broken';

  // macOS cannot make any app frontmost with no display attached, so no amount
  // of activating will help and every later check is meaningless.
  if (displays === 0) return 'no-display';

  if (probe.windowCount === 0) return 'not-running';
  if (!probe.waFrontmost) return 'not-frontmost';
  if (probe.focusedRole !== 'AXTextArea') return 'wrong-focus';
  return 'state-ok';
}

const PLANS: Record<CauseCode, Plan> = {
  // Recoverable: something transient took the screen, and re-asserting is safe.
  'not-running': { action: 'launch-app', retry: true, escalate: false },
  'not-frontmost': { action: 'activate', retry: true, escalate: false },
  'wrong-focus': { action: 'escape-then-focus', retry: true, escalate: false },

  // Needs a human at the keyboard. Retrying burns the run and a Claude call
  // buys nothing — nothing it can say clears a locked Mac or an open dialog.
  locked: { action: null, retry: false, escalate: false },
  'permission-dialog': { action: null, retry: false, escalate: false },
  'no-display': { action: null, retry: false, escalate: false },
  // Safety, not practicality. Steering the app to another chat unattended is
  // precisely the accident the OCR check exists to prevent, so the loop must
  // never try — and a diagnosis is not what this needs either.
  'wrong-chat': { action: null, retry: false, escalate: false },

  // Not fixable here, but worth an explanation: these have non-obvious causes.
  'update-prompt': { action: null, retry: false, escalate: true },
  offline: { action: null, retry: false, escalate: true },
  'tooling-broken': { action: null, retry: false, escalate: true },
  // Everything the probe can see is healthy and the send still failed. This is
  // the case a human cannot resolve from the channel alone, so it is exactly
  // where a diagnosis earns its cost.
  'state-ok': { action: null, retry: false, escalate: true },
};

export function planFor(cause: CauseCode): Plan {
  return PLANS[cause];
}

export interface Attempt {
  action: RemedyAction;
  ok: boolean;
}

export interface Report {
  cause: CauseCode;
  why: string;
  attempted: Attempt[];
  recovered: boolean;
  claudeSays?: string;
  claudeError?: string;
}

// Discord's hard limit is 2000 characters and sendDiscordAlert() truncates at
// it. Staying well inside that keeps the evidence and the diagnosis both
// readable rather than letting one crowd the other out.
const WHY_MAX = 700;
const CLAUDE_MAX = 500;
function clip(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

// One headline per cause, so the first line of the message always agrees with
// the verdict. The probe summary cannot do this job: describeProbe() cannot see
// a refused send, and reports "State looks correct" for a wrong-chat abort —
// which reads as a flat contradiction of the cause directly beneath it.
const HEADLINE: Record<CauseCode, string> = {
  'wrong-chat': 'REFUSED — the open chat is not the expected group. Nothing was typed.',
  locked: 'The Mac is locked; the login window covers the screen.',
  'update-prompt': 'WhatsApp is showing a blocking update prompt.',
  'permission-dialog': 'A macOS permission dialog is open, waiting for a click.',
  offline: 'WhatsApp is disconnected from the network.',
  'no-display': 'No active display — macOS cannot bring any app frontmost.',
  'not-running': 'WhatsApp was not running.',
  'not-frontmost': 'WhatsApp could not hold frontmost.',
  'wrong-focus': 'WhatsApp was frontmost but the composer did not have focus.',
  'tooling-broken': 'A command the send depends on could not be run — check PATH, not WhatsApp.',
  'state-ok': 'Every observable precondition was healthy and the send still failed.',
};

export function renderReport(r: Report): string {
  const head = r.recovered
    ? `WhatsApp send recovered after ${r.attempted.length} attempt(s)`
    : `WhatsApp send failed — ${r.attempted.length} recovery attempt(s), still failing`;

  const lines = [head, `${r.cause}: ${HEADLINE[r.cause]}`, clip(r.why, WHY_MAX)];

  if (r.attempted.length) {
    lines.push(`Tried: ${r.attempted.map((a) => `${a.action} ${a.ok ? '✓' : '✗'}`).join(' · ')}`);
  }
  if (r.claudeSays) lines.push(`Claude says: ${clip(r.claudeSays, CLAUDE_MAX)}`);
  if (r.claudeError) lines.push(`Escalation unavailable: ${clip(r.claudeError, 200)}`);

  return lines.join('\n');
}
