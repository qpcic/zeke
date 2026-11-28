import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runCommand } from '../src/discord/actions.ts';
import { parsePrefix } from '../src/discord/prefix.ts';
import { setup } from './helpers.ts';

const MIN = 60_000;
const solo = (tier: string, rank: string, lp: number) => [{ queueType: 'RANKED_SOLO_5x5', tier, rank, lp, wins: 10, losses: 10 }];

test('$mmr: average rank of recent lobbies vs your rank; ranks cached', async () => {
  const { mock, service, clock } = setup();
  const me = mock.addAccount('Climber', 'EUW', 'EUW1', solo('GOLD', 'IV', 10));
  const enemies = [0, 1, 2, 3, 4].map((i) => mock.addAccount(`Enemy${i}`, 'EUW', 'EUW1', solo('PLATINUM', 'II', 50)));
  const allies = [0, 1, 2, 3].map((i) => mock.addAccount(`Ally${i}`, 'EUW', 'EUW1', solo('PLATINUM', 'IV', 50)));
  await service.linkUser('u1', 'EUW', 'Climber#EUW');
  for (let g = 0; g < 4; g++) {
    clock.advance(40 * MIN);
    mock.play({
      players: [{ puuid: me.puuid, team: 100, champion: 'Ahri' }, ...allies.map((a) => ({ puuid: a.puuid, team: 100 as const })), ...enemies.map((e) => ({ puuid: e.puuid, team: 200 as const }))],
      winner: g % 2 ? 100 : 200, durationSec: 1700,
    });
    await service.tick();
  }
  const before = mock.calls.length;
  const r = await runCommand(service, { callerId: 'u1', guildId: null, canManageGuild: false, style: '/', name: 'mmr' });
  const d = r.embed.description!;
  assert.match(d, /Average enemy: \*\*≈ Platinum II \d+ LP\*\*/);
  assert.match(d, /Average teammate: \*\*≈ Platinum IV \d+ LP\*\*/);
  assert.match(d, /Your rank: \*\*Gold IV \d+ LP\*\*/);
  assert.match(d, /above\*\* your rank: your MMR is probably higher/);
  assert.match(r.embed.fields![0]!.value, /Ahri · enemies ≈ Platinum II/);
  assert.match(r.embed.footer!.text!, /Current ranks of 36 of 36 players/);
  const lookups = mock.calls.slice(before).filter((c) => c.includes('/league/')).length;
  assert.equal(lookups, 9, 'each other player looked up once');

  const again = mock.calls.length;
  await runCommand(service, { callerId: 'u1', guildId: null, canManageGuild: false, style: '/', name: 'mmr', games: 3 });
  assert.equal(mock.calls.slice(again).filter((c) => c.includes('/league/')).length, 0, 'second time: all cached');

  const p = parsePrefix('$mmr kitten 15 flex', '$', { callerId: 'u1', guildId: 'g1', canManageGuild: false })!;
  assert.deepEqual([p.name, p.riotId, p.games, p.queue], ['mmr', 'kitten', 15, 440]);
});
