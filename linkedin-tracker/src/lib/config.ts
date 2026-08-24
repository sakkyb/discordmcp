import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Everything lives relative to the linkedin-tracker/ package root,
// regardless of the cwd launchd happens to use.
export const PACKAGE_ROOT = path.resolve(__dirname, '..', '..');

dotenv.config({ path: path.join(PACKAGE_ROOT, '.env') });

export const CHROME_PROFILE_DIR = path.join(PACKAGE_ROOT, 'chrome-profile');
export const STATE_FILE = path.join(PACKAGE_ROOT, 'state.json');

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`❌ ${name} is not set (see .env.example)`);
    process.exit(1);
  }
  return value;
}

export const config = {
  get linkedinProfileUrl(): string {
    // e.g. https://www.linkedin.com/in/your-slug — no trailing slash needed
    return required('LINKEDIN_PROFILE_URL').replace(/\/+$/, '');
  },
  get notionToken(): string {
    return required('NOTION_TOKEN');
  },
  get notionDatabaseId(): string {
    return required('NOTION_LINKEDIN_DATABASE_ID');
  },
  // Which python3 runs the OCR chat-header check. Must have pyobjc installed
  // (pyobjc-framework-Vision, pyobjc-framework-Quartz). Defaults to an absolute
  // path rather than relying on PATH: launchd runs with a minimal PATH where
  // `python3` resolves to /usr/bin/python3, which has no pyobjc — the same
  // environment trap that made the node binary need its own permission grants.
  get pythonBin(): string {
    return process.env.PYTHON_BIN || '/usr/local/bin/python3';
  },
  // Optional. Used to match a live post to its planned row by content. When
  // absent the tracker falls back to date-only matching, so this deliberately
  // does NOT appear in validateConfig().
  get anthropicApiKey(): string | null {
    return process.env.ANTHROPIC_API_KEY || null;
  },
  // New posts are announced in Discord (the bot posts to a channel via the REST
  // API — no gateway/intents needed). Channel and mention default to the
  // "LinkedIn Maxxing" #content-posted and adi.lami; override in .env if they change.
  get discordToken(): string {
    return required('DISCORD_TOKEN');
  },
  get discordChannelId(): string {
    return process.env.DISCORD_CHANNEL_ID || '1456684379408695351'; // #content-posted
  },
  // Channel for operational alerts (e.g. WhatsApp send failures) — defaults to
  // "LinkedIn Maxxing" #errors-sakky, so failures don't get lost in chat.
  get discordAlertChannelId(): string {
    return process.env.DISCORD_ALERT_CHANNEL_ID || '1537381914543915048';
  },
  get discordMentionUserId(): string | null {
    return process.env.DISCORD_MENTION_USER_ID ?? '541101599368675329';
  },
  // Tomorrow's-post previews go to "LinkedIn Maxxing" #content-upcoming, kept
  // separate from #content-posted so "about to go out" never reads as "live".
  get discordPreviewChannelId(): string {
    return process.env.DISCORD_PREVIEW_CHANNEL_ID || '1541343781155115038'; // #content-upcoming
  },
  // Absolute path to the portfolio-20k repo, whose /linkedin-preview page renders
  // the phone mock we screenshot. Served locally for a few seconds per run
  // rather than deployed, so this is a path and not a URL.
  get portfolio20kDir(): string {
    return required('PORTFOLIO_20K_DIR');
  },
  // Port the temporary `next start` listens on. Fixed rather than random so a
  // stale process from a killed run is easy to spot and reap.
  get previewPort(): number {
    return Number(process.env.PREVIEW_PORT || 4321);
  },
  // LinkedIn has no page or public API for scheduled posts — the composer modal
  // is the only UI, and it does not open under automation. So we call the same
  // internal GraphQL query the modal itself uses. The queryId is version-stamped
  // and WILL rotate when LinkedIn ships a new frontend; when it does the call
  // 400s and the job fails loudly. Re-capture it from DevTools (Network tab,
  // filter "graphql", open the scheduled-posts list) and set this env var.
  get scheduledQueryId(): string {
    return (
      process.env.LINKEDIN_SCHEDULED_QUERY_ID ||
      'voyagerContentcreationDashSharePreviews.bcae3f9b4dca29d5c589c05485dad181'
    );
  },
  // Opt-in extra channel: if set, new posts are also sent to this WhatsApp group
  // via the macOS WhatsApp app (see lib/whatsapp-app.ts). Empty = disabled
  // (Discord remains the primary notification). The name is not used to select
  // the chat — the app stays parked on it — but it gates the send and labels
  // the log line.
  get whatsappWebGroup(): string | null {
    return process.env.WHATSAPP_WEB_GROUP_NAME || null;
  },
  // Headed Chrome looks like normal browsing; keep it unless you know
  // why you want headless.
  get headless(): boolean {
    return process.env.HEADLESS === 'true';
  },
};

// Fail fast on missing configuration before doing anything expensive
// (like launching Chrome).
export function validateConfig(): void {
  void config.linkedinProfileUrl;
  void config.notionToken;
  void config.notionDatabaseId;
}
