import { Client, GatewayIntentBits, Events, Message, TextChannel, DMChannel, NewsChannel, ThreadChannel } from 'discord.js';
import Anthropic from '@anthropic-ai/sdk';
import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import http from 'http';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config();

// Discord's declared attachment.contentType can be wrong (e.g. reports
// image/webp for bytes that are actually PNG), which Claude's API rejects.
// Sniff the real format from magic bytes instead of trusting the label.
function detectImageMediaType(buffer: Buffer): string | null {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (buffer.length >= 6 && (buffer.subarray(0, 6).toString('ascii') === 'GIF87a' || buffer.subarray(0, 6).toString('ascii') === 'GIF89a')) {
    return 'image/gif';
  }
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

// Track bot connection status
let isConnected = false;
let lastActivity = Date.now();

// Enhanced HTTP server with health check endpoint
const PORT = process.env.PORT ?? 3000;
http.createServer((req, res) => {
  if (req.url === '/health') {
    const status = {
      status: isConnected ? 'healthy' : 'unhealthy',
      discord: isConnected ? 'connected' : 'disconnected',
      uptime: process.uptime(),
      lastActivity: new Date(lastActivity).toISOString(),
      memoryUsage: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB'
    };
    res.writeHead(isConnected ? 200 : 503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(status));
  } else {
    res.writeHead(200);
    res.end('OK');
  }
}).listen(PORT);

console.log(`Health check available at http://localhost:${PORT}/health`);

const discord = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
});

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Tool: search the web via Brave Search API (requires BRAVE_API_KEY)
const webSearchTool = betaZodTool({
  name: 'web_search',
  description: 'Search the internet for current information, news, Reddit posts, or any topic',
  inputSchema: z.object({
    query: z.string().describe('The search query'),
  }),
  run: async ({ query }) => {
    const res = await fetch(
      `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5`,
      {
        headers: {
          Accept: 'application/json',
          'Accept-Encoding': 'gzip',
          'X-Subscription-Token': process.env.BRAVE_API_KEY!,
        },
        signal: AbortSignal.timeout(10000),
      }
    );
    if (!res.ok) return `Search failed with status ${res.status}`;
    const data = await res.json() as any;
    const results: any[] = data.web?.results ?? [];
    if (!results.length) return 'No results found.';
    return results.slice(0, 5).map((r: any) =>
      `Title: ${r.title}\nURL: ${r.url}\nSummary: ${r.description ?? 'N/A'}`
    ).join('\n\n');
  },
});

// Humanizer skill (vendored from github.com/blader/humanizer) — strips
// AI-writing tells from generated content so posts read as human-written.
const HUMANIZER_SKILL_PATH = path.join(__dirname, '..', 'skills', 'humanizer.md');
let humanizerSkill: string | null = null;
function loadHumanizerSkill(): string {
  if (humanizerSkill !== null) return humanizerSkill;
  try {
    humanizerSkill = fs.readFileSync(HUMANIZER_SKILL_PATH, 'utf-8');
  } catch (error) {
    console.error('Could not read humanizer skill:', error);
    humanizerSkill = '';
  }
  return humanizerSkill;
}

