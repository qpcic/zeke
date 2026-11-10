import type { AssetSource, StaticData } from '../../assets/ddragon.ts';
import { championName } from '../../assets/ddragon.ts';
import { performances } from '../../core/performance.ts';
import type { MatchDto, ParticipantDto, TeamDto } from '../../riot/types.ts';
import { QUEUE_LABEL } from '../../riot/types.ts';
import { fmtDuration, fmtK } from '../format.ts';
import { C, createCanvas, decode, ensureFonts, fit, font, icon, pill, rounded, type Image, type SKRSContext2D } from './canvas.ts';

/**
 * 10-player scoreboard PNG.
 * Layout (W=1120): champ+lvl | spells | runes | name/role | KDA | damage bar | CS | gold | vision | items(6+trinket)
 */

const W = 1120;
const PAD = 16;
const HEADER_H = 64;
const LABELS_H = 22;
const TEAM_H = 40;
const ROW_H = 58;
const GAP = 12;

const COL = { champ: 28, spells: 82, runes: 108, name: 140, kda: 380, dmg: 500, cs: 660, gold: 740, vision: 812, items: 862 };

const ROLE: Record<string, string> = { TOP: 'Top', JUNGLE: 'Jungle', MIDDLE: 'Mid', BOTTOM: 'Bot', UTILITY: 'Support' };

export interface ScoreboardOptions {
  /** Player whose perspective this is (highlighted strongest). */
  focus: string;
  /** Other tracked/linked players to mark. */
  alsoTracked?: Set<string>;
}

interface Icons {
  champ: Map<string, Image | null>;
  spells: Map<string, (Image | null)[]>;
  runes: Map<string, (Image | null)[]>;
  items: Map<string, (Image | null)[]>;
}

async function loadIcons(m: MatchDto, assets: AssetSource, sd: StaticData | null): Promise<Icons> {
  const get = (url: string | null) => (url ? assets.image(url).then(decode) : Promise.resolve(null));
  const icons: Icons = { champ: new Map(), spells: new Map(), runes: new Map(), items: new Map() };
  await Promise.all(m.info.participants.map(async (p) => {
    const items = [p.item0, p.item1, p.item2, p.item3, p.item4, p.item5, p.item6];
    const [champ, s1, s2, keystone, sub, ...its] = await Promise.all([
      sd ? get(assets.championUrl(sd, p.championId, p.championName)) : null,
      sd ? get(assets.spellUrl(sd, p.summoner1Id)) : null,
      sd ? get(assets.spellUrl(sd, p.summoner2Id)) : null,
      sd && p.perks ? get(assets.perkUrl(sd, p.perks.styles[0]?.selections[0]?.perk ?? 0)) : null,
      sd && p.perks ? get(assets.perkUrl(sd, p.perks.styles[1]?.style ?? 0)) : null,
      ...items.map((id) => (sd && id ? get(assets.itemUrl(sd, id)) : Promise.resolve(null))),
    ]);
    icons.champ.set(p.puuid, champ ?? null);
    icons.spells.set(p.puuid, [s1 ?? null, s2 ?? null]);
    icons.runes.set(p.puuid, [keystone ?? null, sub ?? null]);
    icons.items.set(p.puuid, its.map((x) => x ?? null));
  }));
  return icons;
}

function objectivesText(t: TeamDto | undefined): string {
  const o = t?.objectives;
  if (!o) return '';
  const parts = [
    ['Towers', o.tower?.kills], ['Drakes', o.dragon?.kills], ['Grubs', o.horde?.kills],
    ['Herald', o.riftHerald?.kills], ['Atakhan', o.atakhan?.kills], ['Baron', o.baron?.kills],
  ].filter(([, n]) => n !== undefined && (n as number) > 0) as [string, number][];
  return parts.map(([k, n]) => `${k} ${n}`).join('   ');
}

