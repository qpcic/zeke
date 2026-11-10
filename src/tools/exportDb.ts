import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { config } from '../config.ts';

/**
 * npm run export-db
 * Writes a single consistent, gzipped copy of the database (WAL included) for `$import`.
 * Safe while the bot runs, but stop the bot first if you're moving hosts so no new games are missed.
 */
const src = config.dbPath;
if (!existsSync(src)) throw new Error(`No database at ${src}`);
const stamp = new Date().toISOString().slice(0, 10);
const tmp = join(dirname(src), `export-${Date.now()}.db`);
const out = join(dirname(src), `zeke-export-${stamp}.db.gz`);

const db = new DatabaseSync(src);
db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
const counts = Object.fromEntries(['players', 'tracked', 'links', 'player_matches', 'match_cache'].map((t) => [t, (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n]));
db.close();

writeFileSync(out, gzipSync(readFileSync(tmp), { level: 9 }));
rmSync(tmp);
console.log(`Exported ${out} (${(statSync(out).size / 1e6).toFixed(2)} MB)`);
console.log(counts);
console.log('Send it to the bot in a DM with the message: $import');
