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
  assert.deepEqual(r.queues, { flex: 30, fives: 12, solo: 0 });
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
  assert.equal(r.files[0]!.name, 'scout.png');
  assert.equal(r.files[0]!.data.subarray(1, 4).toString(), 'PNG');
  assert.match(r.embed.footer!.text, /Priority bans: .*Syndra/);
  assert.equal(repo.activePlayers().length, 0, 'scouted players are not tracked');
  void team;
});

test('Ranked 5s carries 90% weight: 5s picks beat flex-only stomps, 5s teammates beat flex regulars', async () => {
  const { banScore, FIVES_WEIGHT } = await import('../src/core/scout.ts');
  assert.equal(FIVES_WEIGHT, 0.9);
  // 46 games: 12 in 5s (weight 3.45 each), 34 flex (0.135 each)
  const w5 = (0.9 * 46) / 12, wf = (0.1 * 46) / 34;
  const flexStomp = { games: 10, wins: 9, wGames: 10 * wf, wWins: 9 * wf };
  const fivesMain = { games: 6, wins: 4, wGames: 6 * w5, wWins: 4 * w5 };
  assert.ok(banScore(fivesMain) > banScore(flexStomp));

  // end to end: in flex the mid is 30-0 on Zed, in 5s 8-2 on Ahri
  const ctx = setup(Date.UTC(2026, 9, 1, 12));
  const { mock, clock, repo, riot } = ctx;
  const ids = ['T', 'J', 'M', 'B', 'S'].map((r) => mock.addAccount(`Five ${r}`, 'EUNE', 'EUN1'));
  const flexPal = mock.addAccount('Flex Regular', 'EUNE', 'EUN1');
  const roles = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'];
  for (let g = 0; g < 40; g++) {
    clock.advance(45 * MIN);
    const fives = g % 4 === 0; // 10 x 5s, 30 x flex
    const players = ids.map((a, i) => ({ puuid: a.puuid, team: 100 as const, role: roles[i], champion: i === 2 ? (fives ? 'Ahri' : 'Zed') : ['Garen', 'Vi', '', 'Jinx', 'Lulu'][i] }));
    if (!fives) players[4] = { puuid: flexPal.puuid, team: 100, role: 'UTILITY', champion: 'Braum' }; // flex: different support
    const win = fives ? g % 20 !== 0 : true; // 5s: 8W 2L, flex: everything won
    mock.play({ players, winner: win ? 100 : 200, queueId: fives ? MOCK_FIVES_QUEUE : 440 });
  }
  const r = await scoutTeam(repo, riot, { puuid: ids[2]!.puuid, name: 'Five M', tag: 'EUNE', platform: 'EUN1' });
  assert.deepEqual(r.queues, { flex: 20, fives: 10, solo: 0 });
  const sup = r.members.find((m) => m.role === 'UTILITY')!;
  assert.equal(sup.name, 'Five S', '5s support outranks the more frequent flex support');
  const mid = r.members.find((m) => m.role === 'MIDDLE')!;
  assert.equal(mid.bans[0]!.championName, 'Ahri', '5s champ is the top ban even though Zed is 30-0 in flex');
});

