import { createCanvas } from '@napi-rs/canvas';
import type { AssetSource, StaticData } from '../assets/ddragon.ts';

/** Offline asset source: deterministic coloured tiles instead of real icons (tests, demo without network). */
export class FakeAssets implements AssetSource {
  private sd: StaticData = { version: '0.0.1', champions: new Map([[62, { id: 'MonkeyKing', key: 62, name: 'Wukong', image: 'MonkeyKing.png' }]]), championsById: new Map(), spells: new Map(), perks: new Map() };
  async staticData() { return this.sd; }
  async image(url: string): Promise<Buffer | null> {
    let h = 0;
    for (const ch of url) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    const c = createCanvas(64, 64);
    const g = c.getContext('2d');
    const grad = g.createLinearGradient(0, 0, 64, 64);
    grad.addColorStop(0, `hsl(${h % 360} 55% 45%)`);
    grad.addColorStop(1, `hsl(${(h >> 8) % 360} 55% 25%)`);
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    return c.encode('png');
  }
  championUrl(_sd: StaticData, id: number, name: string) { return `fake://champ/${id}/${name}`; }
  itemUrl(_sd: StaticData, id: number) { return `fake://item/${id}`; }
  spellUrl(_sd: StaticData, id: number) { return `fake://spell/${id}`; }
  perkUrl(_sd: StaticData, id: number) { return `fake://perk/${id}`; }
  async emblemUrl() { return null; }
}
