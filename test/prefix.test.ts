import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runCommand } from '../src/discord/actions.ts';
import { parsePrefix } from '../src/discord/prefix.ts';
import { setup } from './helpers.ts';

const ctx = { callerId: 'u1', guildId: 'g1', canManageGuild: false };

test('parsePrefix: commands, aliases, args, mentions', () => {
  assert.equal(parsePrefix('hello $recent', '$', ctx), null, 'prefix must lead');
  assert.equal(parsePrefix('$50 for skins', '$', ctx), null, 'unknown words ignored');
  assert.equal(parsePrefix('$', '$', ctx), null);

  assert.equal(parsePrefix('$recent', '$', ctx)!.name, 'recent');
  assert.equal(parsePrefix('$R', '$', ctx)!.name, 'recent');
  assert.equal(parsePrefix('$rs flex', '$', ctx)!.name, 'recent');

  const l = parsePrefix('$link eune ferks kitten#retro', '$', ctx)!;
  assert.deepEqual([l.name, l.region, l.riotId], ['link', 'eune', 'ferks kitten#retro']);

  const g = parsePrefix('$graph <@123456789> 30 flex', '$', { ...ctx, mentionedUserId: '123456789' })!;
  assert.deepEqual([g.queue, g.games, g.targetUserId], [440, 30, '123456789']);
  assert.equal(parsePrefix('$graph 30', '$', ctx)!.queue, undefined, 'no queue -> service default (solo)');
  assert.equal(parsePrefix('$daily flex', '$', ctx)!.queue, 440);
  const d24 = parsePrefix('$daily 24h flex', '$', ctx)!;
  assert.deepEqual([d24.window, d24.queue], ['24h', 440]);
  assert.equal(parsePrefix('$daily', '$', ctx)!.window, undefined, 'default -> today');
  const dId = parsePrefix('$daily ferks kitten#retro eune 24h', '$', ctx)!;
  assert.deepEqual([dId.riotId, dId.region, dId.window], ['ferks kitten#retro', 'eune', '24h']);
  assert.equal(parsePrefix('$recent solo', '$', ctx)!.queue, 420);
  const lbq = parsePrefix('$lb week flex', '$', ctx)!;
  assert.deepEqual([lbq.period, lbq.queue], ['weekly', 440]);

  assert.equal(parsePrefix('$lb week', '$', ctx)!.period, 'weekly');
  assert.equal(parsePrefix('$leaderboard', '$', ctx)!.period, 'daily');

  const ta = parsePrefix('$track add EUW Jänez Novak#SLO', '$', ctx)!;
  assert.deepEqual([ta.sub, ta.region, ta.riotId], ['add', 'EUW', 'Jänez Novak#SLO']);
  const tr = parsePrefix('$track rm Jänez Novak#SLO', '$', ctx)!;
  assert.deepEqual([tr.sub, tr.account], ['remove', 'Jänez Novak#SLO']);
  assert.equal(parsePrefix('$track', '$', ctx)!.sub, 'list');

  assert.equal(parsePrefix('!recent', '!', ctx)!.name, 'recent', 'custom prefix');
});

