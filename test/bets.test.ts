import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAmount } from '../src/core/bets.ts';
import { runCommand } from '../src/discord/actions.ts';
import { editPayload } from '../src/discord/handlers.ts';
import { parsePrefix } from '../src/discord/prefix.ts';
import { fakePoster, setup } from './helpers.ts';

const MIN = 60_000;
const ranks = [{ queueType: 'RANKED_SOLO_5x5', tier: 'GOLD', rank: 'II', lp: 50, wins: 10, losses: 10 }];

test('bets: round opens when a tracked player is in a ranked game, locks, pays 2x on the result', async () => {
  const { mock, service, clock } = setup();
  const a = mock.addAccount('Kitten', 'EUW', 'EUW1', ranks);
  const b = mock.addAccount('Mapet', 'EUW', 'EUW1', ranks);
  await service.addPlayer('g1', 'EUW', 'Kitten#EUW');
  await service.addPlayer('g1', 'EUW', 'Mapet#EUW');
  await service.linkUser('owner', 'EUW', 'Kitten#EUW');
  for (const [u, n] of [['u2', 'Watch Two'], ['u3', 'Watch Three'], ['u4', 'Watch Four']] as const) {
    mock.addAccount(n, 'EUW', 'EUW1', ranks);
    await service.linkUser(u, 'EUW', `${n}#EUW`);
  }
  const { poster, msgs } = fakePoster();
  service.setLogPoster(poster);
  const base = { guildId: 'g1', canManageGuild: true, style: '$' } as const;
  await assert.rejects(runCommand(service, { ...base, callerId: 'x', canManageGuild: false, name: 'bets', channelId: '777' }), /Manage Server/);
  await runCommand(service, { ...base, callerId: 'admin', name: 'bets', channelId: '777' });
  await service.tick();

  // both tracked players in the same game, same team: one round
  const g = mock.startLive({ players: [{ puuid: a.puuid, team: 100, championId: 103 }, { puuid: b.puuid, team: 100, championId: 64 }] });
  clock.advance(2 * MIN);
  await service.tick();
  const posts = [...msgs.values()].filter((m) => m.channelId === '777');
  assert.equal(posts.length, 1, 'one round for the game');
  const round = posts[0]!;
  assert.match(round.reply.embed.title!, /Bets open/);
  assert.match(round.reply.embed.description!, /\*\*Kitten\*\*.*\*\*Mapet\*\*.*are in a Ranked Solo\/Duo game/);
  const roundId = Number((round.reply.components![0] as any).components[0].custom_id.split(':')[2]);
  assert.equal(round.reply.files[0]?.name, 'draft.png', 'draft image like /live');
  assert.equal(round.reply.embed.image?.url, 'attachment://draft.png');
  if (process.env.WRITE_PNG) (await import('node:fs')).writeFileSync('/tmp/draft.png', round.reply.files[0]!.data);

  assert.throws(() => service.bets.place(roundId, 'owner', 'loss', '100'), /in this game, so you can't bet/);
  assert.throws(() => service.bets.place(roundId, 'owner', 'win', '100'), /in this game, so you can't bet/);
  assert.throws(() => service.bets.place(roundId, 'nolink', 'win', '100'), /Link your League account first/);
  service.bets.place(roundId, 'u4', 'win', '200');
  service.bets.place(roundId, 'u2', 'loss', 'half');
  const r3 = service.bets.place(roundId, 'u3', 'win', 'all');
  assert.match(r3.note, /Bet \*\*1000\*\* on \*\*Win\*\*\. 0 points left/);
  assert.throws(() => service.bets.place(roundId, 'u2', 'win', '5'), /already bet/);
  assert.match(JSON.stringify(r3.reply.embed.fields), /Win · 1200 pts.*Lose · 500 pts/);
  assert.equal(r3.reply.embed.image?.url, 'attachment://draft.png', 'a bet keeps the draft');
  assert.equal('files' in editPayload(r3.reply), false, 'button update leaves attachments alone');
  assert.equal(service.bets.balance('g1', 'owner'), 1000, 'blocked bets cost nothing');

  // window closes: locked, buttons gone
  clock.advance(6 * MIN);
  await service.lpTick();
  assert.match(round.reply.embed.title!, /Bets closed/);
  assert.equal(round.reply.embed.image?.url, 'attachment://draft.png', 'draft stays while the game runs');
  assert.equal(editPayload(round.reply).files, undefined, 'edit keeps the image on the message');
  assert.deepEqual(round.reply.components, []);
  assert.throws(() => service.bets.place(roundId, 'u3', 'win', '10'), /closed/);

  // game ends: Kitten's team wins
  mock.endLive(a.puuid); mock.endLive(b.puuid);
  mock.play({ matchId: `EUW1_${g.gameId}`, players: [{ puuid: a.puuid, team: 100 }, { puuid: b.puuid, team: 100 }], winner: 100, lp: { [a.puuid]: 20, [b.puuid]: 20 } });
  clock.advance(2 * MIN);
  await service.tick();
  assert.match(round.reply.embed.title!, /Kitten won/);
  assert.equal(round.reply.embed.image, undefined, 'game over: draft gone');
  assert.deepEqual(editPayload(round.reply).attachments, [], 'and removed from the message');
  assert.equal(service.bets.balance('g1', 'u4'), 1200);
  assert.equal(service.bets.balance('g1', 'u2'), 500);
  assert.equal(service.bets.balance('g1', 'u3'), 2000);

  // broke: bailout before the next bet
  const p = service.bets.pointsReply('g1', 'u3');
  assert.match(p.embed.description!, /\*\*2,000\*\* points · 1W 0L in bets · \+1,000 net/);
  assert.match(p.embed.fields![0]!.value, /🥇 <@u3> · 2,000/);
  assert.equal(parsePrefix('$pts', '$', { callerId: 'u1', guildId: 'g1', canManageGuild: false })!.name, 'points');
});

test('bets: remakes refund; normals and no bet channel open nothing', async () => {
  const { mock, service, clock } = setup();
  const a = mock.addAccount('Solo', 'EUW', 'EUW1', ranks);
  await service.addPlayer('g1', 'EUW', 'Solo#EUW');
  const { poster, msgs } = fakePoster();
  service.setLogPoster(poster);
  await service.tick();
  mock.startLive({ players: [{ puuid: a.puuid, team: 200, championId: 1 }] });
  clock.advance(2 * MIN);
  await service.tick();
  assert.equal(msgs.size, 0, 'no bet channel: nothing');

  service.setBetChannel('g1', '777');
  mock.endLive(a.puuid);
  mock.startLive({ players: [{ puuid: a.puuid, team: 200, championId: 1 }], queueId: 400 });
  clock.advance(2 * MIN);
  await service.tick();
  assert.equal(msgs.size, 0, 'normal draft: no bets');

  mock.endLive(a.puuid);
  const g = mock.startLive({ players: [{ puuid: a.puuid, team: 200, championId: 1 }] });
  clock.advance(2 * MIN);
  await service.tick();
  const round = [...msgs.values()][0]!;
  const roundId = Number((round.reply.components![0] as any).components[0].custom_id.split(':')[2]);
  mock.addAccount('Fan', 'EUW', 'EUW1', ranks);
  await service.linkUser('u1', 'EUW', 'Fan#EUW');
  service.bets.place(roundId, 'u1', 'loss', '300');
  mock.endLive(a.puuid);
  mock.play({ matchId: `EUW1_${g.gameId}`, players: [{ puuid: a.puuid, team: 200 }], winner: 100, remake: true });
  clock.advance(2 * MIN);
  await service.tick();
  assert.match(round.reply.embed.title!, /Remake/);
  assert.equal(service.bets.balance('g1', 'u1'), 1000);
});

test('bets: amount parsing', () => {
  assert.equal(parseAmount('250', 1000), 250);
  assert.equal(parseAmount('1,000', 1000), 1000);
  assert.equal(parseAmount('1k', 5000), 1000);
  assert.equal(parseAmount('all', 640), 640);
  assert.equal(parseAmount('half', 641), 320);
  assert.equal(parseAmount('0', 100), null);
  assert.equal(parseAmount('2000', 1000), null);
  assert.equal(parseAmount('abc', 1000), null);
});

test('bets: an untracked linked account in the game counts too', async () => {
  const { mock, service, clock } = setup();
  const a = mock.addAccount('Star', 'EUW', 'EUW1', ranks);
  const enemy = mock.addAccount('Enemy Alt', 'EUW', 'EUW1', ranks);
  await service.addPlayer('g1', 'EUW', 'Star#EUW');
  await service.linkUser('sneaky', 'EUW', 'Enemy Alt#EUW');
  const { poster, msgs } = fakePoster();
  service.setLogPoster(poster);
  service.setBetChannel('g1', '777');
  await service.tick();
  mock.startLive({ players: [{ puuid: a.puuid, team: 100, championId: 1 }, { puuid: enemy.puuid, team: 200, championId: 2 }] });
  clock.advance(2 * MIN);
  await service.tick();
  const round = [...msgs.values()][0]!;
  const roundId = Number((round.reply.components![0] as any).components[0].custom_id.split(':')[2]);
  assert.throws(() => service.bets.place(roundId, 'sneaky', 'loss', '100'), /in this game/);
});

test('bets: games spotted late get no round', async () => {
  const { mock, service, clock } = setup();
  const a = mock.addAccount('Late', 'EUW', 'EUW1', ranks);
  await service.addPlayer('g1', 'EUW', 'Late#EUW');
  const { poster, msgs } = fakePoster();
  service.setLogPoster(poster);
  service.setBetChannel('g1', '777');
  await service.tick();
  mock.startLive({ players: [{ puuid: a.puuid, team: 100, championId: 1 }], startedAt: clock.now() - 15 * MIN });
  clock.advance(2 * MIN);
  await service.tick();
  assert.equal(msgs.size, 0);
});