test('scout several players: each from their own games, roles fitted, "together" counted', async () => {
  const ctx = setup(Date.UTC(2026, 9, 1, 12));
  const { mock, clock, service } = ctx;
  const solo = [
    { a: mock.addAccount('Solo Top', 'EUNE', 'EUN1'), role: 'TOP', pool: ['Darius', 'Garen'] },
    { a: mock.addAccount('Solo Jg', 'EUNE', 'EUN1'), role: 'JUNGLE', pool: ['Viego', 'Vi'] },
    { a: mock.addAccount('Solo Mid', 'EUNE', 'EUN1'), role: 'MIDDLE', pool: ['Ahri', 'Syndra'] },
    { a: mock.addAccount('Duo Adc', 'EUNE', 'EUN1'), role: 'BOTTOM', pool: ['Jinx', 'Kaisa'] },
    { a: mock.addAccount('Duo Sup', 'EUNE', 'EUN1'), role: 'UTILITY', pool: ['Thresh', 'Lulu'] },
  ];
  // each plays their own solo queue games; the bot lane duos 6 times
  for (let g = 0; g < 12; g++) {
    for (const m of solo.slice(0, 3)) {
      clock.advance(40 * MIN);
      mock.play({ players: [{ puuid: m.a.puuid, team: 100, role: m.role, champion: m.pool[g % 2]! }], winner: g % 3 ? 100 : 200, queueId: 420 });
    }
    clock.advance(40 * MIN);
    const duo = solo.slice(3).map((m) => ({ puuid: m.a.puuid, team: 100 as const, role: m.role, champion: m.pool[g % 2]! }));
    mock.play({ players: g < 6 ? duo : [duo[g % 2]!], winner: 100, queueId: g % 4 ? 420 : 440 });
  }
  const r = await runCommand(service, { callerId: 'u1', guildId: null, canManageGuild: false, style: '/', name: 'scout', riotIds: solo.map((m) => `${m.a.gameName}#${m.a.tagLine}`), region: 'EUNE' });
  assert.equal(r.files[0]!.name, 'scout.png');
  if (process.env.WRITE_PREVIEWS) (await import('node:fs')).writeFileSync('/tmp/scout-multi.png', r.files[0]!.data);

  const { scoutPlayers } = await import('../src/core/scout.ts');
  const rep = await scoutPlayers((service as unknown as { repo: never }).repo, ctx.riot, solo.map((m) => ({ puuid: m.a.puuid, name: m.a.gameName, tag: m.a.tagLine, platform: 'EUN1' as const })));
  assert.equal(rep.mode, 'individual');
  assert.deepEqual(rep.members.map((m) => [m.name, m.role]), [['Solo Top', 'TOP'], ['Solo Jg', 'JUNGLE'], ['Solo Mid', 'MIDDLE'], ['Duo Adc', 'BOTTOM'], ['Duo Sup', 'UTILITY']]);
  assert.equal(rep.together, 6, 'only the bot lane duo games');
  assert.deepEqual(rep.members.map((m) => m.games), [12, 12, 12, 9, 9], 'each from their own games');

  await assert.rejects(runCommand(service, { callerId: 'u1', guildId: null, canManageGuild: false, style: '/', name: 'scout', riotIds: ['Solo Top#EUNE', 'Nobody#XYZ'], region: 'EUNE' }), /not found: \*\*Nobody#XYZ/);
});

test('$scout with several comma-separated players and one region', () => {
  const ctx = { callerId: '1', guildId: 'g', canManageGuild: false };
  const p = parsePrefix('$scout ferks kitten#retro, Mapet#MR10, LOCKEd in#LLJAH eune', '$', ctx)!;
  assert.deepEqual(p.riotIds, ['ferks kitten#retro', 'Mapet#MR10', 'LOCKEd in#LLJAH']);
  assert.equal(p.region, 'eune');
  const noCommas = parsePrefix('$SCOUT fram#polar Mapet#MR10 FULLMUTEYALL#Edyis EUNE', '$', ctx)!;
  assert.deepEqual(noCommas.riotIds, ['fram#polar', 'Mapet#MR10', 'FULLMUTEYALL#Edyis']);
  assert.equal(noCommas.region, 'EUNE');
  const spaces = parsePrefix('$scout ferks kitten#retro LOCKEd in#LLJAH Alexandru I#0706 eune', '$', ctx)!;
  assert.deepEqual(spaces.riotIds, ['ferks kitten#retro', 'LOCKEd in#LLJAH', 'Alexandru I#0706']);
  assert.equal(spaces.region, 'eune');
  const one = parsePrefix('$scout Alexandru I#0706 eune', '$', ctx)!;
  assert.equal(one.riotId, 'Alexandru I#0706');
  assert.equal(one.riotIds, undefined);
});

test('scout 2 of a five-stack: the given two are kept, the other three roles filled with their teammates', async () => {
  const { service, team, randy, riot } = premade();
  const given = [team[0]!, team[1]!]; // top + jungle
  const r = await runCommand(service, { callerId: 'u1', guildId: null, canManageGuild: false, style: '/', name: 'scout', riotIds: given.map((m) => `${m.a.gameName}#${m.a.tagLine}`), region: 'EUNE' });
  assert.equal(r.files[0]!.name, 'scout.png');
  if (process.env.WRITE_PREVIEWS) (await import('node:fs')).writeFileSync('/tmp/scout-fill.png', r.files[0]!.data);

  const { scoutPlayers } = await import('../src/core/scout.ts');
  const rep = await scoutPlayers((service as unknown as { repo: never }).repo, riot, given.map((m) => ({ puuid: m.a.puuid, name: m.a.gameName, tag: m.a.tagLine, platform: 'EUN1' as const })));
  assert.equal(rep.filled, 3);
  assert.deepEqual(rep.members.map((m) => [m.name, m.role, m.isTarget]), [
    ['Enemy Top', 'TOP', true], ['Enemy Jg', 'JUNGLE', true], ['Enemy Mid', 'MIDDLE', false], ['Enemy Adc', 'BOTTOM', false], ['Enemy Sup', 'UTILITY', false],
  ]);
  assert.ok(!rep.members.some((m) => m.puuid === randy.puuid), 'occasional filler not picked over the regular support');
});

test('pasted Riot IDs: invisible marks and "Name #TAG" spacing are cleaned, unicode names work', () => {
  const ctx = { callerId: '1', guildId: 'g', canManageGuild: false };
  const p = parsePrefix('$scout \u2066\u2066Bc Petanek\u2069 #\u2066EUNE1\u2069\u2069, \u2066\u2066hrac lolka 2\u2069 #\u2066EUNE\u2069\u2069, \u2066\u2066BrokenHeartNami\u2069 #\u2066Nami\u2069\u2069, \u2066\u2066smazak nitram\u2069 #\u2066eunak\u2069\u2069 EUNE', '$', ctx)!;
  assert.deepEqual(p.riotIds, ['Bc Petanek#EUNE1', 'hrac lolka 2#EUNE', 'BrokenHeartNami#Nami', 'smazak nitram#eunak']);
  assert.equal(p.region, 'EUNE');
  // "eune" at the start is part of the name; the region is only ever the last word
  const c = parsePrefix('$scout eune čokl#woof eune', '$', ctx)!;
  assert.equal(c.riotId, 'eune čokl#woof');
  assert.equal(c.region, 'eune');
  const two = parsePrefix('$scout eune čokl#woof, euw guy#123 EUNE', '$', ctx)!;
  assert.deepEqual(two.riotIds, ['eune čokl#woof', 'euw guy#123']);
  assert.equal(two.region, 'EUNE');
  const r = parsePrefix('$recent čokl #woof eune', '$', ctx)!;
  assert.equal(r.riotId, 'čokl#woof');
  const r2 = parsePrefix('$recent eune čokl#woof eune flex', '$', ctx)!;
  assert.deepEqual([r2.riotId, r2.region, r2.queue], ['eune čokl#woof', 'eune', 440]);
});

test('scout sample: 30 games, Ranked 5s first, then the newest Flex / Solo games', async () => {
  const { team, repo, riot } = premade();
  const mid = team[2]!.a;
  const r = await scoutTeam(repo, riot, { puuid: mid.puuid, name: mid.gameName, tag: mid.tagLine, platform: 'EUN1' });
  assert.equal(r.sample, 30);
  assert.deepEqual(r.queues, { flex: 18, fives: 12, solo: 0 }, 'all 12 Ranked 5s, 18 newest Flex fill the rest');
});

test('OTP badge: one champion in 60%+ of 8+ games, and it goes to the front of the bans', async () => {
  const { markOtps } = await import('../src/core/scout.ts');
  const champ = (name: string, games: number) => ({ championId: 1, championName: name, games, wins: games, wGames: games, wWins: games, version: '1' });
  const member = (name: string, games: number, pool: ReturnType<typeof champ>[]) => ({ puuid: name, name, tag: 'X', role: null, roleShare: 0, games, wins: 0, mostPlayed: pool, bans: [], isTarget: false });
  const r = markOtps({
    target: { puuid: 'a', name: 'A', tag: 'X', platform: 'EUN1' },
    members: [member('Otp', 20, [champ('Yasuo', 15), champ('Yone', 5)]), member('Flexible', 20, [champ('Ahri', 6), champ('Lux', 6)]), member('Few', 5, [champ('Zed', 5)])],
    priorityBans: [{ ...champ('Ahri', 6), owner: 'Flexible' }],
    sample: 20, queues: { flex: 20, fives: 0 }, weights: { fives: 1, flex: 1 }, fivesQueueId: null, premadeShare: 0,
  });
  assert.deepEqual(r.members.map((m) => m.otp?.championName ?? null), ['Yasuo', null, null]);
  assert.equal(r.members[0]!.otp!.share, 0.75);
  assert.deepEqual(r.priorityBans.map((b) => [b.championName, !!b.otp]), [['Yasuo', true], ['Ahri', false]]);
});