test('prefix flow end to end: link, recent, track needs Manage Server, server-only in DMs', async () => {
  const { mock, service } = setup();
  mock.addAccount('ferks kitten', 'retro', 'EUN1', [{ queueType: 'RANKED_SOLO_5x5', tier: 'EMERALD', rank: 'III', lp: 40, wins: 1, losses: 1 }]);
  const run = (text: string, extra: Partial<typeof ctx> = {}) => runCommand(service, parsePrefix(text, '$', { ...ctx, ...extra })!);

  const linked = await run('$link EUNE ferks kitten#retro');
  assert.match(linked.embed.title!, /Linked ferks kitten#retro/);
  assert.match(linked.embed.description!, /`\$daily`/, 'usage hints use the prefix style');

  await assert.rejects(run('$recent'), /No Solo\/Duo games found/);
  await assert.rejects(run('$recent', { callerId: 'u2' }), /You have no linked account. Use `\$link`/);

  await assert.rejects(run('$track add EUNE ferks kitten#retro'), /Manage Server/);
  const added = await run('$track add EUNE ferks kitten#retro', { canManageGuild: true });
  assert.match(added.embed.title!, /Now tracking/);
  assert.match((await run('$track')).embed.title!, /Tracked accounts \(1\)/, 'list needs no permission');
  assert.match((await run('$track remove FERKS KITTEN#RETRO', { canManageGuild: true })).embed.title!, /Removed from this server/);

  await assert.rejects(run('$leaderboard', { guildId: null }), /only works in a server/);
  await assert.rejects(run('$link EUNE'), /Usage: `\$link <region> <Name#TAG>`/);
  assert.match((await run('$help')).embed.description!, /\$graph .*\[games\] \[solo\|flex\]/);
});

test('extractRiotId handles spaces, keywords and regions around the ID', async () => {
  const { extractRiotId } = await import('../src/discord/prefix.ts');
  assert.deepEqual(extractRiotId(['ferks', 'kitten#retro', 'eune', 'flex', '30']), { riotId: 'ferks kitten#retro', rest: ['eune', 'flex', '30'] });
  assert.deepEqual(extractRiotId(['flex', '30', 'ferks', 'kitten#retro']), { riotId: 'ferks kitten#retro', rest: ['flex', '30'] });
  assert.deepEqual(extractRiotId(['tilted', 'luka#420']), { riotId: 'tilted luka#420', rest: [] });
  assert.deepEqual(extractRiotId(['flex']), { rest: ['flex'] });
  const g = parsePrefix('$g EUNE ferks kitten#retro 20 flex', '$', ctx)!;
  assert.deepEqual([g.riotId, g.region, g.queue, g.games], ['ferks kitten#retro', 'EUNE', 440, 20]);
});

test('global tracking: look up anyone by Riot ID from any server; region only needed the first time', async () => {
  const { mock, service, repo, clock } = setup();
  const a = mock.addAccount('Global Guy', 'EUW', 'EUW1', [{ queueType: 'RANKED_SOLO_5x5', tier: 'GOLD', rank: 'II', lp: 50, wins: 1, losses: 1 }]);
  const run = (text: string, extra: Partial<typeof ctx> = {}) => runCommand(service, parsePrefix(text, '$', { ...ctx, ...extra })!);

  await assert.rejects(run('$daily Global Guy#EUW'), /don't know \*\*Global Guy#EUW\*\* yet. Add the region/);
  const first = await run('$daily Global Guy#EUW euw');
  assert.match(first.embed.description!, /Started tracking \*\*Global Guy#EUW\*\*/);
  assert.match(first.embed.description!, /No Solo\/Duo games today/);
  assert.equal(repo.activePlayers().length, 1);

  clock.advance(30 * 60_000);
  mock.play({ players: [{ puuid: a.puuid, team: 100 }], winner: 100, lp: { [a.puuid]: 21 } });
  await service.tick();

  // another server, no region, different casing: already known, game recorded
  const other = await run('$daily global guy#euw', { guildId: 'g2' });
  assert.equal(other.embed.description, undefined, 'known account: no "started tracking" note');
  assert.equal(other.files[0]!.name, 'daily.png');
  assert.equal(service.recapData(repo.findPlayerByRiotId('global guy', 'euw')!, 'daily')!.header.lpNet, 21);
  const rec = await run('$recent global guy#euw', { guildId: 'g2' });
  assert.match(rec.embed.description!, /\+21 LP/);

  // removing from a server keeps the player and history
  await run('$track add EUW Global Guy#EUW', { canManageGuild: true });
  const rm = await run('$track remove Global Guy#EUW', { canManageGuild: true });
  assert.match(rm.embed.description!, /still tracked globally/);
  assert.equal((await run('$weekly Global Guy#EUW')).files[0]!.name, 'weekly.png');
  assert.equal(service.recapData(repo.findPlayerByRiotId('Global Guy', 'EUW')!, 'weekly')!.header.lpNet, 21);
});

test('$mode: per-user default queue, used when no queue is given, explicit queue still wins', async () => {
  const { mock, service, clock } = setup(Date.UTC(2026, 10, 10, 8, 0, 0));
  const a = mock.addAccount('Mode Guy', 'EUW', 'EUW1', [
    { queueType: 'RANKED_SOLO_5x5', tier: 'GOLD', rank: 'II', lp: 50, wins: 1, losses: 1 },
    { queueType: 'RANKED_FLEX_SR', tier: 'SILVER', rank: 'I', lp: 20, wins: 1, losses: 1 },
  ]);
  const run = (text: string, extra: Partial<typeof ctx> = {}) => runCommand(service, parsePrefix(text, '$', { ...ctx, ...extra })!);
  await run('$link EUW Mode Guy#EUW');
  clock.advance(35 * 60_000);
  mock.play({ players: [{ puuid: a.puuid, team: 100 }], winner: 100, queueId: 440, lp: { [a.puuid]: 18 } });
  await service.tick();

  assert.match((await run('$mode')).embed.title!, /Default mode: Solo\/Duo/);
  assert.match((await run('$daily')).embed.description!, /No Solo\/Duo games/, 'default is solo');

  assert.match((await run('$mode flex')).embed.title!, /set to Flex/);
  assert.equal(service.queueFor('u1'), 440);
  assert.equal((await run('$daily')).files[0]!.name, 'daily.png', 'flex game shows without typing flex');
  assert.match((await run('$daily solo')).embed.description!, /No Solo\/Duo games/, 'explicit queue overrides the mode');
  assert.equal(service.queueFor('someone-else'), 420, 'preference is per user');
  assert.match((await run('$mode')).embed.title!, /Default mode: Flex/);
});
