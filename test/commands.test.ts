import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateEmbed } from '../src/render/embed.ts';
import { asGuildCommands, commands } from '../src/discord/commands.ts';
import { setup } from './helpers.ts';
import { runCommand } from '../src/discord/actions.ts';

const MIN = 60_000;
const ranks = (tier: string, rank: string, lp: number) => [{ queueType: 'RANKED_SOLO_5x5', tier, rank, lp, wins: 100, losses: 90 }];

test('command definitions are valid and scoped right', () => {
  const names = commands.map((c) => c.name).sort();
  assert.deepEqual(names, ['daily', 'graph', 'help', 'leaderboard', 'link', 'live', 'log', 'mode', 'profile', 'recap', 'recent', 'scout', 'server', 'track', 'unlink', 'weekly', 'zeke']);
  const byName = Object.fromEntries(commands.map((c) => [c.name, c]));
  assert.deepEqual(byName.link!.integration_types, [0, 1]);
  assert.deepEqual(byName.recent!.contexts, [0, 1, 2]);
  assert.deepEqual(byName.track!.contexts, [0]);
  assert.equal(byName.track!.default_member_permissions, String(1n << 5n)); // ManageGuild
  assert.ok(asGuildCommands().every((c) => !('integration_types' in c) && !('contexts' in c)));
});