// Run drafted content through the humanizer skill as a second pass.
// Falls back to the original text if the skill is missing or the call fails.
async function humanize(text: string, voiceSample?: string): Promise<string> {
  const skill = loadHumanizerSkill();
  if (!skill) return text;
  try {
    const prompt = `${skill}

---

Apply the humanizer skill above to the text below. Return ONLY the rewritten text — no preamble, no notes, no audit, no explanation. Preserve the author's meaning, structure, and LinkedIn formatting (one sentence per line with a single line break between sentences, no blank lines).${voiceSample ? `\n\nMatch this author's voice:\n${voiceSample}` : ''}

TEXT TO HUMANIZE:
${text}`;

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-5',
      max_tokens: 3000,
      messages: [{ role: 'user', content: prompt }],
    });
    return response.content.find(b => b.type === 'text')?.text ?? text;
  } catch (error) {
    console.error('Humanizer pass failed, returning original draft:', error);
    return text;
  }
}

// Tool: create LinkedIn post.
// The tool's return value is only visible to the model, not to the Discord
// user. `onDraft` hands the finished post back to the handler so it can be
// posted to the channel directly — otherwise the draft never reaches the user.
const makeCreateLinkedInPostTool = (onDraft: (post: string) => void) => betaZodTool({
  name: 'create_linkedin_post',
  description: 'Generate a LinkedIn post based on provided content, images, URLs, or text following specific style guidelines',
  inputSchema: z.object({
    input: z.string().describe('The input content - can be text, URL, image description, or any source material for the post'),
    topic: z.string().optional().describe('Optional specific topic or theme for the post'),
  }),
  run: async ({ input, topic }) => {
    // Read the LinkedIn post generator v2 guidelines (vendored in-repo)
    const guidelinesPath = path.join(__dirname, '..', 'skills', 'linkedin-post-generator-v2.md');
    let guidelines = '';
    
    try {
      guidelines = fs.readFileSync(guidelinesPath, 'utf-8');
    } catch (error) {
      console.error('Could not read LinkedIn guidelines:', error);
      guidelines = 'Use best practices for LinkedIn posts';
    }

    const prompt = `Based on these LinkedIn post guidelines:

${guidelines}

Create a LinkedIn post using this input material:
${input}

${topic ? `Focus on the topic: ${topic}` : ''}

Remember to:
- Use a captivating hook from the styles mentioned
- Keep it under 150 words
- Include a thought-provoking question at the end
- Make it conversational and specific
- Reference real names/products where possible
- Structure it for maximum engagement

Provide the post first. Then, on its own line, write exactly this separator:
--- Alternative hooks ---
and after it list 3 alternative hook/second line combinations for the other hook styles you did not use.`;

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-5',
      max_tokens: 3000,
      messages: [{ role: 'user', content: prompt }],
    });

    const postContent = response.content.find(b => b.type === 'text')?.text ?? '';

    // Split the main post from the alternative-hooks section. Only the post
    // goes through the humanizer — it rewrites prose and would otherwise drop
    // the trailing hook list. The alternates are re-appended unchanged.
    const ALT_MARKER = '--- Alternative hooks ---';
    const markerIdx = postContent.indexOf(ALT_MARKER);
    const mainPost = markerIdx === -1 ? postContent : postContent.slice(0, markerIdx).trim();
    const altHooks = markerIdx === -1 ? '' : postContent.slice(markerIdx).trim();

    // Second pass: strip AI-writing tells so the post reads as human-written.
    const humanizedPost = await humanize(mainPost);
    const result = altHooks ? `${humanizedPost}\n\n${altHooks}` : humanizedPost;
    onDraft(result);
    return result;
  },
});

// Tool: fetch and read the content of a URL
const fetchUrlTool = betaZodTool({
  name: 'fetch_url',
  description: 'Fetch and read the text content of any webpage or URL',
  inputSchema: z.object({
    url: z.string().describe('The full URL to fetch (must start with http:// or https://)'),
  }),
  run: async ({ url }) => {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ClaudeDiscordBot/1.0)' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return `Failed to fetch URL (status ${res.status})`;
    const html = await res.text();
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 8000);
    return text || 'No readable content found at this URL.';
  },
});

// 2025-09-03 is the first API version that supports databases with multiple
// data sources (the Content schedule DB is now multi-source). Pages are created
// under a data_source_id rather than a database_id in this version.
const NOTION_API_VERSION = '2025-09-03';
const NOTION_CONTENT_SCHEDULE_TYPES = [
  'Everyday UX (Monday & Wednesday)',
  'AI/UX Opinion (Tuesday)',
  'Video/Article (Thursday)',
  'Design inspo (stopped)',
  'Meme (Sunday)',
  'Personal life',
] as const;

function draftToNotionBlocks(draftBody: string) {
  const paragraphs = draftBody.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
  const blocks: any[] = [];
  for (const p of paragraphs) {
    for (let i = 0; i < p.length; i += 2000) {
      blocks.push({
        object: 'block',
        type: 'paragraph',
        paragraph: {
          rich_text: [{ type: 'text', text: { content: p.slice(i, i + 2000) } }],
        },
      });
    }
  }
  return blocks.slice(0, 100);
}

// An image pulled off Discord, ready to hand to Notion.
type PendingImage = { buffer: Buffer; filename: string; contentType: string };

// Notion's Direct Upload is two calls: reserve an upload slot, then send the
// bytes. Returns the file_upload id to reference from an image block. We upload
// the bytes rather than pointing Notion at the Discord CDN url, because those
// urls are signed and expire — an external-url image would rot within a day.
async function uploadImageToNotion(img: PendingImage): Promise<string | null> {
  try {
    const createRes = await fetch('https://api.notion.com/v1/file_uploads', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.NOTION_TOKEN}`,
        'Notion-Version': NOTION_API_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        mode: 'single_part',
        filename: img.filename,
        content_type: img.contentType,
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!createRes.ok) {
      console.error(`Notion file_upload create failed (${createRes.status}):`, (await createRes.text()).slice(0, 300));
      return null;
    }
    const { id } = await createRes.json() as any;

    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(img.buffer)], { type: img.contentType }), img.filename);

    const sendRes = await fetch(`https://api.notion.com/v1/file_uploads/${id}/send`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.NOTION_TOKEN}`,
        'Notion-Version': NOTION_API_VERSION,
      },
      body: form,
      signal: AbortSignal.timeout(60000),
    });
    if (!sendRes.ok) {
      console.error(`Notion file_upload send failed (${sendRes.status}):`, (await sendRes.text()).slice(0, 300));
      return null;
    }
    return id;
  } catch (error) {
    console.error('Notion image upload error:', error);
    return null;
  }
}

// Notion rejects single_part uploads over 20MB, and free workspaces cap at 5MB.
// Discord's reported attachment.size can understate the bytes the CDN actually
// serves (seen 4x), so gate on the real buffer length instead.
const NOTION_MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

// Tool: add a new idea row to the Notion "Content schedule" database
const makeAddToContentScheduleTool = (getImage: () => Promise<PendingImage | null>) => betaZodTool({
  name: 'add_to_content_schedule',
  description: 'Add a new content idea row to the Notion "Content schedule" database. Use when the user wants to save a post idea, dump an idea into Notion, or asks to populate the content table. If you have drafted post content, pass it as draftBody so it lives inside the Notion page body.',
  inputSchema: z.object({
    postName: z.string().describe('Working title for the post idea — short and concrete'),
    type: z.enum(NOTION_CONTENT_SCHEDULE_TYPES).optional().describe('Content category, classified from the input. Pick the closest match.'),
    date: z.string().optional().describe('Target publish date in YYYY-MM-DD format. Only set if the user mentioned a specific or relative date (resolve relative dates like "next Tuesday" to absolute).'),
    inspiredByUrl: z.string().url().optional().describe('Source URL the idea was inspired by, only if a URL was provided.'),
    draftBody: z.string().optional().describe('Full draft post content, formatted as it should appear when typed into the Notion page (hook + body + any alternative hooks/notes). Preserve paragraph breaks with blank lines. Do NOT include Discord-specific markdown like leading ">" quote markers — write it as if typing directly into Notion.'),
  }),
  run: async ({ postName, type, date, inspiredByUrl, draftBody }) => {
    const properties: Record<string, any> = {
      'Post name': { title: [{ text: { content: postName } }] },
    };
    if (type) properties.Type = { select: { name: type } };
    if (date) properties.Date = { date: { start: date } };
    if (inspiredByUrl) properties['Inspired by'] = { url: inspiredByUrl };

    const body: Record<string, any> = {
      parent: { type: 'data_source_id', data_source_id: process.env.NOTION_DATA_SOURCE_ID },
      properties,
    };
    const children: any[] = draftBody && draftBody.trim() ? draftToNotionBlocks(draftBody) : [];

    // Attach whatever image came with the Discord message. This is taken from
    // the message itself rather than a tool parameter, so the model never has
    // to pass a url around and can't get it wrong.
    const img = await getImage();
    let imageNote = '';
    if (img) {
      if (img.buffer.length > NOTION_MAX_UPLOAD_BYTES) {
        imageNote = ` (image skipped — ${(img.buffer.length / 1048576).toFixed(1)}MB exceeds Notion's upload limit)`;
      } else {
        const uploadId = await uploadImageToNotion(img);
        if (uploadId) {
          children.push({
            object: 'block',
            type: 'image',
            image: { type: 'file_upload', file_upload: { id: uploadId } },
          });
          imageNote = ' with the image attached';
        } else {
          imageNote = ' (image upload failed — text saved)';
        }
      }
    }

    if (children.length) body.children = children;

    const res = await fetch('https://api.notion.com/v1/pages', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.NOTION_TOKEN}`,
        'Notion-Version': NOTION_API_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      const errText = await res.text();
      return `Notion API error (${res.status}): ${errText.slice(0, 400)}`;
    }
    const data = await res.json() as any;
    const draftedNote = draftBody && draftBody.trim() ? ' with draft body' : '';
    return `Added "${postName}" to Content schedule${draftedNote}${imageNote}.${data.url ? ` ${data.url}` : ''}`;
  },
});

const hasNotion = !!(process.env.NOTION_TOKEN && process.env.NOTION_DATA_SOURCE_ID);

const buildTools = (
  onDraft: (post: string) => void,
  getImage: () => Promise<PendingImage | null> = async () => null,
) => [
  ...(process.env.BRAVE_API_KEY ? [webSearchTool] : []),
  fetchUrlTool,
  makeCreateLinkedInPostTool(onDraft),
  ...(hasNotion ? [makeAddToContentScheduleTool(getImage)] : []),
];

const SYSTEM_PROMPT = `You are a helpful assistant in a Discord server. You have tools to browse the internet, fetch URLs, and create LinkedIn posts.

