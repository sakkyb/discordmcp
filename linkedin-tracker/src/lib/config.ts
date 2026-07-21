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
  get whatsappGroupName(): string | null {
    return process.env.WHATSAPP_GROUP_NAME || null;
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
