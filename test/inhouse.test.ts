import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generate, parseRole, ROLES, type InhousePlayer, type Role } from '../src/core/inhouse.ts';
import { mulberry32 } from '../src/dev/mockRiot.ts';
import { setup } from './helpers.ts';

const TIERS = ['GOLD', 'PLATINUM', 'EMERALD', 'DIAMOND'];
const mk = (n: number, mains: Role[]): InhousePlayer[] => Array.from({ length: n }, (_, i) => ({
  puuid: `p${i}`, name: `P${i}`, tag: 'EUW', main: mains[i % mains.length]!,
  rank: i === 3 ? null : { tier: TIERS[i % 4]!, division: ['IV', 'II', 'I', 'III'][i % 4]!, lp: (i * 17) % 100 },
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

test('$admin 5v5: list, pool, add/remove/clear, generate', async () => {
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
  await ih.add(names.slice(2).map((n, i) => `${n}#EUW euw ${roles[i]}`).join(', '));
  assert.match(ih.pool().embed.title!, /11\/10/);
  assert.match(ih.list().embed.description!, /`Mid    ` \*\*Alpha\*\*#EUW · Gold II 40 LP/);

  // short names for people on the list
  assert.match((await ih.remove('kilo, juli')).embed.description!, /Kilo\n• Juliet[\s\S]*Pool: \*\*9\/10\*\*/);
  await assert.rejects(ih.generate('tryhard'), /9\/10/);
  assert.match(ih.pool().embed.fields![0]!.value, /Juliet/);
  await ih.add('juliet');
  assert.match((await ih.add('alpha jungle')).embed.description!, /Alpha \(main now Jungle\) \(already in\)/);

  const g = await ih.generate('offrole');
  assert.equal(g.files[0]!.name, '5v5.png');
  assert.deepEqual((g.components![0] as { components: { custom_id: string }[] }).components.map((c) => c.custom_id), ['ih:tryhard', 'ih:random', 'ih:offrole']);
  if (process.env.WRITE_PNG) (await import('node:fs')).writeFileSync('/tmp/5v5.png', g.files[0]!.data);

  assert.match(ih.clear().embed.description!, /10 players removed/);
  assert.match((await ih.unlist('kilo')).embed.description!, /Kilo/);
  assert.doesNotMatch(ih.list().embed.description!, /Kilo/);
});