test('/link: several accounts per user, first is main, removing the main promotes the oldest alt', async () => {
  const { mock, service, repo } = setup();
  mock.addAccount('Main Acc', 'EUW', 'EUW1', ranks('GOLD', 'II', 10));
  mock.addAccount('Smurf', 'EUW', 'EUW1', ranks('PLATINUM', 'IV', 50));
  mock.addAccount('Third', 'EUNE', 'EUN1', ranks('SILVER', 'I', 0));

  const a = await service.linkUser('u1', 'EUW1', 'Main Acc#EUW');
  assert.deepEqual([a.added, a.isMain], [true, true]);
  const b = await service.linkUser('u1', 'EUW1', 'Smurf#EUW');
  assert.deepEqual([b.added, b.isMain], [true, false]);
  const again = await service.linkUser('u1', undefined, 'smurf#euw'); // known account: no region needed
  assert.equal(again.added, false);
  await service.linkUser('u1', 'EUNE', 'Third#EUNE');

  assert.deepEqual(service.linkedAccounts('u1').map((p) => p.game_name), ['Main Acc', 'Smurf', 'Third']);
  assert.equal(repo.linkedPlayer('u1')!.game_name, 'Main Acc', 'main is used for mentions / stats');

  // removing the main promotes the oldest alt
  const r = service.unlinkUser('u1', 'Main Acc#EUW');
  assert.equal(r.newMain?.game_name, 'Smurf');
  assert.equal(repo.linkedPlayer('u1')!.game_name, 'Smurf');
  // set main explicitly
  service.setMainAccount('u1', 'Third#EUNE');
  assert.deepEqual(service.linkedAccounts('u1').map((p) => [p.game_name, p.is_main]), [['Third', 1], ['Smurf', 0]]);
  // removing an alt keeps the main
  assert.equal(service.unlinkUser('u1', 'Smurf#EUW').newMain, null);
  assert.throws(() => service.unlinkUser('u1', 'Nobody#X'), /isn't one of your linked accounts/);
  service.unlinkUser('u1'); // only one left: no name needed
  assert.equal(repo.linkedPlayer('u1'), undefined);
  assert.equal(repo.activePlayers().length, 3, 'players are never dropped');
  assert.throws(() => service.unlinkUser('u1'), /no linked account/);
});

test('/recent picks the newest game across all linked accounts; other stats use the main', async () => {
  const { mock, service, clock } = setup();
  const main = mock.addAccount('Mainy', 'EUW', 'EUW1', ranks('GOLD', 'II', 10));
  const alt = mock.addAccount('Alty', 'EUNE', 'EUN1', ranks('GOLD', 'I', 10));
  await service.linkUser('u1', 'EUW', 'Mainy#EUW');
  await service.linkUser('u1', 'EUNE', 'Alty#EUNE');

  clock.advance(30 * MIN);
  mock.play({ players: [{ puuid: main.puuid, team: 100, champion: 'Ahri' }], winner: 100 });
  clock.advance(40 * MIN);
  mock.play({ players: [{ puuid: alt.puuid, team: 100, champion: 'Zed' }], winner: 200 });

  const base = { callerId: 'u2', guildId: null, canManageGuild: false, style: '/' } as const;
  let e = (await runCommand(service, { ...base, name: 'recent', targetUserId: 'u1' })).embed;
  assert.match(e.title!, /Zed/, 'alt played last');

  clock.advance(40 * MIN);
  mock.play({ players: [{ puuid: main.puuid, team: 100, champion: 'Lux' }], winner: 100 });
  e = (await runCommand(service, { ...base, callerId: 'u1', name: 'recent' })).embed;
  assert.match(e.title!, /Lux/);
  await assert.rejects(runCommand(service, { ...base, callerId: 'u1', name: 'recent', queue: 440 }), /No Flex games found on any linked account/);
});

test('link panel: accounts listed main first with add / remove / set-main buttons', async () => {
  const { mock, service } = setup();
  mock.addAccount('Panel Main', 'EUW', 'EUW1', ranks('GOLD', 'II', 10));
  mock.addAccount('Panel Alt', 'EUW', 'EUW1', ranks('GOLD', 'II', 10));
  const base = { callerId: '123', guildId: null, canManageGuild: false, style: '/' } as const;

  const empty = await runCommand(service, { ...base, name: 'link' });
  assert.match(empty.embed.description!, /No accounts linked yet/);
  const btns = (r: typeof empty) => ((r.components![0] as { components: { label: string; custom_id: string; disabled?: boolean }[] }).components);
  assert.deepEqual(btns(empty).map((b) => [b.label, !!b.disabled]), [['Add account', false], ['Remove account', true]]);

  await runCommand(service, { ...base, name: 'link', region: 'EUW', riotId: 'Panel Main#EUW' });
  const two = await runCommand(service, { ...base, name: 'link', riotId: 'Panel Alt#EUW', region: 'EUW' });
  assert.match(two.embed.description!, /Linked \*\*Panel Alt#EUW\*\* as an alt/);
  assert.match(two.embed.description!, /⭐ \*\*Panel Main#EUW\*\*.*main[\s\S]*▫️ \*\*Panel Alt#EUW\*\*/);
  assert.deepEqual(btns(two).map((b) => b.custom_id), ['link:add:123', 'link:remove:123', 'link:main:123']);
  assert.deepEqual(validateEmbed(two.embed), []);

  // /unlink with several accounts and none named opens the remove picker
  const pick = await runCommand(service, { ...base, name: 'unlink' });
  const select = (pick.components![0] as { components: { custom_id: string; options: unknown[] }[] }).components[0]!;
  assert.equal(select.custom_id, 'link:rmpick:123');
  assert.equal(select.options.length, 2);
});

test('linked account stays polled when untracked from a server', async () => {
  const { mock, service, repo } = setup();
  const acc = mock.addAccount('Both', 'EUW', 'EUW1', ranks('GOLD', 'II', 10));
  await service.addPlayer('g1', 'EUW', 'Both#EUW');
  await service.linkUser('u1', 'EUW', 'Both#EUW');
  service.removeTracked('g1', acc.puuid);
  assert.equal(repo.activePlayers().length, 1);
});

test('/recent: recorded game shows LP; before tracking says n/a; any ranked queue by default, scoped on request', async () => {
  const { mock, service, clock } = setup();
  const a = mock.addAccount('Recent', 'EUW', 'EUW1', ranks('EMERALD', 'II', 40));
  mock.play({ players: [{ puuid: a.puuid, team: 100, champion: 'Ahri' }], winner: 100 });
  clock.advance(MIN);
  const { player } = await service.linkUser('u1', 'EUW', 'Recent#EUW');

  let rep = await service.recent(player);
  let e = rep.embed;
  assert.match(e.description!, /LP n\/a/);
  assert.equal(rep.files[0]!.name, 'scoreboard.png');
  assert.equal(rep.files[0]!.data.subarray(1, 4).toString(), 'PNG');
  assert.equal(e.image!.url, 'attachment://scoreboard.png');
  assert.equal(e.fields, undefined, 'no text scoreboard when the image is attached');

  clock.advance(30 * MIN);
  mock.play({ players: [{ puuid: a.puuid, team: 100, champion: 'Jinx' }], winner: 100, lp: { [a.puuid]: 24 } });
  await service.tick();
  e = (await service.recent(player)).embed;
  assert.match(e.title!, /Victory · Jinx/);
  assert.match(e.description!, /\+24 LP/);

  // no queue: newest ranked game of any queue (the later flex game); solo still reachable explicitly
  clock.advance(30 * MIN);
  mock.play({ players: [{ puuid: a.puuid, team: 100, champion: 'Lux' }], winner: 200, queueId: 440 });
  {
    const r = await service.recent(player, 420);
    const urls = (r.components![0] as { components: { url: string }[] }).components.map((b) => b.url);
    assert.match(urls[2]!, /^https:\/\/dpm\.lol\/.+\?match=\d+$/, 'DPM.LOL opens this game');
  }
  e = (await service.recent(player, 420)).embed;
  assert.match(e.title!, /Victory · Jinx/);
  e = (await service.recent(player)).embed;
  assert.match(e.title!, /Defeat · Lux/);
  e = (await service.recent(player, 440)).embed;
  assert.match(e.title!, /Defeat · Lux/);
  assert.match(e.footer!.text, /Ranked Flex/);
  assert.deepEqual(validateEmbed(e), []);
});

test('/daily and /weekly personal recaps render as images', async () => {
  const { mock, service, clock } = setup(Date.UTC(2026, 10, 10, 8, 0, 0)); // Tue 09:00 local
  const a = mock.addAccount('Daily', 'EUW', 'EUW1', ranks('GOLD', 'II', 50));
  const { player } = await service.linkUser('u1', 'EUW', 'Daily#EUW');

  const none = await service.personalRecap(player, 'daily');
  assert.equal(none.files.length, 0);
  assert.match(none.embed.description!, /No Solo\/Duo games today/);
  assert.match((await service.personalRecap(player, 'daily', 420, '24h')).embed.description!, /No Solo\/Duo games in the past 24 hours/);

  for (const [win, lp, champ] of [[true, 21, 'Ahri'], [false, -17, 'Jinx'], [true, 19, 'Lux']] as const) {
    clock.advance(35 * MIN);
    mock.play({ players: [{ puuid: a.puuid, team: 100, champion: champ }], winner: win ? 100 : 200, lp: { [a.puuid]: lp } });
    await service.tick();
  }
  const d = service.recapData(player, 'daily')!;
  assert.deepEqual([d.header.title, d.header.games, d.header.wins, d.header.losses, d.header.lpNet], ['Today · Solo/Duo', 3, 2, 1, 23]);
  assert.equal(service.recapData(player, 'daily', 420, '24h')!.header.title, 'Past 24h · Solo/Duo');
  assert.deepEqual(d.games.map((g) => [g.championName, g.result, g.lpDelta]), [['Lux', 'win', 19], ['Jinx', 'loss', -17], ['Ahri', 'win', 21]], 'newest first');
  assert.deepEqual(d.header.rank, { tier: 'GOLD', division: 'II', lp: 73, queue: 'Solo/Duo' });

  const img = await service.personalRecap(player, 'daily');
  assert.equal(img.files[0]!.name, 'daily.png');
  assert.equal(img.files[0]!.data.subarray(1, 4).toString(), 'PNG');
  assert.equal(img.embed.image!.url, 'attachment://daily.png');

  // games ended 08:35, 09:10, 09:45 UTC (Tue); it's now 09:45
  // 22h later it's Wednesday 07:45 UTC (08:45 Ljubljana): "today" is empty, "past 24h" still has all 3
  clock.advance(22 * 60 * MIN);
  assert.equal(service.recapData(player, 'daily'), null, 'today resets at local midnight');
  assert.equal(service.recapData(player, 'daily', 420, '24h')!.header.games, 3, 'past 24h crosses midnight');
  clock.advance(3 * 60 * MIN); // now >24h after every game
  assert.equal(service.recapData(player, 'daily', 420, '24h'), null);
  assert.equal(service.recapData(player, 'weekly')!.header.lpNet, 23);
  assert.equal((await service.personalRecap(player, 'weekly')).files[0]!.name, 'weekly.png');
  clock.advance(7 * 24 * 60 * MIN); // >7 days after the games
  assert.equal(service.recapData(player, 'weekly'), null, 'past 7 days rolls off too');
});

test('/leaderboard: image of accounts that played, zero-game accounts hidden', async () => {
  const { mock, service, clock } = setup(Date.UTC(2026, 10, 10, 8, 0, 0));
  const hi = mock.addAccount('Climber', 'EUW', 'EUW1', ranks('GOLD', 'I', 10));
  const lo = mock.addAccount('Faller', 'EUW', 'EUW1', ranks('SILVER', 'I', 10));
  mock.addAccount('Idle Master', 'EUW', 'EUW1', ranks('MASTER', 'I', 120));
  for (const id of ['Climber#EUW', 'Faller#EUW', 'Idle Master#EUW']) await service.addPlayer('g1', 'EUW', id);

  const empty = await service.leaderboard('g1', 'daily');
  assert.equal(empty.files.length, 0);
  assert.match(empty.embed.description!, /No Solo\/Duo games in the past 24 hours by the 3 tracked accounts/);
  assert.match((await service.leaderboard('nobody', 'weekly')).embed.description!, /No accounts tracked/);

  clock.advance(30 * MIN);
  mock.play({ players: [{ puuid: hi.puuid, team: 100 }, { puuid: lo.puuid, team: 200 }], winner: 100, lp: { [hi.puuid]: 22, [lo.puuid]: -17 } });
  await service.tick();

  const r = await service.leaderboard('g1', 'daily');
  assert.equal(r.embed.image!.url, 'attachment://leaderboard.png');
  assert.equal(r.files[0]!.data.subarray(1, 4).toString(), 'PNG');

  // the row data the image draws: idle account hidden, sorted by LP, sparkline from recorded LP
  const { computeDigest } = await import('../src/core/digest.ts');
  const { today } = await import('../src/core/time.ts');
  const period = today(clock.now(), 'Europe/Ljubljana');
  const d = computeDigest((service as any).repo, 'g1', 'adhoc', period);
  const rows = service.leaderboardRows(d.players.filter((p) => p.games > 0), period);
  assert.deepEqual(rows.map((x) => [x.name, x.lpNet, x.wins, x.losses]), [['Climber', 22, 1, 0], ['Faller', -17, 0, 1]]);
  assert.equal(rows[0]!.spark.length, 2, 'start LP + after the game');
  assert.equal(rows[0]!.spark[1]! - rows[0]!.spark[0]!, 22);
  assert.deepEqual(rows[0]!.rank, { tier: 'GOLD', division: 'I', lp: 32 });
});

test('/graph: needs 2+ points, then renders a PNG over recorded games', async () => {
  const { mock, service, clock } = setup();
  const a = mock.addAccount('Grapher', 'EUW', 'EUW1', ranks('GOLD', 'I', 80));
  const { player } = await service.linkUser('u1', 'EUW', 'Grapher#EUW');
  await assert.rejects(service.graph(player, 420, 50), /Not enough recorded/);
  for (const [w, lp] of [[true, 22], [true, 20], [false, -18]] as const) {
    clock.advance(40 * MIN);
    mock.play({ players: [{ puuid: a.puuid, team: 100 }], winner: w ? 100 : 200, lp: { [a.puuid]: lp } });
    await service.tick();
  }
  const g = await service.graph(player, 420, 50);
  assert.equal(g.files[0]!.data.subarray(1, 4).toString(), 'PNG');
  assert.match(g.embed.footer!.text, /Only 3 games recorded/);
});

test('text tables are CJK-width aware', async () => {
  const { cell, displayWidth } = await import('../src/render/format.ts');
  assert.equal(displayWidth('아무것도'), 8);
  assert.equal(displayWidth(cell('아무것도 아님', 10)), 10);
  assert.equal(displayWidth(cell('Munja', 10)), 10);
});

test('adaptive polling: active every tick, idle linked 10 min, idle looked-up 30 min', async () => {
  const { pollIntervalMs } = await import('../src/core/tracker.ts');
  const now = Date.UTC(2026, 10, 10);
  assert.equal(pollIntervalMs(now - 60 * MIN, now, false, false), 0);
  assert.equal(pollIntervalMs(now - 5 * 24 * 60 * MIN, now, false, true), 10 * MIN);
  assert.equal(pollIntervalMs(now - 5 * 24 * 60 * MIN, now, false, false), 30 * MIN);
  assert.equal(pollIntervalMs(0, now, true, false), 0, 'pending game: poll until resolved');
});

test('idle players are skipped until due', async () => {
  const { mock, service, clock, repo } = setup();
  const a = mock.addAccount('Sleeper', 'EUW', 'EUW1', ranks('GOLD', 'II', 10));
  await service.linkUser('u1', 'EUW', 'Sleeper#EUW');
  clock.advance(4 * 60 * MIN); // past the "new account" window
  await service.tick(); // polled (due), then scheduled +10 min
  mock.calls = [];
  clock.advance(2 * MIN);
  await service.tick();
  assert.equal(mock.calls.length, 0, 'not due yet');
  clock.advance(9 * MIN);
  mock.play({ players: [{ puuid: a.puuid, team: 100 }], winner: 100, lp: { [a.puuid]: 20 } });
  await service.tick();
  assert.ok(mock.calls.some((c) => c.endsWith('/ids')));
  assert.equal(repo.getPlayer(a.puuid)!.next_poll_at, clock.now(), 'just played: back to every tick');
});

test('solo and flex are tracked separately in daily/weekly and leaderboard', async () => {
  const { mock, service, clock } = setup(Date.UTC(2026, 10, 10, 8, 0, 0));
  const a = mock.addAccount('Both Queues', 'EUW', 'EUW1', [
    { queueType: 'RANKED_SOLO_5x5', tier: 'GOLD', rank: 'II', lp: 50, wins: 1, losses: 1 },
    { queueType: 'RANKED_FLEX_SR', tier: 'SILVER', rank: 'I', lp: 20, wins: 1, losses: 1 },
  ]);
  const { player } = await service.linkUser('u1', 'EUW', 'Both Queues#EUW');
  await service.addPlayer('g1', 'EUW', 'Both Queues#EUW');
  for (const [q, win, lp] of [[420, true, 20], [440, false, -15], [440, false, -16], [420, true, 22]] as const) {
    clock.advance(35 * MIN);
    mock.play({ players: [{ puuid: a.puuid, team: 100 }], winner: win ? 100 : 200, queueId: q, lp: { [a.puuid]: lp } });
    await service.tick();
  }
  const solo = service.recapData(player, 'daily')!;
  assert.deepEqual([solo.header.games, solo.header.wins, solo.header.lpNet, solo.header.rank!.tier], [2, 2, 42, 'GOLD']);
  const flex = service.recapData(player, 'daily', 440)!;
  assert.deepEqual([flex.header.games, flex.header.losses, flex.header.lpNet, flex.header.rank!.tier, flex.header.title], [2, 2, -31, 'SILVER', 'Today · Flex']);

  const { computeDigest } = await import('../src/core/digest.ts');
  const { today } = await import('../src/core/time.ts');
  const period = today(clock.now(), 'Europe/Ljubljana');
  const lbSolo = service.leaderboardRows(computeDigest((service as any).repo, 'g1', 'adhoc', period, 420).players, period, 420);
  const lbFlex = service.leaderboardRows(computeDigest((service as any).repo, 'g1', 'adhoc', period, 440).players, period, 440);
  assert.deepEqual([lbSolo[0]!.lpNet, lbSolo[0]!.queueLabel, lbSolo[0]!.results], [42, 'Solo/Duo', [true, true]]);
  assert.deepEqual([lbFlex[0]!.lpNet, lbFlex[0]!.queueLabel, lbFlex[0]!.results], [-31, 'Flex', [false, false]]);
});

test('/profile: rank cards, exact ladder position for Master+, mastery champs', async () => {
  const { mock, service } = setup();
  mock.addAccount('Apex Guy', 'EUNE', 'EUN1', [{ queueType: 'RANKED_SOLO_5x5', tier: 'MASTER', rank: 'I', lp: 984, wins: 251, losses: 219 }]);
  const { player } = await service.linkUser('u1', 'EUNE', 'Apex Guy#EUNE');
  const r = await service.profile(player);
  assert.equal(r.files[0]!.name, 'profile.png');
  assert.deepEqual((r.components![0] as { components: { label: string }[] }).components.map((b) => b.label), ['U.GG', 'OP.GG', 'DPM.LOL']);
  assert.equal(r.files[0]!.data.subarray(1, 4).toString(), 'PNG');
  // 984 LP sits behind fake0 (1000) -> #2
  const pos = await (service as any).apexPosition('EUN1', 'RANKED_SOLO_5x5', player.puuid);
  assert.deepEqual(pos, { pos: 2, total: 41 });
});

test('profile queue cards sort by tier, division, LP; unranked last', async () => {
  const { sortQueues } = await import('../src/render/image/profile.ts');
  const q = (label: string, rank: { tier: string; division: string; lp: number } | null) => ({ label, rank, wins: 1, losses: 1, ladderPos: null, hotStreak: false });
  const out = sortQueues([
    q('Solo/Duo', { tier: 'MASTER', division: 'I', lp: 1100 }),
    q('Flex', null),
    q('Ranked 5s', { tier: 'CHALLENGER', division: 'I', lp: 589 }),
  ]);
  assert.deepEqual(out.map((x) => x.label), ['Ranked 5s', 'Solo/Duo', 'Flex']);
  const out2 = sortQueues([
    q('Solo/Duo', { tier: 'GOLD', division: 'II', lp: 90 }),
    q('Flex', { tier: 'GOLD', division: 'I', lp: 10 }),
    q('Ranked 5s', { tier: 'GOLD', division: 'I', lp: 40 }),
  ]);
  assert.deepEqual(out2.map((x) => x.label), ['Ranked 5s', 'Flex', 'Solo/Duo']);
});
