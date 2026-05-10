# home-run-bot

Discord bot that watches MLB players and posts to your server when they hit a home run.

The bot polls the [MLB Stats API](https://statsapi.mlb.com) every 4 minutes. When it finds a new homer, it sends a Discord embed with the player, distance, and RBI count. A few seconds later, it grabs Statcast data from [Baseball Savant](https://baseballsavant.mlb.com), generates a ballpark overlay image (exit velo, launch angle, spray direction, wall clearance), and posts that too.

State lives on disk. Restarts don't re-send old alerts, and if the bot was offline long enough to miss several homers, startup catch-up skips the older missed ones and only keeps the newest homer eligible for an alert.

## Data sources

- **MLB Stats API** — live game feeds, player stats, home run counts
- **Baseball Savant** — Statcast metrics (exit velocity, launch angle, spray angle)
- **MLB headshot CDN** — player photos, pulled automatically by player ID

No API keys needed. All three are public.

## Setup

You need Node.js 18+, Python 3.10+, and a Discord bot token.

### 1. Create the Discord bot

Go to the [Discord Developer Portal](https://discord.com/developers/applications). Create a new application. Under **Bot**, enable **Message Content Intent**. Copy the bot token.

Invite the bot to your server with these permissions: View Channels, Send Messages, Embed Links, Attach Files, Read Message History.

### 2. Clone and install

```bash
git clone https://github.com/joe-thomp/home-run-bot.git
cd home-run-bot
npm install
pip install -r requirements.txt
```

### 3. Configure

Copy `.env.example` to `.env`:

```env
BOT_TOKEN=your_discord_bot_token
CHANNEL_ID=your_channel_id
ADMIN_USER_IDS=your_discord_user_id
BOT_USERNAME=home-run-bot
```

`CHANNEL_ID` accepts a single ID or a comma-separated list. Every alert goes to every channel.

`ADMIN_USER_IDS` is optional. Comma-separated Discord user IDs that can run debug and reset commands. Server admins can run them regardless.

### 4. Start

```bash
npm start
```

`npm run dev` if you want auto-restart on file changes.

## Track your own players

Open `bot.js`. The `this.players` object near the top defines who the bot watches:

```js
this.players = {
    '592450': { name: 'Aaron Judge', team: 'NYY', number: '99', lastCheckedHR: 0, sentHomeRuns: new Set(), homeRunParks: {} },
    '660271': { name: 'Shohei Ohtani', team: 'LAD', number: '17', lastCheckedHR: 0, sentHomeRuns: new Set(), homeRunParks: {} },
};
```

The key is the MLB player ID. Find it in the URL of any player page on [mlb.com](https://www.mlb.com/player/) (e.g. `mlb.com/player/aaron-judge-592450`).

Add a player: new entry in `this.players`. Optionally add a shortcut command in `handleCommand()` (like `!judge`).

Remove a player: delete the entry and its command.

Headshots resolve automatically from the player ID. No extra config.

## Commands

**Anyone can run:**

| Command | What it does |
|---|---|
| `!players` | Lists tracked players |
| `!hrstats` | Season HR stats for all tracked players |
| `!parkstats` | Parks breakdown for all players (how many stadiums each HR would clear) |
| `!parkstats [player]` | Parks breakdown for one player (e.g. `!parkstats judge`) |
| `!judge`, `!soto`, etc. | Stats for one player |

**Admin only:**

| Command | What it does |
|---|---|
| `!forcecheck` | Run a home run check right now |
| `!testhr` | Send a fake alert to test formatting |
| `!reset [player]` | Reset a player's tracking state |
| `!debug` | Dump bot internals |

## How it works

The bot checks each tracked player's HR total every 4 minutes via the MLB Stats API. When the count goes up, it:

1. Sends an alert embed to Discord with the player name, HR number, distance, and RBI type.
2. Pulls Statcast data for that at-bat from Baseball Savant.
3. Runs `scripts/hr_analysis.py` to render a ballpark image showing the hit's trajectory, landing spot, and wall clearance.
4. Posts a follow-up embed with the image and full Statcast breakdown.

Tracking state saves to `data/bot_state.json` after every check. The bot skips home runs it already reported, even across restarts. On restart, restored players run one catch-up pass that marks older missed home runs as skipped and only sends or retries the most recent missed home run.

## Files

```
bot.js                  Main bot
scripts/hr_analysis.py  Ballpark image generation
data/fences.json        Stadium fence coordinates
data/stadium_paths.json Stadium outlines
data/bot_state.json     Runtime state (git-ignored)
```

## License

MIT
