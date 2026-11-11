import type { Repo } from '../db/repo.ts';
import { registerFivesQueue } from '../riot/types.ts';

/** kv key holding the discovered Ranked 5s queue id. */
export const KV_FIVES = 'ranked5s_queue_id';

/** Register the Ranked 5s queue id stored in the DB, if one was discovered before. */
export function loadFivesQueue(repo: Repo): number | null {
  const v = repo.getKv(KV_FIVES);
  if (!v) return null;
  registerFivesQueue(Number(v));
  return Number(v);
}

export function saveFivesQueue(repo: Repo, id: number): void {
  repo.setKv(KV_FIVES, String(id));
  registerFivesQueue(id);
}
