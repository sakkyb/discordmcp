// One-time interactive setup: prints a QR code in the terminal. Scan it with
// WhatsApp on your phone (Settings → Linked Devices → Link a Device). The
// session persists in whatsapp-session/ and is reused by scheduled runs.
import qrcode from 'qrcode-terminal';
import { WHATSAPP_SESSION_DIR, config } from './lib/config.js';

const { default: pkg } = await import('whatsapp-web.js');
const { Client, LocalAuth } = pkg;

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: WHATSAPP_SESSION_DIR }),
  puppeteer: { headless: true, executablePath: config.chromePath, args: ['--no-sandbox'] },
});

client.on('qr', (qr: string) => {
  console.log('Scan this QR code with WhatsApp on your phone:');
  qrcode.generate(qr, { small: true });
});

client.on('ready', async () => {
  console.log('✅ WhatsApp linked. Session saved to whatsapp-session/.');
  const chats = await client.getChats();
  const groups = chats.filter(c => c.isGroup).map(c => c.name);
  console.log(`Groups this account can post to:\n  - ${groups.join('\n  - ')}`);
  console.log('\nSet WHATSAPP_GROUP_NAME in .env to one of these (exact match).');
  await client.destroy();
  process.exit(0);
});

client.on('auth_failure', (msg: string) => {
  console.error('❌ WhatsApp auth failed:', msg);
  process.exit(1);
});

console.log('Starting WhatsApp Web client...');
client.initialize();
