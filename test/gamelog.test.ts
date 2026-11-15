import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fakePoster, setup } from './helpers.ts';

const MIN = 60_000;
const ranks = [{ queueType: 'RANKED_SOLO_5x5', tier: 'GOLD', rank: 'II', lp: 50, wins: 10, losses: 10 }];

test('game log: posted as soon as the game is spotted, edited when LP arrives; one post per match', async () => {
  const { mock, service, clock } = setup();
  const a = mock.addAccount('Alpha', 'EUW', 'EUW1', ranks);
  const b = mock.addAccount('Beta', 'EUW', 'EUW1', ranks);
  const c = mock.addAccount('Gamma', 'EUW', 'EUW1', ranks);
  await service.linkUser('u1', 'EUW', 'Alpha#EUW');
  await service.linkUser('u2', 'EUW', 'Beta#EUW');
  await service.addPlayer('g1', 'EUW', 'Gamma#EUW');
  const { poster, msgs } = fakePoster();
  service.setLogPoster(poster, '999');

  clock.advance(30 * MIN);
  // Riot's ladder lags: LP shows up only on a later read
  mock.play({ players: [{ puuid: a.puuid, team: 100, champion: 'Ahri' }, { puuid: b.puuid, team: 100, champion: 'Jinx' }], winner: 100, lp: { [a.puuid]: 21, [b.puuid]: 19 }, lagReads: 2 });
  mock.play({ players: [{ puuid: c.puuid, team: 200, champion: 'Lux' }], winner: 100, lp: { [c.puuid]: -16 }, lagReads: 2 });
  await service.tick();

  assert.equal(msgs.size, 2, 'both matches posted right away');
  const shared = [...msgs.values()].find((m) => /Also in this game/.test(m.reply.embed.description ?? ''))!;
  assert.ok(shared, 'teammates share one post');
  assert.match(shared.reply.embed.description!, /LP updating|LP pending/);
  assert.equal(shared.channelId, '999');

  for (let i = 0; i < 4; i++) { clock.advance(2 * MIN); await service.tick(); }
  assert.equal(msgs.size, 2, 'no new posts, only edits');
  assert.ok(shared.edits >= 1);
  assert.match(shared.reply.embed.description!, /\+21|\+19/);
  assert.doesNotMatch(shared.reply.embed.description!, /LP pending/);
  assert.equal(shared.reply.files[0]!.name, 'scoreboard.png');

  // finished posts are never touched again
  const edits = [...msgs.values()].map((m) => m.edits);
  for (let i = 0; i < 3; i++) { clock.advance(5 * MIN); await service.tick(); }
  assert.deepEqual([...msgs.values()].map((m) => m.edits), edits);
});

test('game log: LP already in on first sight = one final post; a deleted message stops edits', async () => {
  const { mock, service, clock } = setup();
  const a = mock.addAccount('Quick', 'EUW', 'EUW1', ranks);
  await service.linkUser('u1', 'EUW', 'Quick#EUW');
  const { poster, msgs } = fakePoster();
  service.setLogPoster(poster, '999');

  clock.advance(30 * MIN);
  mock.play({ players: [{ puuid: a.puuid, team: 100, champion: 'Zed' }], winner: 100, lp: { [a.puuid]: 22 } });
  await service.tick();
  assert.equal(msgs.size, 1);
  assert.match([...msgs.values()][0]!.reply.embed.description!, /\+22/);

  clock.advance(30 * MIN);
  mock.play({ players: [{ puuid: a.puuid, team: 100, champion: 'Zed' }], winner: 200, lp: { [a.puuid]: -18 }, lagReads: 2 });
  await service.tick();
  assert.equal(msgs.size, 2);
  msgs.delete('m2'); // someone deleted the pending post
  for (let i = 0; i < 4; i++) { clock.advance(2 * MIN); await service.tick(); }
  assert.equal(msgs.size, 1, 'not reposted after a failed edit');
});

test('/recent before LP is in: "+? LP (Waiting on Riot API)", then the message is updated', async () => {
  const { mock, service, clock } = setup();
  const a = mock.addAccount('Waiter', 'EUW', 'EUW1', ranks);
  const { player } = await service.linkUser('u1', 'EUW', 'Waiter#EUW');

  clock.advance(30 * MIN);
  mock.play({ players: [{ puuid: a.puuid, team: 100, champion: 'Ahri' }], winner: 100, lp: { [a.puuid]: 24 }, lagReads: 1 });
  // run /recent before the poller has even seen the game
  const first = await service.recent(player);
  assert.match(first.embed.description!, /\*\*\+\? LP\*\* \(Waiting on Riot API\)/);
  assert.doesNotMatch(first.embed.description!, /before tracking/);
  assert.ok(first.watch);

  const edits: string[] = [];
  service.watchRecent(first.watch!, async (r) => void edits.push(r.embed.description!), 14 * MIN);
  for (let i = 0; i < 3 && !edits.length; i++) { await service.tick(); clock.advance(2 * MIN); }
  assert.equal(edits.length, 1, 'edited once when LP arrived');
  assert.match(edits[0]!, /\+24/);
  for (let i = 0; i < 2; i++) { clock.advance(2 * MIN); await service.tick(); }
  assert.equal(edits.length, 1, 'not edited again');
});

test('fast LP check: only accounts waiting for LP, one league call each, updates the log post', async () => {
  const { mock, service, clock, riot } = setup();
  const a = mock.addAccount('Fast One', 'EUW', 'EUW1', ranks);
  mock.addAccount('Idle Two', 'EUW', 'EUW1', ranks);
  await service.linkUser('u1', 'EUW', 'Fast One#EUW');
  await service.linkUser('u2', 'EUW', 'Idle Two#EUW');
  const { poster, msgs } = fakePoster();
  service.setLogPoster(poster, '999');

  clock.advance(30 * MIN);
  mock.play({ players: [{ puuid: a.puuid, team: 100, champion: 'Ahri' }], winner: 100, lp: { [a.puuid]: 23 }, lagReads: 2 });
  await service.tick(); // spotted, LP not in yet
  assert.match([...msgs.values()][0]!.reply.embed.description!, /Waiting on Riot API/);

  let resolved = 0;
  for (let i = 0; i < 4 && !resolved; i++) {
    clock.advance(30_000);
    const before = riot.requestCount;
    const r = await service.lpTick();
    assert.equal(riot.requestCount - before, 1, 'one league call, only for the account waiting');
    resolved = r.games;
  }
  assert.equal(resolved, 1);
  assert.match([...msgs.values()][0]!.reply.embed.description!, /\+23/);
  assert.equal((await service.lpTick()).requests, 0, 'nothing waiting: no calls');
});