export async function renderScoreboard(m: MatchDto, assets: AssetSource, opts: ScoreboardOptions): Promise<Buffer> {
  ensureFonts();
  const sd = await assets.staticData(m.info.gameVersion);
  const icons = await loadIcons(m, assets, sd);
  const perf = performances(m);

  const H = HEADER_H + LABELS_H + 2 * (TEAM_H + 5 * ROW_H) + GAP + PAD;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, W, H);

  const me = m.info.participants.find((p) => p.puuid === opts.focus);
  const remake = !!me?.gameEndedInEarlySurrender;
  const result = remake ? 'REMAKE' : me?.win ? 'VICTORY' : 'DEFEAT';
  const resultColor = remake ? C.remake : me?.win ? C.win : C.loss;

  // header
  ctx.fillStyle = resultColor;
  ctx.fillRect(0, 0, 6, HEADER_H);
  ctx.font = font(700, 28);
  ctx.fillText(result, PAD + 8, 42);
  const rw = ctx.measureText(result).width;
  ctx.fillStyle = C.sub;
  ctx.font = font(400, 17);
  const patch = m.info.gameVersion.split('.').slice(0, 2).join('.');
  ctx.fillText(`${QUEUE_LABEL[m.info.queueId] ?? `Queue ${m.info.queueId}`}  ·  ${fmtDuration(m.info.gameDuration)}  ·  Patch ${patch}`, PAD + 24 + rw, 41);

  const kills = (team: number) => m.info.participants.filter((p) => p.teamId === team).reduce((n, p) => n + p.kills, 0);
  ctx.textAlign = 'right';
  ctx.font = font(700, 26);
  const k1 = String(kills(100)), k2 = String(kills(200));
  ctx.fillStyle = C.redAccent;
  ctx.fillText(k2, W - PAD - 4, 42);
  const w2 = ctx.measureText(k2).width;
  ctx.fillStyle = C.faint;
  ctx.fillText(':', W - PAD - 12 - w2, 41);
  ctx.fillStyle = C.blueAccent;
  ctx.fillText(k1, W - PAD - 24 - w2, 42);
  ctx.textAlign = 'left';

  // column labels, once
  ctx.fillStyle = C.faint;
  ctx.font = font(600, 12);
  ctx.textAlign = 'center';
  const ly = HEADER_H + 14;
  for (const [s, cx] of [['KDA', COL.kda + 50], ['DAMAGE', COL.dmg + 64], ['CS', COL.cs + 34], ['GOLD', COL.gold + 30], ['VISION', COL.vision + 22], ['ITEMS', COL.items + 122]] as const) ctx.fillText(s, cx, ly);
  ctx.textAlign = 'left';

  const maxDmg = Math.max(...m.info.participants.map((p) => p.totalDamageDealtToChampions), 1);
  let y = HEADER_H + LABELS_H;
  for (const teamId of [100, 200] as const) {
    if (teamId === 200) y += GAP;
    const team = m.info.participants.filter((p) => p.teamId === teamId);
    const tdto = m.info.teams.find((t) => t.teamId === teamId);
    drawTeamHeader(ctx, y, teamId, tdto, team, remake);
    y += TEAM_H;
    for (const p of team) {
      drawRow(ctx, y, p, {
        icons, sd, maxDmg, teamKills: team.reduce((n, x) => n + x.kills, 0), minutes: m.info.gameDuration / 60,
        focus: p.puuid === opts.focus, tracked: !!opts.alsoTracked?.has(p.puuid), perf: perf.get(p.puuid)!, remake,
      });
      y += ROW_H;
    }
  }
  return canvas.encode('png');
}

