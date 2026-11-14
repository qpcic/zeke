import { AttachmentBuilder, PermissionFlagsBits, type Message } from 'discord.js';
import { UserError, type Reply, type Service } from '../core/service.ts';
import { runCommand, type CommandName, type CommandRequest } from './actions.ts';
import type { CommandLogger } from './commandLog.ts';
import { healthEmbed, parseStatsPeriod, statsEmbed } from './admin.ts';
import { parsePlatform, PLATFORM_LABEL, type Platform } from '../riot/regions.ts';
import { errorEmbed, payload } from './handlers.ts';
import { stageImport } from '../core/dbImport.ts';
import { config } from '../config.ts';
import { COLORS, type Embed } from '../render/embed.ts';
import { info } from './actions.ts';

/**
 * "$recent", "$graph flex 30 @friend", "$link EUW ferks kitten#retro", …
 * Only known command names trigger a reply, so "$50" or "$$$" in chat are ignored.
 */

const ALIASES: Record<string, CommandName> = {
  link: 'link', unlink: 'unlink', mode: 'mode', queue: 'mode',
  profile: 'profile', p: 'profile', pf: 'profile', me: 'profile',
  recent: 'recent', r: 'recent', rs: 'recent', last: 'recent',
  recap: 'recap', dailyrecap: 'recap',
  log: 'log', gamelog: 'log',
  server: 'server', serverinfo: 'server', settings: 'server',
  live: 'live', lg: 'live', ingame: 'live', spectate: 'live', game: 'live',
  graph: 'graph', g: 'graph',
  daily: 'daily', d: 'daily', today: 'daily',
  weekly: 'weekly', w: 'weekly', week: 'weekly',
  leaderboard: 'leaderboard', lb: 'leaderboard', top: 'leaderboard',
  track: 'track',
  scout: 'scout', banfor: 'scout', ban: 'scout', bans: 'scout',
  help: 'help', commands: 'help',
  zeke: 'zeke', about: 'zeke', info: 'zeke', invite: 'zeke',
};

