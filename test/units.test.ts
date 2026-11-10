import assert from 'node:assert/strict';
import { test } from 'node:test';
import { absoluteLp, formatRank } from '../src/core/rank.ts';
import { previousDay, previousWeek, zonedMidnight } from '../src/core/time.ts';
import { parseLimitHeader, SlidingWindowLimiter } from '../src/riot/rateLimiter.ts';
import { parseRiotId } from '../src/riot/riotId.ts';

test('parseRiotId', () => {
  assert.deepEqual(parseRiotId('  Jänez Novak #EUW '), { gameName: 'Jänez Novak', tagLine: 'EUW' });
  assert.deepEqual(parseRiotId('we#ird#1234'), { gameName: 'we#ird', tagLine: '1234' });
  assert.throws(() => parseRiotId('ab#EUW'), /3-16/);
  assert.throws(() => parseRiotId('Name#E'), /Tag/);
});

test('absoluteLp ordering and apex', () => {
  assert.equal(absoluteLp({ tier: 'IRON', division: 'IV', lp: 0 }), 0);
  assert.equal(absoluteLp({ tier: 'GOLD', division: 'I', lp: 99 }) + 1, absoluteLp({ tier: 'PLATINUM', division: 'IV', lp: 0 }));
  assert.equal(absoluteLp({ tier: 'DIAMOND', division: 'I', lp: 100 }), absoluteLp({ tier: 'MASTER', division: 'I', lp: 0 }));
  assert.equal(absoluteLp({ tier: 'CHALLENGER', division: 'I', lp: 1200 }) - absoluteLp({ tier: 'GRANDMASTER', division: 'I', lp: 1180 }), 20);
  assert.equal(formatRank({ tier: 'MASTER', division: 'I', lp: 154 }), 'Master 154 LP');
});

test('rate limiter respects every window', async () => {
  let t = 0;
  const l = new SlidingWindowLimiter(parseLimitHeader('2:1,3:10')!, 0, () => t);
  await l.acquire();
  await l.acquire();
  assert.equal(l.waitTime(), 1000); // 1s window full
  t = 1000;
  await l.acquire();
  assert.equal(l.waitTime(), 9000); // 10s window full until first stamp expires at t=10000
  l.block(20_000);
  assert.equal(l.waitTime(), 20_000);
});

test('digest periods are DST-safe (Europe/Ljubljana, DST ends 2026-10-25)', () => {
  const tz = 'Europe/Ljubljana';
  const at = zonedMidnight(2026, 10, 26, tz) + 30 * 60_000; // Mon 26 Oct 00:30 CET
  const d = previousDay(at, tz);
  assert.equal(d.key, '2026-10-25');
  assert.equal(new Date(d.from).toISOString(), '2026-10-24T22:00:00.000Z'); // 00:00 CEST
  assert.equal(new Date(d.to).toISOString(), '2026-10-25T23:00:00.000Z'); // 00:00 CET
  assert.equal((d.to - d.from) / 3600_000, 25);

  const w = previousWeek(at, tz);
  assert.equal(w.key, '2026-W43');
  assert.equal(new Date(w.from).toISOString(), '2026-10-18T22:00:00.000Z');
  assert.equal(w.to, d.to);
});
