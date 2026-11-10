# LeagueBot

Discord bot that tracks League of Legends accounts and answers slash commands with game embeds (result, scoreboard, LP change), personal daily/weekly recaps and per-server LP leaderboards.

The bot never posts on its own. A background poller records every ranked game and LP change for linked and tracked accounts, so the commands have data.

## Commands

| Command | Where | What |
|---|---|---|
| `/link region riot_id` | anywhere | Link your Riot account (one per Discord user) |
| `/unlink` | anywhere | Remove your link |
| `/recent [user]` | anywhere | Most recent game; LP shown if it was recorded |
| `/daily [user]` | anywhere | Today's games, W/L and LP |
| `/weekly [user]` | anywhere | This week's (Mon–Sun) games, W/L and LP |
| `/track add region riot_id` | server, Manage Server | Track an account in this server |
| `/track remove account` | server, Manage Server | Stop tracking (autocomplete) |
| `/track list` | server, Manage Server | List tracked accounts |
| `/leaderboard period` | server | LP leaderboard of tracked accounts, today or this week |

"Anywhere" means servers, the bot's DMs and group DMs. That needs the app to be user-installable.

## Discord setup (once)

1. Developer Portal → your app → **Installation**: enable both **User Install** and **Guild Install**. Install link: *Discord Provided Link*. Guild Install scopes: `applications.commands` and `bot`, with permissions `View Channels`, `Send Messages` and `Embed Links`.
2. Put `DISCORD_TOKEN` and `DISCORD_CLIENT_ID` in `.env`.
3. `npm run register` registers the global commands. Re-run it whenever command definitions change.
4. Add the bot to a server with the install link, or user-install it to get the personal commands everywhere.
5. `npm run dev`.

## Requirements

- Node.js **22.13+** (24 LTS recommended). Uses the built-in `node:sqlite`, so there are no native modules to compile.
- A Riot API key from <https://developer.riotgames.com>.

## Quick start

```bash
npm install
npm run demo          # offline: fake Riot API, simulated day of games, no key needed
npm test              # unit + end-to-end tests against the mock API

cp .env.example .env  # RIOT_API_KEY, DISCORD_TOKEN, DISCORD_CLIENT_ID
npm run register      # push slash commands to Discord
npm run dev           # bot + poll loop
```

The CLI still works for debugging without Discord: `npm run cli -- add EUW "Name#TAG" --guild <serverId>`, `list` and `poll`.

### Previewing embeds

`npm run demo` and `PREVIEW_GAMES=1` render every message:

1. rendered in the terminal,
2. written to `previews/<guild>/<timestamp>-<label>.json` as a webhook payload. Paste it into [Discohook](https://discohook.org) (JSON Data Editor) to see exactly what Discord will show,
3. added to `previews/index.html`, an offline Discord-style page of all messages so far.

## How LP tracking works

match-v5 has no LP, so LP comes from diffing `league-v4/entries/by-puuid` snapshots:

- Ranks map onto one continuous axis (`tier*400 + division*100 + lp`, Master+ = 2800 + lp), so promotions and demotions diff correctly.
- A game is held as **pending** until `wins + losses` for its queue increases. league-v4 often lags match-v5 by a minute or two.
- One game per ladder update gives the exact LP. Several games between two reads only give a sum, which is posted as a batch.
- Remakes: posted immediately, 0 LP, excluded from W/L.
- LP changes with no game (dodge, decay, leaver penalty) are caught by the periodic rank refresh (`RANK_REFRESH_SEC`) and stored as adjustments. Recaps include them, so totals match the ladder.
- If the ladder never updates within `LP_SETTLE_TIMEOUT_SEC`, the game is posted with "LP unavailable".

Day and week windows use local midnight (`DEFAULT_TZ`) and are DST-safe. The code for scheduled midnight recaps (`Service.runDueDigests`) is kept but not scheduled, since the bot is commands-only.

## Rate limits

Dev and personal keys allow 20 req/1s and 100 req/2min **per routing host** (`europe`, `euw1`, … are separate buckets). The client:

- reads `X-App-Rate-Limit` / `X-Method-Rate-Limit` and adapts,
- honours `Retry-After` on 429,
- retries 5xx with backoff.

Cost per poll: 1 request per player (match ids), plus about 2 per new game (match + league). An account that is linked and tracked in several servers is polled once. `/recent` costs 1–2 requests.

## Layout

```
src/
  riot/      client, rate limiter, region routing, Riot ID parsing, DTO types
  db/        node:sqlite schema + migrations, typed repo
  core/      tracker (polling + LP attribution), digest, rank math, timezone math, service
  render/    embed builders (Discord APIEmbed shape), terminal + HTML preview renderers
  discord/   slash command definitions, interaction handlers, registration script
  sinks/     where resolved games go (LogSink by default, TerminalSink for previews)
  dev/       mock Riot API used by tests and demo
  index.ts   bot + poll loop      cli.ts   debug CLI      demo.ts   offline demo
test/        node:test suites
```

## Config (`.env`)

See `.env.example`. `TRACKED_QUEUES=420,440` covers Solo/Duo and Flex.
