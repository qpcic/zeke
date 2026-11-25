import type { Canvas } from '@napi-rs/canvas';
import type { AssetSource } from '../../assets/ddragon.ts';
import { ROLE_LABEL, type Matchup, type Seat } from '../../core/inhouse.ts';
import { formatTierDiv } from '../../core/rank.ts';
import { C, createCanvas, decode, ensureFonts, fit, font, rounded, trimTransparent, type Image } from './canvas.ts';
import { rankAt } from './lpGraph.ts';

/** $admin 5v5 generate: two teams side by side, role by role. */

const W = 1120, PAD = 20, HEAD = 96, TEAM_HEAD = 46, ROW = 66, GAP = 16;
const COL_W = (W - 2 * PAD - GAP) / 2;
const MODE_TITLE = { tryhard: 'Tryhard', random: 'Random', offrole: 'Off-role' } as const;
const BLUE = '#4c8dff', RED = '#ff5a5f';

export async function renderInhouse(m: Matchup, assets: AssetSource | null): Promise<Buffer> {
  ensureFonts();
  const seats = [...m.blue, ...m.red];
  const tiers = [...new Set(seats.map((s) => s.player.rank?.tier).filter((t): t is string => !!t))];
  const emblems = new Map<string, Image | Canvas | null>();
  await Promise.all(tiers.map(async (t) => {
    const url = assets ? await assets.emblemUrl(t).catch(() => null) : null;
    const img = url && assets ? await decode(await assets.image(url)).catch(() => null) : null;
    emblems.set(t, img ? trimTransparent(img) : null);
  }));

  const benchH = m.bench.length ? 40 : 0;
  const H = HEAD + TEAM_HEAD + 5 * ROW + benchH + PAD + 8;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, W, H);

  const grad = ctx.createLinearGradient(0, 0, W, 0);
  grad.addColorStop(0, `${BLUE}38`); grad.addColorStop(0.5, '#00000000'); grad.addColorStop(1, `${RED}38`);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, 80);
  ctx.fillStyle = C.text;
  ctx.font = font(700, 30);
  ctx.fillText(`5v5 · ${MODE_TITLE[m.mode]}`, PAD + 8, 44);
  ctx.fillStyle = C.sub;
  ctx.font = font(400, 16);
  const gap = Math.round(Math.abs(m.blueAvg - m.redAvg));
  ctx.fillText(`${m.onMain} of 10 on their main role · average ranks ${gap} LP apart`, PAD + 8, 70);

  ([['BLUE TEAM', m.blue, m.blueAvg, BLUE], ['RED TEAM', m.red, m.redAvg, RED]] as const).forEach(([label, team, avg, color], k) => {
    const x = PAD + k * (COL_W + GAP);
    let y = HEAD;
    ctx.fillStyle = `${color}22`;
    rounded(ctx, x, y, COL_W, TEAM_HEAD - 8, 8); ctx.fill();
    ctx.fillStyle = color;
    ctx.font = font(700, 17);
    ctx.fillText(label, x + 14, y + 25);
    ctx.textAlign = 'right';
    ctx.fillStyle = C.sub;
    ctx.font = font(400, 14);
    ctx.fillText(`avg ${formatTierDiv(rankAt(avg))}`, x + COL_W - 14, y + 25);
    ctx.textAlign = 'left';
    y += TEAM_HEAD;
    team.forEach((s, i) => row(ctx, s, x, y + i * ROW, emblems, i));
  });

  if (m.bench.length) {
    ctx.fillStyle = C.sub;
    ctx.font = font(400, 15);
    ctx.fillText(fit(ctx, `Sitting out: ${m.bench.map((p) => p.name).join(', ')}`, W - 2 * PAD - 16), PAD + 8, HEAD + TEAM_HEAD + 5 * ROW + 26);
  }
  return canvas.toBuffer('image/png');
}

function row(ctx: ReturnType<ReturnType<typeof createCanvas>['getContext']>, s: Seat, x: number, y: number, emblems: Map<string, Image | Canvas | null>, i: number) {
  const mid = y + (ROW - 6) / 2;
  ctx.fillStyle = i % 2 === 0 ? C.panel : '#1a1b1f';
  rounded(ctx, x, y, COL_W, ROW - 6, 8); ctx.fill();

  ctx.fillStyle = C.faint;
  ctx.font = font(700, 13);
  ctx.fillText(ROLE_LABEL[s.role].toUpperCase(), x + 14, mid + 5);

  const em = s.player.rank ? emblems.get(s.player.rank.tier) : null;
  if (em) {
    const sz = 40, sc = Math.min(sz / em.width, sz / em.height);
    ctx.drawImage(em, x + 92 + (sz - em.width * sc) / 2, mid - (em.height * sc) / 2, em.width * sc, em.height * sc);
  }

  const onMain = s.player.main === s.role;
  const chip = onMain ? 'MAIN' : `main: ${ROLE_LABEL[s.player.main]}`;
  ctx.font = font(700, 12);
  const cw = ctx.measureText(chip).width + 16;
  const nameMax = COL_W - 150 - cw - 20;

  ctx.fillStyle = C.text;
  ctx.font = font(700, 17);
  const nm = fit(ctx, s.player.name, nameMax);
  ctx.fillText(nm, x + 144, mid - 3);
  const nw = ctx.measureText(nm).width;
  ctx.fillStyle = C.faint;
  ctx.font = font(400, 13);
  ctx.fillText(fit(ctx, `#${s.player.tag}`, Math.max(0, nameMax - nw - 4)), x + 144 + nw + 4, mid - 3);
  ctx.fillStyle = C.sub;
  ctx.font = font(400, 14);
  ctx.fillText(s.player.rank ? `${formatTierDiv(s.player.rank)} · ${s.player.rank.lp} LP` : 'Unranked', x + 144, mid + 17);

  const cx = x + COL_W - 14 - cw;
  ctx.fillStyle = onMain ? 'rgba(63,185,80,0.18)' : 'rgba(255,255,255,0.07)';
  rounded(ctx, cx, mid - 11, cw, 22, 11); ctx.fill();
  ctx.fillStyle = onMain ? C.win : C.sub;
  ctx.font = font(700, 12);
  ctx.fillText(chip, cx + 8, mid + 4);
}
