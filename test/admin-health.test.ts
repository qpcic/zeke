import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Client } from 'discord.js';
import { ApiMetrics, health } from '../src/core/health.ts';
import { healthEmbed, parseStatsPeriod, statsEmbed } from '../src/discord/admin.ts';
import { validateEmbed } from '../src/render/embed.ts';
import { setup } from './helpers.ts';

const fakeClient = { ws: { ping: 42 }, guilds: { cache: new Map([['g1', { name: 'Zeke HQ' }]]) } } as unknown as Client;
const ranks = [{ queueType: 'RANKED_SOLO_5x5', tier: 'GOLD', rank: 'II', lp: 50, wins: 10, losses: 10 }];

test('api metrics: status buckets and latency percentiles', () => {
  let t = 1_000_000;
  const m = new ApiMetrics(() => t);
  for (let i = 0; i < 18; i++) m.record('match-v5.byId', 200, 100 + i);
  m.record('league-v4.byPuuid', 404, 50);
  m.record('league-v4.byPuuid', 429, 10);
  m.record('match-v5.byId', 503, 900);
  m.record('account-v1.byRiotId', 'network', 3000);
  const s = m.summary();
  assert.deepEqual([s.total, s.ok, s.notFound, s.rateLimited, s.server, s.network], [22, 18, 1, 1, 1, 1]);
  assert.equal(s.methods[0]![0], 'match-v5.byId');
  assert.ok(s.p50 >= 100 && s.p95 <= 117);
  t += 2 * 3_600_000;
  assert.equal(m.summary().total, 0, 'only the last hour');
});

test('$admin health and stats: real data in, valid embeds out', async () => {
  const { mock, service, repo, clock } = setup();
  mock.addAccount('Health One', 'EUW', 'EUW1', ranks);
  await service.linkUser('u1', 'EUW', 'Health One#EUW');
  await service.tick();
  health.tick({ at: clock.now(), ms: 1200, players: 1, games: 0, requests: 3, ok: true });
  health.noteLog('poll failed for X: Riot 503');
  health.noteLog('tick: 1 players, 0 new games'); // not an error

  for (const [name, style, ok] of [['recent', '/', true], ['recent', '$', true], ['profile', '/', false], ['link-panel', 'panel', true]] as const) {
    repo.recordCommand({ at: clock.now(), name, style, userId: 'u1', guildId: 'g1', ok, ms: 800 });
  }
  repo.recordCommand({ at: clock.now() - 10 * 86_400_000, name: 'old', style: '/', userId: 'u2', guildId: null, ok: true, ms: 10 });

  const h = healthEmbed(service, fakeClient, { dbPath: '/nonexistent.db', pollIntervalSec: 120 }, clock.now());
  assert.deepEqual(validateEmbed(h), []);
  const hf = Object.fromEntries(h.fields!.map((f) => [f.name, f.value]));
  assert.match(hf["Discord"]!, /42 ms\*\* · 1 servers/);
  assert.match(hf['Riot API · last hour']!, /requests/);
  assert.match(hf['Recent errors']!, /Riot 503/);
  assert.doesNotMatch(hf['Recent errors']!, /new games/);
  assert.match(hf['Database']!, /1 players · 1 linked users/);

  const s = statsEmbed(service, fakeClient, '7d', clock.now());
  assert.deepEqual(validateEmbed(s), []);
  assert.match(s.description!, /\*\*4\*\* commands by \*\*1\*\* user in \*\*1\*\* server · 25% errors/);
  const sf = Object.fromEntries(s.fields!.map((f) => [f.name, f.value]));
  assert.match(sf['Top commands']!, /`recent +` █+ 2/);
  assert.match(sf['Top servers']!, /Zeke HQ · 4/);
  assert.doesNotMatch(sf['Top commands']!, /old/, '10 days ago is outside 7d');
  assert.match(statsEmbed(service, fakeClient, 'all', clock.now()).description!, /\*\*5\*\* commands/);

  assert.equal(parseStatsPeriod(['24h']), '24h');
  assert.equal(parseStatsPeriod(['month']), '30d');
  assert.equal(parseStatsPeriod([]), '7d');
});
