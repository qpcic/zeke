import type { AssetSource, StaticData } from '../../assets/ddragon.ts';
import { C, createCanvas, decode, ensureFonts, fit, font, icon, rounded } from './canvas.ts';

/** /champ card: one player's games on one champion within their last 50 ranked games. */

export interface ChampGame {
  win: boolean;
  kills: number;
  deaths: number;
  assists: number;
  cs: number;
  csPerMin: number;
  damage: number;
  role: string;
  endedAt: number;
  queue: string;
  lpDelta: number | null;
}

export interface ChampCard {
  player: string;
  tag: string;
  championId: number;
  championKey: string; // DDragon id, e.g. "MonkeyKing"
  championName: string;
  sampleSize: number; // ranked games looked at
  games: ChampGame[]; // newest first
  totals: { kda: number; k: number; d: number; a: number; csPerMin: number; dmgPerMin: number; kp: number | null; visionPerMin: number; lp: number | null; lpGames: number };
  mainRole: string | null;
  multikills: { penta: number; quadra: number; triple: number };
}

const W = 1040;
const PAD = 20;
const ROLE: Record<string, string> = { TOP: 'Top', JUNGLE: 'Jungle', MIDDLE: 'Mid', BOTTOM: 'Bot', UTILITY: 'Support' };
export const roleLabel = (r: string) => ROLE[r] ?? (r ? r.charAt(0) + r.slice(1).toLowerCase() : '—');

const ago = (ms: number, now: number) => {
  const h = Math.floor((now - ms) / 3_600_000);
  if (h < 1) return 'just now';
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return d < 30 ? `${d}d ago` : `${Math.floor(d / 30)}mo ago`;
};

