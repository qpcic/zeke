function num(name: string, def: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Env ${name} must be a number, got "${raw}"`);
  return n;
}

export const config = {
  riotApiKey: process.env.RIOT_API_KEY ?? '',
  dbPath: process.env.DB_PATH ?? './data/leaguebot.db',
  pollIntervalSec: num('POLL_INTERVAL_SEC', 120),
  rankRefreshSec: num('RANK_REFRESH_SEC', 900),
  lpSettleTimeoutSec: num('LP_SETTLE_TIMEOUT_SEC', 600),
  trackedQueues: (process.env.TRACKED_QUEUES ?? '420,440')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n)),
  defaultTz: process.env.DEFAULT_TZ ?? 'Europe/Ljubljana',
  previewDir: process.env.PREVIEW_DIR ?? './previews',
} as const;

export function requireApiKey(): string {
  if (!config.riotApiKey) throw new Error('RIOT_API_KEY is not set (copy .env.example to .env)');
  return config.riotApiKey;
}