You can also see and analyze images that users share with you. When users share images, you can describe them, analyze designs, read text in them, and use them as input for creating content.

When users ask about current events, websites, Reddit, or anything that requires live data — use your tools to look it up rather than saying you can't.

When users ask you to "create a post" or "create me a post" with any input (image, URL, text), use the create_linkedin_post tool to generate a professional LinkedIn post following the specific style guidelines.

DEFAULT TO DRAFTING. When a user shares an observation, example, screenshot, product detail, or "look at this" moment — even without explicitly saying "create a post" — treat what they've said as raw material for a LinkedIn post and call create_linkedin_post to draft one. This is a content-creation bot: shared observations are post ideas by default. Do NOT just analyze, describe, or discuss the thing and stop; lead with a drafted post. Only skip drafting when the user is clearly just chatting, asking a factual question, or explicitly asks you to only discuss/analyze. If genuinely unsure whether they want a post, draft one anyway and offer to adjust — draft first, ask later.

The full post returned by create_linkedin_post is automatically shown to the user in Discord. Do NOT repeat or paste the post text in your own reply — just add a short note or follow-up question (e.g. offering to tweak it or save it to Notion). Never say things like "I drafted a post above" as your only response; the draft is posted for you, so keep your reply to brief commentary.

When users ask you to "add this to Notion", "save this idea", "populate the content table", or similar, call add_to_content_schedule. Classify the Type field from the content (e.g. AI commentary → "AI/UX Opinion (Tuesday)", real-world UX observation → "Everyday UX (Monday & Wednesday)"). If you also draft a full LinkedIn post (via create_linkedin_post or inline), pass the complete draft — hook, body, and any alternative hooks/notes — as draftBody so the draft lives inside the Notion page body. You can still show the draft in Discord as usual; the draftBody parameter is what gets it into Notion. Always reply with the Notion page URL the tool returns so the user can click straight in.

