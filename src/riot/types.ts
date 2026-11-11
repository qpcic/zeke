// Subset of Riot DTOs we use. Field names match the API exactly.

export interface AccountDto {
  puuid: string;
  gameName?: string;
  tagLine?: string;
}

export type RankedQueueType = 'RANKED_SOLO_5x5' | 'RANKED_FLEX_SR' | (string & {});

export interface LeagueEntryDto {
  leagueId?: string;
  puuid: string;
  queueType: RankedQueueType;
  tier: string; // IRON..CHALLENGER
  rank: string; // I..IV
  leaguePoints: number;
  wins: number;
  losses: number;
  hotStreak: boolean;
  veteran: boolean;
  freshBlood: boolean;
  inactive: boolean;
  miniSeries?: { losses: number; progress: string; target: number; wins: number };
}

export interface ParticipantDto {
  puuid: string;
  riotIdGameName?: string;
  riotIdTagline?: string;
  summonerName?: string;
  championName: string;
  championId: number;
  champLevel: number;
  teamId: 100 | 200;
  teamPosition: string; // TOP JUNGLE MIDDLE BOTTOM UTILITY or ''
  individualPosition: string;
  win: boolean;
  kills: number;
  deaths: number;
  assists: number;
  totalMinionsKilled: number;
  neutralMinionsKilled: number;
  goldEarned: number;
  totalDamageDealtToChampions: number;
  visionScore: number;
  item0: number; item1: number; item2: number; item3: number; item4: number; item5: number; item6: number;
  summoner1Id: number;
  summoner2Id: number;
  perks?: { styles: { description: string; style: number; selections: { perk: number }[] }[] };
  wardsPlaced?: number;
  challenges?: { kda?: number; killParticipation?: number; teamDamagePercentage?: number };
  gameEndedInEarlySurrender: boolean;
  gameEndedInSurrender: boolean;
  pentaKills: number;
  quadraKills: number;
  tripleKills: number;
  doubleKills: number;
}

export interface TeamDto {
  teamId: 100 | 200;
  win: boolean;
  objectives?: {
    baron?: { kills: number };
    dragon?: { kills: number };
    tower?: { kills: number };
    champion?: { kills: number };
    riftHerald?: { kills: number };
    horde?: { kills: number }; // void grubs
    atakhan?: { kills: number };
    inhibitor?: { kills: number };
  };
}

export interface MatchDto {
  metadata: { matchId: string; participants: string[] };
  info: {
    gameCreation: number;
    gameStartTimestamp: number;
    gameEndTimestamp?: number;
    gameDuration: number; // seconds (since patch 11.20)
    gameMode: string;
    gameVersion: string;
    queueId: number;
    platformId: string;
    endOfGameResult?: string;
    participants: ParticipantDto[];
    teams: TeamDto[];
  };
}

export const QUEUE_TYPE_BY_ID: Record<number, RankedQueueType> = {
  420: 'RANKED_SOLO_5x5',
  440: 'RANKED_FLEX_SR',
};

export const FIVES_QUEUE_TYPE = 'RANKED_PREMADE_5x5';

/**
 * Ranked 5s has no documented queue id. Once one is seen in match data it's registered
 * here so every queueId -> queueType / label lookup treats it like Solo and Flex.
 */
export function registerFivesQueue(id: number): void {
  if (!Number.isFinite(id) || id === 420 || id === 440) return;
  QUEUE_TYPE_BY_ID[id] = FIVES_QUEUE_TYPE;
  QUEUE_LABEL[id] = 'Ranked 5s';
}
export const isFivesQueue = (id: number) => QUEUE_TYPE_BY_ID[id] === FIVES_QUEUE_TYPE;

export const QUEUE_LABEL: Record<number, string> = {
  420: 'Ranked Solo/Duo',
  440: 'Ranked Flex',
  400: 'Normal Draft',
  430: 'Normal Blind',
  450: 'ARAM',
  490: 'Quickplay',
};

export interface SummonerDto { puuid: string; profileIconId: number; summonerLevel: number; revisionDate?: number }
export interface ChampionMasteryDto { puuid: string; championId: number; championLevel: number; championPoints: number; lastPlayTime?: number }
export interface LeagueListDto {
  tier: string;
  queue: string;
  entries: { puuid: string; leaguePoints: number; wins: number; losses: number; rank: string }[];
}
