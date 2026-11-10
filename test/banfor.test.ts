import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MOCK_FIVES_QUEUE, mulberry32 } from '../src/dev/mockRiot.ts';
import { assignRoles, scoutTeam, topBans } from '../src/core/scout.ts';
import { runCommand } from '../src/discord/actions.ts';
import { parsePrefix } from '../src/discord/prefix.ts';
import { setup } from './helpers.ts';

const MIN = 60_000;

test('assignRoles resolves conflicts for the best total', () => {
  const r = assignRoles(new Map([
    ['a', { MIDDLE: 10, TOP: 8 }],
    ['b', { MIDDLE: 12 }],
    ['c', { JUNGLE: 9 }],
    ['d', { BOTTOM: 7 }],
    ['e', { UTILITY: 6, BOTTOM: 1 }],
  ]));
  assert.deepEqual(Object.fromEntries(r), { a: 'TOP', b: 'MIDDLE', c: 'JUNGLE', d: 'BOTTOM', e: 'UTILITY' });
});

test('topBans: top 3 winrate among 10 most played, min 5 games per champion', () => {
  const c = (n: string, games: number, wins: number) => ({ championId: 1, championName: n, games, wins, version: '1.1' });
  const bans = topBans([c('A', 10, 5), c('B', 6, 5), c('C', 5, 4), c('Fluke', 3, 3), c('E', 8, 2), c('One', 1, 1)]);
  assert.deepEqual(bans.map((b) => b.championName), ['B', 'C', 'A'], '3W 0L and 1-game picks are ignored');
  assert.deepEqual(topBans([c('A', 9, 5), c('B', 4, 4), c('C', 2, 2)]).map((b) => b.championName), ['A'], 'fewer than 3 if not enough qualify');
  assert.deepEqual(topBans([c('A', 4, 4), c('B', 3, 1)]), [], 'none if nobody has 5 games');
});

function premade() {
  const ctx = setup(Date.UTC(2026, 9, 1, 12));
  const { mock, clock } = ctx;
  const team = [
    { a: mock.addAccount('Enemy Top', 'EUNE', 'EUN1'), role: 'TOP', pool: ['Darius', 'Garen', 'Aatrox'] },
    { a: mock.addAccount('Enemy Jg', 'EUNE', 'EUN1'), role: 'JUNGLE', pool: ['LeeSin', 'Viego', 'Vi'] },
    { a: mock.addAccount('Enemy Mid', 'EUNE', 'EUN1'), role: 'MIDDLE', pool: ['Ahri', 'Syndra', 'Orianna'] },
    { a: mock.addAccount('Enemy Adc', 'EUNE', 'EUN1'), role: 'BOTTOM', pool: ['Jinx', 'Kaisa', 'Ezreal'] },
    { a: mock.addAccount('Enemy Sup', 'EUNE', 'EUN1'), role: 'UTILITY', pool: ['Thresh', 'Lulu', 'Nautilus'] },
  ];
  const randy = mock.addAccount('Random Filler', 'EUNE', 'EUN1');
  const rng = mulberry32(5);
  // 30 flex (sometimes without the support, a random filler instead) + 12 ranked 5s, mid usually wins on Syndra
  for (let g = 0; g < 42; g++) {
    clock.advance(45 * MIN);
    const queueId = g < 30 ? 440 : MOCK_FIVES_QUEUE;
    const win = rng() < 0.55;
    const players = team
      .filter((m) => !(queueId === 440 && g % 5 === 0 && m.role === 'UTILITY'))
      .map((m, i) => {
        const champ = m.role === 'MIDDLE' && g % 3 === 0 ? 'Syndra' : m.pool[(g + i) % 3]!;
        return { puuid: m.a.puuid, team: 100 as const, role: m.role, champion: champ };
      });
    if (players.length < 5) players.push({ puuid: randy.puuid, team: 100, role: 'UTILITY', champion: 'Leona' });
    // Syndra games are wins
    const midSyndra = players.find((p) => p.role === 'MIDDLE')!.champion === 'Syndra';
    mock.play({ players, winner: midSyndra || win ? 100 : 200, queueId });
  }
  return { ...ctx, team, randy };
}

test('scoutTeam: finds the five-stack, roles, picks and bans from one name', async () => {
  const { team, randy, repo, riot } = premade();
  const mid = team[2]!.a;
  const r = await scoutTeam(repo, riot, { puuid: mid.puuid, name: mid.gameName, tag: mid.tagLine, platform: 'EUN1' }, { games: 50 });

  assert.equal(r.fivesQueueId, MOCK_FIVES_QUEUE, '5s queue discovered');
  assert.equal(repo.getKv('ranked5s_queue_id'), String(MOCK_FIVES_QUEUE), 'and cached');
  assert.equal(r.sample, 42);
  assert.deepEqual(r.queues, { flex: 30, fives: 12 });
  assert.deepEqual(r.members.map((m) => [m.role, m.name]), [
    ['TOP', 'Enemy Top'], ['JUNGLE', 'Enemy Jg'], ['MIDDLE', 'Enemy Mid'], ['BOTTOM', 'Enemy Adc'], ['UTILITY', 'Enemy Sup'],
  ]);
  assert.ok(!r.members.some((m) => m.puuid === randy.puuid), 'occasional filler is not on the team');
  const midR = r.members.find((m) => m.role === 'MIDDLE')!;
  assert.equal(midR.bans[0]!.championName, 'Syndra');
  assert.equal(midR.bans[0]!.wins, midR.bans[0]!.games, 'Syndra always wins in this fixture');
  assert.ok(r.priorityBans.some((b) => b.championName === 'Syndra' && b.owner === 'Enemy Mid'));
  assert.equal(r.priorityBans.length, 5);
});

test('$scout (and $banfor/$ban aliases): renders a PNG, does not add the enemy to tracking, needs region for unknown players', async () => {
  const { team, service, repo } = premade();
  const run = (text: string) => runCommand(service, parsePrefix(text, '$', { callerId: 'u', guildId: 'g', canManageGuild: false })!);
  await assert.rejects(run('$scout Enemy Mid#EUNE'), /Add the region/);
  await assert.rejects(run('$banfor Enemy Mid#EUNE'), /Add the region/);
  const r = await run('$ban Enemy Mid#EUNE eune');
  assert.equal(r.files[0]!.name, 'banplan.png');
  assert.equal(r.files[0]!.data.subarray(1, 4).toString(), 'PNG');
  assert.match(r.embed.footer!.text, /Priority bans: .*Syndra/);
  assert.equal(repo.activePlayers().length, 0, 'scouted players are not tracked');
  void team;
});
