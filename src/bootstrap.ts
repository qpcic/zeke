import { health } from './core/health.ts';
import { config, requireApiKey } from './config.ts';
import { Service } from './core/service.ts';
import { Tracker } from './core/tracker.ts';
import { openDb } from './db/db.ts';
import { Repo } from './db/repo.ts';
import { RiotClient, type RiotClientOptions } from './riot/client.ts';
import type { Sink } from './sinks/sink.ts';
import { TerminalSink } from './sinks/terminalSink.ts';
import { DDragon, type AssetSource } from './assets/ddragon.ts';
import { dirname, join } from 'node:path';

export const log = (msg: string) => {
  health.noteLog(msg);
  console.log(`${new Date().toISOString().slice(11, 19)} ${msg}`);
};

export function bootstrap(overrides: { riot?: Partial<RiotClientOptions>; sink?: Sink; dbPath?: string; now?: () => number; assets?: AssetSource | null } = {}) {
  const dbPath = overrides.dbPath ?? config.dbPath;
  const db = openDb(dbPath);
  const assets = overrides.assets !== undefined ? overrides.assets : new DDragon(join(dbPath === ':memory:' ? './data' : dirname(dbPath), 'cache'), fetch, log);
  const repo = new Repo(db, overrides.now);
  const riot = new RiotClient({ apiKey: overrides.riot?.apiKey ?? requireApiKey(), log, ...overrides.riot });
  const tracker = new Tracker(repo, riot, {
    trackedQueues: config.trackedQueues,
    lpSettleTimeoutSec: config.lpSettleTimeoutSec,
    rankRefreshSec: config.rankRefreshSec,
    log,
    now: overrides.now,
  });
  const sink = overrides.sink ?? new TerminalSink(config.previewDir);
  const service = new Service(repo, riot, tracker, sink, config.defaultTz, log, overrides.now, assets, config.defaultRegion);
  return { db, repo, riot, tracker, sink, service, assets };
}
