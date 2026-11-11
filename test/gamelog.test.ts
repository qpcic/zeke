import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Reply } from '../src/core/service.ts';
import { setup } from './helpers.ts';

const MIN = 60_000;
const ranks = [{ queueType: 'RANKED_SOLO_5x5', tier: 'GOLD', rank: 'II', lp: 50, wins: 10, losses: 10 }];

test('game log: every recorded game posted once per match, even with several known accounts in it', async () => {
  const { mock, service, clock } = setup();
  const a = mock.addAccount('Alpha', 'EUW', 'EUW1', ranks);
  const b = mock.addAccount('Beta', 'EUW', 'EUW1', ranks);
  const c = mock.addAccount('Gamma', 'EUW', 'EUW1', ranks);
  await service.linkUser('u1', 'EUW', 'Alpha#EUW');
  await service.linkUser('u2', 'EUW', 'Beta#EUW');
  await service.addPlayer('g1', 'EUW', 'Gamma#EUW'); // server-tracked accounts count too

  const posted: Reply[] = [];
  service.setGameLog(async (r) => void posted.push(r));

  clock.advance(30 * MIN);
  // Alpha and Beta in the same game (same team), Gamma in another
  mock.play({ players: [{ puuid: a.puuid, team: 100, champion: 'Ahri' }, { puuid: b.puuid, team: 100, champion: 'Jinx' }], winner: 100, lp: { [a.puuid]: 21, [b.puuid]: 19 } });
  mock.play({ players: [{ puuid: c.puuid, team: 200, champion: 'Lux' }], winner: 100, lp: { [c.puuid]: -16 } });
  await service.tick();

  assert.equal(posted.length, 2, 'one post per match');
  const shared = posted.find((r) => /Also in this game/.test(r.embed.description ?? ''))!;
  assert.ok(shared, 'second account in the same match is listed, not posted separately');
  assert.match(shared.embed.description!, /\+19 LP|\+21 LP/);
  assert.equal(shared.files[0]!.name, 'scoreboard.png');

  // later ticks never repost
  clock.advance(5 * MIN);
  await service.tick();
  clock.advance(5 * MIN);
  await service.tick();
  assert.equal(posted.length, 2);

  // a failing channel doesn't retry the same game forever
  const fail = async () => { throw new Error('Missing Access'); };
  service.setGameLog(fail);
  clock.advance(30 * MIN);
  mock.play({ players: [{ puuid: a.puuid, team: 100, champion: 'Zed' }], winner: 200, lp: { [a.puuid]: -18 } });
  await service.tick();
  service.setGameLog(async (r) => void posted.push(r));
  clock.advance(5 * MIN);
  await service.tick();
  assert.equal(posted.length, 2);
});
