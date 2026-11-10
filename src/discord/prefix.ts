import { PermissionFlagsBits, type Message } from 'discord.js';
import { UserError, type Service } from '../core/service.ts';
import { runCommand, type CommandName, type CommandRequest } from './actions.ts';
import { parsePlatform } from '../riot/regions.ts';
import { errorEmbed, payload } from './handlers.ts';

/**
 * "$recent", "$graph flex 30 @friend", "$link EUW ferks kitten#retro", …
 * Only known command names trigger a reply, so "$50" or "$$$" in chat are ignored.
 */

const ALIASES: Record<string, CommandName> = {
  link: 'link', unlink: 'unlink',
  recent: 'recent', r: 'recent', last: 'recent',
  graph: 'graph', g: 'graph',
  daily: 'daily', d: 'daily', today: 'daily',
  weekly: 'weekly', w: 'weekly', week: 'weekly',
  leaderboard: 'leaderboard', lb: 'leaderboard', top: 'leaderboard',
  track: 'track',
  help: 'help', commands: 'help',
};

const KEYWORDS = new Set(['flex', 'solo', 'soloq', 'duo', 'daily', 'weekly', 'week', 'w', 'today']);
const isKeyword = (w: string) => KEYWORDS.has(w.toLowerCase()) || /^\d+$/.test(w) || !!parsePlatform(w);

/**
 * Pull "Name With Spaces#TAG" out of free-form args: the token with '#' plus the
 * non-keyword tokens directly before it. Returns the riot id and remaining words.
 */
export function extractRiotId(words: string[]): { riotId?: string; rest: string[] } {
  const k = words.findIndex((w) => w.includes('#'));
  if (k < 0) return { rest: words };
  let start = k;
  while (start > 0 && !isKeyword(words[start - 1]!)) start--;
  return { riotId: words.slice(start, k + 1).join(' '), rest: [...words.slice(0, start), ...words.slice(k + 1)] };
}

/** Exported for tests: turn message text into a request (without Discord objects). */
export function parsePrefix(
  content: string,
  prefix: string,
  ctx: { callerId: string; guildId: string | null; canManageGuild: boolean; mentionedUserId?: string },
): CommandRequest | null {
  if (!prefix || !content.startsWith(prefix)) return null;
  // drop user mentions from the argument text; they arrive via ctx.mentionedUserId
  const body = content.slice(prefix.length).replace(/<@!?\d+>/g, ' ').trim();
  const [head = '', ...rest] = body.split(/\s+/);
  const name = ALIASES[head.toLowerCase()];
  if (!name) return null;

  const req: CommandRequest = {
    name,
    callerId: ctx.callerId,
    targetUserId: ctx.mentionedUserId,
    guildId: ctx.guildId,
    canManageGuild: ctx.canManageGuild,
    style: prefix,
  };
  let words = rest.filter(Boolean);

  // Target lookups: "$graph ferks kitten#retro eune flex 30"
  if (name === 'recent' || name === 'graph' || name === 'daily' || name === 'weekly') {
    const ex = extractRiotId(words);
    if (ex.riotId) {
      req.riotId = ex.riotId;
      const region = ex.rest.find((w) => parsePlatform(w));
      if (region) req.region = region;
      words = ex.rest.filter((w) => w !== region);
    }
  }

  switch (name) {
    case 'link': {
      // region first, everything after is the Riot ID (game names can contain spaces)
      req.region = words[0];
      req.riotId = words.slice(1).join(' ') || undefined;
      break;
    }
    case 'graph': {
      for (const w of words.map((x) => x.toLowerCase())) {
        if (w === 'flex') req.queue = 440;
        else if (w === 'solo' || w === 'soloq' || w === 'duo') req.queue = 420;
        else if (/^\d+$/.test(w)) req.games = Number(w);
      }
      break;
    }
    case 'leaderboard': {
      const w = words[0]?.toLowerCase();
      req.period = w && ['weekly', 'week', 'w'].includes(w) ? 'weekly' : 'daily';
      break;
    }
    case 'track': {
      const sub = words[0]?.toLowerCase();
      if (sub === 'add') {
        req.sub = 'add';
        req.region = words[1];
        req.riotId = words.slice(2).join(' ') || undefined;
      } else if (sub === 'remove' || sub === 'rm' || sub === 'del') {
        req.sub = 'remove';
        req.account = words.slice(1).join(' ') || undefined;
      } else {
        req.sub = 'list';
      }
      break;
    }
  }
  return req;
}

const COOLDOWN_MS = 2500;

export function createPrefixHandler(service: Service, prefix: string, botUserId: () => string | undefined, log: (m: string) => void) {
  const lastUse = new Map<string, number>();

  return async function onMessage(msg: Message) {
    if (msg.author.bot || !msg.content.startsWith(prefix)) return;
    const mentioned = msg.mentions.users.find((u) => u.id !== botUserId());
    const req = parsePrefix(msg.content, prefix, {
      callerId: msg.author.id,
      guildId: msg.guildId,
      canManageGuild: !!msg.member?.permissions.has(PermissionFlagsBits.ManageGuild),
      mentionedUserId: mentioned?.id,
    });
    if (!req) return;

    const now = Date.now();
    if (now - (lastUse.get(msg.author.id) ?? 0) < COOLDOWN_MS) return;
    lastUse.set(msg.author.id, now);
    if (lastUse.size > 5000) lastUse.clear();

    try {
      if ('sendTyping' in msg.channel) await msg.channel.sendTyping().catch(() => {});
      const reply = await runCommand(service, req);
      await msg.reply({ ...payload(reply), allowedMentions: { repliedUser: false } });
    } catch (e) {
      if (!(e instanceof UserError)) log(`${prefix}${req.name} failed: ${(e as Error).stack}`);
      await msg.reply({ embeds: [errorEmbed(e)], allowedMentions: { repliedUser: false } }).catch(() => {});
    }
  };
}
