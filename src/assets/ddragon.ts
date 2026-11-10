import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * Data Dragon / CommunityDragon client with a disk cache (data/cache/...).
 * Everything here is best-effort: a missing icon renders as a placeholder,
 * it never fails a command.
 */

const DD = 'https://ddragon.leagueoflegends.com';
const CD = 'https://raw.communitydragon.org/latest';

/**
 * Candidate paths for tier emblems, best first, resolved PER TIER (cached). The current
 * emblem set includes Emerald; the older mini crests don't (they 404 for emerald), so a
 * single global probe isn't enough.
 */
const EMBLEM_CANDIDATES = [
  (t: string) => `${CD}/plugins/rcp-fe-lol-static-assets/global/default/images/ranked-emblem/emblem-${t}.png`,
  (t: string) => `${CD}/plugins/rcp-fe-lol-shared-components/global/default/${t}.png`,
  (t: string) => `${CD}/plugins/rcp-fe-lol-static-assets/global/default/images/ranked-mini-crests/${t}.png`,
];

export interface ChampionInfo { id: string; key: number; name: string; image: string }
export interface StaticData {
  version: string;
  champions: Map<number, ChampionInfo>; // by numeric key (= participant.championId)
  championsById: Map<string, ChampionInfo>; // by id ("MonkeyKing")
  spells: Map<number, string>; // key -> image file ("SummonerFlash.png")
  perks: Map<number, string>; // perk or style id -> icon path
}

export interface AssetSource {
  staticData(gameVersion: string): Promise<StaticData | null>;
  /** PNG bytes or null. */
  image(url: string): Promise<Buffer | null>;
  championUrl(sd: StaticData, championId: number, championName: string): string;
  profileIconUrl(sd: StaticData, iconId: number): string;
  itemUrl(sd: StaticData, itemId: number): string;
  spellUrl(sd: StaticData, spellId: number): string | null;
  perkUrl(sd: StaticData, perkId: number): string | null;
  emblemUrl(tier: string): Promise<string | null>;
}

export class DDragon implements AssetSource {
  private versions: { list: string[]; at: number } | null = null;
  private data = new Map<string, Promise<StaticData | null>>();
  private mem = new Map<string, Buffer | null>();
  private emblems = new Map<string, Promise<string | null>>();

  constructor(
    private readonly cacheDir: string,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly log: (m: string) => void = () => {},
  ) {}

