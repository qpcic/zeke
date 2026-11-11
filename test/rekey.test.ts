import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setup } from './helpers.ts';

const MIN = 60_000;
const ranks = [{ queueType: 'RANKED_SOLO_5x5', tier: 'GOLD', rank: 'II', lp: 50, wins: 10, losses: 10 }];

async function staleWorld() {
  const ctx = setup(Date.UTC(2026, 10, 10, 8, 0, 0));
  const { mock, service, clock, repo } = ctx;
  const a = mock.addAccount('envy', 'wysi', 'EUW1', ranks);
  await service.linkUser('u1', 'EUW', 'envy#wysi');
  await service.addPlayer('g1', 'EUW', 'envy#wysi');
  clock.advance(35 * MIN);
  mock.play({ players: [{ puuid: a.puuid, team: 100 }], winner: 100, lp: { [a.puuid]: 21 } });
  await service.tick();
  // API key changes: what we have stored is now an id Riot can't decrypt
  repo.rekeyPlayer(a.puuid, 'OLDKEY' + a.puuid);
  return { ...ctx, a };
}

test('poll: stale PUUID is re-resolved by Riot ID, all history moves over', async () => {
  const { service, repo, a, clock, mock } = await staleWorld();
  assert.ok(repo.getPlayer('OLDKEY' + a.puuid));
  clock.advance(30 * MIN);
  mock.play({ players: [{ puuid: a.puuid, team: 100 }], winner: 200, lp: { [a.puuid]: -16 } });
  await service.tick();

  assert.equal(repo.getPlayer('OLDKEY' + a.puuid), undefined, 'old id gone');
  const p = repo.getPlayer(a.puuid)!;
  assert.equal(repo.linkedPlayer('u1')!.puuid, a.puuid, 'link moved');
  assert.equal(repo.trackedInGuild('g1')[0]!.puuid, a.puuid, 'server track moved');
  const d = service.recapData(p, 'daily')!;
  assert.deepEqual([d.header.games, d.header.lpNet], [2, 5], 'old game kept + new game recorded (+21 -16)');
  assert.equal(d.games[1]!.championName !== '?', true, 'cached match still matches the player');
});

test('commands recover too: /profile retries after re-resolving; re-linking merges instead of duplicating', async () => {
  const { service, repo, a } = await staleWorld();
  const stale = repo.getPlayer('OLDKEY' + a.puuid)!;
  const r = await service.profile(stale);
  assert.equal(r.files[0]!.name, 'profile.png');
  assert.ok(repo.getPlayer(a.puuid) && !repo.getPlayer('OLDKEY' + a.puuid));

  // second world: user re-links before any poll
  const w = await staleWorld();
  await w.service.linkUser('u1', 'EUW', 'envy#wysi');
  assert.equal(w.repo.activePlayers().length, 1, 'no duplicate player');
  assert.equal(w.service.recapData(w.repo.getPlayer(w.a.puuid)!, 'daily')!.header.games, 1, 'history kept');
});
