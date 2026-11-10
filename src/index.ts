import { Client, Events, GatewayIntentBits, Partials } from 'discord.js';
import { resolve } from 'node:path';
import { bootstrap, log } from './bootstrap.ts';
import { config, requireDiscord } from './config.ts';
import { createInteractionHandler } from './discord/handlers.ts';
import { createPrefixHandler } from './discord/prefix.ts';
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

// Text commands need the privileged Message Content intent (Developer Portal -> Bot -> Message Content Intent).
const prefixOn = config.prefix.length > 0;
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    ...(prefixOn ? [GatewayIntentBits.GuildMessages, GatewayIntentBits.DirectMessages, GatewayIntentBits.MessageContent] : []),
  ],
  partials: prefixOn ? [Partials.Channel] : [], // DM channels arrive uncached
});
client.on(Events.InteractionCreate, createInteractionHandler(service, log));
if (prefixOn) client.on(Events.MessageCreate, createPrefixHandler(service, config.prefix, () => client.user?.id, log));
client.once(Events.ClientReady, (c) => {
  log(`Discord: logged in as ${c.user.tag} · ${c.guilds.cache.size} server(s)${prefixOn ? ` · prefix "${config.prefix}"` : ''}`);
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

log(`Zeke · polling every ${config.pollIntervalSec}s · queues ${config.trackedQueues.join(',')} · ${repo.activePlayers().length} players`);
// Persistence check: if these numbers drop to 0 after a redeploy, the volume isn't mounted at the DB's folder.
{
  const n = (t: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
  log(`database ${resolve(config.dbPath)} · ${n('players')} players · ${n('links')} links · ${n('tracked')} server tracks · ${n('player_matches')} games`);
}
try {
  await client.login(token);
} catch (e) {
  if (/disallowed intents/i.test((e as Error).message)) {
    log('Discord rejected the Message Content intent. Enable it in Developer Portal -> Bot -> Privileged Gateway Intents, or set PREFIX= (empty) in .env to disable $ commands.');
    process.exit(1);
  }
  throw e;
}
void pollLoop();