If an image was shared in the conversation, it is attached to the Notion page automatically — you do not need to pass it or ask for it. Never tell the user you cannot add their image to Notion.

Keep responses concise and conversational. Use Discord markdown formatting where appropriate (bold with **text**, code with \`code\`). Responses must be under 1900 characters — summarise if needed.`;

// Per-channel conversation history with memory management
const conversations = new Map<string, Anthropic.MessageParam[]>();
// Threads the bot is actively conversing in. Inside these, it reads every
// reply without needing an @mention. (In-memory; resets on restart, but the
// bot re-registers a thread the moment it's mentioned or replies there again.)
const botThreadIds = new Set<string>();
const MAX_HISTORY = 20;
const MAX_CONVERSATIONS = 100; // Limit total conversations to prevent memory issues

// Reconstructs a thread's conversation history straight from Discord after a
// restart (or on first contact with a thread from before the bot joined it),
// since Discord already keeps every message forever — no separate persistence
// needed. Only text is recovered; past image attachments aren't re-fetched.
async function buildHistoryFromThread(thread: ThreadChannel, excludeMessageId?: string): Promise<Anthropic.MessageParam[]> {
  try {
    const fetched = await thread.messages.fetch({ limit: MAX_HISTORY });
    const ordered = Array.from(fetched.values())
      .filter(m => m.id !== excludeMessageId)
      .sort((a, b) => a.createdTimestamp - b.createdTimestamp);

    const history: Anthropic.MessageParam[] = [];
    for (const m of ordered) {
      let text = m.content.replace(/<@!?[0-9]+>/g, '').trim();
      let authorId = m.author.id;

      // A thread's opening message is a synthetic "thread starter" pointer
      // (type 21) with empty content — the real text/image lives on the
      // message it references (the one the thread was spun off of).
      if (m.type === 21 && !text) {
        try {
          const ref = await m.fetchReference();
          text = ref.content.replace(/<@!?[0-9]+>/g, '').trim();
          if (ref.attachments.size > 0) {
            text += (text ? ' ' : '') + '[shared an image]';
          }
          authorId = ref.author.id;
        } catch {
          continue;
        }
      }
      if (!text) continue;

      const role = authorId === discord.user?.id ? 'assistant' : 'user';
      // Merge consecutive same-role messages — Claude's API requires alternation.
      const last = history[history.length - 1];
      if (last && last.role === role && typeof last.content === 'string') {
        last.content += `\n${text}`;
      } else {
        history.push({ role, content: text });
      }
    }
    // Claude requires the history to start with a user turn — drop any bot
    // chatter that somehow precedes the first real user message (rare).
    while (history.length && history[0].role !== 'user') history.shift();
    return history;
  } catch (error) {
    console.error(`Could not rebuild history for thread ${thread.id}:`, error);
    return [];
  }
}

// Finds the most recent image in a thread, walking backwards. Used when the
// user says "save that to Notion" a few messages after posting the image.
// The image usually lives on the message the thread was spun off of, which the
// api exposes as a type-21 starter pointing at the real message.
async function findRecentThreadImage(thread: ThreadChannel): Promise<PendingImage | null> {
  try {
    const fetched = await thread.messages.fetch({ limit: 20 });
    const newestFirst = Array.from(fetched.values()).sort((a, b) => b.createdTimestamp - a.createdTimestamp);

    for (const m of newestFirst) {
      let attachments = Array.from(m.attachments.values());
      if (!attachments.length && m.type === 21) {
        try {
          const ref = await m.fetchReference();
          attachments = Array.from(ref.attachments.values());
        } catch {
          continue;
        }
      }
      const image = attachments.find(a => a.contentType?.startsWith('image/'));
      if (!image) continue;

      const downloaded = await downloadAttachment(image);
      if (downloaded) return downloaded;
    }

    // The scan above only covers the most recent messages, so in a long thread
    // the originating message can fall outside it. Check it explicitly.
    try {
      const starter = await thread.fetchStarterMessage();
      const image = starter?.attachments.find(a => a.contentType?.startsWith('image/'));
      if (image) return await downloadAttachment(image);
    } catch {
      // starter deleted or unreachable — nothing more to try
    }
    return null;
  } catch (error) {
    console.error(`Could not find image in thread ${thread.id}:`, error);
    return null;
  }
}

// Pulls the bytes for a Discord attachment. The cdn url is signed and expires,
// but it comes from a fresh api fetch each time, so it's valid at this point.
async function downloadAttachment(image: { url: string; name: string | null; contentType: string | null }): Promise<PendingImage | null> {
  const res = await fetch(image.url);
  if (!res.ok) return null;
  const buffer = Buffer.from(await res.arrayBuffer());
  return {
    buffer,
    filename: image.name || 'image.jpg',
    contentType: detectImageMediaType(buffer) || image.contentType || 'image/jpeg',
  };
}

// Clean up old conversations periodically
setInterval(() => {
  if (conversations.size > MAX_CONVERSATIONS) {
    const toDelete = conversations.size - MAX_CONVERSATIONS;
    const keys = Array.from(conversations.keys());
    for (let i = 0; i < toDelete; i++) {
      conversations.delete(keys[i]);
    }
    console.log(`Cleaned up ${toDelete} old conversations`);
  }
}, 60000); // Every minute

// Add debug logging for all events
discord.on('debug', (info) => {
  if (info.includes('token') || info.includes('Token')) {
    console.log('Discord debug (token-related):', info.replace(/[\w-]{24}\.[\w-]{6}\.[\w-]{27}/g, '[REDACTED]'));
  } else if (info.includes('Heartbeat') || info.includes('heartbeat')) {
    // Skip heartbeat spam
  } else {
    console.log('Discord debug:', info);
  }
});

discord.once(Events.ClientReady, (client) => {
  isConnected = true;
  lastActivity = Date.now();
  const hasSearch = !!process.env.BRAVE_API_KEY;
  console.log(`✅ Logged in as ${client.user.tag}`);
  console.log(`Web search: ${hasSearch ? 'enabled (Brave)' : 'disabled — add BRAVE_API_KEY to .env to enable'}`);
  console.log('URL fetching: enabled');
  console.log('LinkedIn post creation: enabled');
  console.log('Image analysis: enabled');
  console.log(`Notion content schedule: ${hasNotion ? 'enabled' : 'disabled — set NOTION_TOKEN and NOTION_DATABASE_ID to enable'}`);
});

// Handle disconnection and reconnection
discord.on(Events.ShardDisconnect, (event, shardId) => {
  isConnected = false;
  console.error(`❌ Discord disconnected (shard ${shardId}):`, event);
  console.log('Attempting to reconnect...');
});

discord.on(Events.ShardReconnecting, (shardId) => {
  console.log(`🔄 Reconnecting to Discord (shard ${shardId})...`);
});

discord.on(Events.ShardReady, (shardId) => {
  isConnected = true;
  lastActivity = Date.now();
  console.log(`✅ Reconnected to Discord (shard ${shardId})`);
});

discord.on(Events.ShardResume, (shardId, replayedEvents) => {
  isConnected = true;
  lastActivity = Date.now();
  console.log(`✅ Resumed connection (shard ${shardId}, replayed ${replayedEvents} events)`);
});

discord.on(Events.Error, (error) => {
  console.error('Discord client error:', error);
});

discord.on(Events.Warn, (warning) => {
  console.warn('Discord warning:', warning);
});

type SendTarget = TextChannel | DMChannel | NewsChannel | ThreadChannel;

// Send text to a Discord channel/thread, splitting into <1900-char chunks at
// natural line breaks (Discord's hard message limit is 2000).
async function sendChunked(target: SendTarget, text: string) {
  if (text.length <= 1900) {
    await target.send(text);
    return;
  }
  const chunks: string[] = [];
  let current = '';
  for (const line of text.split('\n')) {
    if (current.length + line.length + 1 <= 1800) {
      current += (current ? '\n' : '') + line;
    } else {
      if (current) chunks.push(current);
      current = line;
      while (current.length > 1800) {
        const splitPoint = current.lastIndexOf(' ', 1800);
        if (splitPoint > 0) {
          chunks.push(current.substring(0, splitPoint));
          current = current.substring(splitPoint + 1);
        } else {
          chunks.push(current.substring(0, 1800));
          current = current.substring(1800);
        }
      }
    }
  }
  if (current) chunks.push(current);

  for (let i = 0; i < chunks.length; i++) {
    const prefix = chunks.length > 1 ? `**Part ${i + 1}/${chunks.length}:**\n` : '';
    await target.send(prefix + chunks[i]);
    if (i < chunks.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
}

discord.on(Events.MessageCreate, async (message: Message) => {
  lastActivity = Date.now();
  
  if (message.author.bot) return;

  // Respond when mentioned, OR to any message in a thread the bot is active in
  // (a thread it created, owns, or has already replied in) — so users don't
  // have to @mention it on every reply inside a thread conversation.
  const inBotThread =
    message.channel instanceof ThreadChannel &&
    (botThreadIds.has(message.channel.id) ||
      message.channel.ownerId === discord.user?.id);
  if (!message.mentions.has(discord.user!) && !inBotThread) return;

  const content = message.content.replace(/<@!?[0-9]+>/g, '').trim();
  
  // Check for image attachments
  const imageAttachments = message.attachments.filter(att => 
    att.contentType?.startsWith('image/')
  );
  
  if (!content && imageAttachments.size === 0) {
    await message.reply("Hi! Ask me anything — I can browse the web and analyze images too.");
    return;
  }

  // Resolve where to reply — a thread off the user's message, or the current
  // channel/thread. Do this BEFORE keying history so the whole conversation
  // (the triggering message in a channel + every thread reply) shares one
  // history bucket, keyed by the thread id rather than split across the parent
  // channel and the thread.
  const ch = message.channel;
  let target: TextChannel | DMChannel | NewsChannel | ThreadChannel = ch as any;
  if (ch instanceof ThreadChannel) {
    target = ch;
  } else if ((ch instanceof TextChannel || ch instanceof NewsChannel)) {
    if (message.hasThread && message.thread) {
      target = message.thread;
    } else {
      try {
        target = await message.startThread({
          name: (content || 'claudius reply').slice(0, 90),
          autoArchiveDuration: 1440,
        });
      } catch (threadError) {
        console.error('Could not start thread, replying in channel instead:', threadError);
        target = ch;
      }
    }
  }

  // Register the thread so future replies in it don't need an @mention.
  if (target instanceof ThreadChannel) {
    botThreadIds.add(target.id);
  }

  const channelId = target instanceof ThreadChannel ? target.id : message.channel.id;
  if (!conversations.has(channelId)) {
    const rebuilt = target instanceof ThreadChannel
      ? await buildHistoryFromThread(target, message.id)
      : [];
    conversations.set(channelId, rebuilt);
  }
  const history = conversations.get(channelId)!;

  // Build message content with images
  const messageContent: any[] = [];

  // The image to hand to Notion if the model decides to save this idea. Set
  // from the attachment on this message; falls back to the most recent image
  // in the thread further down.
  let pendingImage: PendingImage | null = null;

  // Add text if present
  if (content) {
    messageContent.push({ type: 'text', text: content });
  }

  // Add images if present
  if (imageAttachments.size > 0) {
    for (const attachment of imageAttachments.values()) {
      try {
        // Fetch the image
        const imageResponse = await fetch(attachment.url);
        const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());
        const base64Image = imageBuffer.toString('base64');
        const mediaType = detectImageMediaType(imageBuffer) || attachment.contentType || 'image/jpeg';

        if (!pendingImage) {
          pendingImage = {
            buffer: imageBuffer,
            filename: attachment.name || 'image.jpg',
            contentType: mediaType,
          };
        }

        messageContent.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: mediaType,
            data: base64Image
          }
        });
        
        // Add context about the image
        if (!content) {
          messageContent.unshift({ 
            type: 'text', 
            text: 'Please analyze this image:' 
          });
        }
      } catch (error) {
        console.error('Failed to fetch image:', error);
        messageContent.push({ 
          type: 'text', 
          text: `[Failed to load image: ${attachment.name}]` 
        });
      }
    }
  }
  
  // Push structured content to history
  history.push({ role: 'user', content: messageContent });

  if (
    target instanceof TextChannel ||
    target instanceof DMChannel ||
    target instanceof NewsChannel ||
    target instanceof ThreadChannel
  ) {
    await target.sendTyping();
  }

  try {
    // Capture any LinkedIn drafts the tool produces; the tool's return value
    // is only seen by the model, so we post the draft to Discord ourselves.
    const drafts: string[] = [];
    // Resolved lazily and cached, so we only pay for the thread scan/download
    // if the model actually saves to Notion.
    let resolvedImage: PendingImage | null | undefined;
    const tools = buildTools(
      (post) => drafts.push(post),
      async () => {
        if (resolvedImage !== undefined) return resolvedImage;
        resolvedImage = pendingImage
          ?? (target instanceof ThreadChannel ? await findRecentThreadImage(target) : null);
        return resolvedImage;
      },
    );

    const finalMessage = await anthropic.beta.messages.toolRunner({
      model: 'claude-sonnet-5',
      max_tokens: 2000,
      system: SYSTEM_PROMPT,
      tools,
      messages: history,
    });

    const reply = finalMessage.content.find(b => b.type === 'text')?.text ?? '';

    // Persist any drafted posts alongside the reply. The drafts come back via
    // the tool capture (not the model's reply text), so without this the model
    // forgets what it drafted and can't act on "save that to Notion" later.
    const recordedParts: string[] = [];
    for (const draft of drafts) {
      recordedParts.push(`[Drafted LinkedIn post]\n${draft}`);
    }
    if (reply) recordedParts.push(reply);
    history.push({ role: 'assistant', content: recordedParts.join('\n\n') || '(no response)' });
    if (history.length > MAX_HISTORY) {
      history.splice(0, history.length - MAX_HISTORY);
    }

    // Post any drafted posts first — they are not part of the model's reply.
    for (const draft of drafts) {
      await sendChunked(target, draft);
    }

    if (reply) {
      await sendChunked(target, reply);
    } else if (drafts.length === 0) {
      await target.send('I processed your request but had nothing to say.');
    }
  } catch (error) {
    console.error('Error processing message:', error);
    
    // Provide more specific error messages
    let errorMessage = 'Sorry, I ran into an error. ';
    
    if (error instanceof Error) {
      if (error.message.includes('rate limit')) {
        errorMessage += 'I\'m being rate limited. Please wait a moment and try again.';
      } else if (error.message.includes('timeout')) {
        errorMessage += 'The request timed out. Please try again.';
      } else if (error.message.includes('ECONNREFUSED') || error.message.includes('ENOTFOUND')) {
        errorMessage += 'I couldn\'t connect to the service. Please try again later.';
      } else {
        errorMessage += 'Please try again or contact support if this persists.';
      }
    }
    
    try {
      await target.send(errorMessage);
    } catch (replyError) {
      console.error('Failed to send error message:', replyError);
    }
  }
});

