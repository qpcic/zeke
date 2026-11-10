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
  recent: 'recent', r: 'recent', rs: 'recent', last: 'recent',
  graph: 'graph', g: 'graph',
  daily: 'daily', d: 'daily', today: 'daily',
  weekly: 'weekly', w: 'weekly', week: 'weekly',
  leaderboard: 'leaderboard', lb: 'leaderboard', top: 'leaderboard',
  track: 'track',
  banfor: 'banfor', ban: 'banfor', bans: 'banfor', scout: 'banfor',
  help: 'help', commands: 'help',
};

const QUEUE_WORDS: Record<string, number> = { solo: 420, soloq: 420, solo_duo: 420, soloduo: 420, duo: 420, sd: 420, flex: 440 };
const KEYWORDS = new Set([...Object.keys(QUEUE_WORDS), 'daily', 'weekly', 'week', 'w', 'today']);
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

  // Queue is always the LAST argument ("$daily @friend flex", "$lb week flex"); default Solo/Duo.
  if (name === 'recent' || name === 'graph' || name === 'daily' || name === 'weekly' || name === 'leaderboard') {
    const last = words[words.length - 1]?.toLowerCase();
    if (last && last in QUEUE_WORDS) {
      req.queue = QUEUE_WORDS[last];
      words = words.slice(0, -1);
    }
  }

  // "$banfor ferks kitten#retro eune": riot id (spaces allowed) + optional region
  if (name === 'banfor') {
    const ex = extractRiotId(words);
    req.riotId = ex.riotId ?? (words.length ? words.join(' ') : undefined);
    const region = ex.rest.find((w) => parsePlatform(w));
    if (region) req.region = region;
  }

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
      const n = words.find((w) => /^\d+$/.test(w));
      if (n) req.games = Number(n);
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

    // Typing indicator lasts ~10s; keep it alive for slow commands ($banfor on a cold cache).
    const typing = () => ('sendTyping' in msg.channel ? msg.channel.sendTyping().catch(() => {}) : undefined);
    void typing();
    const keepTyping = setInterval(typing, 8000);
    try {
      const reply = await runCommand(service, req);
      await msg.reply({ ...payload(reply), allowedMentions: { repliedUser: false } });
    } catch (e) {
      if (!(e instanceof UserError)) log(`${prefix}${req.name} failed: ${(e as Error).stack}`);
      await msg.reply({ embeds: [errorEmbed(e)], allowedMentions: { repliedUser: false } }).catch(() => {});
    } finally {
      clearInterval(keepTyping);
    }
  };
}
