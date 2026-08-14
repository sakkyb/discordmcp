// Standalone WhatsApp send test, so the send path can be exercised (and its real
// error seen) without waiting for a new LinkedIn post.
//   npm run wa:test
import { sendViaWhatsAppApp } from './lib/whatsapp-app.js';
import { config } from './lib/config.js';

const message = process.argv[2] ?? `wa:test ${new Date().toISOString()} — please ignore`;
try {
  await sendViaWhatsAppApp(message, config.whatsappWebGroup ?? 'LinkedIn Maxxing');
  console.log('✅ sent:', message);
} catch (error) {
  console.error('❌', error instanceof Error ? error.message : error);
  process.exit(1);
}
