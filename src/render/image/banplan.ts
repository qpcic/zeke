import type { AssetSource, StaticData } from '../../assets/ddragon.ts';
import { championName } from '../../assets/ddragon.ts';
import { FIVES_WEIGHT, MIN_BAN_GAMES, winrate, type ChampStat, type MemberReport, type Role, type ScoutReport } from '../../core/scout.ts';
import { C, createCanvas, decode, ensureFonts, fit, font, icon, rounded, type Image, type SKRSContext2D } from './canvas.ts';

/** Scout PNG: 5 role columns (player, most played, ban picks) + team priority bans. */

const W = 1240;
const PAD = 20;
const HEAD_H = 100;
const COL_GAP = 12;
const CARD_H = 430;
const PRIO_H = 150;
const COL_W = (W - 2 * PAD - 4 * COL_GAP) / 5;

const ROLE_LABEL: Record<Role, string> = { TOP: 'TOP', JUNGLE: 'JUNGLE', MIDDLE: 'MID', BOTTOM: 'BOT', UTILITY: 'SUPPORT' };
const ROLE_COLOR: Record<Role, string> = { TOP: '#e0a458', JUNGLE: '#58c27d', MIDDLE: '#6aa8ff', BOTTOM: '#f26d6d', UTILITY: '#c38bff' };

const wrColor = (wr: number) => (wr >= 0.6 ? C.win : wr >= 0.5 ? '#9be3a8' : wr >= 0.4 ? C.sub : C.loss);
const pct = (c: { wins: number; games: number; wGames?: number; wWins?: number }) => Math.round(winrate(c) * 100);

export async function renderBanPlan(r: ScoutReport, assets: AssetSource | null): Promise<Buffer> {
  ensureFonts();
  const anyVersion = r.members.flatMap((m) => m.mostPlayed)[0]?.version ?? '99.99';
  const sd: StaticData | null = assets ? await assets.staticData(anyVersion).catch(() => null) : null;
  const cache = new Map<string, Image | null>();
  const load = async (c: ChampStat) => {
    const k = c.championName;
    if (!cache.has(k)) cache.set(k, assets && sd ? await decode(await assets.image(assets.championUrl(sd, c.championId, c.championName))) : null);
    return cache.get(k)!;
  };
  await Promise.all([...r.members.flatMap((m) => [...m.mostPlayed.slice(0, 5), ...m.bans]), ...r.priorityBans].map(load));

  const H = HEAD_H + CARD_H + PRIO_H + 40;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, W, H);

  // ---- header ----
  const g = ctx.createLinearGradient(0, 0, W, 0);
  g.addColorStop(0, 'rgba(248,81,73,0.25)');
  g.addColorStop(1, 'rgba(248,81,73,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, 84);
  ctx.fillStyle = C.text;
  ctx.font = font(700, 30);
  ctx.fillText('Scout', PAD + 8, 44);
  const tw = ctx.measureText('Scout').width;
  ctx.fillStyle = C.sub;
  ctx.font = font(600, 20);
  ctx.fillText(fit(ctx, `vs ${r.target.name}#${r.target.tag}'s team`, 600), PAD + 20 + tw, 44);
  ctx.font = font(400, 15);
  const qs = [r.queues.flex ? `${r.queues.flex} Flex` : '', r.queues.fives ? `${r.queues.fives} Ranked 5s` : ''].filter(Boolean).join(' + ') || 'no';
  const weighting = r.queues.fives && r.queues.flex ? ` · Ranked 5s weighted ${Math.round(FIVES_WEIGHT * 100)}%` : '';
  ctx.fillText(`Based on their last ${r.sample} team games (${qs})${weighting} · full five-stack in ${Math.round(r.premadeShare * 100)}% of them`, PAD + 8, 72);

  // ---- role columns ----
  const byRole = new Map(r.members.filter((m) => m.role).map((m) => [m.role!, m]));
  (['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'] as Role[]).forEach((role, i) => {
    const x = PAD + i * (COL_W + COL_GAP);
    drawColumn(ctx, x, HEAD_H, role, byRole.get(role) ?? null, cache, sd);
  });

  // ---- priority bans ----
  const py = HEAD_H + CARD_H + 16;
  ctx.fillStyle = C.panel;
  rounded(ctx, PAD, py, W - 2 * PAD, PRIO_H, 12);
  ctx.fill();
  ctx.fillStyle = C.loss;
  ctx.font = font(700, 16);
  ctx.fillText('PRIORITY BANS', PAD + 18, py + 30);
  ctx.fillStyle = C.faint;
  ctx.font = font(400, 13);
  ctx.fillText('most played × winrate across the team', PAD + 160, py + 30);
  const slotW = (W - 2 * PAD - 36) / 5;
  r.priorityBans.forEach((b, i) => {
    const sx = PAD + 18 + i * slotW;
    const img = cache.get(b.championName) ?? null;
    const name = championName(sd, b.championId, b.championName);
    icon(ctx, img, sx, py + 46, 72, 12, name);
    // red slash = banned
    ctx.strokeStyle = 'rgba(248,81,73,0.9)';
    ctx.lineWidth = 4;
    ctx.beginPath(); ctx.moveTo(sx + 6, py + 46 + 66); ctx.lineTo(sx + 66, py + 46 + 6); ctx.stroke();
    ctx.fillStyle = C.text;
    ctx.font = font(700, 18);
    ctx.fillText(fit(ctx, name, slotW - 90), sx + 84, py + 70);
    ctx.fillStyle = wrColor(winrate(b));
    ctx.font = font(600, 15);
    ctx.fillText(`${pct(b)}% · ${b.games} games`, sx + 84, py + 92);
    ctx.fillStyle = C.sub;
    ctx.font = font(400, 13);
    ctx.fillText(fit(ctx, b.owner, slotW - 90), sx + 84, py + 112);
  });
  if (!r.priorityBans.length) {
    ctx.fillStyle = C.sub;
    ctx.font = font(600, 16);
    ctx.fillText(`No champion with ${MIN_BAN_GAMES}+ games yet, so no bans to suggest.`, PAD + 18, py + 90);
  }

  ctx.fillStyle = C.faint;
  ctx.font = font(400, 12);
  ctx.fillText(`Roles: best fit of each player's positions in these games. Bans: top 3 winrates among each player's 10 most played (min. ${MIN_BAN_GAMES} games). Winrates are weighted toward Ranked 5s.`, PAD + 8, H - 14);
  return canvas.toBuffer('image/png');
}

