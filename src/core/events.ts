import type { PlayerRow } from '../db/repo.ts';
import type { MatchDto } from '../riot/types.ts';
import type { Rank } from './rank.ts';

export type GameNote =
  | 'promoted' | 'demoted' | 'placement' | 'batched' | 'unknown' | 'remake' | 'unranked'
  // only used by /recent for games the tracker didn't (yet) resolve:
  | 'pending' | 'unrecorded' | 'norank'
  | null;

/** A finished, LP-resolved game for one tracked player. Sinks turn this into embeds. */
export interface GameResult {
  player: PlayerRow;
  match: MatchDto;
  queueId: number;
  win: boolean;
  remake: boolean;
  lpDelta: number | null;
  note: GameNote;
  rankBefore: Rank | null;
  rankAfter: Rank | null;
  /** For batched results: how many games the LP delta covers. */
  batchSize?: number;
}

export interface LpAdjustment {
  player: PlayerRow;
  queueType: string;
  delta: number;
  rankBefore: Rank;
  rankAfter: Rank;
}