// Graceful shutdown handling
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully...');
  discord.destroy();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully...');
  discord.destroy();
  process.exit(0);
});

// Handle uncaught exceptions and unhandled rejections
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  // Don't exit - try to recover
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  // Don't exit - try to recover
});

if (!process.env.DISCORD_TOKEN) {
  console.error('❌ DISCORD_TOKEN is not set');
  process.exit(1);
}

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('❌ ANTHROPIC_API_KEY is not set');
  process.exit(1);
}

// Login with automatic reconnection and detailed error logging
console.log('Attempting to login to Discord...');
console.log('Token exists:', !!process.env.DISCORD_TOKEN);
console.log('Token length:', process.env.DISCORD_TOKEN?.length || 0);
console.log('Token starts with:', process.env.DISCORD_TOKEN?.substring(0, 10) + '...');

// Test if we can reach Discord's API
console.log('Testing Discord API connectivity...');
fetch('https://discord.com/api/v10/gateway')
  .then(res => {
    console.log('Discord API reachable, status:', res.status);
    return res.json();
  })
  .then(data => {
    console.log('Gateway URL:', data.url);
  })
  .catch(err => {
    console.error('Cannot reach Discord API:', err.message);
  });

// Create a timeout promise
const timeoutPromise = new Promise((_, reject) => {
  setTimeout(() => reject(new Error('Login timeout after 30 seconds')), 30000);
});

// Race between login and timeout
Promise.race([
  discord.login(process.env.DISCORD_TOKEN),
  timeoutPromise
])
  .then(() => {
    console.log('✅ Login promise resolved successfully');
    console.log('Bot should now be online in Discord');
  })
  .catch((error) => {
    isConnected = false;
    console.error('❌ Failed to login to Discord:', error.message || error);
    
    if (error.message && error.message.includes('timeout')) {
      console.error('The login attempt timed out - Discord API may be unreachable');
    } else if (error.message && error.message.includes('token')) {
      console.error('Token appears to be invalid or malformed');
    } else {
      console.error('Full error details:', JSON.stringify(error, Object.getOwnPropertyNames(error), 2));
    }
    
    console.log('Will retry in 10 seconds...');
    setTimeout(() => {
      console.log('Attempting retry...');
      discord.login(process.env.DISCORD_TOKEN)
        .then(() => {
          console.log('✅ Retry successful!');
          isConnected = true;
        })
        .catch((retryError) => {
          console.error('❌ Retry also failed:', retryError.message || retryError);
          isConnected = false;
        });
    }, 10000);
  });
