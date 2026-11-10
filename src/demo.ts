import { bootstrap } from './bootstrap.ts';
import { config } from './config.ts';
import { MockRiot, mulberry32 } from './dev/mockRiot.ts';
import { TerminalSink } from './sinks/terminalSink.ts';

/**
 * Offline demo: fake Riot API + in-memory DB, simulates a day of games for three
 * tracked players and prints every embed. No API key needed.
 *   npm run demo
 * Then open previews/index.html, or paste any previews/<guild>/*.json into discohook.org.
 */
let t = Date.UTC(2026, 10, 8, 15, 0, 0); // Sun 8 Nov, 16:00 Ljubljana
const clock = { now: () => t };
const advance = (min: number) => { t += min * 60_000; };

const mock = new MockRiot(clock, mulberry32(7)); // seeded: same demo every run
const { service, db } = bootstrap({
  dbPath: ':memory:',
  now: clock.now,
  sink: new TerminalSink(config.previewDir),
  riot: { apiKey: 'demo', fetch: mock.fetch, baseUrl: (h) => `http://mock/${h}` },
});

const jan = mock.addAccount('Jan', 'EUW', 'EUW1', [
  { queueType: 'RANKED_SOLO_5x5', tier: 'GOLD', rank: 'I', lp: 84, wins: 61, losses: 55 },
  { queueType: 'RANKED_FLEX_SR', tier: 'SILVER', rank: 'II', lp: 30, wins: 12, losses: 10 },
]);
const miha = mock.addAccount('Miha Kranjc', 'SLO', 'EUW1', [{ queueType: 'RANKED_SOLO_5x5', tier: 'EMERALD', rank: 'III', lp: 12, wins: 140, losses: 133 }]);
const luka = mock.addAccount('tilted luka', '420', 'EUN1', [{ queueType: 'RANKED_SOLO_5x5', tier: 'SILVER', rank: 'IV', lp: 8, wins: 30, losses: 41 }]);

const G = 'demo-server';
for (const [region, id] of [['EUW', 'Jan#EUW'], ['EUW', 'Miha Kranjc#SLO'], ['EUNE', 'tilted luka#420']] as const) {
  const r = await service.addPlayer(G, region, id);
  console.log(`tracking ${r.player.game_name}#${r.player.tag_line} (${r.player.platform})`);
}

async function tick(label: string) {
  console.log(`\n\x1b[2m··· ${new Date(t).toISOString().slice(0, 16)}Z  poll: ${label}\x1b[0m`);
  await service.tick();
}

// 1. Jan wins and promotes to Platinum
advance(35);
mock.play({ players: [{ puuid: jan.puuid, team: 100, champion: 'Ahri' }], winner: 100, lp: { [jan.puuid]: 23 }, stats: { kills: 11, deaths: 2, assists: 7, tripleKills: 1 } });
await tick('Jan promo game');

// 2. Jan + Miha duo, lose; league-v4 lags one read for both
advance(40);
mock.play({ players: [{ puuid: jan.puuid, team: 200, champion: 'Jinx' }, { puuid: miha.puuid, team: 200, champion: 'Thresh' }], winner: 100, lagReads: 2 });
await tick('duo game finished, ladder not updated yet');
advance(2);
await tick('ladder caught up');

// 3. Luka remakes, then loses and demotes to Bronze
advance(10);
mock.play({ players: [{ puuid: luka.puuid, team: 100 }], winner: 100, remake: true });
await tick('remake');
advance(32);
mock.play({ players: [{ puuid: luka.puuid, team: 100, champion: 'Yasuo' }], winner: 200, lp: { [luka.puuid]: -19 }, stats: { kills: 1, deaths: 12, assists: 3 } });
await tick('luka demotes');

// 4. Miha dodges
mock.adjust(miha.puuid, 'RANKED_SOLO_5x5', -5);
advance(16);
await tick('rank refresh catches a dodge');

// 5. Jan flex game
advance(30);
mock.play({ players: [{ puuid: jan.puuid, team: 100, champion: 'Leona' }], winner: 100, queueId: 440, lp: { [jan.puuid]: 19 } });
await tick('Jan flex win');

// 6. Monday 00:02 local -> scheduler posts the daily (Sun 8 Nov) and weekly (2-8 Nov) recaps
t = Date.UTC(2026, 10, 8, 23, 2, 0);
console.log('\n\x1b[2m··· Mon 9 Nov 00:02 local: scheduler run\x1b[0m');
await service.runDueDigests();

db.close();
console.log(`\nPreviews written to ${config.previewDir}/  ->  open ${config.previewDir}/index.html`);
