import type { AssetSource, StaticData } from '../../assets/ddragon.ts';
import { championName } from '../../assets/ddragon.ts';
import { formatTierDiv, type Rank } from '../../core/rank.ts';
import { C, createCanvas, decode, ensureFonts, fit, font, icon, rounded, trimTransparent, type Image, type SKRSContext2D } from './canvas.ts';

/**
 * Live game card: both teams with champion, spells, runes, Riot ID and Solo/Flex rank.
 * Layout (W=1120): champ | spells | keystone + runes | name/champion | Solo/Duo | Flex
 */

export interface LiveRank extends Rank {
  wins: number;
  losses: number;
}

export interface LivePlayer {
  puuid: string | null;
  /** Riot ID; null when Riot hides it (streamer mode) */
  gameName: string | null;
  tagLine: string | null;
  bot: boolean;
  championId: number;
  teamId: number;
  spells: [number, number];
  /** keystone, 3 primary, 2 secondary (shards ignored) */
  perkIds: number[];
  perkSubStyle: number;
  solo: LiveRank | null;
  flex: LiveRank | null;
  /** The account the command was about */
  focus: boolean;
  /** Linked / tracked / known to the bot */
  known: boolean;
}

export interface LiveData {
  queueLabel: string;
  /** Seconds in game; null while still loading in. */
  seconds: number | null;
  bans: { teamId: number; championId: number }[];
  players: LivePlayer[];
}

const W = 1120;
const PAD = 16;
const HEADER_H = 64;
const LABELS_H = 22;
const TEAM_H = 40;
const ROW_H = 60;
const GAP = 12;
const COL = { champ: 28, spells: 82, keystone: 112, runes: 150, name: 232, solo: 560, flex: 830 };

interface Icons {
  champ: Map<number, Image | null>;
  spell: Map<number, Image | null>;
  perk: Map<number, Image | null>;
  emblem: Map<string, Image | null>;
}

async function loadIcons(d: LiveData, assets: AssetSource, sd: StaticData | null): Promise<Icons> {
  const get = (url: string | null) => (url ? assets.image(url).then(decode).catch(() => null) : Promise.resolve(null));
  const icons: Icons = { champ: new Map(), spell: new Map(), perk: new Map(), emblem: new Map() };
  const champs = new Set([...d.players.map((p) => p.championId), ...d.bans.map((b) => b.championId)].filter((c) => c > 0));
  const spells = new Set(d.players.flatMap((p) => p.spells));
  const perks = new Set(d.players.flatMap((p) => [...p.perkIds.slice(0, 6), p.perkSubStyle]).filter((x) => x > 0));
  const tiers = new Set(d.players.flatMap((p) => [p.solo?.tier, p.flex?.tier]).filter((t): t is string => !!t));
  await Promise.all([
    ...[...champs].map(async (c) => icons.champ.set(c, sd ? await get(assets.championUrl(sd, c, sd.champions.get(c)?.id ?? '')) : null)),
    ...[...spells].map(async (s) => icons.spell.set(s, sd ? await get(assets.spellUrl(sd, s)) : null)),
    ...[...perks].map(async (p) => icons.perk.set(p, sd ? await get(assets.perkUrl(sd, p)) : null)),
    ...[...tiers].map(async (t) => {
      const img = await get(await assets.emblemUrl(t).catch(() => null));
      icons.emblem.set(t, img);
    }),
  ]);
  return icons;
}

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export async function renderLive(d: LiveData, assets: AssetSource): Promise<Buffer> {
  ensureFonts();
  const sd = await assets.staticData('');
  const icons = await loadIcons(d, assets, sd);
  const teams = [100, 200].map((t) => d.players.filter((p) => p.teamId === t)).filter((t) => t.length);
  const H = HEADER_H + LABELS_H + teams.reduce((n, t) => n + TEAM_H + t.length * ROW_H, 0) + GAP * (teams.length - 1) + PAD;

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, W, H);

  // header: ● LIVE  Ranked Solo/Duo · 12:34
  ctx.fillStyle = C.loss;
  ctx.fillRect(0, 0, 6, HEADER_H);
  ctx.beginPath();
  ctx.arc(PAD + 16, 33, 7, 0, Math.PI * 2);
  ctx.fill();
  ctx.font = font(700, 28);
  ctx.fillText('LIVE', PAD + 32, 43);
  const lw = ctx.measureText('LIVE').width;
  ctx.fillStyle = C.sub;
  ctx.font = font(400, 17);
  ctx.fillText(`${d.queueLabel}  ·  ${d.seconds === null ? 'Loading in' : `${mmss(d.seconds)} in game`}`, PAD + 48 + lw, 41);

  // column labels
  ctx.fillStyle = C.faint;
  ctx.font = font(600, 12);
  ctx.fillText('RUNES', COL.keystone, HEADER_H + 14);
  ctx.fillText('SOLO/DUO', COL.solo, HEADER_H + 14);
  ctx.fillText('FLEX', COL.flex, HEADER_H + 14);

  let y = HEADER_H + LABELS_H;
  teams.forEach((team, i) => {
    if (i) y += GAP;
    const teamId = team[0]!.teamId as 100 | 200;
    drawTeamHeader(ctx, y, teamId, d.bans.filter((b) => b.teamId === teamId), icons, sd);
    y += TEAM_H;
    for (const p of team) {
      drawRow(ctx, y, p, icons, sd);
      y += ROW_H;
    }
  });
  return canvas.encode('png');
}

