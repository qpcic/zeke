import type { PlayerRow, Repo } from '../db/repo.ts';
import type { Period } from './time.ts';

export interface PlayerDigest {
  player: PlayerRow;
  games: number;
  wins: number;
  losses: number;
  remakes: number;
  /** Net LP per queue type, including adjustments (dodges/decay). */
  lpByQueue: Record<string, number>;
  lpNet: number;
  adjustments: number;
  /** Current rank per queue at digest time. */
  ranks: { queue_type: string; tier: string; division: string; lp: number }[];
}

export interface Digest {
  kind: 'daily' | 'weekly' | 'adhoc';
  period: Period;
  players: PlayerDigest[];
  totals: { games: number; wins: number; losses: number; lpNet: number; activePlayers: number };
}

/** Games, W/L and net LP (incl. dodges/decay) for one player over [from, to). */
export function playerStats(repo: Repo, player: PlayerRow, period: { from: number; to: number }): PlayerDigest {
  const ms = repo.doneMatchesBetween(player.puuid, period.from, period.to);
  const lpByQueue: Record<string, number> = {};
  let adjustments = 0;
  for (const e of repo.lpEventsBetween(player.puuid, period.from, period.to)) {
    lpByQueue[e.queue_type] = (lpByQueue[e.queue_type] ?? 0) + e.delta;
    if (e.kind === 'adjustment') adjustments += e.delta;
  }
  const real = ms.filter((m) => !m.remake);
  return {
    player,
    games: real.length,
    wins: real.filter((m) => m.win).length,
    losses: real.filter((m) => !m.win).length,
    remakes: ms.length - real.length,
    lpByQueue,
    lpNet: Object.values(lpByQueue).reduce((a, b) => a + b, 0),
    adjustments,
    ranks: repo.getSnapshots(player.puuid),
  };
}

export function computeDigest(repo: Repo, guildId: string, kind: Digest['kind'], period: Period): Digest {
  const players = repo.trackedInGuild(guildId).map((p) => playerStats(repo, p, period));
  players.sort((a, b) => b.lpNet - a.lpNet || b.games - a.games);
  const active = players.filter((p) => p.games || p.lpNet);
  return {
    kind,
    period,
    players,
    totals: {
      games: players.reduce((n, p) => n + p.games, 0),
      wins: players.reduce((n, p) => n + p.wins, 0),
      losses: players.reduce((n, p) => n + p.losses, 0),
      lpNet: players.reduce((n, p) => n + p.lpNet, 0),
      activePlayers: active.length,
    },
  };
}
