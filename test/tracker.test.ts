import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateEmbed } from '../src/render/embed.ts';
import { setup } from './helpers.ts';

const MIN = 60_000;
const gold2 = (lp: number) => [{ queueType: 'RANKED_SOLO_5x5', tier: 'GOLD', rank: 'II', lp, wins: 50, losses: 45 }];

test('win with no league lag -> exact LP, valid embed', async () => {
  const { mock, service, sink, clock } = setup();
  mock.addAccount('Jan', 'EUW', 'EUW1', gold2(40));
  const r = await service.addPlayer('g1', 'euw', 'jan#euw');
  assert.equal(r.player.game_name, 'Jan'); // canonical casing from account-v1

  clock.advance(30 * MIN);
  mock.play({ players: [{ puuid: r.player.puuid, team: 100, champion: 'Ahri' }], winner: 100, lp: { [r.player.puuid]: 22 } });
  await service.tick();

  const [post] = sink.take();
  assert.ok(post);
  const e = post.embeds[0]!;
  assert.match(e.title!, /^Victory · Ahri/);
  assert.match(e.description!, /\+22 LP.*Gold II 62 LP/);
  assert.deepEqual(validateEmbed(e), []);
});

test('league-v4 lag: game stays pending until W/L updates, then posts once', async () => {
  const { mock, service, sink, clock } = setup();
  const a = mock.addAccount('Laggy', 'EUW', 'EUW1', gold2(10));
  await service.addPlayer('g1', 'EUW', 'Laggy#EUW');
  clock.advance(30 * MIN);
  mock.play({ players: [{ puuid: a.puuid, team: 200 }], winner: 100, lp: { [a.puuid]: -18 }, lagReads: 2 });

  await service.tick();
  assert.equal(sink.take().length, 0, 'not posted while league is stale');
  clock.advance(2 * MIN);
  await service.tick();
  const posts = sink.take();
  assert.equal(posts.length, 1);
  assert.match(posts[0]!.embeds[0]!.title!, /^Defeat/);
  // −18 from Gold II 10 crosses into Gold III 92
  assert.match(posts[0]!.embeds[0]!.description!, /−18 LP.*Demoted to \*\*Gold III\*\*/);

  clock.advance(2 * MIN);
  await service.tick();
  assert.equal(sink.take().length, 0, 'no duplicate post');
});

test('two games between league reads -> batched sum', async () => {
  const { mock, service, sink, clock } = setup();
  const a = mock.addAccount('Grinder', 'EUW', 'EUW1', gold2(50));
  await service.addPlayer('g1', 'EUW', 'Grinder#EUW');
  clock.advance(30 * MIN);
  mock.play({ players: [{ puuid: a.puuid, team: 100 }], winner: 100, lp: { [a.puuid]: 20 } });
  clock.advance(30 * MIN);
  mock.play({ players: [{ puuid: a.puuid, team: 100 }], winner: 200, lp: { [a.puuid]: -17 } });
  await service.tick();
  const posts = sink.take();
  assert.equal(posts.length, 2);
  assert.match(posts[0]!.embeds[0]!.description!, /2-game batch/);
  assert.match(posts[1]!.embeds[0]!.description!, /\+3 LP\*\* over last 2 games/);
});

test('promotion across tiers', async () => {
  const { mock, service, sink, clock } = setup();
  const a = mock.addAccount('Climber', 'EUW', 'EUW1', [{ queueType: 'RANKED_SOLO_5x5', tier: 'GOLD', rank: 'I', lp: 90, wins: 10, losses: 5 }]);
  await service.addPlayer('g1', 'EUW', 'Climber#EUW');
  clock.advance(30 * MIN);
  mock.play({ players: [{ puuid: a.puuid, team: 100 }], winner: 100, lp: { [a.puuid]: 21 } });
  await service.tick();
  const e = sink.take()[0]!.embeds[0]!;
  assert.match(e.description!, /\+21 LP\*\* · ⬆ Promoted to \*\*Platinum IV\*\* \(Platinum IV 11 LP\)/);
});

