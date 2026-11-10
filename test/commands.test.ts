import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateEmbed } from '../src/render/embed.ts';
import { asGuildCommands, commands } from '../src/discord/commands.ts';
import { setup } from './helpers.ts';

const MIN = 60_000;
const ranks = (tier: string, rank: string, lp: number) => [{ queueType: 'RANKED_SOLO_5x5', tier, rank, lp, wins: 100, losses: 90 }];

test('command definitions are valid and scoped right', () => {
  const names = commands.map((c) => c.name).sort();
  assert.deepEqual(names, ['daily', 'leaderboard', 'link', 'recent', 'track', 'unlink', 'weekly']);
  const byName = Object.fromEntries(commands.map((c) => [c.name, c]));
  assert.deepEqual(byName.link!.integration_types, [0, 1]);
  assert.deepEqual(byName.recent!.contexts, [0, 1, 2]);
  assert.deepEqual(byName.track!.contexts, [0]);
  assert.equal(byName.track!.default_member_permissions, String(1n << 5n)); // ManageGuild
  assert.ok(asGuildCommands().every((c) => !('integration_types' in c) && !('contexts' in c)));
});

test('/link: one account per user, relink replaces, unlink stops polling', async () => {
  const { mock, service, repo } = setup();
  mock.addAccount('Main Acc', 'EUW', 'EUW1', ranks('GOLD', 'II', 10));
  mock.addAccount('Smurf', 'EUW', 'EUW1', ranks('PLATINUM', 'IV', 50));

  const a = await service.linkUser('u1', 'EUW1', 'Main Acc#EUW');
  assert.equal(a.previous, null);
  assert.equal(repo.activePlayers().length, 1);

  const b = await service.linkUser('u1', 'EUW1', 'Smurf#EUW');
  assert.equal(b.previous?.game_name, 'Main Acc');
  assert.deepEqual(repo.activePlayers().map((p) => p.game_name), ['Smurf'], 'old account dropped from poll set');

  service.unlinkUser('u1');
  assert.equal(repo.activePlayers().length, 0);
  assert.throws(() => service.unlinkUser('u1'), /no linked account/);
});

test('linked account stays polled when untracked from a server', async () => {
  const { mock, service, repo } = setup();
  const acc = mock.addAccount('Both', 'EUW', 'EUW1', ranks('GOLD', 'II', 10));
  await service.addPlayer('g1', 'EUW', 'Both#EUW');
  await service.linkUser('u1', 'EUW', 'Both#EUW');
  service.removeTracked('g1', acc.puuid);
  assert.equal(repo.activePlayers().length, 1);
});

test('/recent: recorded game shows LP; game before tracking says unrecorded; normals have no LP line', async () => {
  const { mock, service, clock } = setup();
  const a = mock.addAccount('Recent', 'EUW', 'EUW1', ranks('EMERALD', 'II', 40));
  mock.play({ players: [{ puuid: a.puuid, team: 100, champion: 'Ahri' }], winner: 100 });
  clock.advance(MIN);
  const { player } = await service.linkUser('u1', 'EUW', 'Recent#EUW');

  let e = await service.recent(player);
  assert.match(e.description!, /LP not recorded/);

  clock.advance(30 * MIN);
  mock.play({ players: [{ puuid: a.puuid, team: 100, champion: 'Jinx' }], winner: 100, lp: { [a.puuid]: 24 } });
  await service.tick();
  e = await service.recent(player);
  assert.match(e.title!, /Victory · Jinx/);
  assert.match(e.description!, /\+24 LP/);

  clock.advance(30 * MIN);
  mock.play({ players: [{ puuid: a.puuid, team: 100, champion: 'Lux' }], winner: 200, queueId: 450 });
  e = await service.recent(player);
  assert.match(e.title!, /Defeat · Lux/);
  assert.equal(e.description, undefined);
  assert.match(e.footer!.text, /ARAM/);
  assert.deepEqual(validateEmbed(e), []);
});

test('/daily and /weekly personal recaps', async () => {
  const { mock, service, clock } = setup(Date.UTC(2026, 10, 10, 8, 0, 0)); // Tue 09:00 local
  const a = mock.addAccount('Daily', 'EUW', 'EUW1', ranks('GOLD', 'II', 50));
  const { player } = await service.linkUser('u1', 'EUW', 'Daily#EUW');
  for (const [win, lp] of [[true, 21], [false, -17], [true, 19]] as const) {
    clock.advance(35 * MIN);
    mock.play({ players: [{ puuid: a.puuid, team: 100 }], winner: win ? 100 : 200, lp: { [a.puuid]: lp } });
    await service.tick();
  }
  const d = service.personalRecap(player, 'daily');
  assert.equal(d.title, 'Today');
  assert.match(d.description!, /\*\*3\*\* games · 2W 1L \(67%\) · \*\*\+23 LP\*\*/);
  const games = d.fields!.find((f) => f.name === 'Games')!.value.split('\n');
  assert.equal(games.length, 3);
  assert.match(games[0]!, /^🟩 .* \+19 LP$/); // newest first
  assert.deepEqual(validateEmbed(d), []);

  clock.advance(24 * 60 * MIN); // Wednesday: daily resets, weekly keeps
  assert.match(service.personalRecap(player, 'daily').description!, /No ranked games/);
  assert.match(service.personalRecap(player, 'weekly').description!, /\+23 LP/);
});

test('/leaderboard lists every tracked account, sorted by LP then rank', async () => {
  const { mock, service, clock } = setup(Date.UTC(2026, 10, 10, 8, 0, 0));
  const hi = mock.addAccount('Climber', 'EUW', 'EUW1', ranks('GOLD', 'I', 10));
  mock.addAccount('Idle Master', 'EUW', 'EUW1', ranks('MASTER', 'I', 120));
  mock.addAccount('Idle Iron', 'EUW', 'EUW1', ranks('IRON', 'II', 5));
  for (const id of ['Climber#EUW', 'Idle Master#EUW', 'Idle Iron#EUW']) await service.addPlayer('g1', 'EUW', id);
  clock.advance(30 * MIN);
  mock.play({ players: [{ puuid: hi.puuid, team: 100 }], winner: 100, lp: { [hi.puuid]: 22 } });
  await service.tick();

  const e = service.leaderboard('g1', 'daily');
  const table = e.fields![0]!.value.split('\n').filter((l) => /^\s*\d/.test(l));
  assert.match(table[0]!, /Climber .*\+22\s+G1 32/);
  assert.match(table[1]!, /Idle Master .*·\s+M 120/);
  assert.match(table[2]!, /Idle Iron .*I2 5/);
  assert.match(e.description!, /1\/3 active/);
  assert.deepEqual(validateEmbed(e), []);
});
