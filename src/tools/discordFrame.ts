import { createCanvas, GlobalFonts, loadImage, type SKRSContext2D } from '@napi-rs/canvas';
import { existsSync } from 'node:fs';
import type { Reply } from '../core/service.ts';
import { ensureFonts } from '../render/image/canvas.ts';

/**
 * README shots: a Discord-looking picture of a command being typed and Zeke's answer.
 * Dark theme colours, simplified layout (wider embeds than the real client, for legibility).
 */

const EMOJI_FONT = ['/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf', 'C:/Windows/Fonts/seguiemj.ttf'].find((p) => existsSync(p));
let ready = false;
function fonts() {
  if (ready) return;
  ensureFonts();
  if (EMOJI_FONT) GlobalFonts.registerFromPath(EMOJI_FONT, 'ShotEmoji');
  ready = true;
}
const F = (w: 400 | 500 | 600 | 700, px: number, mono = false) =>
  mono ? `${w} ${px}px "DejaVu Sans Mono", monospace, ShotEmoji` : `${w === 500 ? 600 : w} ${px}px LBInter, "Noto Sans CJK JP", ShotEmoji, sans-serif`;

const D = {
  bg: '#313338', composer: '#383a40', chip: '#1e1f22', embed: '#2b2d31', text: '#dbdee1', head: '#f2f3f5',
  muted: '#949ba4', faint: '#6d6f78', link: '#00a8fc', mention: 'rgba(88,101,242,0.3)', mentionText: '#c9cdfb',
  code: '#1e1f22', blurple: '#5865f2', green: '#248046', red: '#da373c', grey: '#4e5058',
};

export interface Command {
  /** who runs it */
  user: string;
  userColor: string;
  /** "/profile" or "$r kitten" */
  name: string;
  /** slash options shown as chips: [["user", "@Mochi"], ["queue", "Flex"]] */
  options?: [string, string][];
}
export interface ShotMessage {
  reply: Reply;
  /** extra replies under the same header (recap: several embeds in one post) */
  more?: Reply[];
  ephemeral?: boolean;
  /** no "used /x" line: a post Zeke makes on its own */
  auto?: boolean;
}
export interface Shot {
  command?: Command;
  /** caption over the composer, e.g. "or with the $ prefix" */
  messages: ShotMessage[];
  /** ids → names for <@id> / <#id> */
  users: Record<string, string>;
  channels: Record<string, string>;
  now: number;
  tz: string;
  /** attachments already on the message (an edited post that keeps its image) */
  keep?: Record<string, Buffer>;
}

const W = 1100, PAD = 28, AV = 40, MX = PAD + AV + 16, EMBED_W = W - MX - PAD;

