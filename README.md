<div align="center">

# Zeke

**A League of Legends companion for Discord.**
Zeke records every ranked game and LP change for your friends, and turns them into clean, shareable cards:
profiles, scoreboards, daily and weekly recaps, LP graphs, server leaderboards and Scout reports for premade 5v5.

[Features](#features) · [Commands](#commands) · [Self-hosting](docs/self-hosting.md) · [How it works](docs/how-it-works.md)

</div>

<p align="center">
  <img src="docs/images/profile.png" alt="Profile card" width="720">
</p>

## Features

- **Automatic LP tracking:** link your Riot ID once. Zeke watches for finished ranked games in the background and records the exact LP gained or lost in each one, including promotions, demotions, remakes, dodges and decay.
- **Profile cards:** Solo/Duo, Flex and Ranked 5s ranks side by side (best first), W/L, ladder position for Master+, top champions and mastery stats.
- **Match scoreboards:** your latest game as a full 10-player scoreboard with items, runes, damage and MVP/ACE badges.
- **Daily and weekly recaps:** every game of the day or week with champion, KDA, result and LP, plus the net total.
- **LP graphs:** your climb over the last games, drawn on the tier and division ladder with your peak marked.
- **Server leaderboards:** who climbed the most today or this week, with win/loss, LP trend and current rank.
- **Scout:** type one name from the enemy Ranked 5s or Flex team. Zeke finds their five-stack, works out each player's role and best champions, and suggests what to ban.
- **Solo/Duo and Flex kept separate**, and every command also works with a `$` prefix (`$p`, `$rs`, `$lb`…).

<table>
  <tr>
    <td align="center"><img src="docs/images/daily.png" alt="Daily recap" width="420"><br><sub><code>/daily</code> · today's games and LP</sub></td>
    <td align="center"><img src="docs/images/leaderboard.png" alt="Leaderboard" width="420"><br><sub><code>/leaderboard</code> · who climbed today</sub></td>
  </tr>
  <!-- Add more screenshots here, e.g.:
  <tr>
    <td align="center"><img src="docs/images/recent.png" alt="Scoreboard" width="420"><br><sub><code>/recent</code> · latest game</sub></td>
    <td align="center"><img src="docs/images/graph.png" alt="LP graph" width="420"><br><sub><code>/graph</code> · LP over time</sub></td>
  </tr>
  <tr>
    <td align="center" colspan="2"><img src="docs/images/scout.png" alt="Scout" width="860"><br><sub><code>/scout</code> · scout a premade</sub></td>
  </tr>
  -->
</table>

## Commands

Every command works as a slash command and as a message with the `$` prefix. With no account given, a command shows **your** linked account. You can also pass `@someone` (their linked account) or any Riot ID like `Name#TAG`.

### You

| Command | What it does |
|---|---|
| `/link <region> <Name#TAG>` | Link your Riot account to your Discord user |
| `/unlink` | Remove your link |
| `/mode [solo\|flex]` | Set your default queue for stats commands (Solo/Duo unless changed) · `$mode flex` |
| `/profile [@user \| Name#TAG]` | Profile card: ranks, W/L, ladder position, top champions · `$p` |
| `/recent [@user \| Name#TAG] [solo\|flex]` | Scoreboard of the latest game · `$rs` |
| `/daily [@user \| Name#TAG] [solo\|flex]` | Today's games and LP · `$d` |
| `/weekly [@user \| Name#TAG] [solo\|flex]` | This week's games and LP · `$w` |
| `/graph [@user \| Name#TAG] [games] [solo\|flex]` | LP graph over recorded games · `$g` |
| `/scout <Name#TAG> [region]` | Scout that player's Ranked 5s / Flex team: roles, best champs, bans · `$scout` |

### Server

| Command | What it does |
|---|---|
| `/leaderboard <daily\|weekly> [solo\|flex]` | LP leaderboard of the server's tracked accounts · `$lb` |
| `/track add <region> <Name#TAG>` | Add an account to the server leaderboard *(Manage Server)* |
| `/track remove <account>` | Remove an account from the leaderboard *(Manage Server)* |
| `/track list` | Show tracked accounts |

**Good to know**
- **Queue** is always the last argument: `$daily @friend flex`, `$lb week flex`. Without one, your `/mode` is used, which is Solo/Duo unless you change it.
- **Region** is only needed the first time Zeke sees an account: `$p ferks kitten#retro eune`. Game names with spaces work.
- **Accounts are tracked across servers:** once anyone links, tracks or looks up an account, its games are recorded everywhere. Removing it from a server only takes it off that server's leaderboard.
- **History starts when tracking does.** Riot doesn't keep LP history, so graphs and recaps fill up from the moment an account is first added.
- **Personal commands work anywhere** (servers, DMs, group chats) if you install the app to your account. Server commands need Zeke in the server. `$` commands work wherever the bot is a member.
- `$help` lists everything.

## Running your own Zeke

Zeke is self-hosted: you run your own copy with your own Discord bot and Riot API key. It's one small Node.js process with a SQLite database, so a $5/month host or a spare machine is plenty.

```bash
git clone https://github.com/qpcic/zeke.git && cd zeke
npm install
npm run demo          # try it offline: simulated games, no keys needed
cp .env.example .env  # add DISCORD_TOKEN, DISCORD_CLIENT_ID, RIOT_API_KEY
npm run dev           # slash commands register themselves on first start
```

The full guide covers creating the Discord app, getting a Riot API key, Docker and Railway deploys, and moving your data between hosts: **[docs/self-hosting.md](docs/self-hosting.md)**.

## Tech

TypeScript on Node.js 22+ · discord.js · built-in `node:sqlite` · `@napi-rs/canvas` for the images · Riot API (account-v1, league-v4, match-v5, champion-mastery-v4, summoner-v4) · Data Dragon / CommunityDragon for icons. The tests run against a simulated Riot API (`npm test`). [How it works →](docs/how-it-works.md)

---

<sub>Zeke isn't endorsed by Riot Games and doesn't reflect the views or opinions of Riot Games or anyone officially involved in producing or managing Riot Games properties. Riot Games, and all associated properties are trademarks or registered trademarks of Riot Games, Inc.</sub>
