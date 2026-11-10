/** Platform routing values (league-v4, summoner-v4, spectator-v5). */
export const PLATFORMS = [
  'EUW1', 'EUN1', 'TR1', 'RU', 'ME1',
  'NA1', 'BR1', 'LA1', 'LA2',
  'KR', 'JP1',
  'OC1', 'SG2', 'TW2', 'VN2',
] as const;
export type Platform = (typeof PLATFORMS)[number];

/** Regional routing values (account-v1, match-v5). */
export type Region = 'europe' | 'americas' | 'asia' | 'sea';

const REGION_OF: Record<Platform, Region> = {
  EUW1: 'europe', EUN1: 'europe', TR1: 'europe', RU: 'europe', ME1: 'europe',
  NA1: 'americas', BR1: 'americas', LA1: 'americas', LA2: 'americas',
  KR: 'asia', JP1: 'asia',
  OC1: 'sea', SG2: 'sea', TW2: 'sea', VN2: 'sea',
};

/** Human labels, used for slash-command choices later. */
export const PLATFORM_LABEL: Record<Platform, string> = {
  EUW1: 'EUW', EUN1: 'EUNE', TR1: 'TR', RU: 'RU', ME1: 'ME',
  NA1: 'NA', BR1: 'BR', LA1: 'LAN', LA2: 'LAS',
  KR: 'KR', JP1: 'JP',
  OC1: 'OCE', SG2: 'SG', TW2: 'TW', VN2: 'VN',
};

/** match-v5 routing for a platform. */
export function matchRegion(p: Platform): Region {
  return REGION_OF[p];
}

/**
 * account-v1 routing. Account data is global and any cluster serves any account,
 * but `sea` is not served by account-v1, so map it to asia.
 */
export function accountRegion(p: Platform): Region {
  const r = REGION_OF[p];
  return r === 'sea' ? 'asia' : r;
}

/** Accepts "euw", "EUW1", "eune", "lan", etc. */
export function parsePlatform(input: string): Platform | null {
  const s = input.trim().toUpperCase();
  if ((PLATFORMS as readonly string[]).includes(s)) return s as Platform;
  const byLabel = (Object.entries(PLATFORM_LABEL) as [Platform, string][]).find(([, l]) => l === s);
  return byLabel ? byLabel[0] : null;
}

/** Match IDs are prefixed with the platform, e.g. "EUW1_7123456789". */
export function platformOfMatchId(matchId: string): Platform | null {
  const prefix = matchId.split('_')[0] ?? '';
  return parsePlatform(prefix);
}