function drawTeamHeader(ctx: SKRSContext2D, y: number, teamId: 100 | 200, t: TeamDto | undefined, team: ParticipantDto[], remake: boolean) {
  ctx.fillStyle = teamId === 100 ? C.blue : C.red;
  rounded(ctx, PAD, y, W - 2 * PAD, TEAM_H, 8);
  ctx.fill();
  const accent = teamId === 100 ? C.blueAccent : C.redAccent;
  ctx.fillStyle = accent;
  ctx.font = font(700, 16);
  const label = `${teamId === 100 ? 'BLUE' : 'RED'} TEAM`;
  ctx.fillText(label, PAD + 12, y + 26);
  let x = PAD + 12 + ctx.measureText(label).width + 10;
  if (!remake) {
    ctx.fillStyle = t?.win ? C.win : C.loss;
    ctx.font = font(600, 14);
    const res = t?.win ? 'Victory' : 'Defeat';
    ctx.fillText(res, x, y + 26);
    x += ctx.measureText(res).width + 16;
  }
  ctx.fillStyle = C.sub;
  ctx.font = font(400, 14);
  const gold = team.reduce((n, p) => n + p.goldEarned, 0);
  ctx.fillText(`${fmtK(gold)} gold`, x, y + 26);
  ctx.textAlign = 'right';
  ctx.fillText(objectivesText(t), W - PAD - 12, y + 26);
  ctx.textAlign = 'left';

}