function drawColumn(ctx: SKRSContext2D, x: number, y: number, role: Role, m: MemberReport | null, cache: Map<string, Image | null>, sd: StaticData | null) {
  ctx.fillStyle = C.panel;
  rounded(ctx, x, y, COL_W, CARD_H, 12);
  ctx.fill();
  ctx.fillStyle = ROLE_COLOR[role];
  rounded(ctx, x, y, COL_W, 5, 2);
  ctx.fill();

  ctx.fillStyle = ROLE_COLOR[role];
  ctx.font = font(700, 14);
  ctx.fillText(ROLE_LABEL[role], x + 14, y + 28);

  if (!m) {
    ctx.fillStyle = C.faint;
    ctx.font = font(600, 15);
    ctx.fillText('No regular player found', x + 14, y + 60);
    return;
  }
  if (m.isTarget) {
    ctx.fillStyle = C.faint;
    ctx.font = font(600, 11);
    ctx.textAlign = 'right';
    ctx.fillText('SCOUTED', x + COL_W - 14, y + 28);
    ctx.textAlign = 'left';
  }
  ctx.fillStyle = C.text;
  ctx.font = font(700, 18);
  ctx.fillText(fit(ctx, m.name, COL_W - 28), x + 14, y + 54);
  ctx.fillStyle = C.faint;
  ctx.font = font(400, 13);
  ctx.fillText(fit(ctx, `#${m.tag}`, COL_W - 28), x + 14, y + 72);
  ctx.fillStyle = wrColor(m.games ? m.wins / m.games : 0);
  ctx.font = font(600, 13);
  ctx.fillText(`${m.wins}W ${m.games - m.wins}L · ${pct(m)}%`, x + 14, y + 94);
  ctx.fillStyle = C.sub;
  ctx.font = font(400, 12);
  ctx.fillText(`${Math.round(m.roleShare * 100)}% of games in this role`, x + 14, y + 112);

  // most played (top 5)
  ctx.fillStyle = C.faint;
  ctx.font = font(600, 11);
  ctx.fillText('MOST PLAYED', x + 14, y + 140);
  const small = Math.min(36, (COL_W - 28 - 4 * 6) / 5);
  m.mostPlayed.slice(0, 5).forEach((c, i) => {
    const ix = x + 14 + i * (small + 6);
    icon(ctx, cache.get(c.championName) ?? null, ix, y + 150, small, 7, championName(sd, c.championId, c.championName));
    ctx.fillStyle = C.sub;
    ctx.font = font(600, 11);
    ctx.textAlign = 'center';
    ctx.fillText(String(c.games), ix + small / 2, y + 150 + small + 14);
    ctx.textAlign = 'left';
  });

  // bans
  ctx.fillStyle = C.loss;
  ctx.font = font(700, 13);
  ctx.fillText('BAN', x + 14, y + 236);
  m.bans.forEach((b, i) => {
    const by = y + 248 + i * 58;
    ctx.fillStyle = 'rgba(248,81,73,0.08)';
    rounded(ctx, x + 10, by, COL_W - 20, 50, 9);
    ctx.fill();
    icon(ctx, cache.get(b.championName) ?? null, x + 16, by + 5, 40, 8, b.championName);
    ctx.fillStyle = C.text;
    ctx.font = font(700, 15);
    ctx.fillText(fit(ctx, championName(sd, b.championId, b.championName), COL_W - 80), x + 64, by + 22);
    ctx.fillStyle = wrColor(winrate(b));
    ctx.font = font(600, 13);
    ctx.fillText(`${pct(b)}% · ${b.games} games`, x + 64, by + 40);
  });
  if (!m.bans.length) {
    ctx.fillStyle = C.faint;
    ctx.font = font(400, 13);
    ctx.fillText(`No champion with ${MIN_BAN_GAMES}+ games`, x + 14, y + 262);
  }
}
