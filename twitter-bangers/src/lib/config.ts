import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Everything lives relative to the twitter-bangers/ package root, regardless
// of the cwd launchd happens to use.
export const PACKAGE_ROOT = path.resolve(__dirname, '..', '..');

dotenv.config({ path: path.join(PACKAGE_ROOT, '.env') });

// Its own profile, separate from linkedin-tracker/chrome-profile, so an X run
// never contends with a LinkedIn run for the same Chrome profile lock.
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

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    console.error(`❌ ${name} must be a non-negative number, got ${raw}`);
    process.exit(1);
  }
  return n;
}

export const config = {
  get discordToken(): string {
    return required('DISCORD_TOKEN');
  },
  get notionToken(): string {
    return required('NOTION_TOKEN');
  },
  // The "content ideas" view lives on the "Content schedule" database (inside
  // the LinkedIn page). Pages are created under its data source, not the
  // database id. Same value as NOTION_DATA_SOURCE_ID in the repo-root .env.
  get notionDataSourceId(): string {
    return process.env.NOTION_CONTENT_IDEAS_DATA_SOURCE_ID || '27801c06-49d0-80e9-af9e-000b48703100';
  },
  // Title column of that table ("Post name" on Content schedule).
  get notionTitleProperty(): string {
    return process.env.NOTION_TITLE_PROPERTY || 'Post name';
  },
  // Date column, filled with the run date so the row sorts with the week.
  get notionDateProperty(): string {
    return process.env.NOTION_DATE_PROPERTY || 'Date';
  },
  get discordChannelId(): string {
    return process.env.DISCORD_CHANNEL_ID || '1548630846737490041'; // #twitter-weekly-bangers
  },
  get discordAlertChannelId(): string {
    return process.env.DISCORD_ALERT_CHANNEL_ID || '1537381914543915048'; // #errors-sakky
  },
  get minFaves(): number {
    return num('MIN_FAVES', 50_000);
  },
  get maxPosts(): number {
    return num('MAX_POSTS', 100);
  },
  get reportCount(): number {
    return num('REPORT_COUNT', 50);
  },
  get lookbackDays(): number {
    return num('LOOKBACK_DAYS', 7);
  },
  // Relevance classifier (Claude). Same key the Discord bot and LinkedIn
  // tracker use. CLASSIFY=false skips it and reports the raw top list.
  get anthropicApiKey(): string {
    return required('ANTHROPIC_API_KEY');
  },
  get classify(): boolean {
    return process.env.CLASSIFY !== 'false';
  },
  get classifierModel(): string {
    return process.env.CLASSIFIER_MODEL || 'claude-sonnet-5';
  },
  get minScore(): number {
    return num('MIN_SCORE', 3);
  },
  get headless(): boolean {
    return process.env.HEADLESS === 'true';
  },
  get dryRun(): boolean {
    return process.env.DRY_RUN === 'true';
  },
};

// Fail fast on missing configuration before launching Chrome. A dry run
// touches neither Discord nor Notion, so it needs neither token.
export function validateConfig(): void {
  if (config.classify) void config.anthropicApiKey;
  if (config.dryRun) return;
  void config.discordToken;
  void config.notionToken;
}
