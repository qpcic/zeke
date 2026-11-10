import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { applyPendingImport } from '../core/dbImport.ts';

const MIGRATIONS: string[] = [
  /* 1 */ `
  CREATE TABLE guilds (
    guild_id        TEXT PRIMARY KEY,
    log_channel_id  TEXT,
    timezone        TEXT NOT NULL,
    created_at      INTEGER NOT NULL
  );

  -- One row per Riot account, shared by all guilds tracking it (poll once, fan out).
  CREATE TABLE players (
    puuid            TEXT PRIMARY KEY,
    platform         TEXT NOT NULL,
    game_name        TEXT NOT NULL,
    tag_line         TEXT NOT NULL,
    last_match_check INTEGER NOT NULL,   -- epoch seconds, passed as match-v5 startTime
    last_rank_check  INTEGER NOT NULL DEFAULT 0, -- epoch ms
    created_at       INTEGER NOT NULL
  );

  CREATE TABLE tracked (
    guild_id   TEXT NOT NULL REFERENCES guilds(guild_id) ON DELETE CASCADE,
    puuid      TEXT NOT NULL REFERENCES players(puuid) ON DELETE CASCADE,
    added_by   TEXT,
    added_at   INTEGER NOT NULL,
    PRIMARY KEY (guild_id, puuid)
  );
  CREATE INDEX tracked_puuid ON tracked(puuid);

  -- Latest known rank per queue; the "before" side of every LP diff.
  CREATE TABLE rank_snapshots (
    puuid      TEXT NOT NULL REFERENCES players(puuid) ON DELETE CASCADE,
    queue_type TEXT NOT NULL,
    tier       TEXT NOT NULL,
    division   TEXT NOT NULL,
    lp         INTEGER NOT NULL,
    wins       INTEGER NOT NULL,
    losses     INTEGER NOT NULL,
    taken_at   INTEGER NOT NULL,
    PRIMARY KEY (puuid, queue_type)
  );

  -- Raw match payloads, shared when several tracked players are in one game.
  CREATE TABLE match_cache (
    match_id   TEXT PRIMARY KEY,
    json       TEXT NOT NULL,
    fetched_at INTEGER NOT NULL
  );

  -- Per (match, player). status: pending -> done | ignored
  CREATE TABLE player_matches (
    match_id     TEXT NOT NULL,
    puuid        TEXT NOT NULL REFERENCES players(puuid) ON DELETE CASCADE,
    queue_id     INTEGER NOT NULL,
    status       TEXT NOT NULL,
    win          INTEGER NOT NULL,
    remake       INTEGER NOT NULL,
    game_end     INTEGER NOT NULL,     -- epoch ms
    first_seen   INTEGER NOT NULL,     -- epoch ms
    lp_delta     INTEGER,              -- null = unknown / batched / placement
    note         TEXT,                 -- promoted | demoted | placement | batched | unknown | remake | unranked
    tier_after   TEXT,
    div_after    TEXT,
    lp_after     INTEGER,
    finalized_at INTEGER,
    PRIMARY KEY (match_id, puuid)
  );
  CREATE INDEX pm_status ON player_matches(puuid, status);
  CREATE INDEX pm_end ON player_matches(game_end);

  -- Every LP movement, game-attributed or not (dodges, decay). Digest sums this.
  CREATE TABLE lp_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    puuid      TEXT NOT NULL REFERENCES players(puuid) ON DELETE CASCADE,
    queue_type TEXT NOT NULL,
    delta      INTEGER NOT NULL,
    kind       TEXT NOT NULL,          -- game | adjustment
    match_id   TEXT,
    at         INTEGER NOT NULL        -- epoch ms
  );
  CREATE INDEX lp_events_at ON lp_events(puuid, at);

  -- Which guild already got which game posted (idempotent fan-out).
  CREATE TABLE posts (
    guild_id  TEXT NOT NULL,
    match_id  TEXT NOT NULL,
    puuid     TEXT NOT NULL,
    posted_at INTEGER NOT NULL,
    PRIMARY KEY (guild_id, match_id, puuid)
  );

  -- Last digest run per guild+kind, so a restart near midnight doesn't double-post.
  CREATE TABLE digest_runs (
    guild_id    TEXT NOT NULL,
    kind        TEXT NOT NULL,         -- daily | weekly
    period_key  TEXT NOT NULL,         -- e.g. 2026-11-10 or 2026-W46
    ran_at      INTEGER NOT NULL,
    PRIMARY KEY (guild_id, kind, period_key)
  );
  `,
  /* 2 */ `
  -- Discord user <-> Riot account (one per user). Linked players are polled like tracked ones.
  CREATE TABLE links (
    discord_user_id TEXT PRIMARY KEY,
    puuid           TEXT NOT NULL REFERENCES players(puuid) ON DELETE CASCADE,
    linked_at       INTEGER NOT NULL
  );
  CREATE INDEX links_puuid ON links(puuid);
  `,
  /* 3 */ `
  -- Players are global and never dropped; polling frequency adapts to activity.
  ALTER TABLE players ADD COLUMN next_poll_at INTEGER NOT NULL DEFAULT 0;   -- epoch ms
  ALTER TABLE players ADD COLUMN last_game_at INTEGER NOT NULL DEFAULT 0;   -- epoch ms of newest seen game
  UPDATE players SET last_game_at = COALESCE((SELECT MAX(game_end) FROM player_matches pm WHERE pm.puuid = players.puuid), 0);
  `,
  /* 4 */ `
  -- Small key/value store for discovered facts (e.g. the Ranked 5s queue id).
  CREATE TABLE kv (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  `,
  /* 5 */ `
  -- Per-Discord-user preferences (default queue for stats commands).
  CREATE TABLE user_prefs (
    discord_user_id TEXT PRIMARY KEY,
    default_queue   INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
  );
  `,
];

export type DB = DatabaseSync;

export function openDb(path: string): DB {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
    applyPendingImport(path);
  }
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

function migrate(db: DB): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  for (let v = row.user_version; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}

export function tx<T>(db: DB, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
