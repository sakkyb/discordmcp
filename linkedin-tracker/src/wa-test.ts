// Standalone WhatsApp send test, so the send path can be exercised (and its real
// error seen) without waiting for a new LinkedIn post. Runs the full recovery
// loop, not the bare send, so what this exercises is what production runs.
//   npm run wa:test
//   npm run wa:test -- "a message" "A Different Group"   (second arg forces a
//   wrong-chat refusal, for checking the safety stop without a real drift)
import { sendWithRecovery } from './lib/wa-loop.js';
import { config } from './lib/config.js';

const message = process.argv[2] ?? `wa:test ${new Date().toISOString()} — please ignore`;
const group = process.argv[3] ?? config.whatsappWebGroup ?? 'LinkedIn Maxxing';

const { sent, report } = await sendWithRecovery(message, group);
if (report) console.log(`\n--- report that would go to #errors-sakky ---\n${report}\n`);
if (sent) {
  console.log('✅ sent:', message);
} else {
  console.error('❌ not sent');
  process.exit(1);
}
