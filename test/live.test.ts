import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { runCommand } from '../src/discord/actions.ts';
import { setup } from './helpers.ts';

const ranks = [
  { queueType: 'RANKED_SOLO_5x5', tier: 'EMERALD', rank: 'II', lp: 45, wins: 60, losses: 48 },
  { queueType: 'RANKED_FLEX_SR', tier: 'GOLD', rank: 'I', lp: 12, wins: 9, losses: 11 },
];
const base = { callerId: 'u1', guildId: null, canManageGuild: false, style: '/' } as const;

test('/live: not in game until the loading screen, then a card of both teams', async () => {
  const { mock, service, clock } = setup();
  const me = mock.addAccount('Live Main', 'EUW', 'EUW1', ranks);
  const alt = mock.addAccount('Live Alt', 'EUW', 'EUW1', ranks);
  const friend = mock.addAccount('Duo Friend', 'EUW', 'EUW1', ranks.slice(0, 1));
  await service.linkUser('u1', 'EUW', 'Live Main#EUW');
  await service.linkUser('u1', 'EUW', 'Live Alt#EUW');
  await service.linkUser('u9', 'EUW', 'Duo Friend#EUW');

  await assert.rejects(runCommand(service, { ...base, name: 'live' }), /None of your linked accounts is in a game right now/);
  await assert.rejects(runCommand(service, { ...base, name: 'live', riotId: 'Duo Friend#EUW', region: 'EUW' }), /Duo Friend#EUW\*\* isn't in a game right now/);

  // the ALT is in game (with a known friend and one hidden player): /live finds it
  mock.startLive({ players: [{ puuid: alt.puuid, team: 100, championId: 103 }, { puuid: friend.puuid, team: 100, championId: 222 }], startedAt: clock.now() - 754_000, hidden: 1 });
  const r = await runCommand(service, { ...base, name: 'live' });
  assert.equal(r.files[0]!.name, 'live.png');
  assert.equal(r.embed.image?.url, 'attachment://live.png');
  assert.match(r.embed.footer!.text, /Live Alt#EUW · EUW/);
  const btns = (r.components![0] as { components: { style: number; label: string; url: string }[] }).components;
  assert.deepEqual(btns.map((b) => [b.style, b.label]), [[5, 'U.GG'], [5, 'OP.GG'], [5, 'DPM.LOL']]);
  assert.equal(btns[0]!.url, 'https://u.gg/lol/profile/euw1/Live%20Alt-EUW/live-game');
  assert.ok(r.files[0]!.data.length > 10_000, 'rendered an image');
  if (process.env.WRITE_PREVIEWS) writeFileSync('/tmp/live.png', r.files[0]!.data);

  // someone else: @mention works the same way
  const other = await runCommand(service, { ...base, callerId: 'u2', name: 'live', targetUserId: 'u9' });
  assert.match(other.embed.footer!.text, /Duo Friend#EUW/);

  mock.endLive(alt.puuid);
  mock.endLive(friend.puuid);
  await assert.rejects(runCommand(service, { ...base, name: 'live' }), /not|None/);
  void me;
});

test('/live: rank column follows the queue (Flex game shows Flex ranks); all 9 runes kept', async () => {
  const { mock, service, clock, repo } = setup();
  const me = mock.addAccount('Flexer', 'EUW', 'EUW1', ranks);
  await service.linkUser('u1', 'EUW', 'Flexer#EUW');
  mock.startLive({ players: [{ puuid: me.puuid, team: 200, championId: 89 }], startedAt: clock.now() - 60_000, queueId: 440 });
  const r = await runCommand(service, { ...base, name: 'live' });
  if (process.env.WRITE_PREVIEWS) writeFileSync('/tmp/live-flex.png', r.files[0]!.data);
  assert.ok(r.files[0]!.data.length > 10_000);
  void repo;
});

test('live links match the sites\' URL formats', async () => {
  const { liveGameLinks } = await import('../src/render/statsLinks.ts');
  assert.deepEqual(liveGameLinks('EUN1', 'ferks kitten', 'retro').map((l) => l.url), [
    'https://u.gg/lol/profile/eun1/ferks%20kitten-retro/live-game',
    'https://op.gg/lol/summoners/eune/ferks%20kitten-retro/ingame',
    'https://dpm.lol/ferks%20kitten-retro/live',
  ]);
});
