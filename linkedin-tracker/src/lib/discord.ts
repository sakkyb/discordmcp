import { config } from './config.js';

const API = 'https://discord.com/api/v10';

// Strip query/tracking params (?utm_source=…) so we announce the bare post URL
// and don't hand LinkedIn attribution.
export function plainUrl(url: string): string {
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}

// Discord rejects anything over 2000 characters with a 400. A Playwright
// failure pasted into an alert blows straight past that, so the alert about a
// failed send was itself failing — leaving the failure completely silent.
const DISCORD_MAX = 2000;
function fit(content: string): string {
  return content.length <= DISCORD_MAX ? content : `${content.slice(0, DISCORD_MAX - 3)}...`;
}

export interface DiscordFile { name: string; data: Buffer }

async function postMessage(channelId: string, content: string, files: DiscordFile[] = []): Promise<void> {
  content = fit(content);
  const url = `${API}/channels/${channelId}/messages`;
  const auth = { Authorization: `Bot ${config.discordToken}` };

  // JSON for the common case; multipart only when there is something to attach.
  // Note: do NOT set Content-Type for multipart — fetch derives it from FormData
  // and must include the boundary.
  let res: Response;
  if (files.length) {
    const form = new FormData();
    form.append('payload_json', JSON.stringify({ content }));
    // Buffer is a Uint8Array subclass, but its generic type does not satisfy
    // BlobPart under @types/node — wrap it rather than casting the type away.
    files.forEach((f, i) => form.append(`files[${i}]`, new Blob([new Uint8Array(f.data)]), f.name));
    res = await fetch(url, { method: 'POST', headers: auth, body: form });
  } else {
    res = await fetch(url, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
  }

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Discord message failed (${res.status}): ${detail}`);
  }
}

// Announce a newly-detected post in the Discord channel, tagging the configured
// user. Sent as the bot via the REST API — the same token the Discord bot uses,
// no gateway connection required.
//
// `note` appends context to that same message — used when the post could not be
// matched to a planned row — rather than firing a separate alert, since it is
// information about the post, not an operational failure.
export async function notifyNewPost(postUrl: string, note?: string): Promise<void> {
  const mention = config.discordMentionUserId ? `<@${config.discordMentionUserId}> ` : '';
  const body = `${mention}Today's post is now live, and here is the link to it:\n${plainUrl(postUrl)}`;
  await postMessage(config.discordChannelId, note ? `${body}\n\n${note}` : body);
}

// Operational alert (e.g. WhatsApp send failed) → the alert channel (#errors-sakky).
// Attachments are for failure evidence only — never attach on a success path,
// since a WhatsApp screenshot shows the group's contents.
export async function sendDiscordAlert(text: string, files: DiscordFile[] = []): Promise<void> {
  await postMessage(config.discordAlertChannelId, `⚠️ ${text}`, files);
}
