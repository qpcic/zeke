import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gunzipSync } from 'node:zlib';

/**
 * Database import used by `$import`: validate an uploaded file and stage it as
 * `<db>.import`. On next start, `applyPendingImport` swaps it in (after backing up the
 * current database). Staging + restart avoids swapping a database that's open.
 */

const REQUIRED_TABLES = ['players', 'tracked', 'links', 'player_matches', 'rank_snapshots'];

export interface ImportSummary { players: number; links: number; tracked: number; games: number }

export function stageImport(dbPath: string, file: Buffer): ImportSummary {
  const raw = file[0] === 0x1f && file[1] === 0x8b ? gunzipSync(file) : file;
  if (raw.subarray(0, 16).toString('latin1') !== 'SQLite format 3\0') throw new Error('That file is not a SQLite database (or .db.gz).');
  const staged = `${dbPath}.import`;
  mkdirSync(dirname(dbPath), { recursive: true });
  writeFileSync(staged, raw);
  try {
    const db = new DatabaseSync(staged, { readOnly: true });
    try {
      const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name));
      const missing = REQUIRED_TABLES.filter((t) => !tables.has(t));
      if (missing.length) throw new Error(`Not a Zeke database (missing tables: ${missing.join(', ')}).`);
      const n = (t: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
      return { players: n('players'), links: n('links'), tracked: n('tracked'), games: n('player_matches') };
    } finally {
      db.close();
    }
  } catch (e) {
    rmSync(staged, { force: true });
    throw e;
  }
}

/** Call before opening the database. Returns the backup path if an import was applied. */
export function applyPendingImport(dbPath: string, log: (m: string) => void = console.log): string | null {
  const staged = `${dbPath}.import`;
  if (dbPath === ':memory:' || !existsSync(staged)) return null;
  let backup: string | null = null;
  if (existsSync(dbPath)) {
    const dir = join(dirname(dbPath), 'backups');
    mkdirSync(dir, { recursive: true });
    backup = join(dir, `pre-import-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
    renameSync(dbPath, backup);
  }
  for (const ext of ['-wal', '-shm']) rmSync(dbPath + ext, { force: true });
  renameSync(staged, dbPath);
  log(`database import applied${backup ? ` (previous database saved to ${backup})` : ''}`);
  return backup;
}
