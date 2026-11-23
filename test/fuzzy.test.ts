import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runCommand } from '../src/discord/actions.ts';
import { parsePrefix } from '../src/discord/prefix.ts';
import { setup } from './helpers.ts';

const solo = [{ queueType: 'RANKED_SOLO_5x5', tier: 'GOLD', rank: 'II', lp: 40, wins: 10, losses: 10 }];
const ctx = { callerId: 'u1', guildId: 'g1', canManageGuild: false };
const base = { ...ctx, style: '$' } as const;

test('known accounts by part of the name: $r kitten → ferks kitten#retro', async () => {
  const { mock, service } = setup();
  mock.addAccount('ferks kitten', 'retro', 'EUN1', solo);
  mock.addAccount('Kitty Cat', 'EUW', 'EUW1', solo);
  mock.addAccount('Mapet', 'MR10', 'EUN1', solo);
  mock.addAccount('Mapetko', 'EUNE', 'EUN1', solo);
  await service.lookup('ferks kitten#retro', 'EUNE');
  await service.lookup('Kitty Cat#EUW', 'EUW');
  await service.lookup('Mapet#MR10', 'EUNE');
  await service.lookup('Mapetko#EUNE', 'EUNE');

  const find = (q: string, region?: string) => { const p = service.findKnown(q, { ...ctx, region }); return `${p.game_name}#${p.tag_line}`; };
  assert.equal(find('kitten'), 'ferks kitten#retro', 'a word of the name');
  assert.equal(find('FERKSKITTEN'), 'ferks kitten#retro', 'case and spaces ignored');
  assert.equal(find('mapet'), 'Mapet#MR10', 'exact name beats a longer one');
  assert.equal(find('mapetk'), 'Mapetko#EUNE');
  assert.equal(find('^kit'), 'Kitty Cat#EUW', 'regex');
  assert.equal(find('kit', 'EUW'), 'Kitty Cat#EUW', 'region narrows it');
  assert.equal(find('kit'), 'Kitty Cat#EUW', 'name starting with it beats a later word');
  assert.throws(() => find('ape'), /matches 2 accounts: `Mapet#MR10`, `Mapetko#EUNE`/);
  assert.throws(() => find('nobody'), /No known account matches/);

  // prefix: leftover words become the name, options stay options
  assert.equal(parsePrefix('$r kitten', '$', ctx)!.riotId, 'kitten');
  const g = parsePrefix('$graph ferks kitten 30 flex', '$', ctx)!;
  assert.deepEqual([g.riotId, g.games, g.queue], ['ferks kitten', 30, 440]);
  const d = parsePrefix('$daily kit eune 24h', '$', ctx)!;
  assert.deepEqual([d.riotId, d.region, d.window], ['kit', 'eune', '24h']);
  assert.equal(parsePrefix('$daily 24h', '$', ctx)!.riotId, undefined);

  // end to end: commands take the short name
  const r = await runCommand(service, { ...base, name: 'profile', riotId: 'kitten' });
  assert.equal(r.files[0]!.name, 'profile.png');
  await assert.rejects(runCommand(service, { ...base, name: 'recent', riotId: 'zzz' }), /No known account matches \*\*zzz/);
});