function drawTeamHeader(ctx: SKRSContext2D, y: number, teamId: 100 | 200, bans: { championId: number }[], icons: Icons, sd: StaticData | null) {
  ctx.fillStyle = teamId === 100 ? C.blue : C.red;
  rounded(ctx, PAD, y, W - 2 * PAD, TEAM_H, 8);
  ctx.fill();
  ctx.fillStyle = teamId === 100 ? C.blueAccent : C.redAccent;
  ctx.font = font(700, 16);
  ctx.fillText(`${teamId === 100 ? 'BLUE' : 'RED'} TEAM`, PAD + 12, y + 26);

  const shown = bans.filter((b) => b.championId > 0);
  if (!shown.length) return;
  const size = 26;
  let x = W - PAD - 10 - shown.length * (size + 4);
  ctx.fillStyle = C.sub;
  ctx.font = font(600, 13);
  ctx.textAlign = 'right';
  ctx.fillText('Bans', x - 8, y + 25);
  ctx.textAlign = 'left';
  for (const b of shown) {
    const img = icons.champ.get(b.championId) ?? null;
    ctx.save();
    ctx.globalAlpha = 0.55; // banned: dimmed
    icon(ctx, img, x, y + 7, size, 5, championName(sd, b.championId, '?'));
    ctx.restore();
    x += size + 4;
  }
}