const QUEUE_WORDS: Record<string, number> = {
  solo: 420, soloq: 420, solo_duo: 420, soloduo: 420, duo: 420, sd: 420,
  flex: 440,
  // Ranked 5s: resolved to the real queue id by the service (FIVES pseudo id)
  '5s': 5, fives: 5, '5v5': 5, r5: 5, r5s: 5, premade: 5,
};
const WINDOW_24H = new Set(['24h', '24', 'last24', 'last24h', 'rolling', 'past24h']);
const KEYWORDS = new Set([...Object.keys(QUEUE_WORDS), ...WINDOW_24H, 'daily', 'weekly', 'week', 'w', 'today']);
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
  ctx: { callerId: string; guildId: string | null; canManageGuild: boolean; mentionedUserId?: string; mentionedChannelId?: string },
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
  if (name === 'recent' || name === 'graph' || name === 'daily' || name === 'weekly' || name === 'leaderboard' || name === 'mode') {
    const last = words[words.length - 1]?.toLowerCase();
    if (last && last in QUEUE_WORDS) {
      req.queue = QUEUE_WORDS[last];
      words = words.slice(0, -1);
    }
  }

  // "$scout ferks kitten#retro eune": riot id (spaces allowed) + optional region
  if (name === 'scout') {
    const ex = extractRiotId(words);
    req.riotId = ex.riotId ?? (words.length ? words.join(' ') : undefined);
    const region = ex.rest.find((w) => parsePlatform(w));
    if (region) req.region = region;
  }

  // Target lookups: "$graph ferks kitten#retro eune flex 30"
  if (name === 'recent' || name === 'live' || name === 'graph' || name === 'daily' || name === 'weekly' || name === 'profile') {
    const ex = extractRiotId(words);
    if (ex.riotId) {
      req.riotId = ex.riotId;
      const region = ex.rest.find((w) => parsePlatform(w));
      if (region) req.region = region;
      words = ex.rest.filter((w) => w !== region);
    }
  }

  // "$daily 24h" / "$daily today": window option (before the queue, which is last)
  if (name === 'daily') {
    const w = words.find((x) => WINDOW_24H.has(x.toLowerCase()) || x.toLowerCase() === 'today');
    if (w) {
      req.window = w.toLowerCase() === 'today' ? 'today' : '24h';
      words = words.filter((x) => x !== w);
    }
  }

  switch (name) {
    case 'link': {
      // "$link euw Name#TAG" (region first; game names can contain spaces) or "$link Name#TAG" for known accounts
      if (words.length && parsePlatform(words[0]!) && words.length > 1) {
        req.region = words[0];
        req.riotId = words.slice(1).join(' ');
      } else {
        req.riotId = words.join(' ') || undefined;
      }
      break;
    }
    case 'log':
    case 'recap': {
      // "$recap #channel" (channel mention) or "$recap off"
      const ch = ctx.mentionedChannelId ?? /^<#(\d+)>$/.exec(words[0] ?? '')?.[1];
      if (ch) req.channelId = ch;
      else if (/^(off|stop|disable|none)$/i.test(words[0] ?? '')) req.off = true;
      break;
    }
    case 'unlink':
      req.account = words.join(' ') || undefined;
      break;
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

export function createPrefixHandler(
  service: Service,
  prefix: string,
  botUserId: () => string | undefined,
  log: (m: string) => void,
  cmdLog?: CommandLogger,
) {
  const audit = (msg: Message, started: number, ok: boolean, error?: string, name?: string) =>
    cmdLog?.({
      text: msg.content,
      name: name ?? 'unknown',
      style: '$',
      userId: msg.author.id,
      userName: msg.author.username,
      guildId: msg.guildId,
      guildName: msg.guild?.name,
      channelId: msg.channelId,
      ok,
      error,
      ms: Date.now() - started,
    });
  const lastUse = new Map<string, number>();

  /** Owner-only: replace the database with an attached export (npm run export-db), then restart. */
  async function handleImport(msg: Message): Promise<void> {
    const reply = (title: string, desc: string, color: number = COLORS.info) => msg.reply({ embeds: [info(title, desc, color)], allowedMentions: { repliedUser: false } });
    if (!config.ownerId) return void (await reply('Import disabled', 'Set `OWNER_ID` (your Discord user ID) in the bot\'s environment to enable `$import`.', COLORS.loss));
    if (msg.author.id !== config.ownerId) return; // silently ignore everyone else
    const file = msg.attachments.find((a) => /\.db(\.gz)?$/i.test(a.name));
    if (!file) return void (await reply('Attach the export', 'Run `npm run export-db` on your PC and send the `.db.gz` file with the message `$import`.', COLORS.loss));
    if (file.size > 50 * 1024 * 1024) return void (await reply('Too big', 'Export is over 50 MB.', COLORS.loss));
    try {
      const res = await fetch(file.url);
      if (!res.ok) throw new Error(`download failed (${res.status})`);
      const s = stageImport(config.dbPath, Buffer.from(await res.arrayBuffer()));
      await reply('Import staged ✔', `${s.players} players · ${s.links} links · ${s.tracked} server tracks · ${s.games} recorded games\nRestarting to apply. The current database is backed up first. Back in a few seconds.`, COLORS.win);
      log(`import staged by owner: ${JSON.stringify(s)}; exiting so the host restarts us`);
      setTimeout(() => process.exit(1), 1500); // non-zero: Railway / docker restart policies bring us back
    } catch (e) {
      await reply('Import failed', (e as Error).message, COLORS.loss);
    }
  }

  /**
   * Owner console: `$admin ...` only in CONSOLE_CHANNEL_ID and only from OWNER_ID.
   * Anyone/anywhere else gets no reply at all.
   */
  async function handleAdmin(msg: Message, args: string[]): Promise<void> {
    if (!config.ownerId || !config.consoleChannelId) return;
    if (msg.author.id !== config.ownerId || msg.channelId !== config.consoleChannelId) return;
    const send = (embed: Embed, files: Reply['files'] = []) =>
      msg.reply({ embeds: [embed], files: files.map((f) => new AttachmentBuilder(f.data, { name: f.name })), allowedMentions: { parse: [], repliedUser: false } });
    const sub = (args[0] ?? '').toLowerCase();
    const rest = args.slice(1);
    const page = Number(rest.find((w) => /^\d+$/.test(w)) ?? 1);
    try {
      switch (sub) {
        case 'list': {
          const r = service.adminPlayers(page);
          const lines = r.rows.map((p) => `**${p.game_name}#${p.tag_line}** · ${PLATFORM_LABEL[p.platform as Platform] ?? p.platform} · ${p.games} games · ${p.links} link${p.links === 1 ? '' : 's'} · ${p.servers} server${p.servers === 1 ? '' : 's'}`);
          await send({ title: `Known accounts (${r.total})`, description: lines.join('\n') || 'None yet.', color: COLORS.info, footer: { text: `Page ${r.page}/${r.pages}${r.page < r.pages ? ` · ${prefix}admin list ${r.page + 1}` : ''}` } });
          return;
        }
        case 'links': {
          const r = service.adminLinks(page);
          const lines = r.rows.map((l) => `<@${l.discord_user_id}> → ${l.is_main ? '⭐ ' : ''}**${l.game_name}#${l.tag_line}** · ${PLATFORM_LABEL[l.platform as Platform] ?? l.platform} · <t:${Math.floor(l.linked_at / 1000)}:d>`);
          await send({ title: `Links (${r.total})`, description: lines.join('\n') || 'No links yet.', color: COLORS.info, footer: { text: `Page ${r.page}/${r.pages}${r.page < r.pages ? ` · ${prefix}admin links ${r.page + 1}` : ''}` } });
          return;
        }
        case 'remove':
        case 'purge': {
          const confirm = rest[rest.length - 1]?.toLowerCase() === 'confirm';
          const idWords = confirm ? rest.slice(0, -1) : rest;
          if (!idWords.length) throw new UserError(`Usage: \`${prefix}admin remove <Name#TAG> [confirm]\``);
          const r = service.adminRemove(idWords.join(' '), confirm);
          const c = r.counts;
          const what = `${c.games} recorded games · ${c.lpEvents} LP entries · ${c.links} Discord link${c.links === 1 ? '' : 's'} · ${c.servers} server track${c.servers === 1 ? '' : 's'}`;
          if (!r.done) {
            await send({ title: `Remove ${r.player.game_name}#${r.player.tag_line}?`, description: `This permanently deletes:\n${what}\nand stops tracking the account.\n\nRun \`${prefix}admin remove ${r.player.game_name}#${r.player.tag_line} confirm\` to do it.`, color: COLORS.loss });
          } else {
            log(`admin: purged ${r.player.game_name}#${r.player.tag_line} (${what})`);
            await send({ title: `Removed ${r.player.game_name}#${r.player.tag_line}`, description: `Deleted ${what}. The account is no longer tracked.`, color: COLORS.win });
          }
          return;
        }
        case 'health':
        case 'status': {
          await send(healthEmbed(service, msg.client, { dbPath: config.dbPath, pollIntervalSec: config.pollIntervalSec }));
          return;
        }
        case 'stats':
        case 'usage': {
          await send(statsEmbed(service, msg.client, parseStatsPeriod(rest)));
          return;
        }
        case 'globallb':
        case 'glb': {
          const words = rest.map((w) => w.toLowerCase());
          const kind = words.some((w) => ['weekly', 'week', 'w'].includes(w)) ? 'weekly' : 'daily';
          const q = words.includes('flex') ? 440 : words.some((w) => QUEUE_WORDS[w] === 5) ? await service.resolveQueue(5) : 420;
          const r = await service.globalLeaderboard(kind, q);
          await send(r.embed, r.files);
          return;
        }
        default:
          await send({
            title: 'Admin console',
            description: [
              `\`${prefix}admin health\` uptime, polling, Riot API errors / rate limits, database, recent errors`,
              `\`${prefix}admin stats [24h|7d|30d|all]\` command usage, top servers / users, growth`,
              `\`${prefix}admin list [page]\` all known accounts`,
              `\`${prefix}admin links [page]\` Discord → Riot links (10 per page)`,
              `\`${prefix}admin globallb [daily|weekly] [solo|flex|5s]\` leaderboard of every account`,
              `\`${prefix}admin remove <Name#TAG> [confirm]\` delete an account's games and links`,
            ].join('\n'),
            color: COLORS.info,
          });
      }
    } catch (e) {
      if (!(e instanceof UserError)) log(`admin ${sub} failed: ${(e as Error).stack}`);
      await send(errorEmbed(e));
    }
  }

  return async function onMessage(msg: Message) {
    if (msg.author.bot || !msg.content.startsWith(prefix)) return;
    {
      const [head, ...args] = msg.content.slice(prefix.length).trim().split(/\s+/);
      if (head?.toLowerCase() === 'admin') {
        // Only the owner in the console channel gets a reply; log just those (others are ignored silently).
        if (config.ownerId && msg.author.id === config.ownerId && msg.channelId === config.consoleChannelId) {
          const t = Date.now();
          await handleAdmin(msg, args);
          audit(msg, t, true, undefined, `admin ${(args[0] ?? '').toLowerCase()}`.trim());
        }
        return;
      }
    }
    if (msg.content.slice(prefix.length).trim().toLowerCase() === 'import') {
      if (msg.author.id === config.ownerId) audit(msg, Date.now(), true, undefined, 'import');
      return void (await handleImport(msg));
    }
    const mentioned = msg.mentions.users.find((u) => u.id !== botUserId());
    const req = parsePrefix(msg.content, prefix, {
      callerId: msg.author.id,
      guildId: msg.guildId,
      canManageGuild: !!msg.member?.permissions.has(PermissionFlagsBits.ManageGuild),
      mentionedUserId: mentioned?.id,
      mentionedChannelId: msg.mentions.channels.first()?.id,
    });
    if (!req) return;
    req.guildName = msg.guild?.name;
    req.serverCount = msg.client.guilds.cache.size;

    const now = Date.now();
    if (now - (lastUse.get(msg.author.id) ?? 0) < COOLDOWN_MS) return;
    lastUse.set(msg.author.id, now);
    if (lastUse.size > 5000) lastUse.clear();

    // Typing indicator lasts ~10s; keep it alive for slow commands ($scout on a cold cache).
    const typing = () => ('sendTyping' in msg.channel ? msg.channel.sendTyping().catch(() => {}) : undefined);
    void typing();
    const keepTyping = setInterval(typing, 8000);
    try {
      const reply = await runCommand(service, req);
      await msg.reply({ ...payload(reply), allowedMentions: { repliedUser: false } });
      audit(msg, now, true, undefined, req.name);
    } catch (e) {
      audit(msg, now, false, (e as Error).message, req.name);
      if (!(e instanceof UserError)) log(`${prefix}${req.name} failed: ${(e as Error).stack}`);
      await msg.reply({ embeds: [errorEmbed(e)], allowedMentions: { repliedUser: false } }).catch(() => {});
    } finally {
      clearInterval(keepTyping);
    }
  };
}
