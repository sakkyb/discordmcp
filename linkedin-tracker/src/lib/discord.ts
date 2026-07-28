import { config } from './config.js';

const API = 'https://discord.com/api/v10';

// Strip query/tracking params (?utm_source=…) so we announce the bare post URL
// and don't hand LinkedIn attribution.
export function plainUrl(url: string): string {
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}

async function postMessage(channelId: string, content: string): Promise<void> {
  const res = await fetch(`${API}/channels/${channelId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bot ${config.discordToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Discord message failed (${res.status}): ${detail}`);
  }
}

// Announce a newly-detected post in the Discord channel, tagging the configured
// user. Sent as the bot via the REST API — the same token the Discord bot uses,
// no gateway connection required.
export async function notifyNewPost(postUrl: string): Promise<void> {
  const mention = config.discordMentionUserId ? `<@${config.discordMentionUserId}> ` : '';
  await postMessage(config.discordChannelId, `${mention}Today's post is now live, and here is the link to it:\n${plainUrl(postUrl)}`);
}

// Operational alert (e.g. WhatsApp send failed) → the alert channel (#random-chat).
export async function sendDiscordAlert(text: string): Promise<void> {
  await postMessage(config.discordAlertChannelId, `⚠️ ${text}`);
}
