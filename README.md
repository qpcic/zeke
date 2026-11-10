# LeagueBot

Discord bot that tracks League of Legends players per server and posts each finished game to a channel (result, scoreboard, LP change), plus daily and weekly recaps at local midnight.

> **Status:** core engine only. Output goes to the terminal and to `previews/` (no Discord yet).

## Requirements

- Node.js **22.13+** (24 LTS recommended). Uses the built-in `node:sqlite`, so there are no native modules to compile.
- A Riot API key from <https://developer.riotgames.com>.

## Quick start

```bash
npm install
npm run demo          # offline: fake Riot API, simulated day of games, no key needed
npm test              # unit + end-to-end tests against the mock API

cp .env.example .env  # put your RIOT_API_KEY in
npm run cli -- add EUW "Name#TAG"
npm run cli -- list
npm run cli -- poll   # one polling pass
npm run dev           # long-running: poll loop + midnight recaps
```

`--guild <id>` on any CLI command picks the "server" (default `local`). This will become the Discord guild ID later.

### Previewing embeds

Every message is:

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

Recaps are idempotent (`digest_runs`) and catch up if the bot was down at midnight (until 06:00 local). Periods are computed per guild timezone and are DST-safe.

## Rate limits

Dev and personal keys allow 20 req/1s and 100 req/2min **per routing host** (`europe`, `euw1`, … are separate buckets). The client:

- reads `X-App-Rate-Limit` / `X-Method-Rate-Limit` and adapts,
- honours `Retry-After` on 429,
- retries 5xx with backoff.

Cost per poll: 1 request per tracked player (match ids), plus about 2 per new game (match + league). A player tracked in several servers is polled once.

## Layout

```
src/
  riot/      client, rate limiter, region routing, Riot ID parsing, DTO types
  db/        node:sqlite schema + migrations, typed repo
  core/      tracker (polling + LP attribution), digest, rank math, timezone math, service
  render/    embed builders (Discord APIEmbed shape), terminal + HTML preview renderers
  sinks/     output targets; TerminalSink now, DiscordSink later
  dev/       mock Riot API used by tests and demo
  index.ts   long-running process      cli.ts   slash-command stand-in      demo.ts
test/        node:test suites
```

## Config (`.env`)

See `.env.example`. `TRACKED_QUEUES=420,440` covers Solo/Duo and Flex.
