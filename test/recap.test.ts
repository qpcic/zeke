import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Reply } from '../src/core/service.ts';
import { previousDay } from '../src/core/time.ts';
import { runCommand } from '../src/discord/actions.ts';
import { parsePrefix } from '../src/discord/prefix.ts';
import { setup } from './helpers.ts';

const MIN = 60_000;
const ranks = [
  { queueType: 'RANKED_SOLO_5x5', tier: 'GOLD', rank: 'II', lp: 50, wins: 10, losses: 10 },
  { queueType: 'RANKED_FLEX_SR', tier: 'GOLD', rank: 'II', lp: 50, wins: 10, losses: 10 },
];
const mod = { callerId: 'admin', guildId: 'g1', canManageGuild: true, style: '/' } as const;

test('daily recap: Manage Server only, posted once ~10 min after local midnight, one image per played queue', async () => {
  const { mock, service, clock } = setup();
  const a = mock.addAccount('Recap One', 'EUW', 'EUW1', ranks);
  const b = mock.addAccount('Recap Two', 'EUW', 'EUW1', ranks);
  await service.addPlayer('g1', 'EUW', 'Recap One#EUW');
  await service.addPlayer('g1', 'EUW', 'Recap Two#EUW');

  await assert.rejects(runCommand(service, { ...mod, canManageGuild: false, name: 'recap' }), /Manage Server/);
  const panel = await runCommand(service, { ...mod, name: 'recap' });
  assert.match(panel.embed.description!, /\*\*Off\.\*\*/);
  assert.equal((panel.components![0] as { components: { type: number }[] }).components[0]!.type, 8, 'Discord channel picker');

  const posts: { channelId: string; replies: Reply[] }[] = [];
  service.setRecapPoster(async (channelId, replies) => void posts.push({ channelId, replies }));
  const set = await runCommand(service, { ...mod, name: 'recap', channelId: '555' });
  assert.match(set.embed.description!, /Posting to <#555>/);

  // today: solo + flex games; nothing is posted during the day
  clock.advance(30 * MIN);
  mock.play({ players: [{ puuid: a.puuid, team: 100, champion: 'Ahri' }, { puuid: b.puuid, team: 200, champion: 'Zed' }], winner: 100, lp: { [a.puuid]: 20, [b.puuid]: -17 } });
  clock.advance(30 * MIN);
  mock.play({ players: [{ puuid: a.puuid, team: 100, champion: 'Lux' }], winner: 100, queueId: 440, lp: { [a.puuid]: 15 } });
  for (let i = 0; i < 4; i++) { clock.advance(5 * MIN); await service.tick(); }
  assert.equal(posts.length, 0);

  // jump to 5 past local midnight: still waiting for late LP; 11 past: posted
  const tz = service.guild('g1').timezone;
  const midnight = previousDay(clock.now() + 24 * 3_600_000, tz).to;
  clock.advance(midnight + 5 * MIN - clock.now());
  await service.tick();
  assert.equal(posts.length, 0);
  clock.advance(6 * MIN);
  await service.tick();
  assert.equal(posts.length, 1);
  assert.equal(posts[0]!.channelId, '555');
  assert.deepEqual(posts[0]!.replies.map((r) => r.files[0]?.name), ['leaderboard.png', 'leaderboard.png'], 'Solo and Flex');

  // never twice for the same day
  clock.advance(30 * MIN);
  await service.tick();
  assert.equal(posts.length, 1);

  // a quiet day still gets a short post
  clock.advance(24 * 3_600_000);
  await service.tick();
  assert.equal(posts.length, 2);
  assert.match(posts[1]!.replies[0]!.embed.description!, /No ranked games/);

  // off: nothing more
  await runCommand(service, { ...mod, name: 'recap', off: true });
  clock.advance(24 * 3_600_000);
  await service.tick();
  assert.equal(posts.length, 2);
});

test('$recap #channel / $recap off parse', () => {
  const ctx = { callerId: '1', guildId: 'g', canManageGuild: true };
  assert.equal(parsePrefix('$recap <#123>', '$', { ...ctx, mentionedChannelId: '123' })!.channelId, '123');
  assert.equal(parsePrefix('$recap off', '$', ctx)!.off, true);
  assert.equal(parsePrefix('$recap', '$', ctx)!.channelId, undefined);
});