function drawRow(ctx: SKRSContext2D, y: number, p: LivePlayer, icons: Icons, sd: StaticData | null) {
  const mid = y + ROW_H / 2;
  if (p.focus || p.known) {
    ctx.fillStyle = p.focus ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.04)';
    ctx.fillRect(PAD, y + 2, W - 2 * PAD, ROW_H - 4);
    ctx.fillStyle = p.focus ? C.text : C.faint;
    ctx.fillRect(PAD, y + 2, 4, ROW_H - 4);
  }
  ctx.fillStyle = 'rgba(255,255,255,0.04)';
  ctx.fillRect(PAD + 8, y + ROW_H - 1, W - 2 * PAD - 16, 1);

  const cname = championName(sd, p.championId, '?');
  icon(ctx, icons.champ.get(p.championId) ?? null, COL.champ, mid - 22, 44, 8, cname);
  icon(ctx, icons.spell.get(p.spells[0]) ?? null, COL.spells, mid - 22, 21, 4);
  icon(ctx, icons.spell.get(p.spells[1]) ?? null, COL.spells, mid + 1, 21, 4);

  // runes: big keystone, then 3 primary runes on top and secondary tree + 2 runes below
  const [ks, p1, p2, p3, s1, s2] = p.perkIds;
  ctx.fillStyle = '#0d0e10';
  ctx.beginPath();
  ctx.arc(COL.keystone + 16, mid, 17, 0, Math.PI * 2);
  ctx.fill();
  if (ks) icon(ctx, icons.perk.get(ks) ?? null, COL.keystone + 1, mid - 15, 30, 15);
  const small = (id: number | undefined, x: number, yy: number) => {
    if (!id) return;
    ctx.fillStyle = '#0d0e10';
    ctx.beginPath();
    ctx.arc(x + 9, yy + 9, 10, 0, Math.PI * 2);
    ctx.fill();
    icon(ctx, icons.perk.get(id) ?? null, x, yy, 18, 9);
  };
  [p1, p2, p3].forEach((id, i) => small(id, COL.runes + i * 22, mid - 21));
  [p.perkSubStyle, s1, s2].forEach((id, i) => small(id, COL.runes + i * 22, mid + 3));

  // name + champion
  const hidden = !p.gameName;
  const name = p.bot ? `${cname} Bot` : hidden ? 'Hidden player' : p.gameName!;
  ctx.font = font(p.focus ? 700 : 600, 17);
  ctx.fillStyle = hidden ? C.sub : p.focus ? '#ffffff' : C.text;
  const shown = fit(ctx, name, 290);
  ctx.fillText(shown, COL.name, mid - 3);
  if (p.tagLine && !p.bot) {
    const nw = ctx.measureText(shown).width;
    ctx.font = font(400, 14);
    ctx.fillStyle = C.faint;
    ctx.fillText(fit(ctx, `#${p.tagLine}`, Math.max(0, 300 - nw)), COL.name + nw + 4, mid - 3);
  }
  ctx.font = font(400, 14);
  ctx.fillStyle = C.sub;
  ctx.fillText(cname, COL.name, mid + 17);

  drawRank(ctx, COL.solo, mid, p.solo, icons, p.bot || hidden);
  drawRank(ctx, COL.flex, mid, p.flex, icons, p.bot || hidden);
}

function drawRank(ctx: SKRSContext2D, x: number, mid: number, r: LiveRank | null, icons: Icons, unknown: boolean) {
  if (!r) {
    ctx.font = font(600, 15);
    ctx.fillStyle = C.faint;
    ctx.fillText(unknown ? '—' : 'Unranked', x, mid + 5);
    return;
  }
  const em = icons.emblem.get(r.tier);
  const es = 42;
  if (em) {
    const t = trimTransparent(em);
    const s = Math.min(es / t.width, es / t.height);
    ctx.drawImage(t, x + (es - t.width * s) / 2, mid - (t.height * s) / 2, t.width * s, t.height * s);
  }
  const tx = x + es + 10;
  ctx.font = font(700, 15);
  ctx.fillStyle = C.text;
  const tier = formatTierDiv(r);
  ctx.fillText(tier, tx, mid - 3);
  const tw = ctx.measureText(tier).width;
  ctx.font = font(400, 14);
  ctx.fillStyle = C.sub;
  ctx.fillText(` · ${r.lp} LP`, tx + tw, mid - 3);
  const games = r.wins + r.losses;
  const wr = games ? Math.round((r.wins / games) * 100) : 0;
  ctx.font = font(400, 13);
  ctx.fillStyle = wr >= 55 ? C.win : wr < 45 && games >= 10 ? C.loss : C.faint;
  ctx.fillText(`${wr}% WR`, tx, mid + 16);
  const ww = ctx.measureText(`${wr}% WR`).width;
  ctx.fillStyle = C.faint;
  ctx.fillText(` · ${r.wins}W ${r.losses}L`, tx + ww, mid + 16);
}
