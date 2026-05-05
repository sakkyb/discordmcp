# Discord Claude Bot (Render Deployment Only)

A Discord bot powered by Claude that can browse the web, analyze images, and create LinkedIn posts. This bot is deployed exclusively on Render for 24/7 availability and cannot be run locally to prevent token conflicts.

## Features

- **Web Browsing**: Search the internet and fetch webpage content
- **Image Analysis**: View and understand images shared in Discord
- **LinkedIn Post Creation**: Generate professional LinkedIn posts following specific style guidelines
- **Persistent Memory**: Maintains conversation context per channel
- **Health Monitoring**: Built-in health check endpoint for uptime monitoring
- **Auto-Recovery**: Handles disconnections and errors gracefully

## Deployment

**This bot runs exclusively on Render.** Local development is disabled to prevent Discord token conflicts.

### Prerequisites

- Discord bot token (from Discord Developer Portal)
- Anthropic API key
- Render account
- Optional: Brave Search API key for web search

## Setup (Render Only)

1. Fork or clone this repository to your GitHub account

2. Create a new Web Service on Render:
   - Connect your GitHub repository
   - Use the existing `render.yaml` configuration

3. Set environment variables on Render:
   - `DISCORD_TOKEN`: Your Discord bot token
   - `ANTHROPIC_API_KEY`: Your Claude API key  
   - `BRAVE_API_KEY`: (Optional) For web search

4. Deploy and monitor:
   - Check health at `https://your-app.onrender.com/health`
   - Configure UptimeRobot to ping the health endpoint

## Local Development

**Local execution is intentionally disabled.** Do not create a `.env` file locally. All development should be tested through the Render deployment to maintain a single source of truth and prevent token conflicts.

## Usage

In Discord, mention the bot with your request:
- `@bot what's the latest news about AI?`
- `@bot create me a post about this design` (with image)
- `@bot analyze this screenshot` (with image)
- `@bot fetch https://example.com and summarize`
```bash
npm install
```

3. Create a `.env` file in the root directory with your Discord bot token:
```
DISCORD_TOKEN=your_discord_bot_token_here
```

4. Build the server:
```bash
npm run build
```

## Usage with Claude for Desktop

1. Open your Claude for Desktop configuration file:
   - macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
   - Windows: `%APPDATA%\Claude\claude_desktop_config.json`

2. Add the Discord MCP server configuration:
```json
{
  "mcpServers": {
    "discord": {
      "command": "node",
      "args": ["path/to/discordmcp/build/index.js"],
      "env": {
        "DISCORD_TOKEN": "your_discord_bot_token_here"
      }
    }
  }
}
```

3. Restart Claude for Desktop

## Available Tools

### send-message
Sends a message to a specified Discord channel.

Parameters:
- `server` (optional): Server name or ID (required if bot is in multiple servers)
- `channel`: Channel name (e.g., "general") or ID
- `message`: Message content to send

Example:
```json
{
  "channel": "general",
  "message": "Hello from MCP!"
}
```

### read-messages
Reads recent messages from a specified Discord channel.

Parameters:
- `server` (optional): Server name or ID (required if bot is in multiple servers)
- `channel`: Channel name (e.g., "general") or ID
- `limit` (optional): Number of messages to fetch (default: 50, max: 100)

Example:
```json
{
  "channel": "general",
  "limit": 10
}
```

## Development

1. Install development dependencies:
```bash
npm install --save-dev typescript @types/node
```

2. Start the server in development mode:
```bash
npm run dev
```

## Testing

You can test the server using the MCP Inspector:

```bash
npx @modelcontextprotocol/inspector node build/index.js
```

## Examples

Here are some example interactions you can try with Claude after setting up the Discord MCP server:

1. "Can you read the last 5 messages from the general channel?"
2. "Please send a message to the announcements channel saying 'Meeting starts in 10 minutes'"
3. "What were the most recent messages in the development channel about the latest release?"

Claude will use the appropriate tools to interact with Discord while asking for your approval before sending any messages.

## Security Considerations

- The bot requires proper Discord permissions to function
- All message sending operations require explicit user approval
- Environment variables should be properly secured
- Token should never be committed to version control
- Channel access is limited to channels the bot has been given access to

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Support

If you encounter any issues or have questions:
1. Check the GitHub Issues section
2. Consult the MCP documentation at https://modelcontextprotocol.io
3. Open a new issue with detailed reproduction steps