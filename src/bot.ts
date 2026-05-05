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

// Minimal HTTP server so Render keeps the service alive (free tier requires a web port)
const PORT = process.env.PORT ?? 3000;
http.createServer((_, res) => { res.writeHead(200); res.end('OK'); }).listen(PORT);

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

// Tool: create LinkedIn post
const createLinkedInPostTool = betaZodTool({
  name: 'create_linkedin_post',
  description: 'Generate a LinkedIn post based on provided content, images, URLs, or text following specific style guidelines',
  inputSchema: z.object({
    input: z.string().describe('The input content - can be text, URL, image description, or any source material for the post'),
    topic: z.string().optional().describe('Optional specific topic or theme for the post'),
  }),
  run: async ({ input, topic }) => {
    // Read the LinkedIn post generator v2 guidelines
    const guidelinesPath = '/Users/sakshatbaral/Documents/GitHub/life-master/life-hub/skills/linkedin-post-generator-v2.md';
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
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    });

    const postContent = response.content.find(b => b.type === 'text')?.text ?? '';
    return `📝 **LinkedIn Post Created:**\n\n${postContent}`;
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

const tools = [
  ...(process.env.BRAVE_API_KEY ? [webSearchTool] : []),
  fetchUrlTool,
  createLinkedInPostTool,
];

const SYSTEM_PROMPT = `You are a helpful assistant in a Discord server. You have tools to browse the internet, fetch URLs, and create LinkedIn posts.

When users ask about current events, websites, Reddit, or anything that requires live data — use your tools to look it up rather than saying you can't.

When users ask you to "create a post" or "create me a post" with any input (image, URL, text), use the create_linkedin_post tool to generate a professional LinkedIn post following the specific style guidelines.

Keep responses concise and conversational. Use Discord markdown formatting where appropriate (bold with **text**, code with \`code\`). Responses must be under 1900 characters — summarise if needed.`;

// Per-channel conversation history (in-memory)
const conversations = new Map<string, Anthropic.MessageParam[]>();
const MAX_HISTORY = 20;

discord.once(Events.ClientReady, (client) => {
  const hasSearch = !!process.env.BRAVE_API_KEY;
  console.log(`Logged in as ${client.user.tag}`);
  console.log(`Web search: ${hasSearch ? 'enabled (Brave)' : 'disabled — add BRAVE_API_KEY to .env to enable'}`);
  console.log('URL fetching: enabled');
  console.log('LinkedIn post creation: enabled');
});

discord.on(Events.MessageCreate, async (message: Message) => {
  if (message.author.bot) return;
  if (!message.mentions.has(discord.user!)) return;

  const content = message.content.replace(/<@!?[0-9]+>/g, '').trim();
  if (!content) {
    await message.reply("Hi! Ask me anything — I can browse the web too.");
    return;
  }

  const channelId = message.channel.id;
  if (!conversations.has(channelId)) {
    conversations.set(channelId, []);
  }
  const history = conversations.get(channelId)!;
  history.push({ role: 'user', content });

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
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
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

    if (reply.length <= 2000) {
      await message.reply(reply);
    } else {
      const chunks = reply.match(/[\s\S]{1,2000}/g) ?? [];
      for (const chunk of chunks) {
        await message.reply(chunk);
      }
    }
  } catch (error) {
    console.error('Error:', error);
    await message.reply('Sorry, I ran into an error. Please try again.');
  }
});

if (!process.env.DISCORD_TOKEN) throw new Error('DISCORD_TOKEN is not set');
if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set');

discord.login(process.env.DISCORD_TOKEN);
