# Discord Claude Bot (Mac Mini Deployment)

A Discord bot powered by Claude that can browse the web, analyze images, and create LinkedIn posts. Runs 24/7 as a local `launchd` service on a Mac Mini, with automatic restarts and startup-on-boot.

## Features

- **LinkedIn Post Creation**: Generate professional LinkedIn posts using Sakky's v2 style guidelines
- **Image Analysis**: View, understand, and analyze images shared in Discord
- **Web Browsing**: Fetch and summarize webpage content
- **Persistent Memory**: Maintains conversation context per Discord channel
- **Health Monitoring**: Built-in `/health` endpoint
- **Auto-Recovery**: Handles disconnections and errors gracefully
- **Multi-part Responses**: Automatically splits long responses across multiple messages

## Live Bot

- **Name**: claudius maximus 2.0
- **Hosting**: Mac Mini (local, always-on)

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

**Platform**: Mac Mini, running locally via `launchd`
**Connection model**: The bot makes an outbound WebSocket connection to Discord's gateway — no port forwarding, static IP, or domain is required for it to work anywhere in the world.
**Process management**: `launchd` starts the bot at boot and restarts it automatically if it crashes.
**No other host runs this bot**: only ever run one instance at a time — a duplicate instance with the same `DISCORD_TOKEN` will conflict with this one.

## Setup on the Mac Mini

1. Install Node.js (v20+) if you don't have it:
   ```bash
   brew install node
   ```

2. Clone the repo and install dependencies:
   ```bash
   git clone <this-repo-url>
   cd discordmcp
   npm install
   ```

3. Create your `.env` file from the example and fill in your secrets:
   ```bash
   cp .env.example .env
   ```

4. Build the project:
   ```bash
   npm run build
   ```

5. Install it as a `launchd` service (starts now, and on every boot):
   ```bash
   ./scripts/setup-mac.sh
   ```
   This also disables system sleep (`pmset`) so the process keeps running while the lid is closed or the Mini is idle. Sudo is required for that step.

That's it — mention the bot in Discord and it should respond.

### Checking status

```bash
launchctl list | grep com.sakky.discordbot   # confirm it's running
tail -f logs/bot.out.log                     # follow logs
tail -f logs/bot.err.log                     # follow error logs
curl http://localhost:3000/health            # health check
```

### Stopping / restarting

```bash
launchctl unload ~/Library/LaunchAgents/com.sakky.discordbot.plist   # stop
launchctl load ~/Library/LaunchAgents/com.sakky.discordbot.plist     # start
```

### Uninstalling the service

```bash
./scripts/uninstall-mac.sh
```

### Updating the bot

```bash
git pull
npm install
npm run build
launchctl unload ~/Library/LaunchAgents/com.sakky.discordbot.plist
launchctl load ~/Library/LaunchAgents/com.sakky.discordbot.plist
```

### Recovering after a macOS software update

A macOS update can stamp a TCC attribute (`com.apple.macl`) onto the bot's log
files such that launchd can no longer open them. When that happens the service
fails to launch with **exit code 78 (`EX_CONFIG`) and no log output**, and
just loops via `KeepAlive` without ever coming up. Symptoms: `launchctl list |
grep discordbot` shows a non-zero last exit, no process is running, and
`curl http://localhost:3000/health` returns nothing.

Fix — drop the wedged log files so launchd recreates clean ones, then restart:

```bash
cd ~/Documents/Github/life-master/discordmcp
launchctl bootout "gui/$(id -u)/com.sakky.discordbot" 2>/dev/null   # stop the failing loop
rm -f logs/bot.out.log logs/bot.err.log                            # remove the wedged files
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.sakky.discordbot.plist
sleep 10 && curl http://localhost:3000/health                      # should report "healthy"
```

The same applies to the LinkedIn-tracker jobs if they ever fail identically —
delete `linkedin-tracker/logs/*.log` and reload those agents.

## Environment Variables

See `.env.example`. Required:
- `DISCORD_TOKEN`: Bot token from Discord Developer Portal
- `ANTHROPIC_API_KEY`: Claude API key

Optional:
- `BRAVE_API_KEY`: enables the web search tool
- `NOTION_TOKEN` / `NOTION_DATA_SOURCE_ID`: enables saving LinkedIn posts to the Notion "Content schedule" (uses the data source id, required for multi-source databases on API version 2025-09-03)
- `PORT`: port for the local health endpoint (defaults to 3000)

## Health Check

The bot exposes a health endpoint at `/health` (local only, `http://localhost:3000/health` by default) that returns:

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
