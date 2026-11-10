import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { DDragon } from '../src/assets/ddragon.ts';
import { trimTransparent } from '../src/render/image/canvas.ts';

const png = () => {
  const c = createCanvas(8, 8);
  c.getContext('2d').fillRect(0, 0, 8, 8);
  return c.toBuffer('image/png');
};

test('emblems resolve per tier: emerald missing from one set falls through to the next', async () => {
  const calls: string[] = [];
  // ranked-emblem set lacks emerald here; mini crests have everything except emerald; shared-components has emerald
  const fakeFetch = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const ok = url.includes('/ranked-emblem/') ? !url.includes('emerald') : url.includes('/rcp-fe-lol-shared-components/') ? true : !url.includes('emerald');
    return new Response(ok ? png() : 'nope', { status: ok ? 200 : 404 });
  }) as typeof fetch;
  const dd = new DDragon(mkdtempSync(join(tmpdir(), 'dd-')), fakeFetch);
  assert.match((await dd.emblemUrl('GOLD'))!, /ranked-emblem\/emblem-gold\.png$/);
  assert.match((await dd.emblemUrl('EMERALD'))!, /rcp-fe-lol-shared-components\/global\/default\/emerald\.png$/);
  const before = calls.length;
  await dd.emblemUrl('EMERALD');
  assert.equal(calls.length, before, 'resolved emblem is cached');
});

test('trimTransparent crops padding to a centred square', async () => {
  const c = createCanvas(200, 100);
  const g = c.getContext('2d');
  g.fillStyle = '#f00';
  g.fillRect(90, 30, 20, 40); // 20x40 visible box in a lot of empty space
  const img = await loadImage(c.toBuffer('image/png'));
  const t = trimTransparent(img);
  assert.equal(t.width, 40);
  assert.equal(t.height, 40);
});
