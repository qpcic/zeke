import { Client, Events, GatewayIntentBits } from 'discord.js';
import { bootstrap, log } from './bootstrap.ts';
import { config, requireDiscord } from './config.ts';
import { createInteractionHandler } from './discord/handlers.ts';
import { LogSink } from './sinks/logSink.ts';
import { TerminalSink } from './sinks/terminalSink.ts';

/**
 * Long-running process: Discord client (slash commands) + background poll loop.
 * Commands-only: the poller records games/LP so /daily, /weekly and /leaderboard
 * have data; nothing is posted unprompted.
 */
const { token } = requireDiscord();
const { service, repo, db } = bootstrap({
  sink: config.previewGames ? new TerminalSink(config.previewDir) : new LogSink(log),
});

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
client.on(Events.InteractionCreate, createInteractionHandler(service, log));
client.once(Events.ClientReady, (c) => {
  log(`Discord: logged in as ${c.user.tag} · ${c.guilds.cache.size} server(s)`);
});

let stopping = false;
let pollTimer: NodeJS.Timeout | undefined;

async function pollLoop() {
  if (stopping) return;
  const started = Date.now();
  try {
    const players = repo.activePlayers().length;
    const r = await service.tick();
    if (r.games || r.requests > players) {
      log(`tick: ${players} players, ${r.games} new games, ${r.requests} requests, ${((Date.now() - started) / 1000).toFixed(1)}s`);
    }
  } catch (e) {
    log(`tick failed: ${(e as Error).stack}`);
  }
  // Fixed delay between ticks (not interval) so slow ticks never overlap.
  pollTimer = setTimeout(pollLoop, config.pollIntervalSec * 1000);
}

let lastNameRefresh = Date.now();
const renamer = setInterval(() => {
  if (Date.now() - lastNameRefresh < 24 * 3600_000) return;
  lastNameRefresh = Date.now();
  service.refreshNames().catch((e) => log(`name refresh failed: ${(e as Error).message}`));
}, 3600_000);

async function shutdown() {
  if (stopping) return;
  stopping = true;
  log('shutting down');
  clearTimeout(pollTimer);
  clearInterval(renamer);
  await client.destroy();
  db.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

log(`LeagueBot · polling every ${config.pollIntervalSec}s · queues ${config.trackedQueues.join(',')} · ${repo.activePlayers().length} players`);
await client.login(token);
void pollLoop();