export async function renderShot(s: Shot): Promise<Buffer> {
  fonts();
  const canvas = createCanvas(W, 7000);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = D.bg;
  ctx.fillRect(0, 0, W, 7000);
  let y = PAD;

  // ---- composer: the command being typed ----
  if (s.command) {
    ctx.fillStyle = D.composer;
    rr(ctx, PAD, y, W - 2 * PAD, 56, 10); ctx.fill();
    // "+" button
    ctx.fillStyle = '#b5bac1';
    ctx.beginPath(); ctx.arc(PAD + 28, y + 28, 12, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = D.composer;
    ctx.fillRect(PAD + 27, y + 21, 2, 14); ctx.fillRect(PAD + 21, y + 27, 14, 2);
    let x = PAD + 56;
    ctx.font = F(600, 17);
    ctx.fillStyle = D.head;
    ctx.fillText(s.command.name, x, y + 34);
    x += ctx.measureText(s.command.name).width + 12;
    for (const [k, v] of s.command.options ?? []) {
      ctx.font = F(600, 15);
      const kw = ctx.measureText(`${k}`).width;
      ctx.font = F(400, 15);
      const vw = ctx.measureText(v).width;
      const w = kw + vw + 30;
      ctx.fillStyle = D.chip;
      rr(ctx, x, y + 14, w, 28, 6); ctx.fill();
      ctx.fillStyle = '#4e5058';
      rr(ctx, x, y + 14, kw + 16, 28, 6); ctx.fill();
      ctx.fillRect(x + kw + 10, y + 14, 6, 28);
      ctx.font = F(600, 15); ctx.fillStyle = D.head;
      ctx.fillText(k, x + 8, y + 33);
      ctx.font = F(400, 15); ctx.fillStyle = D.text;
      ctx.fillText(v, x + kw + 22, y + 33);
      x += w + 8;
    }
    // caret
    ctx.fillStyle = D.text;
    ctx.fillRect(x + 2, y + 17, 2, 22);
    // "send" hint
    ctx.font = F(400, 13); ctx.fillStyle = D.faint; ctx.textAlign = 'right';
    ctx.fillText('⏎ Enter', W - PAD - 18, y + 33);
    ctx.textAlign = 'left';
    y += 56 + 22;
    // divider
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    ctx.fillRect(PAD, y, W - 2 * PAD, 1);
    y += 22;
  }

  for (const m of s.messages) {
    // "↳ Jan used /profile"
    if (s.command && !m.auto) {
      ctx.strokeStyle = '#4e5058'; ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(PAD + AV / 2, y + 22); ctx.lineTo(PAD + AV / 2, y + 12); ctx.quadraticCurveTo(PAD + AV / 2, y + 8, PAD + AV / 2 + 6, y + 8); ctx.lineTo(MX - 8, y + 8);
      ctx.stroke();
      avatar(ctx, MX + 8, y + 8, 8, s.command.userColor, s.command.user);
      ctx.font = F(600, 14); ctx.fillStyle = s.command.userColor;
      ctx.fillText(s.command.user, MX + 22, y + 13);
      let x = MX + 22 + ctx.measureText(s.command.user).width + 5;
      ctx.font = F(400, 14); ctx.fillStyle = D.muted;
      ctx.fillText('used', x, y + 13);
      x += ctx.measureText('used').width + 5;
      ctx.font = F(600, 14); ctx.fillStyle = D.link;
      ctx.fillText(s.command.name.startsWith('/') ? s.command.name.split(' ')[0]! : s.command.name.split(' ')[0]!, x, y + 13);
      y += 22;
    }
    // bot header
    avatar(ctx, PAD + AV / 2, y + AV / 2, AV / 2, '#5865f2', 'Z');
    ctx.font = F(600, 16); ctx.fillStyle = D.head;
    ctx.fillText('Zeke', MX, y + 16);
    let hx = MX + ctx.measureText('Zeke').width + 6;
    ctx.fillStyle = D.blurple;
    rr(ctx, hx, y + 3, 30, 16, 3); ctx.fill();
    ctx.font = F(600, 10); ctx.fillStyle = '#fff';
    ctx.fillText('APP', hx + 5, y + 15);
    hx += 38;
    ctx.font = F(400, 12); ctx.fillStyle = D.muted;
    ctx.fillText(`Today at ${clock(s.now, s.tz)}`, hx, y + 15);
    y += 26;
    for (const r of [m.reply, ...(m.more ?? [])]) {
      y = await drawReply(ctx, s, r, y);
      y += 8;
    }
    if (m.ephemeral) {
      ctx.font = F(400, 12); ctx.fillStyle = D.muted;
      ctx.fillText('👁  Only you can see this · ', MX, y + 10);
      const w = ctx.measureText('👁  Only you can see this · ').width;
      ctx.fillStyle = D.link; ctx.fillText('Dismiss message', MX + w, y + 10);
      y += 20;
    }
    y += 18;
  }

  const h = Math.ceil(y + PAD - 18);
  const out = createCanvas(W, h);
  const o = out.getContext('2d');
  o.drawImage(canvas, 0, 0);
  return out.toBuffer('image/png');
}

async function drawReply(ctx: SKRSContext2D, s: Shot, r: Reply, y: number): Promise<number> {
  const content = (r as Reply & { content?: string }).content;
  if (content) y = text(ctx, s, content, MX, y + 2, EMBED_W, 15, D.text) + 6;
  const e = r.embed;
  const hasEmbed = e && (e.title || e.description || e.fields?.length || e.image || e.footer);
  if (hasEmbed) {
    const x0 = MX, inner = EMBED_W - 32;
    // measure on a scratch pass by drawing into a throwaway area? simpler: draw body, then box behind
    const top = y;
    const body = createCanvas(EMBED_W, 5000);
    const b = body.getContext('2d');
    let by = 14;
    if (e.author?.name) { b.font = F(600, 14); b.fillStyle = D.head; b.fillText(e.author.name, 16, by + 12); by += 24; }
    if (e.title) by = text(b, s, `**${e.title}**`, 16, by, inner, 16, D.head) + 6;
    if (e.description) by = text(b, s, e.description, 16, by, inner, 15, D.text) + 8;
    if (e.fields?.length) {
      let row: typeof e.fields = [];
      const flush = () => {
        if (!row.length) return;
        const colW = inner / (row.length === 1 && !row[0]!.inline ? 1 : 3);
        let maxY = by;
        row.forEach((f, i) => {
          const fx = 16 + i * colW;
          let fy = text(b, s, `**${f.name}**`, fx, by, colW - 12, 14, D.head) + 2;
          fy = text(b, s, f.value, fx, fy, colW - 12, 14, D.text);
          maxY = Math.max(maxY, fy);
        });
        by = maxY + 10;
        row = [];
      };
      for (const f of e.fields) {
        if (!f.inline) { flush(); row = [f]; flush(); continue; }
        row.push(f);
        if (row.length === 3) flush();
      }
      flush();
    }
    if (e.image?.url) {
      const name = e.image.url.replace('attachment://', '');
      const data = r.files.find((f) => f.name === name)?.data ?? s.keep?.[name];
      const file = data ? { data } : null;
      if (file) {
        const img = await loadImage(file.data);
        const w = Math.min(inner, img.width), h = Math.round((img.height / img.width) * w); // never upscale
        b.save(); rr(b, 16, by, w, h, 6); b.clip();
        b.drawImage(img, 16, by, w, h);
        b.restore();
        by += h + 10;
      }
    }
    if (e.footer?.text) by = text(b, s, `-# ${e.footer.text}${e.timestamp ? ` · ${clock(Date.parse(e.timestamp), s.tz)}` : ''}`, 16, by, inner, 12, D.muted) + 4;
    const h = by + 6;
    ctx.fillStyle = D.embed;
    rr(ctx, x0, top, EMBED_W, h, 6); ctx.fill();
    ctx.fillStyle = e.color !== undefined ? `#${e.color.toString(16).padStart(6, '0')}` : '#1e1f22';
    rr(ctx, x0, top, 4, h, 2); ctx.fill();
    ctx.drawImage(body, 0, 0, EMBED_W, h, x0, top, EMBED_W, h);
    y = top + h + 6;
  } else {
    // image-only replies without an embed: attachments
    for (const f of r.files) {
      const img = await loadImage(f.data);
      const w = Math.min(EMBED_W, img.width), h = Math.round((img.height / img.width) * w);
      ctx.save(); rr(ctx, MX, y, w, h, 8); ctx.clip(); ctx.drawImage(img, MX, y, w, h); ctx.restore();
      y += h + 8;
    }
  }
  // components
  for (const row of (r.components ?? []) as { components: Record<string, unknown>[] }[]) {
    let x = MX;
    for (const c of row.components) {
      if (c.type === 2) {
        const label = String(c.label ?? '');
        const emoji = (c.emoji as { name?: string } | undefined)?.name;
        const style = Number(c.style);
        ctx.font = F(600, 14);
        const lw = ctx.measureText(`${emoji ? emoji + ' ' : ''}${label}`).width + (style === 5 ? 20 : 0);
        const w = lw + 32;
        ctx.fillStyle = style === 1 ? D.blurple : style === 3 ? D.green : style === 4 ? D.red : D.grey;
        ctx.globalAlpha = c.disabled ? 0.5 : 1;
        rr(ctx, x, y, w, 34, 6); ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.fillText(`${emoji ? emoji + ' ' : ''}${label}`, x + 16, y + 22);
        if (style === 5) {
          // external link glyph
          const gx = x + w - 26, gy = y + 11;
          ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.6;
          ctx.strokeRect(gx, gy + 3, 9, 9);
          ctx.beginPath(); ctx.moveTo(gx + 5, gy + 7); ctx.lineTo(gx + 12, gy); ctx.moveTo(gx + 8, gy); ctx.lineTo(gx + 12, gy); ctx.lineTo(gx + 12, gy + 4); ctx.stroke();
        }
        ctx.globalAlpha = 1;
        x += w + 8;
      } else {
        // selects (string / user / channel)
        const opts = (c.options as { label: string; default?: boolean }[] | undefined) ?? [];
        const label = opts.find((o) => o.default)?.label ?? String(c.placeholder ?? 'Select…');
        const w = Math.min(EMBED_W, 520);
        ctx.fillStyle = D.chip;
        rr(ctx, x, y, w, 40, 6); ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.08)'; ctx.lineWidth = 1; ctx.stroke();
        ctx.font = F(400, 15); ctx.fillStyle = opts.some((o) => o.default) ? D.text : D.muted;
        ctx.fillText(label, x + 14, y + 26);
        ctx.strokeStyle = D.text; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(x + w - 26, y + 17); ctx.lineTo(x + w - 20, y + 23); ctx.lineTo(x + w - 14, y + 17); ctx.stroke();
        x += w + 8;
      }
    }
    y += row.components.some((c) => c.type !== 2) ? 48 : 42;
  }
  return y;
}

