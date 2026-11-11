import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MOCK_FIVES_QUEUE } from '../src/dev/mockRiot.ts';
import { FIVES } from '../src/core/service.ts';
import { runCommand } from '../src/discord/actions.ts';
import { setup } from './helpers.ts';

const MIN = 60_000;
const ranks = [
  { queueType: 'RANKED_SOLO_5x5', tier: 'GOLD', rank: 'II', lp: 50, wins: 10, losses: 10 },
  { queueType: 'RANKED_PREMADE_5x5', tier: 'SILVER', rank: 'I', lp: 30, wins: 4, losses: 2 },
];

test('Ranked 5s: queue id discovered from games, then tracked with LP like Solo/Flex', async () => {
  const { mock, service, repo, clock } = setup();
  const a = mock.addAccount('Five', 'EUW', 'EUW1', ranks);
  const { player } = await service.linkUser('u1', 'EUW', 'Five#EUW');

  // before any 5s game the pseudo id resolves to nothing
  assert.equal(await service.resolveQueue(FIVES), FIVES);

  clock.advance(30 * MIN);
  mock.play({ players: [{ puuid: a.puuid, team: 100, champion: 'Ahri' }], winner: 100, queueId: MOCK_FIVES_QUEUE });
  await service.tick();
  assert.equal(repo.getKv('ranked5s_queue_id'), String(MOCK_FIVES_QUEUE), 'discovered by the poller');
  assert.equal(await service.resolveQueue(FIVES), MOCK_FIVES_QUEUE);

  clock.advance(30 * MIN);
  mock.play({ players: [{ puuid: a.puuid, team: 100, champion: 'Jinx' }], winner: 100, lp: { [a.puuid]: 23 }, queueId: MOCK_FIVES_QUEUE });
  await service.tick();
  const pm = repo.lpHistory(player.puuid, MOCK_FIVES_QUEUE, 10);
  assert.equal(pm.length, 2);
  assert.equal(pm[1]!.lp_delta, 23, 'second 5s game has exact LP');

  const e = (await service.recent(player, FIVES)).embed;
  assert.match(e.title!, /Victory · Jinx/);
  assert.match(e.description!, /\+23 LP/);
  assert.match(e.footer?.text ?? '', /Ranked 5s/);

  const recap = await service.personalRecap(player, 'daily', MOCK_FIVES_QUEUE, '24h');
  assert.equal(recap.files.length, 1, 'daily 5s recap renders');
});

test('/mode 5s is stored and used by daily; /recent ignores /mode', async () => {
  const { mock, service, clock } = setup();
  const a = mock.addAccount('Moder', 'EUW', 'EUW1', ranks);
  await service.linkUser('u1', 'EUW', 'Moder#EUW');
  const base = { callerId: 'u1', guildId: null, canManageGuild: false, style: '/' } as const;

  const set = await runCommand(service, { ...base, name: 'mode', queue: FIVES });
  assert.match(set.embed.title!, /Ranked 5s/);
  assert.equal(service.queueFor('u1'), FIVES);

  clock.advance(30 * MIN);
  mock.play({ players: [{ puuid: a.puuid, team: 100, champion: 'Lux' }], winner: 200, queueId: 420, lp: { [a.puuid]: -18 } });
  const recent = await runCommand(service, { ...base, name: 'recent' });
  assert.match(recent.embed.title!, /Defeat · Lux/, 'solo game shown even though mode is 5s');

  const daily = await runCommand(service, { ...base, name: 'daily', window: '24h' });
  assert.match(daily.embed.description ?? daily.embed.title ?? '', /Ranked 5s/);
});
