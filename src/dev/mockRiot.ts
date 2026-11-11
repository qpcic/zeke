import { randomUUID } from 'node:crypto';
import { absoluteLp, TIERS } from '../core/rank.ts';
import type { Platform } from '../riot/regions.ts';
import { QUEUE_TYPE_BY_ID, type LeagueEntryDto, type MatchDto, type ParticipantDto } from '../riot/types.ts';

/**
 * In-memory fake of the Riot endpoints we use, with league-v4 lagging behind
 * match-v5 like the real thing. Used by tests and `npm run demo`.
 */

/** Queues the mock treats as "ranked" for match-v5 type=ranked (470 stands in for Ranked 5s). */
export const MOCK_FIVES_QUEUE = 470;
const RANKED_QUEUES = new Set([420, 440, MOCK_FIVES_QUEUE]);

/** Deterministic PRNG so generated matches are reproducible. */
export function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CHAMPS = ['Ahri', 'LeeSin', 'Jinx', 'Thresh', 'Darius', 'Lux', 'Yasuo', 'Kaisa', 'Nautilus', 'Viego', 'Orianna', 'Ezreal', 'Leona', 'Garen', 'Sylas', 'Vi', 'Caitlyn', 'Lulu', 'Aatrox', 'Syndra'];
const NAMES = ['Kebab Enjoyer', 'xXSlayerXx', 'MidOrFeed', 'Baron Steal', 'tilted again', 'NoFlashNoProb', 'Ward Bot', 'Jungle Diff', 'gg ff 15', 'Pentaless'];
const POSITIONS = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'];
const SPELLS: Record<string, [number, number]> = { TOP: [4, 12], JUNGLE: [4, 11], MIDDLE: [4, 14], BOTTOM: [4, 7], UTILITY: [4, 3] };
const KEYSTONES: [number, number][] = [[8000, 8010], [8000, 8005], [8100, 8112], [8100, 8128], [8200, 8229], [8200, 8214], [8400, 8437]];
const SECONDARY = [8000, 8100, 8200, 8300, 8400];
const ITEMS = [3031, 3089, 3157, 6672, 3006, 3020, 3047, 3071, 3053, 3864, 3165, 6653, 3135, 3036, 3065, 3075, 2003, 0];

function rankFromAbs(abs: number): { tier: string; rank: string; leaguePoints: number } {
  if (abs >= 2800) return { tier: 'MASTER', rank: 'I', leaguePoints: abs - 2800 };
  const clamped = Math.max(0, abs);
  const t = Math.floor(clamped / 400);
  const d = Math.floor((clamped % 400) / 100);
  return { tier: TIERS[t]!, rank: ['IV', 'III', 'II', 'I'][d]!, leaguePoints: clamped % 100 };
}

interface Account { puuid: string; gameName: string; tagLine: string; platform: Platform }
interface PendingLeague { readsLeft: number; apply: () => void }

export interface PlayOpts {
  /** tracked puuid -> which team (100/200) */
  players: { puuid: string; team: 100 | 200; champion?: string; role?: string; win?: boolean }[];
  winner: 100 | 200;
  queueId?: number;
  durationSec?: number;
  remake?: boolean;
  /** LP change per puuid (defaults: +20..+25 win, -15..-20 loss) */
  lp?: Record<string, number>;
  /** league-v4 shows the change only after this many reads for that player */
  lagReads?: number;
  /** extra stat overrides for tracked players */
  stats?: Partial<ParticipantDto>;
}

export class MockRiot {
  accounts = new Map<string, Account>();
  league = new Map<string, LeagueEntryDto[]>();
  matches = new Map<string, MatchDto>();
  matchIds = new Map<string, string[]>(); // newest first
  pendingLeague = new Map<string, PendingLeague[]>();
  calls: string[] = [];
  private seq = 7_100_000_000;

  constructor(public clock: { now: () => number }, private rng: () => number = Math.random) {}

