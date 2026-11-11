import { tx } from '../db/db.ts';
import type { PlayerMatchRow, PlayerRow, Repo, SnapshotRow } from '../db/repo.ts';
import { isStalePuuidError, type RiotClient } from '../riot/client.ts';
import { FIVES_QUEUE_TYPE, isFivesQueue, QUEUE_TYPE_BY_ID, type LeagueEntryDto, type MatchDto } from '../riot/types.ts';
import { loadFivesQueue, saveFivesQueue } from './queues.ts';
import type { GameNote, GameResult, LpAdjustment } from './events.ts';
import { absoluteLp, compareDivision, type Rank } from './rank.ts';

export interface TrackerOptions {
  trackedQueues: number[];
  lpSettleTimeoutSec: number;
  rankRefreshSec: number;
  now?: () => number;
  log?: (msg: string) => void;
}

/**
 * Poll interval by recency of the player's last game. Players in a session get
 * checked every tick; dormant accounts barely cost anything.
 */
export function pollIntervalMs(lastActivity: number, now: number, hasPending: boolean, anchored: boolean): number {
  if (hasPending) return 0;
  if (now - lastActivity < 3 * 3600_000) return 0; // in a session: every tick
  // A ranked game takes >15 min, so 10 min keeps per-game LP exact for linked/tracked accounts.
  // Accounts that were only looked up are checked less often; worst case two games get batched.
  return anchored ? 10 * 60_000 : 30 * 60_000;
}

export interface TickResult {
  games: GameResult[];
  adjustments: LpAdjustment[];
  requests: number;
}

/**
 * match-v5 `startTime` filters on game START, so a game in progress during the previous
 * tick started before last_match_check. Look back far enough to cover the longest games;
 * it's still one request, and dedup against player_matches handles the overlap.
 */
const START_OVERLAP_SEC = 2 * 60 * 60;

const toRank = (s: { tier: string; division?: string; rank?: string; lp?: number; leaguePoints?: number }): Rank => ({
  tier: s.tier,
  division: s.division ?? s.rank ?? '',
  lp: s.lp ?? s.leaguePoints ?? 0,
});

/** Remakes (early surrender vote) give no W/L and no LP, except a penalty for the AFK player. */
export function isRemake(m: MatchDto, puuid: string): boolean {
  return !!m.info.participants.find((x) => x.puuid === puuid)?.gameEndedInEarlySurrender;
}

export class Tracker {
  private readonly now: () => number;
  private readonly log: (msg: string) => void;
  private readonly rankedOnly: boolean;

