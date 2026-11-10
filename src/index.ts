import { bootstrap, log } from './bootstrap.ts';
import { config } from './config.ts';

/**
 * Long-running process: poll loop + minute scheduler for digests.
 * Discord client will be started here later; for now output goes to the terminal sink.
 */
const { service, repo, db } = bootstrap();

let stopping = false;
let pollTimer: NodeJS.Timeout | undefined;

async function pollLoop() {
  if (stopping) return;
  const started = Date.now();
  try {
    const players = repo.activePlayers().length;
    const r = await service.tick();
    log(`tick: ${players} players, ${r.games} new games, ${r.requests} requests, ${((Date.now() - started) / 1000).toFixed(1)}s`);
  } catch (e) {
    log(`tick failed: ${(e as Error).stack}`);
  }
  // Fixed delay between ticks (not interval) so slow ticks never overlap.
  pollTimer = setTimeout(pollLoop, config.pollIntervalSec * 1000);
}

const scheduler = setInterval(() => {
  service.runDueDigests().catch((e) => log(`digest failed: ${(e as Error).message}`));
}, 60_000);

let lastNameRefresh = 0;
const renamer = setInterval(() => {
  if (Date.now() - lastNameRefresh < 24 * 3600_000) return;
  lastNameRefresh = Date.now();
  service.refreshNames().catch((e) => log(`name refresh failed: ${(e as Error).message}`));
}, 3600_000);

function shutdown() {
  if (stopping) return;
  stopping = true;
  log('shutting down');
  clearTimeout(pollTimer);
  clearInterval(scheduler);
  clearInterval(renamer);
  db.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

log(`LeagueBot (terminal mode) · polling every ${config.pollIntervalSec}s · queues ${config.trackedQueues.join(',')} · preview: ${config.previewDir}/index.html`);
void service.runDueDigests();
void pollLoop();
