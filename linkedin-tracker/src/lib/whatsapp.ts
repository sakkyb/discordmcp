import { WHATSAPP_SESSION_DIR } from './config.js';

// whatsapp-web.js is CommonJS; import dynamically to keep ESM happy.
// The client is only spun up when there's actually something to send —
// most scheduled runs find no new post and never touch WhatsApp.
export async function sendToGroup(groupName: string, message: string): Promise<void> {
  const { default: pkg } = await import('whatsapp-web.js');
  const { Client, LocalAuth } = pkg;

  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: WHATSAPP_SESSION_DIR }),
    puppeteer: { headless: true, args: ['--no-sandbox'] },
  });

  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(
          'WhatsApp client did not become ready within 120s. ' +
          "If the session expired, run 'npm run login:whatsapp' on the Mac Mini."
        )),
        120_000
      );
      client.on('ready', () => { clearTimeout(timeout); resolve(); });
      client.on('auth_failure', (msg: string) => {
        clearTimeout(timeout);
        reject(new Error(`WhatsApp auth failed: ${msg}. Run 'npm run login:whatsapp' to re-link.`));
      });
      client.initialize().catch(reject);
    });

    const chats = await client.getChats();
    const group = chats.find(c => c.isGroup && c.name === groupName);
    if (!group) {
      const groupNames = chats.filter(c => c.isGroup).map(c => c.name).slice(0, 20);
      throw new Error(
        `WhatsApp group "${groupName}" not found. Groups visible to this account: ${groupNames.join(', ')}`
      );
    }
    await group.sendMessage(message);
    // Give the message a moment to actually flush before tearing down.
    await new Promise(resolve => setTimeout(resolve, 3000));
  } finally {
    await client.destroy().catch(() => {});
  }
}