  constructor(
    private readonly repo: Repo,
    private readonly riot: RiotClient,
    private readonly opts: TrackerOptions,
  ) {
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => {});
    this.rankedOnly = opts.trackedQueues.every((q) => q in QUEUE_TYPE_BY_ID);
    loadFivesQueue(repo);
  }

  /** Ranked 5s is tracked alongside the configured queues once its queue id is known. */
  private isTracked(queueId: number): boolean {
    return this.opts.trackedQueues.includes(queueId) || isFivesQueue(queueId);
  }

  /**
   * First time 5s is tracked: drop 5s rank snapshots taken while it wasn't, so W/L from
   * untracked games isn't attributed to the first tracked game (or logged as a fake adjustment).
   */
  private ensureFivesBaseline(): void {
    if (!Object.values(QUEUE_TYPE_BY_ID).includes(FIVES_QUEUE_TYPE) || this.repo.getKv('fives_tracking_since')) return;
    this.repo.deleteSnapshots(FIVES_QUEUE_TYPE);
    this.repo.setKv('fives_tracking_since', String(this.now()));
  }

  /** A `type=ranked` game that isn't Solo/Duo or Flex on a 10-player map is Ranked 5s. */
  private noteFivesQueue(m: MatchDto): void {
    const q = m.info.queueId;
    if (!this.rankedOnly || q in QUEUE_TYPE_BY_ID || m.info.participants.length !== 10) return;
    saveFivesQueue(this.repo, q);
    this.log(`discovered Ranked 5s queue id ${q}; tracking it from now on`);
    this.ensureFivesBaseline();
  }

  /** Snapshot current rank so the first tracked game has a baseline. Call when a player is added. */
  async baseline(player: PlayerRow): Promise<LeagueEntryDto[]> {
    const entries = await this.riot.getLeagueEntries(player.platform, player.puuid);
    tx(this.repo.db, () => {
      for (const e of entries) this.repo.putSnapshot(this.snapFromEntry(player.puuid, e));
      this.repo.setLastRankCheck(player.puuid, this.now());
    });
    return entries;
  }

  /** One polling pass over every tracked player. */
  async tick(): Promise<TickResult> {
    const before = this.riot.requestCount;
    const games: GameResult[] = [];
    const adjustments: LpAdjustment[] = [];
    this.ensureFivesBaseline();
    for (const due of this.repo.duePlayers(this.now())) {
      let player = due;
      try {
        let r;
        try {
          r = await this.pollPlayer(player);
        } catch (err) {
          if (!isStalePuuidError(err)) throw err;
          const re = await this.rekey(player);
          if (!re) throw err;
          player = re;
          r = await this.pollPlayer(player);
        }
        games.push(...r.games);
        adjustments.push(...r.adjustments);
      } catch (err) {
        this.log(`poll failed for ${player.game_name}#${player.tag_line}: ${(err as Error).message}`);
      }
      const fresh = this.repo.getPlayer(player.puuid);
      if (fresh) {
        const pending = this.repo.pendingMatches(player.puuid).length > 0;
        const activity = Math.max(fresh.last_game_at, fresh.created_at);
        this.repo.setNextPoll(player.puuid, this.now() + pollIntervalMs(activity, this.now(), pending, this.repo.isAnchored(player.puuid)));
      }
    }
    games.sort((a, b) => (a.match.info.gameEndTimestamp ?? 0) - (b.match.info.gameEndTimestamp ?? 0));
    return { games, adjustments, requests: this.riot.requestCount - before };
  }

  /**
   * Re-resolve a player whose stored PUUID was encrypted by a previous API key.
   * Looks them up by Riot ID with the current key and moves all their data over.
   */
  async rekey(player: PlayerRow): Promise<PlayerRow | null> {
    const acc = await this.riot.getAccountByRiotId(player.platform, player.game_name, player.tag_line).catch(() => null);
    if (!acc) {
      this.log(`rekey: ${player.game_name}#${player.tag_line} not found by Riot ID (renamed?); keeping old id`);
      return null;
    }
    if (acc.puuid !== player.puuid) {
      this.repo.rekeyPlayer(player.puuid, acc.puuid);
      this.repo.setKv('puuid_epoch', String(this.now()));
      this.log(`rekey: ${player.game_name}#${player.tag_line} moved to the current API key's PUUID`);
    }
    return this.repo.getPlayer(acc.puuid) ?? null;
  }

  async pollPlayer(player: PlayerRow): Promise<{ games: GameResult[]; adjustments: LpAdjustment[] }> {
    const tickStartSec = Math.floor(this.now() / 1000);

    // 1. discover new match IDs
    const ids = await this.riot.getMatchIds(player.platform, player.puuid, {
      startTime: Math.max(0, player.last_match_check - START_OVERLAP_SEC),
      type: this.rankedOnly ? 'ranked' : undefined,
      count: 20,
    });
    const known = this.repo.knownMatchIds(player.puuid, ids);
    const fresh = ids.filter((id) => !known.has(id)).reverse(); // oldest first

    for (const id of fresh) {
      const m = await this.getMatch(player, id);
      if (!m) continue;
      this.noteFivesQueue(m);
      const gameEnd = m.info.gameEndTimestamp ?? m.info.gameStartTimestamp + m.info.gameDuration * 1000;
      // The look-back window reaches before tracking began; those games were already in the baseline.
      const tracked = this.isTracked(m.info.queueId) && gameEnd >= player.created_at;
      const p = m.info.participants.find((x) => x.puuid === player.puuid);
      this.repo.insertPlayerMatch({
        match_id: id,
        puuid: player.puuid,
        queue_id: m.info.queueId,
        status: tracked && p ? 'pending' : 'ignored',
        win: p?.win ? 1 : 0,
        remake: isRemake(m, player.puuid) ? 1 : 0,
        game_end: gameEnd,
      });
      if (tracked && p) this.repo.bumpLastGame(player.puuid, gameEnd);
    }
    this.repo.setLastMatchCheck(player.puuid, tickStartSec);

    // 2. reconcile LP if there's anything pending, or periodically to catch dodges/decay
    const pending = this.repo.pendingMatches(player.puuid);
    const rankDue = this.now() - player.last_rank_check >= this.opts.rankRefreshSec * 1000;
    if (!pending.length && !rankDue) return { games: [], adjustments: [] };

    const entries = await this.riot.getLeagueEntries(player.platform, player.puuid);
    this.repo.setLastRankCheck(player.puuid, this.now());
    return this.reconcile(player, pending, entries);
  }

  private async getMatch(player: PlayerRow, matchId: string): Promise<MatchDto | null> {
    const cached = this.repo.getCachedMatch(matchId);
    if (cached) return cached;
    const m = await this.riot.getMatch(player.platform, matchId);
    if (m) this.repo.cacheMatch(m);
    return m;
  }

  private snapFromEntry(puuid: string, e: LeagueEntryDto): SnapshotRow {
    return { puuid, queue_type: e.queueType, tier: e.tier, division: e.rank, lp: e.leaguePoints, wins: e.wins, losses: e.losses, taken_at: this.now() };
  }

  /**
   * Core LP attribution. league-v4 lags match-v5 by seconds to minutes, so a game
   * is only resolved once wins+losses for its queue has gone up. Per queue:
   *   gamesDelta = (W+L)_now - (W+L)_snapshot
   *   - remakes: resolved immediately, never counted in W+L
   *   - gamesDelta == 0: league not updated yet -> keep pending (until timeout)
   *   - gamesDelta >= 1: oldest `gamesDelta` pending games are covered by lpDelta;
   *     exactly one -> exact LP, more -> batched (sum only)
   *   - no pending but LP moved: adjustment (dodge, decay, leaver penalty)
   */
  reconcile(player: PlayerRow, pending: PlayerMatchRow[], entries: LeagueEntryDto[]): { games: GameResult[]; adjustments: LpAdjustment[] } {
    const games: GameResult[] = [];
    const adjustments: LpAdjustment[] = [];
    const now = this.now();
    const timedOut = (m: PlayerMatchRow) => now - m.first_seen >= this.opts.lpSettleTimeoutSec * 1000;

    const queueTypes = new Set<string>([
      ...this.opts.trackedQueues.map((q) => QUEUE_TYPE_BY_ID[q]).filter((x): x is string => !!x),
      ...(Object.values(QUEUE_TYPE_BY_ID).includes(FIVES_QUEUE_TYPE) ? [FIVES_QUEUE_TYPE] : []),
    ]);

    // Non-ranked tracked queues (ARAM etc.) have no LP: resolve immediately.
    for (const m of pending.filter((m) => !QUEUE_TYPE_BY_ID[m.queue_id])) {
      games.push(this.finalize(player, m, null, null, null, m.remake ? 'remake' : null));
    }

    tx(this.repo.db, () => {
      for (const qt of queueTypes) {
        const qPending = pending.filter((m) => QUEUE_TYPE_BY_ID[m.queue_id] === qt);
        const entry = entries.find((e) => e.queueType === qt);
        const snap = this.repo.getSnapshot(player.puuid, qt);
        const before = snap ? toRank(snap) : null;
        const after = entry ? toRank(entry) : null;

        // Remakes: never touch W/L; LP loss (if they were the leaver) shows up as an adjustment.
        for (const m of qPending.filter((m) => m.remake)) games.push(this.finalize(player, m, 0, before, before, 'remake'));
        const real = qPending.filter((m) => !m.remake);

        if (!entry) {
          // Still unranked / in placements: no LP to diff.
          for (const m of real.filter(timedOut)) games.push(this.finalize(player, m, null, null, null, 'unranked'));
          continue;
        }

        if (!snap) {
          // First time this queue has an entry (placements just finished, or we never had a baseline).
          for (const m of real) games.push(this.finalize(player, m, null, null, after, 'placement'));
          this.repo.putSnapshot(this.snapFromEntry(player.puuid, entry));
          continue;
        }

        const gamesDelta = entry.wins + entry.losses - (snap.wins + snap.losses);
        const lpDelta = absoluteLp(after!) - absoluteLp(before!);

        if (gamesDelta < 0) {
          // Season/split reset: W/L zeroed. Re-baseline, nothing to attribute.
          this.log(`${player.game_name}: ${qt} W/L went backwards (reset?), re-baselining`);
          for (const m of real) games.push(this.finalize(player, m, null, null, after, 'unknown'));
          this.repo.putSnapshot(this.snapFromEntry(player.puuid, entry));
          continue;
        }

        if (gamesDelta === 0) {
          if (!real.length && lpDelta !== 0) {
            this.repo.addLpEvent({ puuid: player.puuid, queueType: qt, delta: lpDelta, kind: 'adjustment', at: now });
            adjustments.push({ player, queueType: qt, delta: lpDelta, rankBefore: before!, rankAfter: after! });
            this.repo.putSnapshot(this.snapFromEntry(player.puuid, entry));
          }
          for (const m of real.filter(timedOut)) games.push(this.finalize(player, m, null, before, before, 'unknown'));
          continue;
        }

        // gamesDelta >= 1
        if (gamesDelta > real.length) {
          // Games we never saw (played before baseline, outside the ids window, or a dodge+game combo).
          this.log(`${player.game_name}: ${qt} +${gamesDelta} games on ladder but only ${real.length} pending`);
        }
        const covered = real.slice(0, Math.min(gamesDelta, real.length));
        if (covered.length === 1 && gamesDelta === 1) {
          const m = covered[0]!;
          const cmp = compareDivision(after!, before!);
          const note: GameNote = cmp > 0 ? 'promoted' : cmp < 0 ? 'demoted' : null;
          this.repo.addLpEvent({ puuid: player.puuid, queueType: qt, delta: lpDelta, kind: 'game', matchId: m.match_id, at: m.game_end });
          games.push(this.finalize(player, m, lpDelta, before, after, note));
        } else if (covered.length) {
          // Several games finished between two league reads: only the sum is knowable.
          const last = covered[covered.length - 1]!;
          this.repo.addLpEvent({ puuid: player.puuid, queueType: qt, delta: lpDelta, kind: 'game', matchId: last.match_id, at: last.game_end });
          for (const m of covered) {
            const g = this.finalize(player, m, m === last ? lpDelta : null, before, after, 'batched');
            g.batchSize = covered.length;
            games.push(g);
          }
        } else {
          // LP moved with W/L but we have no pending game to pin it on.
          this.repo.addLpEvent({ puuid: player.puuid, queueType: qt, delta: lpDelta, kind: 'adjustment', at: now });
          if (lpDelta) adjustments.push({ player, queueType: qt, delta: lpDelta, rankBefore: before!, rankAfter: after! });
        }
        this.repo.putSnapshot(this.snapFromEntry(player.puuid, entry));
      }
    });

    return { games, adjustments };
  }

  private finalize(player: PlayerRow, m: PlayerMatchRow, lpDelta: number | null, before: Rank | null, after: Rank | null, note: GameNote): GameResult {
    this.repo.finalizeMatch(m.match_id, m.puuid, {
      lpDelta, note,
      tier: after?.tier, division: after?.division, lp: after?.lp,
    });
    const match = this.repo.getCachedMatch(m.match_id)!;
    return { player, match, queueId: m.queue_id, win: !!m.win, remake: !!m.remake, lpDelta, note, rankBefore: before, rankAfter: after };
  }
}
