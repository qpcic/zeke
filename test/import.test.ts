import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/db/db.ts';
import { Repo } from '../src/db/repo.ts';
import { stageImport } from '../src/core/dbImport.ts';

test('export -> $import -> restart applies the database and backs up the old one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'imp-'));
  // "local PC" database with real content
  const srcPath = join(dir, 'local.db');
  const src = openDb(srcPath);
  const r = new Repo(src);
  r.ensureGuild('g1', 'Europe/Ljubljana');
  r.upsertPlayer({ puuid: 'p1', platform: 'EUN1', gameName: 'ferks kitten', tagLine: 'retro', lastMatchCheck: 0 });
  r.track('g1', 'p1');
  r.link('u1', 'p1');
  const exportPath = join(dir, 'export.db');
  src.exec(`VACUUM INTO '${exportPath}'`);
  src.close();
  const gz = gzipSync(readFileSync(exportPath));

  // "Railway" database: fresh and empty, open
  const livePath = join(dir, 'data', 'leaguebot.db');
  const live = openDb(livePath);
  assert.equal(new Repo(live).activePlayers().length, 0);

  const s = stageImport(livePath, gz);
  assert.deepEqual(s, { players: 1, links: 1, tracked: 1, games: 0 });
  assert.ok(existsSync(`${livePath}.import`));
  live.close();

  // restart
  const after = openDb(livePath);
  const repo = new Repo(after);
  assert.equal(repo.linkedPlayer('u1')!.game_name, 'ferks kitten');
  assert.equal(repo.trackedInGuild('g1').length, 1);
  assert.ok(!existsSync(`${livePath}.import`));
  assert.equal(readdirSync(join(dir, 'data', 'backups')).filter((f) => f.startsWith('pre-import-')).length, 1);
  after.close();
});

test('stageImport rejects non-databases and foreign databases', () => {
  const dir = mkdtempSync(join(tmpdir(), 'imp-'));
  const live = join(dir, 'leaguebot.db');
  assert.throws(() => stageImport(live, Buffer.from('hello')), /not a SQLite database/);
  const other = join(dir, 'other.db');
  const db = openDb(':memory:');
  db.exec(`VACUUM INTO '${other}'`); // migrated schema -> valid
  db.close();
  const foreign = join(dir, 'foreign.db');
  const f = new DatabaseSync(foreign);
  f.exec('CREATE TABLE stuff (a)');
  f.close();
  assert.throws(() => stageImport(live, readFileSync(foreign)), /Not a Zeke database/);
  assert.ok(!existsSync(`${live}.import`), 'rejected file is not left staged');
  assert.equal(stageImport(live, readFileSync(other)).players, 0);
});
