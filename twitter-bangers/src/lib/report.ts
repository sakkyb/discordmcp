import type { Tweet } from './tweets.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function weekLabel(date: Date): string {
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

export function formatLikes(n: number): string {
  const short = (v: number, suffix: string) => `${Number.isInteger(v) ? v : v.toFixed(1)}${suffix}`;
  if (n >= 1_000_000) return short(Math.round(n / 100_000) / 10, 'M');
  if (n >= 1_000) return short(Math.round(n / 100) / 10, 'K');
  return String(n);
}

// Discord rejects anything over 2000 characters; leave headroom.
const LIMIT = 1900;
const SNIPPET = 110;

// First non-empty line of the tweet, trimmed, so the list stays scannable.
function snippet(text: string): string {
  const line = text.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  return line.length > SNIPPET ? `${line.slice(0, SNIPPET - 1)}…` : line;
}

// Links are wrapped in <> so Discord does not unfurl 20 previews; the tweet
// cards live in Notion.
function entry(i: number, t: Tweet): string {
  const s = snippet(t.text);
  return `${i}. @${t.handle} — ${formatLikes(t.likes)} likes\n${s ? `   ${s}\n` : ''}   <${t.url}>`;
}

export interface ReportInput {
  runDate: Date;
  report: Tweet[];
  checked: number;
  notionUrl: string | null;
  notionError?: string;
}

// One message in the common case; entries spill into follow-up messages only
// when the total would pass Discord's cap. The Notion line is always last.
export function buildReportMessages(opts: ReportInput): string[] {
  const header = `**Twitter weekly bangers — week of ${weekLabel(opts.runDate)}**`;
  const footer = opts.notionError
    ? `Notion save failed: ${opts.notionError}`
    : opts.notionUrl
      ? `Saved in Notion: <${opts.notionUrl}>`
      : '';

  if (opts.report.length === 0) {
    const body = `${header}\nNo new bangers this week (${opts.checked} checked, none unseen).`;
    return [footer ? `${body}\n\n${footer}` : body];
  }

  const intro = `${header}\n${opts.report.length} new posts with 50k+ likes and images (of ${opts.checked} checked).\n`;
  const chunks: string[] = [];
  let cur = intro;
  opts.report.forEach((t, i) => {
    const e = `\n${entry(i + 1, t)}`;
    if (cur.length + e.length > LIMIT) {
      chunks.push(cur);
      cur = e.trimStart();
    } else {
      cur += e;
    }
  });
  if (footer) {
    const f = `\n\n${footer}`;
    if (cur.length + f.length > LIMIT) {
      chunks.push(cur);
      cur = footer;
    } else {
      cur += f;
    }
  }
  chunks.push(cur);
  return chunks;
}
