// Parses the record emitted by `wa-send.applescript probe` and turns it into a
// sentence that names the CAUSE of a send failure.
//
// Why this exists: composerHasFocus() returned false for two unrelated
// conditions — WhatsApp not frontmost, and focus not being a text area — and the
// caller threw one message for both. Five production failures produced five
// identical strings and identified nothing.

export interface ProbeRecord {
  waFrontmost: boolean;
  frontmostApp: string;
  focusedRole: string;
  windowCount: number;
  bounds: string;
}

export function parseProbe(raw: string): ProbeRecord {
  const kv = new Map<string, string>();
  for (const part of (raw ?? '').trim().split('|')) {
    const i = part.indexOf('=');
    if (i > 0) kv.set(part.slice(0, i), part.slice(i + 1));
  }
  return {
    waFrontmost: kv.get('waFrontmost') === 'true',
    frontmostApp: kv.get('frontmostApp') || 'unknown',
    focusedRole: kv.get('focusedRole') || 'none',
    windowCount: Number(kv.get('windowCount') ?? 0) || 0,
    bounds: kv.get('bounds') || '',
  };
}

// What the SCREEN says, via Vision OCR. This is the only way to see a modal:
// WhatsApp's accessibility tree reports every text value as "missing value", so
// an update prompt and a normal chat window both read as "AXGroup".
const SCREEN_PATTERNS: [RegExp, string][] = [
  [/enter password|touch id|unlock/i, 'the Mac is LOCKED — the login window is covering the screen'],
  [/update whatsapp|new version|version is required|update required/i,
    'WhatsApp is showing a blocking UPDATE prompt — it cannot be typed into until dismissed'],
  [/wants access to control|allow .* to control|accessibility access|screen recording/i,
    'a macOS PERMISSION dialog is open and waiting for a click nobody is there to give'],
  [/no internet|you are offline|connecting…|reconnecting/i, 'WhatsApp is disconnected from the network'],
];

export function classifyScreen(text: string): string | null {
  for (const [re, meaning] of SCREEN_PATTERNS) if (re.test(text ?? '')) return meaning;
  return null;
}

// Ordered most-specific first. `displays` is null when the count could not be read.
// `screenText` is Vision OCR output and takes priority where it matches, because
// it is direct evidence where an accessibility role is only inference.
export function describeProbe(p: ProbeRecord, displays: number | null, screenText = ''): string {
  const seen = classifyScreen(screenText);
  if (seen) return `CAUSE: ${seen}. (Read from the screen by Vision OCR.)`;

  if (displays === 0) {
    return 'CAUSE: no active display. macOS cannot make any app frontmost with zero displays attached, ' +
      'so the composer check can never pass. Check the virtual display is running.';
  }
  if (!p.waFrontmost) {
    return `CAUSE: WhatsApp did not come frontmost — "${p.frontmostApp}" held it instead ` +
      `(displays=${displays ?? 'unknown'}, windows=${p.windowCount}).`;
  }
  if (p.focusedRole !== 'AXTextArea') {
    return `CAUSE: WhatsApp was frontmost but focus was on ${p.focusedRole}, not the message composer. ` +
      'The app is probably not parked on a chat.';
  }
  return 'State looks correct (frontmost, composer focused) — the failure is elsewhere in the send.';
}