function drawRow(
  ctx: SKRSContext2D,
  y: number,
  p: ParticipantDto,
  o: {
    icons: Icons; sd: StaticData | null; maxDmg: number; teamKills: number; minutes: number;
    focus: boolean; tracked: boolean; perf: { score: number; rank: number; badge: 'MVP' | 'ACE' | null }; remake: boolean;
  },
) {
  const mid = y + ROW_H / 2;
  if (o.focus || o.tracked) {
    ctx.fillStyle = o.focus ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.04)';
    ctx.fillRect(PAD, y + 2, W - 2 * PAD, ROW_H - 4);
    ctx.fillStyle = o.focus ? (p.win ? C.win : o.remake ? C.remake : C.loss) : C.faint;
    ctx.fillRect(PAD, y + 2, 4, ROW_H - 4);
  }
  // separator
  ctx.fillStyle = 'rgba(255,255,255,0.04)';
  ctx.fillRect(PAD + 8, y + ROW_H - 1, W - 2 * PAD - 16, 1);

  // champion + level
  const cname = championName(o.sd, p.championId, p.championName);
  icon(ctx, o.icons.champ.get(p.puuid) ?? null, COL.champ, mid - 22, 44, 8, cname);
  ctx.fillStyle = '#0d0e10';
  rounded(ctx, COL.champ + 26, mid + 8, 22, 16, 5);
  ctx.fill();
  ctx.fillStyle = C.text;
  ctx.font = font(600, 11);
  ctx.textAlign = 'center';
  ctx.fillText(String(p.champLevel), COL.champ + 37, mid + 20);
  ctx.textAlign = 'left';

  // spells / runes
  const [s1, s2] = o.icons.spells.get(p.puuid) ?? [];
  icon(ctx, s1 ?? null, COL.spells, mid - 22, 21, 4);
  icon(ctx, s2 ?? null, COL.spells, mid + 1, 21, 4);
  const [ks, sub] = o.icons.runes.get(p.puuid) ?? [];
  ctx.fillStyle = '#0d0e10';
  ctx.beginPath(); ctx.arc(COL.runes + 11, mid - 11, 11, 0, Math.PI * 2); ctx.fill();
  icon(ctx, ks ?? null, COL.runes, mid - 22, 22, 11);
  icon(ctx, sub ?? null, COL.runes + 3, mid + 3, 16, 8);

  // name + role/champ
  const name = p.riotIdGameName || p.summonerName || '?';
  ctx.fillStyle = o.focus ? '#ffffff' : C.text;
  ctx.font = font(o.focus ? 700 : 600, 17);
  const maxName = 200 - (o.perf.badge ? 46 : 0);
  const shown = fit(ctx, name, maxName);
  ctx.fillText(shown, COL.name, mid - 3);
  if (o.perf.badge && !o.remake) {
    pill(ctx, o.perf.badge, COL.name + ctx.measureText(shown).width + 8, mid - 18, o.perf.badge === 'MVP' ? C.gold : C.purple);
  }
  ctx.fillStyle = C.sub;
  ctx.font = font(400, 13);
  ctx.fillText(fit(ctx, `${cname}${ROLE[p.teamPosition] ? ` · ${ROLE[p.teamPosition]}` : ''}`, 220), COL.name, mid + 16);

  // KDA
  ctx.textAlign = 'center';
  ctx.font = font(600, 17);
  const kx = COL.kda + 50;
  const parts = [String(p.kills), '/', String(p.deaths), '/', String(p.assists)];
  const colors = [C.text, C.faint, C.loss, C.faint, C.text];
  const widths = parts.map((s) => ctx.measureText(s).width + (s === '/' ? 6 : 0));
  let x = kx - widths.reduce((a, b) => a + b, 0) / 2;
  ctx.textAlign = 'left';
  parts.forEach((s, i) => {
    ctx.fillStyle = colors[i]!;
    ctx.fillText(s, x + (s === '/' ? 3 : 0), mid - 3);
    x += widths[i]!;
  });
  ctx.textAlign = 'center';
  const ratio = p.deaths === 0 ? 'Perfect' : ((p.kills + p.assists) / p.deaths).toFixed(2);
  const kp = o.teamKills ? Math.min(100, Math.round(((p.kills + p.assists) / o.teamKills) * 100)) : 0;
  const r = p.deaths === 0 ? 99 : (p.kills + p.assists) / p.deaths;
  ctx.fillStyle = r >= 5 ? C.gold : r >= 3 ? '#7ec8ff' : C.sub;
  ctx.font = font(400, 13);
  ctx.fillText(`${ratio} KDA · ${kp}%`, kx, mid + 16);

  // damage bar
  const bw = 128;
  const frac = p.totalDamageDealtToChampions / o.maxDmg;
  ctx.fillStyle = C.text;
  ctx.font = font(600, 15);
  ctx.fillText(p.totalDamageDealtToChampions.toLocaleString('en-US'), COL.dmg + bw / 2, mid - 4);
  ctx.fillStyle = '#2b2e35';
  rounded(ctx, COL.dmg, mid + 6, bw, 8, 4); ctx.fill();
  ctx.fillStyle = p.teamId === 100 ? C.blueAccent : C.redAccent;
  rounded(ctx, COL.dmg, mid + 6, Math.max(6, bw * frac), 8, 4); ctx.fill();

  // CS
  const cs = p.totalMinionsKilled + p.neutralMinionsKilled;
  ctx.fillStyle = C.text;
  ctx.font = font(600, 16);
  ctx.fillText(String(cs), COL.cs + 34, mid - 3);
  ctx.fillStyle = C.sub;
  ctx.font = font(400, 13);
  ctx.fillText(`${(cs / o.minutes).toFixed(1)}/m`, COL.cs + 34, mid + 16);

  // gold / vision
  ctx.fillStyle = C.text;
  ctx.font = font(600, 16);
  ctx.fillText(fmtK(p.goldEarned), COL.gold + 30, mid + 6);
  ctx.fillText(String(p.visionScore), COL.vision + 22, mid + 6);
  ctx.textAlign = 'left';

  // items (6 + trinket)
  const its = o.icons.items.get(p.puuid) ?? [];
  const ids = [p.item0, p.item1, p.item2, p.item3, p.item4, p.item5, p.item6];
  for (let i = 0; i < 7; i++) {
    const ix = COL.items + i * 34 + (i === 6 ? 6 : 0);
    if (ids[i]) icon(ctx, its[i] ?? null, ix, mid - 16, 32, i === 6 ? 16 : 6, '');
    else {
      ctx.fillStyle = '#23252b';
      rounded(ctx, ix, mid - 16, 32, 32, i === 6 ? 16 : 6);
      ctx.fill();
    }
  }
}
