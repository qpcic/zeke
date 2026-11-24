/**
 * README pictures: puts a fake Discord message around a screenshot of Zeke's answer,
 * with the command being typed on top.
 *
 *   npm run frame                                   every entry in docs/images/shots.json
 *   npm run frame -- recent.png "/recent queue:Flex" one picture
 *
 * Inputs come from docs/images/, outputs go to docs/images/framed/ (same file name).
 * Entries whose screenshot isn't there yet are listed and skipped.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderShot } from './discordFrame.ts';

const IN = 'docs/images';
const OUT = 'docs/images/framed';
const MANIFEST = join(IN, 'shots.json');

export interface ShotEntry {
  /** screenshot in docs/images (also the output name) */
  image: string;
  /** what's typed: "/graph compare:@Mochi, kitten days:14" or "$r kitten" */
  command?: string;
  /** who runs it (default User) */
  user?: string;
  /** embed colour bar, e.g. "#3fb950" (default Discord blurple) */
  color?: string;
  /** "Only you can see this" under the answer */
  ephemeral?: boolean;
  /** a post Zeke makes on its own (recap, game log, bets): no command, no "used /x" line */
  auto?: boolean;
  /** text above the image, e.g. a footer-like note */
  text?: string;
}

const USER_COLORS: Record<string, string> = { Jan: '#f0b232', Mochi: '#eb459e', Miha: '#57f287', Luka: '#ed4245', Zephyr: '#3ba55c', Nika: '#00a8fc' };

/** "/graph compare:@Mochi, kitten days:14" → name + option chips; "$" commands stay plain text. */
export function parseCommand(cmd: string): { name: string; options: [string, string][] } {
  if (!cmd.startsWith('/')) return { name: cmd, options: [] };
  const parts = cmd.split(/\s+(?=[\w-]+:)/);
  const name = parts.shift()!;
  return { name, options: parts.map((p) => { const i = p.indexOf(':'); return [p.slice(0, i), p.slice(i + 1).trim()] as [string, string]; }) };
}

export async function frame(e: ShotEntry): Promise<Buffer> {
  const data = readFileSync(join(IN, e.image));
  const user = e.user ?? 'User';
  const cmd = e.command && !e.auto ? parseCommand(e.command) : null;
  return renderShot({
    command: cmd ? { user, userColor: USER_COLORS[user] ?? '#f0b232', name: cmd.name, options: cmd.options } : undefined,
    messages: [{
      reply: {
        embed: { color: parseInt((e.color ?? '#5865f2').slice(1), 16), ...(e.text ? { description: e.text } : {}), image: { url: 'attachment://shot.png' } },
        files: [{ name: 'shot.png', data }],
      },
      ephemeral: e.ephemeral,
      auto: e.auto,
    }],
    users: {}, channels: {}, now: Date.now(), tz: 'Europe/Ljubljana',
  });
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const [image, command] = process.argv.slice(2);
  const entries: ShotEntry[] = image ? [{ image, command }] : JSON.parse(readFileSync(MANIFEST, 'utf8'));
  const missing: string[] = [];
  for (const e of entries) {
    if (!existsSync(join(IN, e.image))) { missing.push(e.image); continue; }
    writeFileSync(join(OUT, e.image), await frame(e));
    console.log(`framed ${e.image}${e.command ? `  (${e.command})` : ''}`);
  }
  if (missing.length) console.log(`\nno screenshot yet (put these in ${IN}/):\n  ${missing.join('\n  ')}`);
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('frameShots.ts')) await main();