  addAccount(gameName: string, tagLine: string, platform: Platform, ranks: { queueType: string; tier: string; rank: string; lp: number; wins: number; losses: number }[] = []): Account {
    const a = { puuid: randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, ''), gameName, tagLine, platform };
    this.accounts.set(a.puuid, a);
    this.league.set(a.puuid, ranks.map((r) => ({
      puuid: a.puuid, queueType: r.queueType, tier: r.tier, rank: r.rank, leaguePoints: r.lp, wins: r.wins, losses: r.losses,
      hotStreak: false, veteran: false, freshBlood: false, inactive: false,
    })));
    this.matchIds.set(a.puuid, []);
    return a;
  }

  /** Simulate a finished game that ended "now". */
  play(o: PlayOpts): MatchDto {
    const queueId = o.queueId ?? 420;
    const dur = o.remake ? 200 : o.durationSec ?? 1500 + Math.floor(this.rng() * 900);
    const end = this.clock.now();
    const start = end - dur * 1000;
    const platform = this.accounts.get(o.players[0]!.puuid)!.platform;
    const matchId = `${platform}_${this.seq++}`;

    const usedChamps = new Set(o.players.map((p) => p.champion).filter(Boolean));
    const pickChamp = () => {
      const free = CHAMPS.filter((c) => !usedChamps.has(c));
      const c = free[Math.floor(this.rng() * free.length)]!;
      usedChamps.add(c);
      return c;
    };

    const participants: ParticipantDto[] = [];
    for (const team of [100, 200] as const) {
      // place players with an explicit role in that role's slot
      const listed = o.players.filter((p) => p.team === team);
      const tracked: (typeof listed[number] | undefined)[] = new Array(5).fill(undefined);
      for (const p of listed.filter((x) => x.role)) tracked[POSITIONS.indexOf(p.role!)] = p;
      for (const p of listed.filter((x) => !x.role)) tracked[tracked.findIndex((x) => !x)] = p;
      for (let i = 0; i < 5; i++) {
        const tp = tracked[i];
        const acc = tp ? this.accounts.get(tp.puuid)! : null;
        const win = team === o.winner && !o.remake;
        const r = (a: number, b: number) => a + Math.floor(this.rng() * (b - a + 1));
        const pos = POSITIONS[i]!;
        const support = pos === 'UTILITY';
        participants.push({
          puuid: acc?.puuid ?? randomUUID(),
          riotIdGameName: acc?.gameName ?? NAMES[r(0, NAMES.length - 1)]!,
          riotIdTagline: acc?.tagLine ?? 'EUW',
          championName: tp?.champion ?? pickChamp(),
          championId: r(1, 900),
          champLevel: r(11, 18),
          teamId: team,
          teamPosition: pos,
          individualPosition: pos,
          win: o.remake ? false : win,
          kills: r(win ? 3 : 0, win ? 14 : 8),
          deaths: r(win ? 0 : 3, win ? 6 : 11),
          assists: r(support ? 8 : 2, support ? 25 : 14),
          totalMinionsKilled: support ? r(20, 50) : r(140, 260),
          neutralMinionsKilled: pos === 'JUNGLE' ? r(120, 200) : r(0, 12),
          goldEarned: r(8000, 16000),
          totalDamageDealtToChampions: support ? r(6000, 14000) : r(14000, 38000),
          visionScore: support ? r(50, 90) : r(12, 40),
          item0: ITEMS[r(0, 16)]!, item1: ITEMS[r(0, 16)]!, item2: ITEMS[r(0, 16)]!, item3: ITEMS[r(0, 17)]!, item4: ITEMS[r(0, 17)]!, item5: ITEMS[r(0, 17)]!,
          item6: support ? 3364 : 3340,
          summoner1Id: SPELLS[pos]![0], summoner2Id: SPELLS[pos]![1],
          perks: (() => {
            const [style, keystone] = KEYSTONES[r(0, KEYSTONES.length - 1)]!;
            const sub = SECONDARY.filter((x) => x !== style)[r(0, 3)]!;
            return { styles: [{ description: 'primaryStyle', style, selections: [{ perk: keystone }] }, { description: 'subStyle', style: sub, selections: [] }] };
          })(),
          wardsPlaced: r(5, 40),
          gameEndedInEarlySurrender: !!o.remake,
          gameEndedInSurrender: !o.remake && dur < 1700,
          pentaKills: 0, quadraKills: 0, tripleKills: 0, doubleKills: r(0, 2),
          ...(acc ? o.stats : {}),
        });
      }
    }
    if (o.remake) for (const p of participants) Object.assign(p, { kills: 0, deaths: 0, assists: 0, totalMinionsKilled: 10, neutralMinionsKilled: 0, totalDamageDealtToChampions: 300, goldEarned: 1400, visionScore: 1 });

    const m: MatchDto = {
      metadata: { matchId, participants: participants.map((p) => p.puuid) },
      info: {
        gameCreation: start - 30_000, gameStartTimestamp: start, gameEndTimestamp: end, gameDuration: dur,
        gameMode: 'CLASSIC', gameVersion: '15.22.723.4211', queueId, platformId: platform, endOfGameResult: 'GameComplete',
        participants,
        teams: [100, 200].map((t) => {
          const won = !o.remake && t === o.winner;
          const n = (a: number, b: number) => (o.remake ? 0 : a + Math.floor(this.rng() * (b - a + 1)));
          return {
            teamId: t as 100 | 200, win: won,
            objectives: {
              tower: { kills: won ? n(7, 11) : n(1, 6) }, dragon: { kills: won ? n(2, 4) : n(0, 2) },
              baron: { kills: won ? n(0, 2) : n(0, 1) }, riftHerald: { kills: n(0, 1) }, horde: { kills: n(0, 6) },
              atakhan: { kills: won ? n(0, 1) : 0 }, inhibitor: { kills: won ? n(1, 3) : n(0, 1) }, champion: { kills: 0 },
            },
          };
        }),
      },
    };
    this.matches.set(matchId, m);

    for (const tp of o.players) {
      this.matchIds.get(tp.puuid)!.unshift(matchId);
      if (o.remake) continue;
      const qt = QUEUE_TYPE_BY_ID[queueId];
      if (!qt) continue;
      const win = tp.team === o.winner;
      const delta = o.lp?.[tp.puuid] ?? (win ? 20 + Math.floor(this.rng() * 6) : -(15 + Math.floor(this.rng() * 6)));
      const apply = () => this.applyLeague(tp.puuid, qt, win, delta);
      const lag = o.lagReads ?? 0;
      if (lag <= 0) apply();
      else {
        const q = this.pendingLeague.get(tp.puuid) ?? [];
        q.push({ readsLeft: lag, apply });
        this.pendingLeague.set(tp.puuid, q);
      }
    }
    return m;
  }

  /** LP change with no game (dodge / decay). */
  adjust(puuid: string, queueType: string, delta: number): void {
    const e = this.league.get(puuid)!.find((x) => x.queueType === queueType)!;
    Object.assign(e, rankFromAbs(absoluteLp({ tier: e.tier, division: e.rank, lp: e.leaguePoints }) + delta));
  }

  private applyLeague(puuid: string, qt: string, win: boolean, delta: number) {
    const entries = this.league.get(puuid)!;
    const e = entries.find((x) => x.queueType === qt);
    if (!e) return; // unranked: would be a placement game; tests add the entry manually
    const abs = absoluteLp({ tier: e.tier, division: e.rank, lp: e.leaguePoints }) + delta;
    Object.assign(e, rankFromAbs(abs));
    if (win) e.wins++;
    else e.losses++;
  }

  // ---- HTTP surface ----
  fetch: typeof fetch = async (input) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const path = decodeURIComponent(url.pathname).replace(/^\/[^/]+/, ''); // strip "/<host>"
    this.calls.push(path);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json', 'x-app-rate-limit': '20:1,100:120', 'x-app-rate-limit-count': '1:1,1:120', 'x-method-rate-limit': '2000:10' },
      });
    const notFound = () => json({ status: { message: 'Data not found', status_code: 404 } }, 404);
    // PUUIDs from "another API key" (tests prefix them with OLDKEY) can't be decrypted
    const stale = path.match(/OLDKEY\w+/);
    if (stale) return json({ status: { message: `Bad Request - Exception decrypting ${stale[0]}`, status_code: 400 } }, 400);

    let m: RegExpMatchArray | null;
    if ((m = path.match(/^\/riot\/account\/v1\/accounts\/by-riot-id\/([^/]+)\/([^/]+)$/))) {
      const a = [...this.accounts.values()].find((x) => x.gameName.toLowerCase() === m![1]!.toLowerCase() && x.tagLine.toLowerCase() === m![2]!.toLowerCase());
      return a ? json({ puuid: a.puuid, gameName: a.gameName, tagLine: a.tagLine }) : notFound();
    }
    if ((m = path.match(/^\/riot\/account\/v1\/accounts\/by-puuid\/(\w+)$/))) {
      const a = this.accounts.get(m[1]!);
      return a ? json({ puuid: a.puuid, gameName: a.gameName, tagLine: a.tagLine }) : notFound();
    }
    if ((m = path.match(/^\/lol\/league\/v4\/entries\/by-puuid\/(\w+)$/))) {
      const puuid = m[1]!;
      const q = this.pendingLeague.get(puuid) ?? [];
      for (const p of q) p.readsLeft--;
      while (q.length && q[0]!.readsLeft <= 0) q.shift()!.apply();
      return json(structuredClone(this.league.get(puuid) ?? []));
    }
    if ((m = path.match(/^\/lol\/summoner\/v4\/summoners\/by-puuid\/(\w+)$/))) {
      const a = this.accounts.get(m[1]!);
      return a ? json({ puuid: a.puuid, profileIconId: 4568, summonerLevel: 487 }) : notFound();
    }
    if ((m = path.match(/^\/lol\/champion-mastery\/v4\/champion-masteries\/by-puuid\/(\w+)$/))) {
      if (!this.accounts.has(m[1]!)) return notFound();
      const extra = Array.from({ length: 60 }, (_, i) => [200 + i, 30_000 - i * 400, Math.max(1, 6 - Math.floor(i / 10))]);
      return json([[112, 812_344, 42], [103, 401_112, 28], [134, 220_970, 19], [61, 98_012, 11], [127, 41_500, 7], ...extra]
        .map(([championId, championPoints, championLevel]) => ({ puuid: m![1], championId, championPoints, championLevel })));
    }
    if ((m = path.match(/^\/lol\/champion-mastery\/v4\/champion-masteries\/by-puuid\/(\w+)\/top$/))) {
      if (!this.accounts.has(m[1]!)) return notFound();
      return json([[112, 812_344, 42], [103, 401_112, 28], [134, 220_970, 19], [61, 98_012, 11], [127, 41_500, 7]]
        .map(([championId, championPoints, championLevel]) => ({ puuid: m![1], championId, championPoints, championLevel })));
    }
    if ((m = path.match(/^\/lol\/league\/v4\/(challenger|grandmaster|master)leagues\/by-queue\/(\w+)$/))) {
      const tier = m[1]!.toUpperCase();
      const entries = [...this.league.values()].flat().filter((e) => e.queueType === m![2] && e.tier === tier)
        .map((e) => ({ puuid: e.puuid, leaguePoints: e.leaguePoints, wins: e.wins, losses: e.losses, rank: 'I' }));
      // pad with fake apex players so positions look realistic
      const fake = tier === 'MASTER' ? Array.from({ length: 40 }, (_, i) => ({ puuid: `fake${i}`, leaguePoints: 1000 - i * 20, wins: 100, losses: 90, rank: 'I' })) : [];
      return json({ tier, queue: m[2], entries: [...entries, ...fake] });
    }
    if ((m = path.match(/^\/lol\/match\/v5\/matches\/by-puuid\/(\w+)\/ids$/))) {
      const startTime = Number(url.searchParams.get('startTime') ?? 0) * 1000;
      const count = Number(url.searchParams.get('count') ?? 20);
      const type = url.searchParams.get('type');
      const queue = url.searchParams.get('queue');
      const ids = (this.matchIds.get(m[1]!) ?? []).filter((id) => {
        const mm = this.matches.get(id)!;
        if (type === 'ranked' && !RANKED_QUEUES.has(mm.info.queueId)) return false;
        if (queue && mm.info.queueId !== Number(queue)) return false;
        return mm.info.gameStartTimestamp >= startTime;
      });
      return json(ids.slice(0, count));
    }
    if ((m = path.match(/^\/lol\/match\/v5\/matches\/(\w+)$/))) {
      const mm = this.matches.get(m[1]!);
      return mm ? json(mm) : notFound();
    }
    return notFound();
  };
}
