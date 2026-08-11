import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Everything lives relative to the linkedin-tracker/ package root,
// regardless of the cwd launchd happens to use.
export const PACKAGE_ROOT = path.resolve(__dirname, '..', '..');

dotenv.config({ path: path.join(PACKAGE_ROOT, '.env') });

export const CHROME_PROFILE_DIR = path.join(PACKAGE_ROOT, 'chrome-profile');
export const WHATSAPP_SESSION_DIR = path.join(PACKAGE_ROOT, 'whatsapp-session');
// Separate persistent Chrome profile for WhatsApp Web (Playwright UI automation),
// kept apart from the LinkedIn scraping profile so the two sessions don't clash.
export const WHATSAPP_WEB_PROFILE_DIR = path.join(PACKAGE_ROOT, 'whatsapp-web-profile');
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
    return process.env.DISCORD_CHANNEL_ID || '1456685055656329237';
  },
  // Channel for operational alerts (e.g. WhatsApp send failures) — defaults to
  // "LinkedIn Maxxing" #random-chat.
  get discordAlertChannelId(): string {
    return process.env.DISCORD_ALERT_CHANNEL_ID || '1456686005154480239';
  },
  get discordMentionUserId(): string | null {
    return process.env.DISCORD_MENTION_USER_ID ?? '541101599368675329';
  },
  // Opt-in extra channel: if set, new posts are also sent to this WhatsApp group
  // by driving WhatsApp Web via Playwright (see lib/whatsapp-web.ts). Empty =
  // disabled (Discord remains the primary notification).
  get whatsappWebGroup(): string | null {
    return process.env.WHATSAPP_WEB_GROUP_NAME || null;
  },
  // Headed Chrome looks like normal browsing; keep it unless you know
  // why you want headless.
  get headless(): boolean {
    return process.env.HEADLESS === 'true';
  },
  // whatsapp-web.js drives Chrome via puppeteer. We point it at the system
  // Google Chrome (a universal binary → runs natively on arm64) instead of
  // puppeteer's bundled Chromium — more robust and matches the LinkedIn
  // scraper, which also uses real Chrome. Override via CHROME_PATH if needed.
  get chromePath(): string {
    return process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  },
};

// Fail fast on missing configuration before doing anything expensive
// (like launching Chrome).
export function validateConfig(): void {
  void config.linkedinProfileUrl;
  void config.notionToken;
  void config.notionDatabaseId;
}
