export interface RiotId {
  gameName: string;
  tagLine: string;
}

export class RiotIdParseError extends Error {}

/**
 * Parse "Game Name#TAG". Splits on the LAST '#', since game names may contain
 * spaces and unicode. Riot limits: gameName 3-16 chars, tagLine 3-5 alnum.
 */
export function parseRiotId(input: string): RiotId {
  const s = input.normalize('NFC').trim();
  const i = s.lastIndexOf('#');
  if (i <= 0 || i === s.length - 1) throw new RiotIdParseError(`Expected "Name#TAG", got "${input}"`);
  const gameName = s.slice(0, i).trim();
  const tagLine = s.slice(i + 1).trim();
  const nameLen = [...gameName].length;
  if (nameLen < 3 || nameLen > 16) throw new RiotIdParseError(`Game name must be 3-16 characters ("${gameName}")`);
  if (!/^[\p{L}\p{N}]{3,5}$/u.test(tagLine)) throw new RiotIdParseError(`Tag must be 3-5 letters/digits ("${tagLine}")`);
  return { gameName, tagLine };
}

export const formatRiotId = (r: RiotId): string => `${r.gameName}#${r.tagLine}`;
