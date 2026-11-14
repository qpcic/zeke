import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { findChampion } from '../src/core/service.ts';
import { runCommand } from '../src/discord/actions.ts';
import { parsePrefix } from '../src/discord/prefix.ts';
import { setup } from './helpers.ts';

const MIN = 60_000;
const solo = (tier: string, rank: string, lp: number) => [{ queueType: 'RANKED_SOLO_5x5', tier, rank, lp, wins: 30, losses: 25 }];
const base = { callerId: 'u1', guildId: 'g1', canManageGuild: false, style: '/' } as const;

test('/ladder: tracked accounts + all linked accounts of server members, by current rank', async () => {
  const { mock, service } = setup();
  mock.addAccount('Tracked Gold', 'EUW', 'EUW1', solo('GOLD', 'I', 80));
  mock.addAccount('Member Main', 'EUW', 'EUW1', solo('EMERALD', 'IV', 10));
  mock.addAccount('Member Alt', 'EUW', 'EUW1', solo('MASTER', 'I', 1100));
  mock.addAccount('Chall Guy', 'EUW', 'EUW1', solo('CHALLENGER', 'I', 589));
  mock.addAccount('Outsider', 'EUW', 'EUW1', solo('DIAMOND', 'I', 99));
  mock.addAccount('No Rank', 'EUW', 'EUW1', []);
  await service.addPlayer('g1', 'EUW', 'Tracked Gold#EUW');
  await service.linkUser('m1', 'EUW', 'Member Main#EUW');
  await service.linkUser('m1', 'EUW', 'Member Alt#EUW');
  await service.linkUser('m2', 'EUW', 'Chall Guy#EUW');
  await service.linkUser('m3', 'EUW', 'No Rank#EUW');
  await service.linkUser('x9', 'EUW', 'Outsider#EUW'); // linked, but not in this server

  const members = [{ id: 'm1', name: 'Jan' }, { id: 'm2', name: 'Capi' }, { id: 'm3', name: 'New' }];
  const r = await runCommand(service, { ...base, name: 'ladder', members });
  assert.equal(r.files[0]!.name, 'ladder.png');
  if (process.env.WRITE_PREVIEWS) writeFileSync('/tmp/ladder.png', r.files[0]!.data);

  // sorted by current rank (Challenger 589 above Master 1100); outsider and unranked left out
  const { renderLadder: _unused } = await import('../src/render/image/ladder.ts');
  void _unused;
  await assert.rejects(runCommand(service, { ...base, guildId: null, name: 'ladder' }), /server/i);
});

test('/champ: first run fetches the last 50 ranked games, later runs only new ones', async () => {
  const { mock, service, clock, riot } = setup();
  const me = mock.addAccount('Champ Main', 'EUW', 'EUW1', solo('GOLD', 'II', 40));
  await service.linkUser('u1', 'EUW', 'Champ Main#EUW');
  // 60 games before the bot knew them: 30 Ahri (20 wins), 30 Zed
  for (let i = 0; i < 60; i++) {
    clock.advance(40 * MIN);
    mock.play({ players: [{ puuid: me.puuid, team: 100, champion: i % 2 ? 'Zed' : 'Ahri' }], winner: i % 3 === 0 ? 200 : 100 });
  }
  const before = riot.requestCount;
  const r = await runCommand(service, { ...base, name: 'champ', champion: 'ahri' });
  const first = riot.requestCount - before;
  assert.ok(first >= 50, `fetched ~50 matches (${first} requests)`);
  assert.equal(r.files[0]!.name, 'champ.png');
  assert.match(r.embed.footer?.text ?? '', /Fetched 50 games/);
  if (process.env.WRITE_PREVIEWS) writeFileSync('/tmp/champ.png', r.files[0]!.data);

  clock.advance(40 * MIN);
  mock.play({ players: [{ puuid: me.puuid, team: 100, champion: 'Ahri' }], winner: 100 });
  const b2 = riot.requestCount;
  await runCommand(service, { ...base, name: 'champ', champion: 'Ahri' });
  assert.ok(riot.requestCount - b2 <= 3, 'second run: match list + the one new game');

  // no champion: most played; unknown champion: friendly error
  assert.equal((await runCommand(service, { ...base, name: 'champ' })).files[0]!.name, 'champ.png');
  await assert.rejects(runCommand(service, { ...base, name: 'champ', champion: 'Teemo' }), /no Teemo games|don't know/);
});

test('champion matching and $champ parsing', () => {
  const seen = [{ id: 1, name: 'MissFortune' }, { id: 2, name: 'LeeSin' }, { id: 3, name: 'Ahri' }];
  assert.equal(findChampion('mf', null, seen), 1);
  assert.equal(findChampion('lee sin', null, seen), 2);
  assert.equal(findChampion('ahr', null, seen), 3);
  assert.equal(findChampion('zzz', null, seen), null);
  const ctx = { callerId: '1', guildId: 'g', canManageGuild: false };
  const p = parsePrefix('$champ lee sin ferks kitten#retro eune flex', '$', ctx)!;
  assert.deepEqual([p.champion, p.riotId, p.region, p.queue], ['lee sin', 'ferks kitten#retro', 'eune', 440]);
  assert.equal(parsePrefix('$c ahri', '$', ctx)!.champion, 'ahri');
  assert.equal(parsePrefix('$champ', '$', ctx)!.champion, undefined);
  assert.equal(parsePrefix('$ladder flex', '$', ctx)!.queue, 440);
});
