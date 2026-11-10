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

  const l = parsePrefix('$link eune ferks kitten#retro', '$', ctx)!;
  assert.deepEqual([l.name, l.region, l.riotId], ['link', 'eune', 'ferks kitten#retro']);

  const g = parsePrefix('$graph flex 30 <@123456789>', '$', { ...ctx, mentionedUserId: '123456789' })!;
  assert.deepEqual([g.queue, g.games, g.targetUserId], [440, 30, '123456789']);

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

  await assert.rejects(run('$recent'), /No games found/);
  await assert.rejects(run('$recent', { callerId: 'u2' }), /You have no linked account. Use `\$link`/);

  await assert.rejects(run('$track add EUNE ferks kitten#retro'), /Manage Server/);
  const added = await run('$track add EUNE ferks kitten#retro', { canManageGuild: true });
  assert.match(added.embed.title!, /Now tracking/);
  assert.match((await run('$track')).embed.title!, /Tracked accounts \(1\)/, 'list needs no permission');
  assert.match((await run('$track remove FERKS KITTEN#RETRO', { canManageGuild: true })).embed.title!, /Stopped tracking/);

  await assert.rejects(run('$leaderboard', { guildId: null }), /only works in a server/);
  await assert.rejects(run('$link EUNE'), /Usage: `\$link <region> <Name#TAG>`/);
  assert.match((await run('$help')).embed.description!, /\$graph \[solo\|flex\]/);
});
