import type { Embed } from './embed.ts';

/** Renders an embed in the terminal roughly the way Discord lays it out. */

const ESC = '\x1b[';
const reset = `${ESC}0m`;
const bold = (s: string) => `${ESC}1m${s}${ESC}22m`;
const dim = (s: string) => `${ESC}2m${s}${ESC}22m`;
const fg = (hex: number, s: string) => `${ESC}38;2;${(hex >> 16) & 255};${(hex >> 8) & 255};${hex & 255}m${s}${ESC}39m`;
const link = (s: string) => `${ESC}38;2;0;168;252m${s}${ESC}39m`;
const codeBg = (s: string) => `${ESC}48;2;30;31;34m${s}${ESC}49m`;

const visibleLen = (s: string) => [...s.replace(/\x1b\[[0-9;]*m/g, '')].length;

/** Minimal Discord markdown: **bold**, `code`, ```blocks``` handled by caller. */
function inline(md: string): string {
  return md.replace(/\*\*(.+?)\*\*/g, (_, t) => bold(t)).replace(/`([^`]+)`/g, (_, t) => codeBg(` ${t} `));
}

function renderValue(v: string, width: number): string[] {
  const out: string[] = [];
  const parts = v.split(/```\n?/);
  parts.forEach((part, i) => {
    if (!part) return;
    if (i % 2 === 1) {
      const lines = part.replace(/\n$/, '').split('\n');
      const w = Math.min(width, Math.max(...lines.map((l) => [...l].length)) + 2);
      for (const l of lines) out.push(codeBg(' ' + l + ' '.repeat(Math.max(0, w - [...l].length - 1))));
    } else {
      for (const l of part.replace(/\n$/, '').split('\n')) out.push(inline(l));
    }
  });
  return out;
}

export function renderEmbedToTerminal(e: Embed, width = 72): string {
  const bar = fg(e.color ?? 0x4f545c, '▌');
  const lines: string[] = [];
  const push = (s = '') => lines.push(`${bar} ${s}`);

  push();
  if (e.author) push(bold(e.author.name));
  if (e.title) push(bold(e.url ? link(e.title) : e.title));
  if (e.thumbnail) push(dim(`[thumb] ${e.thumbnail.url}`));
  if (e.description) for (const l of e.description.split('\n')) push(inline(l));

  const fields = e.fields ?? [];
  for (let i = 0; i < fields.length; ) {
    // Discord groups up to 3 consecutive inline fields per row.
    const row = [];
    while (i < fields.length && fields[i]!.inline && row.length < 3) row.push(fields[i++]!);
    if (row.length) {
      push();
      const colW = Math.floor((width - 2) / 3);
      const pad = (s: string) => s + ' '.repeat(Math.max(1, colW - visibleLen(s)));
      push(row.map((f) => pad(bold(f.name))).join(''));
      const vals = row.map((f) => renderValue(f.value, colW));
      const h = Math.max(...vals.map((v) => v.length));
      for (let r = 0; r < h; r++) push(vals.map((v) => pad(v[r] ?? '')).join(''));
      continue;
    }
    const f = fields[i++]!;
    push();
    push(bold(f.name));
    for (const l of renderValue(f.value, width)) push(l);
  }

  if (e.image) push(dim(`[image] ${e.image.url}`));
  const foot = [e.footer?.text, e.timestamp ? new Date(e.timestamp).toLocaleString('en-GB') : undefined].filter(Boolean).join(' • ');
  if (foot) {
    push();
    push(dim(foot));
  }
  push();
  return lines.join('\n') + reset;
}