test('remake posts immediately with no LP, dodge shows as adjustment, digest sums both', async () => {
  const { mock, service, sink, clock } = setup(Date.UTC(2026, 10, 10, 8, 0, 0)); // 09:00 Ljubljana
  const a = mock.addAccount('Remaker', 'EUW', 'EUW1', gold2(50));
  await service.addPlayer('g1', 'EUW', 'Remaker#EUW');
  clock.advance(30 * MIN);
  mock.play({ players: [{ puuid: a.puuid, team: 100 }], winner: 100, remake: true });
  await service.tick();
  const [remake] = sink.take();
  assert.match(remake!.embeds[0]!.title!, /^Remake/);

  clock.advance(30 * MIN);
  mock.play({ players: [{ puuid: a.puuid, team: 100 }], winner: 100, lp: { [a.puuid]: 25 } });
  await service.tick();
  sink.take();

  // dodge: −5 with no game; detected on the periodic rank refresh (15 min)
  mock.adjust(a.puuid, 'RANKED_SOLO_5x5', -5);
  clock.advance(16 * MIN);
  await service.tick();
  const [adj] = sink.take();
  assert.match(adj!.embeds[0]!.title!, /−5 LP without a game/);

  // jump to 00:05 next day local -> daily digest for 10 Nov
  clock.advance(15 * 3600_000);
  await service.runDueDigests();
  const [digest] = sink.take();
  assert.equal(digest!.kind, 'digest');
  const e = digest!.embeds[0]!;
  assert.match(e.title!, /Daily recap · Tue 10 Nov/);
  assert.match(e.description!, /\*\*1\*\* games · 1W 0L .*\+20 LP/); // remake excluded; +25 −5
  assert.deepEqual(validateEmbed(e), []);

  await service.runDueDigests();
  assert.equal(sink.take().length, 0, 'digest runs once per period');
});

test('two tracked players in one game: match fetched once, both posted, both highlighted', async () => {
  const { mock, service, sink, clock } = setup();
  const a = mock.addAccount('Duo One', 'EUW', 'EUW1', gold2(10));
  const b = mock.addAccount('Duo Two', 'EUW', 'EUW1', gold2(30));
  await service.addPlayer('g1', 'EUW', 'Duo One#EUW');
  await service.addPlayer('g1', 'EUW', 'Duo Two#EUW');
  clock.advance(30 * MIN);
  mock.play({ players: [{ puuid: a.puuid, team: 100 }, { puuid: b.puuid, team: 100 }], winner: 100 });
  mock.calls = [];
  await service.tick();
  assert.equal(mock.calls.filter((c) => /\/matches\/EUW1_\d+$/.test(c)).length, 1);
  const posts = sink.take();
  assert.equal(posts.length, 2);
  const board = posts[0]!.embeds[0]!.fields!.find((f) => f.name.includes('Blue'))!.value;
  assert.equal((board.match(/▶/g) ?? []).length, 2);
});

test('same player tracked in two guilds: polled once, posted to both', async () => {
  const { mock, service, sink, clock } = setup();
  const a = mock.addAccount('Shared', 'EUW', 'EUW1', gold2(10));
  await service.addPlayer('g1', 'EUW', 'Shared#EUW');
  const again = await service.addPlayer('g2', 'EUW', 'Shared#EUW');
  assert.equal(again.alreadyTracked, false);
  clock.advance(30 * MIN);
  mock.play({ players: [{ puuid: a.puuid, team: 100 }], winner: 100 });
  mock.calls = [];
  await service.tick();
  assert.equal(mock.calls.filter((c) => c.endsWith('/ids')).length, 1);
  assert.deepEqual(sink.take().map((p) => p.guild).sort(), ['g1', 'g2']);
});

test('league never updates -> posted as unknown after settle timeout', async () => {
  const { mock, service, sink, clock } = setup();
  const a = mock.addAccount('Stuck', 'EUW', 'EUW1', gold2(10));
  await service.addPlayer('g1', 'EUW', 'Stuck#EUW');
  clock.advance(30 * MIN);
  mock.play({ players: [{ puuid: a.puuid, team: 100 }], winner: 100, lagReads: 999 });
  await service.tick();
  assert.equal(sink.take().length, 0);
  clock.advance(11 * MIN);
  await service.tick();
  assert.match(sink.take()[0]!.embeds[0]!.description!, /LP change unavailable/);
});

test('games before tracking started are ignored', async () => {
  const { mock, service, sink, clock } = setup();
  const a = mock.addAccount('Old', 'EUW', 'EUW1', gold2(10));
  mock.play({ players: [{ puuid: a.puuid, team: 100 }], winner: 100 });
  clock.advance(MIN);
  await service.addPlayer('g1', 'EUW', 'Old#EUW');
  await service.tick();
  assert.equal(sink.take().length, 0);
});

test('bad input', async () => {
  const { service } = setup();
  await assert.rejects(service.addPlayer('g1', 'mars', 'a#b'), /Unknown region/);
  await assert.rejects(service.addPlayer('g1', 'EUW', 'NoTag'), /Expected "Name#TAG"/);
  await assert.rejects(service.addPlayer('g1', 'EUW', 'Ghost#EUW'), /not found/);
});
