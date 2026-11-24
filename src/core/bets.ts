import { championName, type AssetSource } from '../assets/ddragon.ts';
import type { BetRoundRow, BetRow, Repo } from '../db/repo.ts';
import { QUEUE_LABEL } from '../riot/types.ts';
import type { PlayerRow } from '../db/repo.ts';
import type { CurrentGameInfo } from '../riot/types.ts';
import type { LiveSeen } from './tracker.ts';
import type { LogPoster, Reply } from './service.ts';

/**
 * Bets: when a tracked player is spotted in a ranked game, the server's bet channel gets a post
 * with Win / Lose buttons. Bets close BET_WINDOW_MS after the post and pay 2x; a remake refunds.
 * Points are per server and not real: everyone starts with START_POINTS, and anyone who drops
 * below BAILOUT_BELOW gets topped back up to BAILOUT_TO before their next bet.
 */
export const START_POINTS = 1000;
export const BET_WINDOW_MS = 5 * 60_000;
export const BAILOUT_BELOW = 10;
export const BAILOUT_TO = 100;
export const PAYOUT = 2;
/** A round with no result this long after opening is refunded (game never showed up). */
export const ROUND_TTL_MS = 3 * 3_600_000;
export const BET_PREFIX = 'bet:';
/** Games already running longer than this when first seen get no round. */
export const LATE_MS = 8 * 60_000;

export class BetError extends Error {}

/** The draft image is attached once, when the round is posted; later edits keep it. */
export const DRAFT_FILE = 'draft.png';

interface Who { puuid: string; name: string; champion: string }

export class Bets {
  constructor(
    private readonly repo: Repo,
    private readonly now: () => number,
    private readonly log: (m: string) => void,
    private readonly assets: AssetSource | null,
    private readonly rankedQueues: () => number[],
    /** The /live draft image for a round post (both teams, champions, ranks). */
    private readonly draft?: (player: PlayerRow, game: CurrentGameInfo) => Promise<Buffer>,
  ) {}

  private poster: LogPoster | null = null;
  setPoster(p: LogPoster | null) {
    this.poster = p;
  }

  /** Open a round per server (with a bet channel) for every ranked game first seen this tick. */
  async open(live: LiveSeen[]): Promise<void> {
    if (!this.poster || !live.length) return;
    const ranked = this.rankedQueues();
    const sd = this.assets ? await this.assets.staticData('').catch(() => null) : null;
    const drafts = new Map<number, Promise<Buffer | null>>(); // one render per game, shared by servers
    for (const { player, game } of live) {
      const queueId = game.gameQueueConfigId ?? 0;
      if (!ranked.includes(queueId)) continue;
      // spotted late (idle players are checked less often): too late for fair bets
      if (game.gameStartTime && this.now() - game.gameStartTime > LATE_MS) continue;
      const matchId = `${game.platformId}_${game.gameId}`;
      const me = game.participants.find((p) => p.puuid === player.puuid);
      if (!me) continue;
      for (const guild of this.repo.guildsTracking(player.puuid)) {
        if (!guild.bet_channel_id) continue;
        const tracked = new Map(this.repo.trackedInGuild(guild.guild_id).map((p) => [p.puuid, p]));
        const who = (team: number): Who[] => game.participants
          .filter((p) => p.teamId === team && p.puuid && tracked.has(p.puuid))
          .map((p) => ({ puuid: p.puuid!, name: tracked.get(p.puuid!)!.game_name, champion: championName(sd, p.championId, '') }));
        const players = who(me.teamId);
        const opponents = who(me.teamId === 100 ? 200 : 100);
        const id = this.repo.createBetRound({
          guild_id: guild.guild_id, match_id: matchId, puuid: player.puuid, team_id: me.teamId, queue_id: queueId,
          players: JSON.stringify(players), opponents: JSON.stringify(opponents),
          participants: JSON.stringify(game.participants.map((p) => p.puuid).filter(Boolean)),
          channel_id: guild.bet_channel_id,
          opened_at: this.now(), closes_at: this.now() + BET_WINDOW_MS,
        });
        if (id === null) continue; // a teammate already opened this game's round here
        try {
          if (!drafts.has(game.gameId)) {
            drafts.set(game.gameId, this.draft ? this.draft(player, game).catch((e) => {
              this.log(`bets: draft image failed for ${matchId}: ${(e as Error).message}`);
              return null;
            }) : Promise.resolve(null));
          }
          const png = await drafts.get(game.gameId)!;
          const reply = this.roundReply(this.repo.getBetRound(id)!);
          if (png) {
            reply.embed.image = { url: `attachment://${DRAFT_FILE}` };
            reply.files = [{ name: DRAFT_FILE, data: png }];
          }
          const messageId = await this.poster.send(guild.bet_channel_id, reply);
          this.repo.setBetRoundMessage(id, messageId, !!png);
        } catch (e) {
          this.log(`bets: could not post round for ${matchId} in ${guild.guild_id}: ${(e as Error).message}`);
          this.repo.deleteBetRound(id);
        }
      }
    }
  }

