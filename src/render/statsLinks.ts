import { PLATFORM_LABEL, type Platform } from '../riot/regions.ts';

/**
 * Third-party live-game pages for a Riot ID, as Discord link buttons.
 * u.gg uses the platform id (eun1), op.gg the region label (eune), dpm.lol only the Riot ID.
 */
export function liveGameLinks(platform: Platform, gameName: string, tagLine: string): { label: string; url: string }[] {
  const slug = encodeURIComponent(`${gameName}-${tagLine}`);
  return [
    { label: 'U.GG', url: `https://u.gg/lol/profile/${platform.toLowerCase()}/${slug}/live-game` },
    { label: 'OP.GG', url: `https://op.gg/lol/summoners/${PLATFORM_LABEL[platform].toLowerCase()}/${slug}/ingame` },
    { label: 'DPM.LOL', url: `https://dpm.lol/${slug}/live` },
  ];
}

/** Third-party profile pages for a Riot ID. */
export function profileLinks(platform: Platform, gameName: string, tagLine: string): { label: string; url: string }[] {
  const slug = encodeURIComponent(`${gameName}-${tagLine}`);
  return [
    { label: 'U.GG', url: `https://u.gg/lol/profile/${platform.toLowerCase()}/${slug}/overview` },
    { label: 'OP.GG', url: `https://op.gg/lol/summoners/${PLATFORM_LABEL[platform].toLowerCase()}/${slug}` },
    { label: 'DPM.LOL', url: `https://dpm.lol/${slug}` },
  ];
}

/**
 * Links for one finished game. DPM.LOL opens the match itself (numeric game id from
 * "EUN1_4028021941"); U.GG and OP.GG have no public per-match URL, so they open the
 * profile, where the game is at the top of the match history.
 */
export function matchLinks(platform: Platform, gameName: string, tagLine: string, matchId: string): { label: string; url: string }[] {
  const gameId = matchId.split('_').pop()!;
  const [ugg, opgg, dpm] = profileLinks(platform, gameName, tagLine);
  return [ugg!, opgg!, { label: 'DPM.LOL', url: `${dpm!.url}?match=${encodeURIComponent(gameId)}` }];
}

/** One action row of link buttons (style 5). */
export function linkButtonRow(links: { label: string; url: string }[]): object {
  return { type: 1, components: links.slice(0, 5).map((l) => ({ type: 2, style: 5, label: l.label, url: l.url })) };
}