// ---------- text with a bit of Discord markdown ----------

interface Run { t: string; bold?: boolean; code?: boolean; mention?: boolean; link?: boolean; italic?: boolean; strike?: boolean }

function inline(s: Shot, line: string): Run[] {
  const runs: Run[] = [];
  const re = /\*\*(.+?)\*\*|`([^`]+)`|<@!?(\d+|[\w-]+)>|<#(\d+)>|<t:(\d+)(?::([tTdDfFR]))?>|\[([^\]]+)\]\(([^)]+)\)|~~(.+?)~~|(?<![\w*])\*([^*]+)\*(?!\w)|<a?:\w+:\d+>/g;
  let last = 0, m: RegExpExecArray | null;
  while ((m = re.exec(line))) {
    if (m.index > last) runs.push({ t: line.slice(last, m.index) });
    if (m[1] !== undefined) runs.push(...inline(s, m[1]).map((r) => ({ ...r, bold: true })));
    else if (m[2] !== undefined) runs.push({ t: m[2], code: true });
    else if (m[3] !== undefined) runs.push({ t: `@${s.users[m[3]] ?? m[3]}`, mention: true });
    else if (m[4] !== undefined) runs.push({ t: `#${s.channels[m[4]] ?? 'channel'}`, mention: true });
    else if (m[5] !== undefined) runs.push({ t: stamp(Number(m[5]) * 1000, m[6] ?? 'f', s), code: true });
    else if (m[7] !== undefined) runs.push({ t: m[7], link: true });
    else if (m[9] !== undefined) runs.push({ t: m[9], strike: true });
    else if (m[10] !== undefined) runs.push({ t: m[10], italic: true });
    last = m.index + m[0].length;
  }
  if (last < line.length) runs.push({ t: line.slice(last) });
  return runs;
}

