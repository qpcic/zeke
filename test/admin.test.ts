import assert from 'node:assert/strict';
import { test } from 'node:test';

// config reads env at import time; node --test runs each file in its own process
process.env.OWNER_ID = 'owner';
process.env.CONSOLE_CHANNEL_ID = 'console';

const { setup } = await import('./helpers.ts');
const { createPrefixHandler } = await import('../src/discord/prefix.ts');

const MIN = 60_000;

function fakeMsg(content: string, authorId: string, channelId: string) {
  const replies: { embeds: { title?: string; description?: string; footer?: { text: string }; image?: unknown }[]; files?: unknown[] }[] = [];
  return {
    replies,
    msg: {
      content, channelId, guildId: 'g1',
      author: { id: authorId, bot: false },
      member: null,
      mentions: { users: { find: () => undefined } },
      channel: { sendTyping: async () => {} },
      attachments: { find: () => undefined },
      reply: async (r: (typeof replies)[number]) => { replies.push(r); },
    },
  };
}

async function world() {
  const ctx = setup(Date.UTC(2026, 10, 10, 8, 0, 0));
  const { mock, service, clock } = ctx;
  const a = mock.addAccount('Keep Me', 'EUW', 'EUW1', [{ queueType: 'RANKED_SOLO_5x5', tier: 'GOLD', rank: 'II', lp: 10, wins: 1, losses: 1 }]);
  const b = mock.addAccount('Purge Me', 'EUW', 'EUW1', [{ queueType: 'RANKED_SOLO_5x5', tier: 'SILVER', rank: 'I', lp: 10, wins: 1, losses: 1 }]);
  await service.linkUser('u1', 'EUW', 'Keep Me#EUW');
  await service.linkUser('u2', 'EUW', 'Purge Me#EUW');
  await service.addPlayer('g1', 'EUW', 'Purge Me#EUW');
  await service.addPlayer('g2', 'EUW', 'Purge Me#EUW');
  clock.advance(35 * MIN);
  mock.play({ players: [{ puuid: a.puuid, team: 100 }, { puuid: b.puuid, team: 200 }], winner: 100, lp: { [a.puuid]: 20, [b.puuid]: -15 } });
  await service.tick();
  const handler = createPrefixHandler(service, '$', () => 'bot', () => {});
  const run = async (text: string, author = 'owner', channel = 'console') => {
    const f = fakeMsg(text, author, channel);
    await handler(f.msg as never);
    return f.replies;
  };
  return { ...ctx, run };
}

test('$admin only answers the owner in the console channel', async () => {
  const { run } = await world();
  assert.equal((await run('$admin list', 'someone')).length, 0, 'not owner: silent');
  assert.equal((await run('$admin list', 'owner', 'general')).length, 0, 'owner elsewhere: silent');
  assert.equal((await run('$admin')).at(0)!.embeds[0]!.title, 'Admin console');
});

test('$admin list and links', async () => {
  const { run } = await world();
  const list = (await run('$admin list'))[0]!.embeds[0]!;
  assert.equal(list.title, 'Known accounts (2)');
  assert.match(list.description!, /\*\*Purge Me#EUW\*\* · EUW · 1 games · 1 link · 2 servers/);
  const links = (await run('$admin links'))[0]!.embeds[0]!;
  assert.equal(links.title, 'Links (2)');
  assert.match(links.description!, /<@u1> → \*\*Keep Me#EUW\*\*/);
  assert.match(links.footer!.text, /Page 1\/1/);
});

test('$admin remove: dry run first, confirm deletes games, links and tracks', async () => {
  const { run, repo } = await world();
  const dry = (await run('$admin remove Purge Me#EUW'))[0]!.embeds[0]!;
  assert.match(dry.title!, /Remove Purge Me#EUW\?/);
  assert.match(dry.description!, /1 recorded games · 1 LP entries · 1 Discord link · 2 server tracks/);
  assert.ok(repo.findPlayerByRiotId('Purge Me', 'EUW'), 'nothing deleted without confirm');

  const done = (await run('$admin remove purge me#euw confirm'))[0]!.embeds[0]!;
  assert.match(done.title!, /Removed Purge Me#EUW/);
  assert.equal(repo.findPlayerByRiotId('Purge Me', 'EUW'), undefined);
  assert.equal(repo.linkedPlayer('u2'), undefined);
  assert.equal(repo.trackedInGuild('g1').length, 0);
  assert.ok(repo.linkedPlayer('u1'), 'other accounts untouched');
});

test('$admin globallb: leaderboard over every known account', async () => {
  const { run } = await world();
  const r = (await run('$admin globallb'))[0]!;
  assert.equal((r.files ?? []).length, 1, 'image attached');
  const weeklyFlex = (await run('$admin glb week flex'))[0]!.embeds[0]!;
  assert.match(weeklyFlex.description!, /No Flex games in the past 7 days by the 2 known accounts/);
});
