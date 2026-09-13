import { config } from './config.js';

const API = 'https://discord.com/api/v10';

// Discord rejects anything over 2000 characters with a 400. Alerts carry
// error text of unknown length, so every send is clipped.
const DISCORD_MAX = 2000;
const fit = (s: string) => (s.length <= DISCORD_MAX ? s : `${s.slice(0, DISCORD_MAX - 3)}...`);

// Sent as the bot via the REST API — the same token the Discord bot uses, no
// gateway connection required.
export async function postMessage(channelId: string, content: string): Promise<void> {
  const res = await fetch(`${API}/channels/${channelId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bot ${config.discordToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: fit(content) }),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Discord message failed (${res.status}): ${detail}`);
  }
}

// Chunks go out one after another so the list reads top to bottom.
export async function postReport(messages: string[]): Promise<void> {
  for (const m of messages) await postMessage(config.discordChannelId, m);
}

// Operational alert → #errors-sakky, so a failed run is never silent.
export async function sendAlert(text: string): Promise<void> {
  await postMessage(config.discordAlertChannelId, `⚠️ twitter-bangers: ${text}`);
}