/** Draws wrapped markdown text; returns the y below it. */
function text(ctx: SKRSContext2D, s: Shot, src: string, x0: number, y0: number, maxW: number, px: number, color: string): number {
  let y = y0;
  for (let raw of src.split('\n')) {
    let size = px, col = color, x = x0, quote = false;
    if (raw.startsWith('-# ')) { raw = raw.slice(3); size = Math.max(11, px - 3); col = D.muted; }
    else if (raw.startsWith('### ')) { raw = `**${raw.slice(4)}**`; size = px + 1; }
    else if (raw.startsWith('## ')) { raw = `**${raw.slice(3)}**`; size = px + 4; }
    if (raw.startsWith('> ')) { raw = raw.slice(2); quote = true; x += 14; }
    else if (/^[-•] /.test(raw)) { raw = `•  ${raw.slice(2)}`; }
    const lh = Math.round(size * 1.38);
    if (!raw.trim()) { y += Math.round(lh * 0.6); continue; }
    const lineTop = y;
    let cx = x;
    const startLine = () => { cx = x; y += lh; };
    y += lh - Math.round(lh * 0.28); // baseline of the first line
    const runs = inline(s, raw);
    for (const r of runs) {
      ctx.font = F(r.bold ? 700 : 400, size, r.code);
      const words = r.code || r.mention ? [r.t] : r.t.split(/(\s+)/);
      for (const w of words) {
        if (!w) continue;
        const ww = ctx.measureText(w).width + (r.code ? 8 : r.mention ? 4 : 0);
        if (cx + ww > x0 + maxW && cx > x && /\S/.test(w)) { startLine(); }
        if (cx === x && !/\S/.test(w)) continue;
        if (r.code) { ctx.fillStyle = D.code; rr(ctx, cx, y - size + 1, ww, size + 6, 4); ctx.fill(); }
        if (r.mention) { ctx.fillStyle = D.mention; rr(ctx, cx, y - size + 1, ww, size + 6, 3); ctx.fill(); }
        ctx.fillStyle = r.mention ? D.mentionText : r.link ? D.link : r.code ? '#e3e5e8' : r.bold && col === color ? D.head : col;
        ctx.fillText(w, cx + (r.code ? 4 : r.mention ? 2 : 0), y);
        if (r.strike) ctx.fillRect(cx, y - size / 3, ww, 1.5);
        cx += ww;
      }
    }
    y += Math.round(lh * 0.28);
    if (quote) { ctx.fillStyle = '#4e5058'; rr(ctx, x0, lineTop + 2, 4, y - lineTop - 2, 2); ctx.fill(); }
  }
  return y;
}

