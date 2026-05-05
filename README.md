# Discord Claude Bot (Railway Deployment)

A Discord bot powered by Claude Opus 4.7 that can browse the web, analyze images, and create LinkedIn posts. Deployed on Railway for 24/7 availability with robust error handling and monitoring.

## Features

- **LinkedIn Post Creation**: Generate professional LinkedIn posts using Sakky's v2 style guidelines
- **Image Analysis**: View, understand, and analyze images shared in Discord 
- **Web Browsing**: Fetch and summarize webpage content
- **Persistent Memory**: Maintains conversation context per Discord channel
- **Health Monitoring**: Built-in `/health` endpoint for uptime monitoring
- **Auto-Recovery**: Handles disconnections and errors gracefully
- **Multi-part Responses**: Automatically splits long responses across multiple messages

## Live Bot

- **Name**: claudius maximus 2.0
- **Health Check**: https://discord-claude-bot-production.up.railway.app/health
- **Model**: Claude Opus 4.7
- **Hosting**: Railway

## Usage

In Discord, mention the bot with your request:

### LinkedIn Posts
- `@claudius maximus 2.0 create me a post about this new AI feature`
- `@claudius maximus 2.0 draft me a post about [topic] - [URL]`
- Upload an image + `@claudius maximus 2.0 create me a post about this design`

### Web Browsing  
- `@claudius maximus 2.0 what's the latest news about AI?`
- `@claudius maximus 2.0 fetch https://example.com and summarize`

### Image Analysis
- `@claudius maximus 2.0 analyze this screenshot` (with image)
- `@claudius maximus 2.0 what's in this image?` (with image)

### General Chat
- `@claudius maximus 2.0 hello` 
- `@claudius maximus 2.0 explain quantum computing`

## Deployment Architecture

**Platform**: Railway (switched from Render due to IP blocking issues)
**No Local Development**: Prevents Discord token conflicts
**Auto-Deploy**: Pushes to main branch trigger deployments
**Monitoring**: UptimeRobot pings health endpoint every 5 minutes

## Environment Variables

Required on Railway:
- `DISCORD_TOKEN`: Bot token from Discord Developer Portal
- `ANTHROPIC_API_KEY`: Claude API key
- `BRAVE_API_KEY`: (Optional) For enhanced web search

## Health Check

The bot exposes a health endpoint at `/health` that returns:

```json
{
  "status": "healthy",
  "discord": "connected", 
  "uptime": 1234,
  "lastActivity": "2026-05-05T11:21:19.700Z",
  "memoryUsage": "22MB"
}
```

- **200 status**: Bot is healthy and connected to Discord
- **503 status**: Bot is running but Discord is disconnected

## LinkedIn Post Guidelines Integration

The bot uses Sakky's LinkedIn Post Generator v2 guidelines for:
- Captivating hooks (quotes, contrarian observations, surprising stats)
- Tactical vs story structure based on content type
- 150-word limit with engagement-focused endings
- Alternative hook variations for each post
- Specific voice and positioning strategy

## Technical Details

- **Node.js** with TypeScript
- **Discord.js** for Discord API integration  
- **Anthropic SDK** for Claude integration
- **Automatic message splitting** for responses >1900 characters
- **Error handling** with specific error types (rate limits, timeouts, token issues)
- **Conversation memory** management (max 20 messages per channel, 100 channels max)

## Development

**Local development is intentionally disabled** to prevent Discord token conflicts. All changes should be:

1. Made in code
2. Committed to GitHub
3. Tested via Railway deployment

## Monitoring Setup

Configure UptimeRobot to monitor:
- **URL**: https://discord-claude-bot-production.up.railway.app/health  
- **Method**: HTTP GET
- **Interval**: 5 minutes
- **Keyword**: "healthy" (optional)

This keeps Railway from sleeping the service and provides downtime alerts.

## Bot Permissions

The bot requires these Discord permissions:
- View Channels
- Send Messages  
- Read Message History
- Attach Files
- Embed Links
- Add Reactions

## License

MIT License - see LICENSE file for details.