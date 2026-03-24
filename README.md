# home-run-bot

A Discord bot that monitors MLB players for home runs and sends real-time alerts to your server. When a tracked player goes yard, the bot posts a quick notification, then follows up with Statcast details (exit velo, launch angle, distance) and a ballpark overlay image showing the hit.

## Features

- Checks tracked players every 5 minutes using the MLB Stats API
- Sends alerts to one or more Discord channels
- Includes HR distance, RBI type, and season totals
- Generates a ballpark overlay image with spray direction and wall distance
- Persists state to disk so restarts don't re-send old alerts
- Discord commands for checking stats and managing the bot

## Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [Python](https://www.python.org/) 3.10+ (for ballpark overlay images)
- A Discord bot token ([create one here](https://discord.com/developers/applications))
  - Enable the **Message Content Intent** under Bot settings
  - Give the bot permissions: View Channels, Send Messages, Embed Links, Attach Files, Read Message History

### Installation

```bash
git clone https://github.com/YOUR_USERNAME/home-run-bot.git
cd home-run-bot
npm install
pip install -r requirements.txt
```

### Configuration

Copy `.env.example` to `.env` and fill in your values:

```env
BOT_TOKEN=your_discord_bot_token
CHANNEL_ID=your_discord_channel_id
ADMIN_USER_IDS=your_discord_user_id
BOT_USERNAME=home-run-bot
```

| Variable | Description |
|---|---|
| `BOT_TOKEN` | Your Discord bot token |
| `CHANNEL_ID` | Channel ID(s) to post alerts in. Comma-separated for multiple channels. |
| `ADMIN_USER_IDS` | (Optional) Comma-separated Discord user IDs allowed to run admin commands |
| `BOT_USERNAME` | (Optional) Bot display name to sync on startup |

### Run

```bash
npm start
```

For development with auto-restart:

```bash
npm run dev
```

## Tracking Your Own Players

The tracked players are defined near the top of `bot.js` in the `this.players` object. Each entry uses the player's [MLB player ID](https://www.mlb.com/) as the key:

```js
this.players = {
    '592450': { name: 'Aaron Judge', team: 'NYY', number: '99', lastCheckedHR: 0, sentHomeRuns: new Set() },
    '660271': { name: 'Shohei Ohtani', team: 'LAD', number: '17', lastCheckedHR: 0, sentHomeRuns: new Set() },
};
```

**To add a player:**

1. Find their MLB player ID (it's in the URL on their [MLB.com player page](https://www.mlb.com/player/))
2. Add an entry to `this.players` in `bot.js`
3. (Optional) Add a shortcut command in the `handleCommand()` method (e.g. `!judge`)

**To remove a player:** delete their entry from `this.players` and remove any matching command in `handleCommand()`.

Player headshot images are automatically pulled from MLB based on the player ID.

## Commands

### Public

| Command | Description |
|---|---|
| `!players` | List all tracked players |
| `!hrstats` | Show HR stats for all tracked players |
| `!judge`, `!soto`, etc. | Show stats for a specific player |

### Admin Only

| Command | Description |
|---|---|
| `!forcecheck` | Manually trigger a home run check |
| `!testhr` | Send a test home run alert |
| `!reset [player]` | Reset a player's HR tracking state |
| `!debug` | Show bot debug info |

## How It Works

1. Every 5 minutes, the bot queries the MLB Stats API for each tracked player's HR count
2. When a new HR is detected, it sends a quick alert embed to Discord
3. It then waits for detailed Statcast data (exit velo, launch angle, spray angle)
4. A Python script generates a ballpark overlay image showing where the ball landed
5. The bot posts a follow-up message with the full details and image

State is saved in `data/bot_state.json` so the bot remembers what it's already reported across restarts.

## Project Structure

```
bot.js                  - Main bot logic
scripts/hr_analysis.py  - Ballpark overlay image generation
data/fences.json        - Stadium fence coordinates
data/stadium_paths.json - Stadium outline data
data/bot_state.json     - Runtime state (auto-generated, git-ignored)
```

## License

MIT