// ---------- helpers ----------

function rr(ctx: SKRSContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath(); ctx.roundRect(x, y, w, h, r);
}

function avatar(ctx: SKRSContext2D, cx: number, cy: number, r: number, color: string, label: string) {
  ctx.fillStyle = color;
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.font = F(700, Math.round(r * 0.95));
  ctx.textAlign = 'center';
  ctx.fillText([...label][0]!.toUpperCase(), cx, cy + r * 0.34);
  ctx.textAlign = 'left';
}

const clock = (t: number, tz: string) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit' }).format(t);

function stamp(t: number, style: string, s: Shot): string {
  const tz = s.tz;
  if (style === 'R') {
    const d = (t - s.now) / 1000, a = Math.abs(d);
    const [n, u] = a < 60 ? [Math.round(a), 'second'] : a < 3600 ? [Math.round(a / 60), 'minute'] : a < 86400 ? [Math.round(a / 3600), 'hour'] : [Math.round(a / 86400), 'day'];
    const unit = `${n} ${u}${n === 1 ? '' : 's'}`;
    return d >= 0 ? `in ${unit}` : `${unit} ago`;
  }
  const o: Intl.DateTimeFormatOptions =
    style === 't' ? { hour: '2-digit', minute: '2-digit' }
    : style === 'T' ? { hour: '2-digit', minute: '2-digit', second: '2-digit' }
    : style === 'd' ? { day: '2-digit', month: '2-digit', year: 'numeric' }
    : style === 'D' ? { day: 'numeric', month: 'long', year: 'numeric' }
    : style === 'F' ? { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' }
    : { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' };
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, ...o }).format(t);
}
