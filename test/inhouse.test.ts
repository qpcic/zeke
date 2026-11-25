import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ForcedRolesError, generate, parseRole, ratingChanges, ROLES, type InhousePlayer, type Role } from '../src/core/inhouse.ts';
import { mulberry32 } from '../src/dev/mockRiot.ts';
import { setup } from './helpers.ts';

const TIERS = ['GOLD', 'PLATINUM', 'EMERALD', 'DIAMOND'];
const mk = (n: number, mains: Role[]): InhousePlayer[] => Array.from({ length: n }, (_, i) => ({
  puuid: `p${i}`, name: `P${i}`, tag: 'EUW', main: mains[i % mains.length]!,
  rank: i === 3 ? null : { tier: TIERS[i % 4]!, division: ['IV', 'II', 'I', 'III'][i % 4]!, lp: (i * 17) % 100 },
  rating: 1000,
}));
const valid = (seats: { role: Role }[]) => assert.deepEqual(seats.map((s) => s.role), [...ROLES]);

test('5v5 tryhard: everyone on their main when the pool allows it, teams close in rank', () => {
  const pool = mk(10, [...ROLES, ...ROLES]);
  for (let s = 0; s < 20; s++) {
    const m = generate(pool, 'tryhard', mulberry32(s));
    valid(m.blue); valid(m.red);
    assert.equal(m.onMain, 10);
    assert.ok(Math.abs(m.blueAvg - m.redAvg) <= 120, `gap ${Math.abs(m.blueAvg - m.redAvg)}`);
    assert.equal(new Set([...m.blue, ...m.red].map((x) => x.player.puuid)).size, 10);
  }
  // three mid mains: only two can play mid
  const crowded = mk(10, ['MIDDLE', 'MIDDLE', 'MIDDLE', 'TOP', 'TOP', 'JUNGLE', 'JUNGLE', 'BOTTOM', 'BOTTOM', 'UTILITY']);
  assert.equal(generate(crowded, 'tryhard', mulberry32(1)).onMain, 9);
});

test('5v5 offrole: nobody on their main role; random: any valid teams', () => {
  const pool = mk(10, [...ROLES, ...ROLES]);
  for (let s = 0; s < 20; s++) {
    const off = generate(pool, 'offrole', mulberry32(s));
    valid(off.blue); valid(off.red);
    assert.equal(off.onMain, 0);
    const r = generate(pool, 'random', mulberry32(s));
    valid(r.blue); valid(r.red);
  }
  // rerolls differ
  const a = new Set(Array.from({ length: 10 }, (_, s) => generate(pool, 'tryhard', mulberry32(s)).blue.map((x) => x.player.puuid).sort().join()));
  assert.ok(a.size > 1, 'rerolls give different teams');
});

test('5v5: needs 10, extra players sit out', () => {
  assert.throws(() => generate(mk(9, [...ROLES]), 'random'), /Need 10/);
  const m = generate(mk(12, [...ROLES]), 'tryhard', mulberry32(3));
  assert.equal(m.bench.length, 2);
  assert.equal(parseRole('jg'), 'JUNGLE');
  assert.equal(parseRole('ADC'), 'BOTTOM');
  assert.equal(parseRole('supp'), 'UTILITY');
  assert.equal(parseRole('kitten'), null);
});

test('5v5 rating: ±25 for even teams, half on your main role, upsets move more', () => {
  const t = (r: number, main: boolean[]) => main.map((m, i) => ({ puuid: `${r}-${i}`, rating: r, onMain: m }));
  const even = ratingChanges(t(1000, [true, false, false, false, false]), t(1000, [false, false, false, false, true]), 'blue');
  assert.deepEqual(even.map((c) => c.delta), [13, 25, 25, 25, 25, -25, -25, -25, -25, -13]);
  assert.deepEqual(even.map((c) => c.won), [true, true, true, true, true, false, false, false, false, false]);
  const upset = ratingChanges(t(900, [false, false, false, false, false]), t(1100, [false, false, false, false, false]), 'blue');
  assert.equal(upset[0]!.delta, 38);
  const expected = ratingChanges(t(900, [false, false, false, false, false]), t(1100, [false, false, false, false, false]), 'red');
  assert.equal(expected[0]!.delta, 12);
});