  private async getJson<T>(url: string, cacheFile: string | null): Promise<T | null> {
    const path = cacheFile ? join(this.cacheDir, cacheFile) : null;
    if (path) {
      try {
        return JSON.parse(await readFile(path, 'utf8')) as T;
      } catch { /* not cached */ }
    }
    try {
      const res = await this.fetchFn(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) return null;
      const text = await res.text();
      if (path) {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, text);
      }
      return JSON.parse(text) as T;
    } catch (e) {
      this.log(`ddragon: ${url} failed: ${(e as Error).message}`);
      return null;
    }
  }

  /** "16.22.735.1234" -> "16.22.1" if Data Dragon has it, else the newest version. */
  async resolveVersion(gameVersion: string): Promise<string | null> {
    if (!this.versions || Date.now() - this.versions.at > 6 * 3600_000) {
      const list = await this.getJson<string[]>(`${DD}/api/versions.json`, null);
      if (list?.length) this.versions = { list, at: Date.now() };
    }
    const [maj, min] = gameVersion.split('.');
    const list = this.versions?.list;
    if (!list) return `${maj}.${min}.1`; // offline: best guess, disk cache may still have it
    return list.find((v) => v.startsWith(`${maj}.${min}.`)) ?? list[0] ?? null;
  }

  staticData(gameVersion: string): Promise<StaticData | null> {
    const key = gameVersion.split('.').slice(0, 2).join('.');
    let p = this.data.get(key);
    if (!p) {
      p = this.loadStatic(gameVersion);
      this.data.set(key, p);
      p.then((r) => { if (!r) this.data.delete(key); }); // retry later if it failed
    }
    return p;
  }

  private async loadStatic(gameVersion: string): Promise<StaticData | null> {
    const v = await this.resolveVersion(gameVersion);
    if (!v) return null;
    type ChampJson = { data: Record<string, { id: string; key: string; name: string; image: { full: string } }> };
    type SpellJson = { data: Record<string, { key: string; image: { full: string } }> };
    type RuneJson = { id: number; icon: string; slots: { runes: { id: number; icon: string }[] }[] }[];
    const [champs, spells, runes] = await Promise.all([
      this.getJson<ChampJson>(`${DD}/cdn/${v}/data/en_US/champion.json`, `${v}/champion.json`),
      this.getJson<SpellJson>(`${DD}/cdn/${v}/data/en_US/summoner.json`, `${v}/summoner.json`),
      this.getJson<RuneJson>(`${DD}/cdn/${v}/data/en_US/runesReforged.json`, `${v}/runesReforged.json`),
    ]);
    if (!champs) return null;
    const sd: StaticData = { version: v, champions: new Map(), championsById: new Map(), spells: new Map(), perks: new Map() };
    for (const c of Object.values(champs.data)) {
      const info = { id: c.id, key: Number(c.key), name: c.name, image: c.image.full };
      sd.champions.set(info.key, info);
      sd.championsById.set(info.id, info);
    }
    for (const s of Object.values(spells?.data ?? {})) sd.spells.set(Number(s.key), s.image.full);
    for (const style of runes ?? []) {
      sd.perks.set(style.id, style.icon);
      for (const slot of style.slots) for (const r of slot.runes) sd.perks.set(r.id, r.icon);
    }
    return sd;
  }

  async image(url: string): Promise<Buffer | null> {
    if (this.mem.has(url)) return this.mem.get(url)!;
    const file = join(this.cacheDir, 'img', url.replace(/^https?:\/\//, '').replace(/[^\w./-]/g, '_'));
    let buf: Buffer | null = null;
    try {
      buf = await readFile(file);
    } catch {
      try {
        const res = await this.fetchFn(url, { signal: AbortSignal.timeout(8000) });
        if (res.ok) {
          buf = Buffer.from(await res.arrayBuffer());
          await mkdir(dirname(file), { recursive: true });
          await writeFile(file, buf);
        }
      } catch { /* offline */ }
    }
    if (this.mem.size > 2000) this.mem.clear();
    if (buf) this.mem.set(url, buf); // don't pin failures: a 404/offline result is retried next time
    return buf;
  }

  championUrl(sd: StaticData, championId: number, championName: string): string {
    const c = sd.champions.get(championId) ?? sd.championsById.get(championName);
    return `${DD}/cdn/${sd.version}/img/champion/${c?.image ?? `${championName}.png`}`;
  }
  profileIconUrl(sd: StaticData, iconId: number): string {
    return `${DD}/cdn/${sd.version}/img/profileicon/${iconId}.png`;
  }
  itemUrl(sd: StaticData, itemId: number): string {
    return `${DD}/cdn/${sd.version}/img/item/${itemId}.png`;
  }
  spellUrl(sd: StaticData, spellId: number): string | null {
    const f = sd.spells.get(spellId);
    return f ? `${DD}/cdn/${sd.version}/img/spell/${f}` : null;
  }
  perkUrl(sd: StaticData, perkId: number): string | null {
    const icon = sd.perks.get(perkId);
    return icon ? `${DD}/cdn/img/${icon}` : null;
  }

  /** First candidate URL that actually serves this tier's emblem (downloaded + disk-cached via image()). */
  emblemUrl(tier: string): Promise<string | null> {
    const t = tier.toLowerCase();
    let p = this.emblems.get(t);
    if (!p) {
      p = (async () => {
        for (const c of EMBLEM_CANDIDATES) {
          const url = c(t);
          if (await this.image(url)) return url;
        }
        this.log(`ddragon: no emblem found for ${t}`);
        return null;
      })();
      this.emblems.set(t, p);
      p.then((r) => { if (!r) this.emblems.delete(t); }); // retry later (maybe offline)
    }
    return p;
  }

}

/** Display name for a champion ("MonkeyKing" -> "Wukong"), falling back to the raw name. */
export function championName(sd: StaticData | null, championId: number, raw: string): string {
  return sd?.champions.get(championId)?.name ?? sd?.championsById.get(raw)?.name ?? raw;
}