  /** Lock rounds past their window, settle ones whose game is in, refund ones that never finished. */
  async update(): Promise<void> {
    const now = this.now();
    for (const r of this.repo.unsettledBetRounds()) {
      // the focus player's row appears as soon as the game is detected (result known, LP maybe not)
      const row = this.repo.matchRows(r.match_id).find((x) => x.puuid === r.puuid);
      if (row) {
        this.settle(r, row.remake ? 'remake' : row.win ? 'win' : 'loss');
      } else if (now - r.opened_at > ROUND_TTL_MS) {
        this.settle(r, null);
      } else if (r.status === 'open' && now >= r.closes_at) {
        this.repo.setBetRoundStatus(r.id, 'locked');
      } else {
        continue;
      }
      await this.edit(this.repo.getBetRound(r.id)!);
    }
  }

  private settle(r: BetRoundRow, result: BetRoundRow['result']): void {
    const payouts = new Map<string, number>();
    for (const b of this.repo.betsFor(r.id)) {
      payouts.set(b.user_id, result === 'win' || result === 'loss' ? (b.side === result ? b.amount * PAYOUT : 0) : b.amount);
    }
    this.repo.settleBetRound(r, payouts, result === 'win' || result === 'loss' ? 'settled' : 'void', result);
  }

  private async edit(r: BetRoundRow): Promise<void> {
    if (!this.poster || !r.message_id) return;
    await this.poster.edit(r.channel_id, r.message_id, this.roundReply(r)).catch((e) =>
      this.log(`bets: could not edit round ${r.id}: ${(e as Error).message}`));
  }

  /**
   * Place a bet. Needs a linked account; anyone playing in the game can't bet on it.
   * Returns the refreshed round post and a short confirmation for the bettor.
   */
  place(roundId: number, userId: string, side: 'win' | 'loss', amountInput: string): { reply: Reply; note: string } {
    const r = this.repo.getBetRound(roundId);
    if (!r) throw new BetError('That bet is gone.');
    if (r.status !== 'open' || this.now() >= r.closes_at) throw new BetError('Betting on this game is closed.');
    if (this.repo.getBet(r.id, userId)) throw new BetError('You already bet on this game.');
    // Betting needs a linked account, so Zeke can tell who is playing; players sit their own game out.
    const linked = this.repo.linkedPlayers(userId).map((p) => p.puuid);
    if (!linked.length) throw new BetError('Link your League account first (`/link`) to bet: that way nobody can bet on their own game.');
    const inGame = new Set([
      ...(JSON.parse(r.participants) as string[]),
      ...[...(JSON.parse(r.players) as Who[]), ...(JSON.parse(r.opponents) as Who[])].map((w) => w.puuid),
    ]);
    if (linked.some((p) => inGame.has(p))) throw new BetError("You're in this game, so you can't bet on it.");

    let note = '';
    let points = this.repo.wallet(r.guild_id, userId, START_POINTS);
    if (points < BAILOUT_BELOW) {
      this.repo.setWallet(r.guild_id, userId, BAILOUT_TO);
      points = BAILOUT_TO;
      note = ` You were broke, so you got a ${BAILOUT_TO} point bailout.`;
    }
    const amount = parseAmount(amountInput, points);
    if (amount === null) throw new BetError(`Bet a whole number from 1 to ${points} (or "all").`);
    if (!this.repo.placeBet(r.guild_id, r.id, userId, side, amount, this.now())) throw new BetError('You already bet on this game.');
    return {
      reply: this.roundReply(this.repo.getBetRound(r.id)!),
      note: `Bet **${amount}** on **${side === 'win' ? 'Win' : 'Lose'}**. ${points - amount} points left.${note}`,
    };
  }

  balance(guildId: string, userId: string): number {
    return this.repo.wallet(guildId, userId, START_POINTS);
  }