test('$admin 5v5: list, pool (max 10, menus), generate, winner, rating, undo', async () => {
  const { mock, service } = setup();
  const solo = (tier: string) => [{ queueType: 'RANKED_SOLO_5x5', tier, rank: 'II', lp: 40, wins: 10, losses: 10 }];
  const names = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Fox', 'Golf', 'Hotel', 'India', 'Juliet', 'Kilo'];
  names.forEach((n, i) => mock.addAccount(n, 'EUW', 'EUW1', solo(TIERS[i % 4]!)));
  const ih = service.inhouse;

  const r1 = await ih.add('Alpha#EUW euw mid, Bravo#EUW euw top, Charlie#EUW euw');
  assert.match(r1.embed.description!, /Alpha \(new on the list\)/);
  assert.match(r1.embed.description!, /Charlie\*\* isn't on the list yet: add their main role/);
  assert.match(r1.embed.description!, /Pool: \*\*2\/10\*\*/);

  const roles = ['jungle', 'adc', 'sup', 'top', 'mid', 'jg', 'bot', 'support', 'mid'];
  const r2 = await ih.add(names.slice(2).map((n, i) => `${n}#EUW euw ${roles[i]}`).join(', '));
  assert.match(r2.embed.description!, /Kilo\*\* is on the list now, but didn't fit: the pool is full \(10\/10\)/);
  assert.match(ih.list().embed.description!, /`Mid    ` \*\*Alpha\*\*#EUW · Gold II 40 LP · \*\*1000\*\*/);

  // the panel: a menu with everyone, ticked = in the pool
  let panel = ih.pool();
  assert.match(panel.embed.title!, /10\/10/);
  const menu = (panel.components![0] as { components: { custom_id: string; max_values: number; options: { value: string; default: boolean; label: string }[] }[] }).components[0]!;
  assert.equal(menu.custom_id, 'ih:pool:0');
  assert.equal(menu.max_values, 10);
  assert.equal(menu.options.filter((o) => o.default).length, 10);
  const kilo = menu.options.find((o) => o.label.startsWith('Kilo'))!.value;
  const alpha = menu.options.find((o) => o.label.startsWith('Alpha'))!.value;
  assert.throws(() => ih.setPoolFromMenu(0, menu.options.map((o) => o.value)), /11 players: the pool holds 10/);
  panel = ih.setPoolFromMenu(0, menu.options.filter((o) => o.value !== alpha).map((o) => o.value));
  assert.match(panel.embed.description!, /Kilo/);
  assert.doesNotMatch(panel.embed.description!, /Alpha/);
  void kilo;

  await assert.rejects((async () => { await ih.remove('kilo'); return ih.generate('tryhard'); })(), /9\/10/);
  await ih.add('alpha');
  assert.match((await ih.add('alpha jungle')).embed.description!, /Alpha \(main now Jungle\) \(already in\)/);

  // generate → Blue won → ratings → switch to Red → undo
  const g = await ih.generate('offrole');
  assert.equal(g.files[0]!.name, '5v5.png');
  const rows = g.components as { components: { custom_id: string }[] }[];
  const winBlue = rows[0]!.components[0]!.custom_id;
  assert.match(winBlue, /^ih:win:\d+:blue$/);
  assert.deepEqual(rows[1]!.components.map((c) => c.custom_id), ['ih:tryhard', 'ih:random', 'ih:offrole']);
  const id = Number(winBlue.split(':')[2]);

  const done = await ih.setWinner(id, 'blue');
  if (process.env.WRITE_PNG) (await import('node:fs')).writeFileSync('/tmp/5v5-result.png', done.files[0]!.data);
  assert.equal((done.components![0] as { components: { custom_id: string }[] }).components[0]!.custom_id, `ih:undo:${id}`);
  const ratings = () => service.inhouse.top().embed.description!;
  assert.match(ratings(), /\*\*1025\*\* · 1W 0L/); // off-role: full change
  assert.match(ratings(), /\*\*975\*\* · 0W 1L/);

  await ih.setWinner(id, 'red'); // pressed the wrong one
  const after = service.inhouse.top().embed.description!;
  assert.equal((after.match(/1W 0L/g) ?? []).length, 5);
  assert.equal((after.match(/0W 1L/g) ?? []).length, 5);

  await ih.undo(id);
  assert.match(service.inhouse.top().embed.description!, /No games decided yet/);

  assert.match(ih.clear().embed.description!, /10 players removed/);
  assert.match((await ih.unlist('kilo')).embed.description!, /Kilo/);
  assert.doesNotMatch(ih.list().embed.description!, /Kilo/);
});

test('5v5 forced roles: generate keeps people on their forced roles, every mode', () => {
  for (const mode of ['tryhard', 'offrole', 'random'] as const) {
    for (let s = 0; s < 15; s++) {
      const pool = mk(10, [...ROLES, ...ROLES]);
      pool[0]!.allowed = ['MIDDLE']; // a top main forced mid
      pool[1]!.allowed = ['UTILITY', 'BOTTOM'];
      const m = generate(pool, mode, mulberry32(s));
      const seat = (id: string) => [...m.blue, ...m.red].find((x) => x.player.puuid === id)!;
      assert.equal(seat('p0').role, 'MIDDLE', mode);
      assert.ok(['UTILITY', 'BOTTOM'].includes(seat('p1').role), mode);
      valid(m.blue); valid(m.red);
    }
  }
  const bad = mk(10, [...ROLES]);
  for (const i of [0, 1, 2]) bad[i]!.allowed = ['MIDDLE'];
  assert.throws(() => generate(bad, 'tryhard'), ForcedRolesError);
});

test('$admin 5v5 force: pick a player, tick roles, generate follows; forces stay with the player', async () => {
  const { mock, service } = setup();
  const solo = [{ queueType: 'RANKED_SOLO_5x5', tier: 'GOLD', rank: 'II', lp: 40, wins: 10, losses: 10 }];
  const names = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Fox', 'Golf', 'Hotel', 'India', 'Juliet'];
  names.forEach((n) => mock.addAccount(n, 'EUW', 'EUW1', solo));
  const roles = ['top', 'jg', 'mid', 'adc', 'sup', 'top', 'jg', 'mid', 'adc', 'sup'];
  const ih = service.inhouse;
  await ih.add(names.map((n, i) => `${n}#EUW euw ${roles[i]}`).join(', '));

  let panel = ih.forcePanel();
  const players = (panel.components![0] as { components: { custom_id: string; options: { value: string; label: string }[] }[] }).components[0]!;
  assert.equal(players.custom_id, 'ih:fp');
  const alpha = players.options.find((o) => o.label.startsWith('Alpha'))!.value;
  panel = ih.forcePanel(alpha);
  const roleMenu = (panel.components![1] as { components: { custom_id: string; options: { value: string; description?: string }[] }[] }).components[0]!;
  assert.equal(roleMenu.custom_id, `ih:fr:${alpha}`);
  assert.equal(roleMenu.options.find((o) => o.value === 'TOP')!.description, 'main role');

  panel = ih.setForce(alpha, ['UTILITY']);
  assert.match(panel.embed.description!, /🔒 \*\*Alpha\*\* will play Support/);
  assert.match(ih.pool().embed.description!, /\*\*Alpha\*\*.*🔒 Support/);
  for (let k = 0; k < 5; k++) {
    const g = await ih.generate('tryhard');
    const id = Number((g.components![0] as { components: { custom_id: string }[] }).components[0]!.custom_id.split(':')[2]);
    const row = service['repo'].inhouseMatch(id)!;
    const seats = [...JSON.parse(row.blue), ...JSON.parse(row.red)] as { puuid: string; role: string }[];
    assert.equal(seats.find((x) => x.puuid === alpha)!.role, 'UTILITY');
  }
  assert.match(ih.setForce(alpha, ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY']).embed.description!, /Alpha\*\* can play any role/);
  ih.setForce(alpha, ['MIDDLE']);
  await ih.remove('alpha');
  await ih.add('alpha');
  assert.match(ih.pool().embed.description!, /\*\*Alpha\*\*.*🔒 Mid/, 'forced roles stay with the player');
  ih.clear();
  assert.match(ih.list().embed.description!, /\*\*Alpha\*\*.*🔒 Mid/, 'even after the pool is cleared');
  assert.match(ih.forcePanel().embed.description!, /🔒 \*\*Alpha\*\*: Mid · not in the pool/);
  assert.match(ih.clearForces().embed.description!, /Nobody has forced roles/);
});

test('$admin 5v5: rank is the highest of Solo/Duo, Flex and 5s', async () => {
  const { mock, service } = setup();
  mock.addAccount('Flexer', 'EUW', 'EUW1', [
    { queueType: 'RANKED_SOLO_5x5', tier: 'GOLD', rank: 'II', lp: 40, wins: 10, losses: 10 },
    { queueType: 'RANKED_FLEX_SR', tier: 'DIAMOND', rank: 'IV', lp: 12, wins: 10, losses: 10 },
  ]);
  mock.addAccount('Soloer', 'EUW', 'EUW1', [
    { queueType: 'RANKED_SOLO_5x5', tier: 'EMERALD', rank: 'I', lp: 70, wins: 10, losses: 10 },
    { queueType: 'RANKED_FLEX_SR', tier: 'SILVER', rank: 'I', lp: 5, wins: 10, losses: 10 },
  ]);
  await service.inhouse.add('Flexer#EUW euw mid, Soloer#EUW euw top');
  const list = service.inhouse.list().embed.description!;
  assert.match(list, /\*\*Flexer\*\*#EUW · Diamond IV 12 LP \(Flex\)/);
  assert.match(list, /\*\*Soloer\*\*#EUW · Emerald I 70 LP · /);
});
