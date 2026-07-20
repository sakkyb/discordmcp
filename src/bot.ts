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

Apply the humanizer skill above to the text below. Return ONLY the rewritten text — no preamble, no notes, no audit, no explanation. Preserve the author's meaning, structure, and any LinkedIn formatting (line breaks, hooks, alternative-hook lists).${voiceSample ? `\n\nMatch this author's voice:\n${voiceSample}` : ''}

TEXT TO HUMANIZE:
${text}`;

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-5',
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }],
    });
    return response.content.find(b => b.type === 'text')?.text ?? text;
  } catch (error) {
    console.error('Humanizer pass failed, returning original draft:', error);
    return text;
  }
}

// Tool: create LinkedIn post
const createLinkedInPostTool = betaZodTool({
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

Provide the post and then list 3 alternative hook/second line combinations.`;

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-5',
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }],
    });

    const postContent = response.content.find(b => b.type === 'text')?.text ?? '';
    // Second pass: strip AI-writing tells so the post reads as human-written.
    // Use Sakky's exemplar cohort post from the guidelines as the voice sample.
    const humanized = await humanize(postContent);
    return humanized;
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

const NOTION_API_VERSION = '2022-06-28';
const NOTION_CONTENT_SCHEDULE_TYPES = [
  'Everyday UX (Tuesday)',
  'AI/UX Opinion (Wednesday)',
  'Video (Thursday)',
  'Design inspo',
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

// Tool: add a new idea row to the Notion "Content schedule" database
const addToContentScheduleTool = betaZodTool({
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
      parent: { database_id: process.env.NOTION_DATABASE_ID },
      properties,
    };
    if (draftBody && draftBody.trim()) {
      body.children = draftToNotionBlocks(draftBody);
    }

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
    return `Added "${postName}" to Content schedule${draftedNote}.${data.url ? ` ${data.url}` : ''}`;
  },
});

const hasNotion = !!(process.env.NOTION_TOKEN && process.env.NOTION_DATABASE_ID);

const tools = [
  ...(process.env.BRAVE_API_KEY ? [webSearchTool] : []),
  fetchUrlTool,
  createLinkedInPostTool,
  ...(hasNotion ? [addToContentScheduleTool] : []),
];

const SYSTEM_PROMPT = `You are a helpful assistant in a Discord server. You have tools to browse the internet, fetch URLs, and create LinkedIn posts.

You can also see and analyze images that users share with you. When users share images, you can describe them, analyze designs, read text in them, and use them as input for creating content.

When users ask about current events, websites, Reddit, or anything that requires live data — use your tools to look it up rather than saying you can't.

When users ask you to "create a post" or "create me a post" with any input (image, URL, text), use the create_linkedin_post tool to generate a professional LinkedIn post following the specific style guidelines.

When users ask you to "add this to Notion", "save this idea", "populate the content table", or similar, call add_to_content_schedule. Classify the Type field from the content (e.g. AI commentary → "AI/UX Opinion (Wednesday)", real-world UX observation → "Everyday UX (Tuesday)"). If you also draft a full LinkedIn post (via create_linkedin_post or inline), pass the complete draft — hook, body, and any alternative hooks/notes — as draftBody so the draft lives inside the Notion page body. You can still show the draft in Discord as usual; the draftBody parameter is what gets it into Notion. Always reply with the Notion page URL the tool returns so the user can click straight in.

Keep responses concise and conversational. Use Discord markdown formatting where appropriate (bold with **text**, code with \`code\`). Responses must be under 1900 characters — summarise if needed.`;

// Per-channel conversation history with memory management
const conversations = new Map<string, Anthropic.MessageParam[]>();
const MAX_HISTORY = 20;
const MAX_CONVERSATIONS = 100; // Limit total conversations to prevent memory issues

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

discord.on(Events.MessageCreate, async (message: Message) => {
  lastActivity = Date.now();
  
  if (message.author.bot) return;
  if (!message.mentions.has(discord.user!)) return;

  const content = message.content.replace(/<@!?[0-9]+>/g, '').trim();
  
  // Check for image attachments
  const imageAttachments = message.attachments.filter(att => 
    att.contentType?.startsWith('image/')
  );
  
  if (!content && imageAttachments.size === 0) {
    await message.reply("Hi! Ask me anything — I can browse the web and analyze images too.");
    return;
  }

  const channelId = message.channel.id;
  if (!conversations.has(channelId)) {
    conversations.set(channelId, []);
  }
  const history = conversations.get(channelId)!;
  
  // Build message content with images
  const messageContent: any[] = [];
  
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

  const ch = message.channel;
  if (
    ch instanceof TextChannel ||
    ch instanceof DMChannel ||
    ch instanceof NewsChannel ||
    ch instanceof ThreadChannel
  ) {
    await ch.sendTyping();
  }

  try {
    const finalMessage = await anthropic.beta.messages.toolRunner({
      model: 'claude-sonnet-5',
      max_tokens: 1500,
      system: SYSTEM_PROMPT,
      tools,
      messages: history,
    });

    const reply = finalMessage.content.find(b => b.type === 'text')?.text ?? '';

    // Store only the final text in history for clean multi-turn context
    history.push({ role: 'assistant', content: reply });
    if (history.length > MAX_HISTORY) {
      history.splice(0, history.length - MAX_HISTORY);
    }

    if (!reply) {
      await message.reply('I processed your request but had nothing to say.');
      return;
    }

    if (reply.length <= 1900) {
      await message.reply(reply);
    } else {
      // Split into chunks at natural break points
      const chunks = [];
      let current = '';
      const lines = reply.split('\n');
      
      for (const line of lines) {
        if (current.length + line.length + 1 <= 1800) { // Leave more room for numbering
          current += (current ? '\n' : '') + line;
        } else {
          if (current) chunks.push(current);
          current = line;
          
          // Handle very long lines by splitting them
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
      
      // Send all chunks
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const prefix = chunks.length > 1 ? `**Part ${i + 1}/${chunks.length}:**\n` : '';
        await message.reply(prefix + chunk);
        
        // Small delay between chunks to avoid rate limiting
        if (i < chunks.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }
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
      await message.reply(errorMessage);
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
