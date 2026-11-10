/**
 * Discord embed object, structurally identical to discord-api-types' APIEmbed,
 * so it can later be passed straight to discord.js (`channel.send({ embeds: [e] })`).
 * Limits: title 256, description 4096, 25 fields, field name 256 / value 1024, total 6000.
 */
export interface Embed {
  title?: string;
  description?: string;
  url?: string;
  color?: number;
  timestamp?: string;
  author?: { name: string; url?: string; icon_url?: string };
  thumbnail?: { url: string };
  image?: { url: string };
  footer?: { text: string; icon_url?: string };
  fields?: { name: string; value: string; inline?: boolean }[];
}

export const COLORS = {
  win: 0x2ecc71,
  loss: 0xe74c3c,
  remake: 0x95a5a6,
  promoted: 0xf1c40f,
  digest: 0x5865f2,
  info: 0x3498db,
} as const;

/** Total character count as Discord measures it, to stay under 6000. */
export function embedSize(e: Embed): number {
  return (e.title?.length ?? 0) + (e.description?.length ?? 0) + (e.footer?.text.length ?? 0) + (e.author?.name.length ?? 0) +
    (e.fields ?? []).reduce((n, f) => n + f.name.length + f.value.length, 0);
}

export function validateEmbed(e: Embed): string[] {
  const errs: string[] = [];
  if ((e.title?.length ?? 0) > 256) errs.push('title > 256');
  if ((e.description?.length ?? 0) > 4096) errs.push('description > 4096');
  if ((e.fields?.length ?? 0) > 25) errs.push('fields > 25');
  for (const f of e.fields ?? []) {
    if (f.name.length > 256) errs.push(`field name > 256: ${f.name.slice(0, 20)}`);
    if (f.value.length > 1024) errs.push(`field value > 1024: ${f.name}`);
    if (!f.name || !f.value) errs.push(`empty field: "${f.name}"`);
  }
  if (embedSize(e) > 6000) errs.push('total > 6000');
  return errs;
}
