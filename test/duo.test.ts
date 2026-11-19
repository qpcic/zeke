import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runCommand } from '../src/discord/actions.ts';
import { parsePrefix } from '../src/discord/prefix.ts';
import { setup } from './helpers.ts';

const MIN = 60_000;
const solo = [{ queueType: 'RANKED_SOLO_5x5', tier: 'GOLD', rank: 'II', lp: 40, wins: 10, losses: 10 }];
const ctx = { callerId: 'u1', guildId: 'g1', canManageGuild: false };
const base = { callerId: 'u1', guildId: 'g1', canManageGuild: false, style: '/' } as const;

test('/duo and /rivals: record together and against, across linked accounts', async () => {
  const { mock, service, clock } = setup();
  const me = mock.addAccount('Me Main', 'EUW', 'EUW1', solo);
  const alt = mock.addAccount('Me Alt', 'EUW', 'EUW1', solo);
  const fr = mock.addAccount('Friend', 'EUW', 'EUW1', solo);
  await service.linkUser('u1', 'EUW', 'Me Main#EUW');
  await service.linkUser('u1', 'EUW', 'Me Alt#EUW');
  await service.linkUser('u2', 'EUW', 'Friend#EUW');

  // together: 3 on main (Ahri+Lee 2W 1L... ), 1 on alt; against: 2 (1–1)
  const games: [string, number, number, string, string][] = [
    [me.puuid, 100, 100, 'Ahri', 'Lee Sin'],
    [me.puuid, 100, 100, 'Ahri', 'Lee Sin'],
    [me.puuid, 100, 200, 'Ahri', 'Lee Sin'],
    [alt.puuid, 100, 100, 'Jinx', 'Thresh'],
    [me.puuid, 200, 100, 'Zed', 'Yasuo'],
    [alt.puuid, 200, 200, 'Zed', 'Yasuo'],
  ];
  for (const [p, theirTeam, winner, mine, theirs] of games) {
    clock.advance(40 * MIN);
    mock.play({ players: [{ puuid: p, team: 100, champion: mine }, { puuid: fr.puuid, team: theirTeam, champion: theirs }], winner });
    await service.tick();
  }

  const d = (await runCommand(service, { ...base, name: 'duo', targetUserId: 'u2' })).embed;
  assert.match(d.description!, /\*\*3W 1L\*\* together · 75% in 4 games/);
  assert.match(d.fields!.find((f) => f.name === 'Best champion pairs')!.value, /Ahri \+ Lee Sin\*\* · 2W 1L/);

  const r = (await runCommand(service, { ...base, name: 'rivals', targetUserId: 'u2' })).embed;
  assert.match(r.description!, /Me Main 1 – 1 Friend\*\* in 2 games .* dead even/);

  await assert.rejects(runCommand(service, { ...base, callerId: 'u2', name: 'rivals', targetUserId: 'u9' }), /link/i);
  assert.equal(parsePrefix('$vs <@123456789>', '$', ctx)?.name, 'rivals');
  assert.equal(parsePrefix('$duo <@123456789>', '$', { ...ctx, mentionedUserId: '123456789' })?.targetUserId, '123456789');
});
