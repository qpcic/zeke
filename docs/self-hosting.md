# Self-hosting Zeke

You need:
- **Node.js 22.13+** (24 LTS recommended). Zeke uses the built-in `node:sqlite`, so there's nothing native to compile.
- **A Discord application** (free).
- **A Riot API key** (free).

[← Back to README](../README.md)

## 1. Create the Discord app

1. Open the [Discord Developer Portal](https://discord.com/developers/applications) → **New Application**.
2. **Bot** tab:
   - **Reset Token** and copy it. That's `DISCORD_TOKEN`.
   - Turn on **Message Content Intent** under *Privileged Gateway Intents*. It's only needed for `$` commands.
3. **General Information:** copy the **Application ID**. That's `DISCORD_CLIENT_ID`.
4. **Installation** tab:
   - Enable both **Guild Install** and **User Install**, and set the install link to *Discord Provided Link*.
   - For Guild Install, choose scopes `bot` and `applications.commands`, with permissions **View Channels**, **Send Messages** and **Embed Links**.
5. Open the install link to add the bot to a server, or to your own account for the personal commands everywhere.

## 2. Get a Riot API key

Sign in at [developer.riotgames.com](https://developer.riotgames.com).
- **Development key:** on the dashboard. It expires every **24 hours**, so it's fine for trying things out.
- **Personal key:** for running the bot permanently. Use **Register Product → Personal API Key** and describe your bot. Personal keys don't expire, and they're meant for small private communities.

## 3. Configure

```bash
cp .env.example .env
```

| Variable | Required | Description |
|---|---|---|
| `DISCORD_TOKEN` | ✔ | Bot token |
| `DISCORD_CLIENT_ID` | ✔ | Application ID |
| `RIOT_API_KEY` | ✔ | Riot API key |
| `DEFAULT_REGION` | | Region assumed by `/scout` for unknown players, e.g. `EUNE` |
| `PREFIX` | | Text command prefix (default `$`; empty turns `$` commands off) |
| `OWNER_ID` | | Your Discord user ID; enables `$import` and `$admin` |
| `CONSOLE_CHANNEL_ID` | | Channel where `$admin` commands work |
| `DEFAULT_TZ` | | Timezone used for dates shown on the cards (default `Europe/Ljubljana`) |
| `DB_PATH` | | SQLite file (default `./data/leaguebot.db`) |
| `POLL_INTERVAL_SEC` | | Seconds between polls (default `120`) |
| `TRACKED_QUEUES` | | Queues to record (default `420,440` = Solo/Duo, Flex) |
| `AUTO_REGISTER` | | `0` = don't register slash commands on startup (default: on) |
| `DEV_GUILD_ID` | | Test server for `npm run register -- --guild` |

## 4. Run locally

```bash
npm install
npm run dev
```

Other scripts:
Slash commands are registered automatically on startup whenever their definitions change (`AUTO_REGISTER=0` turns this off; `npm run register` does it by hand). Discord can take a minute to show new commands. Press Ctrl+R in Discord if they don't appear.

- `npm run demo`: offline demo with a simulated Riot API; no keys needed.
- `npm test`: test suite.
- `npm run build && npm start`: production build.

## 5. Host it 24/7

Zeke is one long-running process (a Discord connection plus a background poller) with a SQLite file. Any host that keeps a process running and gives you a **persistent disk** works. Serverless platforms like Vercel don't: they have no long-running process and no disk.

### Railway

1. **New Project → Deploy from GitHub repo** → your fork. Railway builds the `Dockerfile`.
2. **Variables:** add the variables from step 3.
3. **Add a Volume** with mount path **`/app/data`**. Without it, every deploy wipes the database.
4. Optional: turn on **Settings → Source → Wait for CI**, so only commits that pass tests get deployed.

Every push to `main` redeploys. Each start logs `database /app/data/leaguebot.db · N players · …`; if those counts drop to 0 after a deploy, the volume isn't mounted.

### Docker (any VPS)

```bash
git clone https://github.com/qpcic/zeke.git && cd zeke
cp .env.example .env && nano .env
docker compose up -d --build
docker compose logs -f
```

- **Data:** lives in `./data` on the host and survives rebuilds.
- **Update:** `git pull && docker compose up -d --build`.
- **Architectures:** the image builds for amd64 and arm64.

### Without Docker

Install Node 22.13+ and `fonts-noto-cjk` (so Korean, Japanese and Chinese names render), then run `npm ci && npm run build && npm start` under systemd or pm2.

**Run only one instance per bot token.** Two copies would both answer every command.

## Moving to a new host

1. On the old machine, stop the bot and run `npm run export-db`. It writes `data/zeke-export-<date>.db.gz` (links, tracked accounts, history, cached matches).
2. On the new host, set `OWNER_ID` to your Discord user ID.
3. DM the bot `$import` with the file attached. It checks the file, backs up the current database to `data/backups/`, swaps yours in and restarts.

## Admin console

With `OWNER_ID` and `CONSOLE_CHANNEL_ID` set, the owner can run these in that channel (anyone else, or anywhere else, gets no reply):

| Command | What it does |
|---|---|
| `$admin list [page]` | All known accounts with games, links and servers |
| `$admin links [page]` | Discord user → Riot account links, 10 per page |
| `$admin globallb [daily\|weekly] [solo\|flex\|5s]` | Leaderboard of every known account |
| `$admin remove <Name#TAG> [confirm]` | Delete an account's games, LP history, links and server tracks. Without `confirm` it only shows what would be deleted |

## Backups

All state is in the data folder (`data/`, or `/app/data` in Docker/Railway). To back it up, run `npm run export-db`, or stop the bot and copy the folder. `data/cache/` only holds icons and can be deleted at any time.

## CI

`.github/workflows/ci.yml` runs typecheck, tests and build on Node 22 and 24, the offline demo and a Docker build, on every push and pull request. `docker-publish.yml` publishes multi-arch images to GitHub Container Registry.