export async function renderChamp(c: ChampCard, assets: AssetSource | null, sd: StaticData | null, now = Date.now()): Promise<Buffer> {
  ensureFonts();
  const champImg = assets && sd ? await decode(await assets.image(assets.championUrl(sd, c.championId, c.championKey))).catch(() => null) : null;
  const list = c.games.slice(0, 8);
  const HEAD_H = 120, TILES_H = 104, STRIP_H = 44, ROW_H = 46, FOOT_H = 36;
  const H = HEAD_H + TILES_H + STRIP_H + 26 + list.length * ROW_H + FOOT_H;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, W, H);

  const wins = c.games.filter((g) => g.win).length;
  const losses = c.games.length - wins;
  const wr = Math.round((wins / c.games.length) * 100);

  // header
  const grad = ctx.createLinearGradient(0, 0, W, 0);
  grad.addColorStop(0, 'rgba(88,101,242,0.25)');
  grad.addColorStop(1, 'rgba(88,101,242,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, 104);
  icon(ctx, champImg, PAD + 8, 18, 72, 14, c.championName);
  ctx.fillStyle = C.text;
  ctx.font = font(700, 32);
  ctx.fillText(fit(ctx, c.championName, 520), PAD + 96, 54);
  ctx.fillStyle = C.sub;
  ctx.font = font(400, 16);
  ctx.fillText(
    fit(ctx, `${c.player}#${c.tag} · ${c.games.length} of the last ${c.sampleSize} ranked games${c.mainRole ? ` · mostly ${roleLabel(c.mainRole)}` : ''}`, 600),
    PAD + 96, 82,
  );
  ctx.textAlign = 'right';
  ctx.font = font(700, 32);
  ctx.fillStyle = wr >= 55 ? C.win : wr < 45 ? C.loss : C.text;
  ctx.fillText(`${wins}W ${losses}L`, W - PAD - 8, 54);
  ctx.fillStyle = C.sub;
  ctx.font = font(400, 16);
  ctx.fillText(`${wr}% win rate`, W - PAD - 8, 82);
  ctx.textAlign = 'left';

  // stat tiles
  const t = c.totals;
  const tiles: [string, string, string][] = [
    ['KDA', t.d ? t.kda.toFixed(2) : 'Perfect', `${t.k.toFixed(1)} / ${t.d.toFixed(1)} / ${t.a.toFixed(1)}`],
    ['CS / MIN', t.csPerMin.toFixed(1), 'minions + monsters'],
    ['DAMAGE / MIN', Math.round(t.dmgPerMin).toLocaleString('en-US'), 'to champions'],
    ['KILL PART.', t.kp === null ? '—' : `${Math.round(t.kp * 100)}%`, 'of team kills'],
    ['VISION / MIN', t.visionPerMin.toFixed(2), 'vision score'],
    ['LP', t.lp === null ? '—' : `${t.lp > 0 ? '+' : ''}${t.lp}`, t.lp === null ? 'not tracked yet' : `over ${t.lpGames} tracked game${t.lpGames === 1 ? '' : 's'}`],
  ];
  const tw = (W - 2 * PAD - 5 * 12) / 6;
  tiles.forEach(([label, value, sub], i) => {
    const x = PAD + i * (tw + 12);
    const y = HEAD_H;
    ctx.fillStyle = C.panel;
    rounded(ctx, x, y, tw, TILES_H - 16, 10);
    ctx.fill();
    ctx.fillStyle = C.faint;
    ctx.font = font(600, 12);
    ctx.fillText(label, x + 14, y + 22);
    ctx.fillStyle = label === 'LP' && t.lp !== null ? (t.lp > 0 ? C.win : t.lp < 0 ? C.loss : C.text) : C.text;
    ctx.font = font(700, 24);
    ctx.fillText(fit(ctx, value, tw - 24), x + 14, y + 52);
    ctx.fillStyle = C.sub;
    ctx.font = font(400, 12);
    ctx.fillText(fit(ctx, sub, tw - 24), x + 14, y + 72);
  });

  // results strip (oldest -> newest)
  let y = HEAD_H + TILES_H;
  ctx.fillStyle = C.faint;
  ctx.font = font(600, 12);
  ctx.fillText('RESULTS', PAD + 8, y + 22);
  const strip = [...c.games].reverse().slice(-40);
  strip.forEach((g, i) => {
    ctx.fillStyle = g.win ? C.win : C.loss;
    rounded(ctx, PAD + 90 + i * 20, y + 8, 16, 18, 3);
    ctx.fill();
  });
  const multi = [c.multikills.penta && `${c.multikills.penta} penta`, c.multikills.quadra && `${c.multikills.quadra} quadra`, c.multikills.triple && `${c.multikills.triple} triple`].filter(Boolean).join(' · ');
  if (multi) {
    ctx.textAlign = 'right';
    ctx.fillStyle = '#f5c542';
    ctx.font = font(600, 13);
    ctx.fillText(multi, W - PAD - 8, y + 22);
    ctx.textAlign = 'left';
  }

  // recent games
  y += STRIP_H;
  ctx.fillStyle = C.faint;
  ctx.font = font(600, 12);
  ctx.fillText('RECENT GAMES', PAD + 8, y + 12);
  y += 22;
  list.forEach((g, i) => {
    const ry = y + i * ROW_H;
    const mid = ry + ROW_H / 2;
    ctx.fillStyle = i % 2 === 0 ? C.panel : '#1a1b1f';
    rounded(ctx, PAD, ry + 3, W - 2 * PAD, ROW_H - 6, 8);
    ctx.fill();
    ctx.fillStyle = g.win ? C.win : C.loss;
    ctx.fillRect(PAD, ry + 3, 4, ROW_H - 6);
    ctx.font = font(700, 15);
    ctx.fillText(g.win ? 'Victory' : 'Defeat', PAD + 16, mid + 5);
    ctx.fillStyle = C.text;
    ctx.font = font(700, 16);
    ctx.fillText(`${g.kills} / ${g.deaths} / ${g.assists}`, PAD + 110, mid + 5);
    ctx.fillStyle = C.sub;
    ctx.font = font(400, 14);
    ctx.fillText(`${g.cs} CS (${g.csPerMin.toFixed(1)})`, PAD + 250, mid + 5);
    ctx.fillText(`${g.damage.toLocaleString('en-US')} dmg`, PAD + 410, mid + 5);
    ctx.fillText(`${roleLabel(g.role)} · ${g.queue}`, PAD + 540, mid + 5);
    ctx.fillText(ago(g.endedAt, now), PAD + 730, mid + 5);
    if (g.lpDelta !== null) {
      ctx.textAlign = 'right';
      ctx.fillStyle = g.lpDelta > 0 ? C.win : g.lpDelta < 0 ? C.loss : C.sub;
      ctx.font = font(700, 16);
      ctx.fillText(`${g.lpDelta > 0 ? '+' : ''}${g.lpDelta} LP`, W - PAD - 14, mid + 5);
      ctx.textAlign = 'left';
    }
  });

  ctx.fillStyle = C.faint;
  ctx.font = font(400, 13);
  ctx.fillText('Ranked Solo/Duo, Flex and 5s · remakes not counted · LP only for games Zeke recorded', PAD + 8, H - 12);
  return canvas.toBuffer('image/png');
}