  /** /points: your balance and record, plus the server's top 10. */
  pointsReply(guildId: string, userId: string, targetId = userId): Reply {
    const pts = this.balance(guildId, targetId);
    const rec = this.repo.betRecord(guildId, targetId);
    const top = this.repo.walletTop(guildId, 10);
    const medal = ['🥇', '🥈', '🥉'];
    const you = targetId === userId;
    return {
      embed: {
        title: '🎲 Points',
        color: 0xf5c542,
        description: `${you ? 'You have' : `<@${targetId}> has`} **${pts.toLocaleString('en-US')}** points` +
          (rec.won + rec.lost ? ` · ${rec.won}W ${rec.lost}L in bets · ${rec.net >= 0 ? '+' : ''}${rec.net.toLocaleString('en-US')} net` : ' · no bets settled yet'),
        fields: top.length
          ? [{ name: 'Richest in this server', value: top.map((t, i) => `${medal[i] ?? `\`${i + 1}.\``} <@${t.user_id}> · ${t.points.toLocaleString('en-US')}`).join('\n'), inline: false }]
          : [],
        footer: { text: `Bets pay ${PAYOUT}x · everyone starts with ${START_POINTS} · points aren't real` },
      },
      files: [],
    };
  }

  /** The round post: who's playing, the pot on each side, and the result once it's in. */
  roundReply(r: BetRoundRow): Reply {
    const players = JSON.parse(r.players) as Who[];
    const opponents = JSON.parse(r.opponents) as Who[];
    const bets = this.repo.betsFor(r.id);
    const side = (s: 'win' | 'loss') => bets.filter((b) => b.side === s);
    const sum = (bs: BetRow[]) => bs.reduce((n, b) => n + b.amount, 0);
    const list = (bs: BetRow[]) => bs.length ? bs.map((b) => `<@${b.user_id}> ${b.amount}${b.payout !== null && r.status === 'settled' ? (b.payout ? ` → **+${b.payout - b.amount}**` : ' → lost') : ''}`).join('\n').slice(0, 1000) : '—';
    const names = (ws: Who[]) => ws.map((w) => `**${w.name}**${w.champion ? ` (${w.champion})` : ''}`).join(', ');
    const queue = QUEUE_LABEL[r.queue_id] ?? 'Ranked';
    const head = `${names(players)} ${players.length > 1 ? 'are' : 'is'} in a ${queue} game` +
      (opponents.length ? `, against ${names(opponents)}` : '') + '.';
    const title =
      r.status === 'settled' ? (r.result === 'win' ? `✅ ${players[0]!.name} won` : `❌ ${players[0]!.name} lost`)
      : r.status === 'void' ? (r.result === 'remake' ? '↩️ Remake · bets refunded' : '↩️ No result · bets refunded')
      : r.status === 'locked' ? '🔒 Bets closed · game in progress'
      : '🎲 Bets open';
    const status =
      r.status === 'open' ? `Will they win? Bets close <t:${Math.floor(r.closes_at / 1000)}:R> and pay ${PAYOUT}x.`
      : r.status === 'locked' ? 'Waiting for the result.'
      : r.status === 'settled' ? `${bets.filter((b) => b.payout).length} of ${bets.length} bet${bets.length === 1 ? '' : 's'} paid out.`
      : 'Everyone got their points back.';
    const win = side('win'), loss = side('loss');
    const live = r.status === 'open' || r.status === 'locked';
    return {
      embed: {
        title,
        color: r.status === 'settled' ? (r.result === 'win' ? 0x3fb950 : 0xf85149) : r.status === 'void' ? 0x8b949e : 0xf5c542,
        description: `${head}\n${status}`,
        fields: [
          { name: `🟩 Win · ${sum(win)} pts`, value: list(win), inline: true },
          { name: `🟥 Lose · ${sum(loss)} pts`, value: list(loss), inline: true },
        ],
        footer: { text: `Points aren't real · /points for your balance` },
        // the draft stays while the game runs; once it's decided the post is just the result
        ...(r.has_draft && live ? { image: { url: `attachment://${DRAFT_FILE}` } } : {}),
      },
      ...(r.has_draft && !live ? { clearAttachments: true } : {}),
      files: [],
      components: r.status === 'open'
        ? [{
            type: 1,
            components: [
              { type: 2, style: 3, label: 'Bet Win', custom_id: `${BET_PREFIX}w:${r.id}` },
              { type: 2, style: 4, label: 'Bet Lose', custom_id: `${BET_PREFIX}l:${r.id}` },
              { type: 2, style: 2, label: 'My points', custom_id: `${BET_PREFIX}p:${r.id}` },
            ],
          }]
        : [],
    };
  }
}

/** "250", "1,000", "all", "half" → a stake within the balance, or null. */
export function parseAmount(input: string, balance: number): number | null {
  const s = input.trim().toLowerCase().replace(/[,\s_]/g, '');
  const n = s === 'all' || s === 'allin' ? balance : s === 'half' ? Math.floor(balance / 2) : /^\d+k$/.test(s) ? Number(s.slice(0, -1)) * 1000 : /^\d+$/.test(s) ? Number(s) : NaN;
  return Number.isInteger(n) && n >= 1 && n <= balance ? n : null;
}
