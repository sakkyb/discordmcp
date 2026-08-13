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
  // Optional. Used to match a live post to its planned row by content. When
  // absent the tracker falls back to date-only matching, so this deliberately
  // does NOT appear in validateConfig().
  get anthropicApiKey(): string | null {
    return process.env.ANTHROPIC_API_KEY || null;
  },
  // New posts are announced in Discord (the bot posts to a channel via the REST
  // API — no gateway/intents needed). Channel and mention default to the
  // "LinkedIn Maxxing" #general and adi.lami; override in .env if they change.
  get discordToken(): string {
    return required('DISCORD_TOKEN');
  },
  get discordChannelId(): string {
    return process.env.DISCORD_CHANNEL_ID || '1456684379408695351'; // #content-posted
  },
  // Channel for operational alerts (e.g. WhatsApp send failures) — defaults to
  // "LinkedIn Maxxing" #error-messages, so failures don't get lost in chat.
  get discordAlertChannelId(): string {
    return process.env.DISCORD_ALERT_CHANNEL_ID || '1537381914543915048';
  },
  get discordMentionUserId(): string | null {
    return process.env.DISCORD_MENTION_USER_ID ?? '541101599368675329';
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
