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
  /** Region assumed by /scout for unknown players when none is given, e.g. EUNE. Empty = must be given. */
  defaultRegion: process.env.DEFAULT_REGION ?? '',
  previewDir: process.env.PREVIEW_DIR ?? './previews',
  discordToken: process.env.DISCORD_TOKEN ?? '',
  discordClientId: process.env.DISCORD_CLIENT_ID ?? '',
  devGuildId: process.env.DEV_GUILD_ID ?? '',
  /** Register/update global slash commands on startup when their definitions changed (AUTO_REGISTER=0 to disable). */
  autoRegister: process.env.AUTO_REGISTER !== '0',
  /** Channel where owner-only $admin commands are accepted. */
  consoleChannelId: process.env.CONSOLE_CHANNEL_ID ?? '',
  /** Your Discord user ID: allows owner-only commands like $import. */
  ownerId: process.env.OWNER_ID ?? '',
  /** Message prefix for text commands ("$recent"). Empty string disables (and drops the Message Content intent). */
  prefix: process.env.PREFIX ?? '$',
  /** Also render every resolved game to terminal + previews/ (debugging). */
  previewGames: process.env.PREVIEW_GAMES === '1',
} as const;

export function requireDiscord(): { token: string; clientId: string } {
  if (!config.discordToken || !config.discordClientId) throw new Error('DISCORD_TOKEN and DISCORD_CLIENT_ID must be set in .env');
  return { token: config.discordToken, clientId: config.discordClientId };
}

export function requireApiKey(): string {
  if (!config.riotApiKey) throw new Error('RIOT_API_KEY is not set (copy .env.example to .env)');
  return config.riotApiKey;
}
