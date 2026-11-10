/** Data Dragon asset URLs. Version derived from the match's gameVersion ("15.22.723.1234" -> "15.22.1"). */
export function ddVersion(gameVersion: string): string {
  const [maj, min] = gameVersion.split('.');
  return `${maj}.${min}.1`;
}

// match-v5 championName vs Data Dragon id mismatches
const CHAMP_ID_FIX: Record<string, string> = { FiddleSticks: 'Fiddlesticks' };

export const championIcon = (version: string, championName: string) =>
  `https://ddragon.leagueoflegends.com/cdn/${version}/img/champion/${CHAMP_ID_FIX[championName] ?? championName}.png`;

/** Ranked emblem from CommunityDragon (no versioning needed). */
export const rankEmblem = (tier: string) =>
  `https://raw.communitydragon.org/latest/plugins/rcp-fe-lol-static-assets/global/default/images/ranked-emblem/emblem-${tier.toLowerCase()}.png`;

export const patchLabel = (gameVersion: string) => gameVersion.split('.').slice(0, 2).join('.');
