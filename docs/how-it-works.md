# How Zeke works

[← Back to README](../README.md)

## LP tracking

Riot's match data (match-v5) contains no LP. Zeke works it out by comparing the player's rank (league-v4) before and after each game:

- **One LP scale:** every rank maps to a single number (`tier × 400 + division × 100 + LP`; Master and above = 2800 + LP), so promotions and demotions diff correctly.
- **Waiting for the ladder:** a finished game stays *pending* until the queue's wins + losses go up, since the ladder often updates a minute or two after the match.
- **Exact vs batched:** one game per ladder update gives the exact LP. Several games between two checks only give a combined total, shown as "batched".
- **Remakes** count as 0 LP and aren't counted in W/L.
- **Dodges, decay and leaver penalties** are LP changes without a game. They're recorded separately and included in recaps, so totals always match the ladder.
- **Timeout:** if the ladder doesn't update within `LP_SETTLE_TIMEOUT_SEC`, the game is recorded with LP unknown.

"Today" and "this week" (Mon–Sun) use local midnight in `DEFAULT_TZ` and handle daylight-saving changes.

## Polling

Every account Zeke has seen (linked, tracked or looked up) stays tracked, and is polled at most once even if it's in several servers. How often depends on activity:

| Account state | Checked |
|---|---|
| Played in the last 3 hours, or a game is waiting for LP | every poll (2 min) |
| Idle, linked or on a server leaderboard | every 10 min |
| Idle, only ever looked up | every 30 min |

A ranked game lasts longer than 10 minutes, so linked and tracked accounts still get exact per-game LP.

Each check is one request, plus about two per new game. The client follows Riot's rate-limit headers (per routing host), waits out `Retry-After` on 429, and retries server errors with backoff.

## Scouting (`/scout`)

From one player's name, Zeke takes their last 50 team games: Ranked 5s first, then Flex to fill the rest.
1. **Team:** the player plus the 4 allies who appear most often (at least 3 shared games).
2. **Roles:** the best overall assignment of everyone's positions, so two mids get split sensibly.
3. **Bans per player:** of their 10 most played champions, the 3 best winrates, counting only champions with at least 5 games.
4. **Priority bans:** the team's 5 biggest threats, by winrate × how often they're played.

Ranked 5s carries **90%** of the weight in all of this (`FIVES_WEIGHT`). Winrates are pulled toward 50% when there's little data, so a 9W 1L in Flex doesn't outrank a strong Ranked 5s pick.

Riot doesn't document the Ranked 5s queue ID, so Zeke finds it on the first scan and stores it. Scouted players are **not** added to tracking.

## Profile ladder position

Master, Grandmaster and Challenger show the exact position ("#1,096 on EUNE"), from Riot's apex ladders, cached for 30 minutes. Riot has no ladder position below Master, so none is shown there.

## Images

Cards are drawn with `@napi-rs/canvas`:
- **Icons:** champions, items, spells and runes come from Data Dragon, matched to each game's patch. Rank emblems come from CommunityDragon. Everything is cached in `data/cache/`.
- **Fallbacks:** a missing icon shows a placeholder. If rendering fails, the bot sends a text embed instead.
- **Fonts:** Inter is bundled (OFL). CJK names fall back to system fonts.
- **MVP / ACE:** a simple score from KDA, kill participation, and damage, vision and gold share. MVP is the best player on the winning team, ACE the best on the losing team.

## Project layout

```
src/
  riot/          Riot API client, rate limiter, region routing, Riot ID parsing
  db/            SQLite schema + migrations, typed repository
  core/          tracker (polling + LP), recaps, scouting, rank math, timezones, service layer
  render/        embed builders; render/image/ = canvas cards (scoreboard, graph, leaderboard, recap, profile, ban plan)
  assets/        Data Dragon / CommunityDragon client with disk cache
  discord/       slash commands, $ prefix parser, handlers, registration
  tools/         export-db
  dev/           simulated Riot API used by tests and the demo
test/            node:test suites
```

## Data

Everything lives in one SQLite file:
- Riot accounts (PUUID, Riot ID, region)
- Discord user → account links
- Server leaderboards
- Rank snapshots
- Recorded games with LP changes
- Cached match data

Nothing is sent anywhere except the Riot API, Data Dragon/CommunityDragon (for icons) and Discord.
