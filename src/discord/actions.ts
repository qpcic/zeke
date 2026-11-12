import { formatRank } from '../core/rank.ts';
import { linkedStatus, linkPanel, unlinkedStatus } from './linkPanel.ts';
import { FIVES, FLEX, queueName, UserError, type Reply, type Service } from '../core/service.ts';
import type { PlayerRow } from '../db/repo.ts';
import { COLORS, type Embed } from '../render/embed.ts';
import { PLATFORM_LABEL } from '../riot/regions.ts';
import type { LeagueEntryDto } from '../riot/types.ts';

/**
 * Transport-agnostic command logic. Slash commands and $prefix messages both
 * parse into a CommandRequest and render the returned Reply.
 */
export type CommandName = 'link' | 'unlink' | 'mode' | 'profile' | 'recent' | 'graph' | 'daily' | 'weekly' | 'leaderboard' | 'track' | 'scout' | 'help';

export interface CommandRequest {
  name: CommandName;
  callerId: string;
  /** Discord user whose linked account to show (defaults to caller). */
  targetUserId?: string;
  guildId: string | null;
  canManageGuild: boolean;
  /** How the user invokes commands, for help/usage text: "/" or "$". */
  style: '/' | string;
  region?: string;
  riotId?: string;
  period?: 'daily' | 'weekly';
  queue?: number;
  games?: number;
  sub?: 'add' | 'remove' | 'list';
  /** /daily window: today (default) or past 24h */
  window?: 'today' | '24h';
  /** track remove: puuid (slash autocomplete) or "Name#TAG" (prefix). */
  account?: string;
}

/** Replies that should only be visible to the caller where the transport supports it. */
export const PRIVATE: ReadonlySet<CommandName> = new Set(['link', 'unlink', 'mode', 'help']);

const QUEUE_NAME: Record<string, string> = { RANKED_SOLO_5x5: 'Solo/Duo', RANKED_FLEX_SR: 'Flex', RANKED_PREMADE_5x5: 'Ranked 5s' };
export const tag = (p: PlayerRow) => `${p.game_name}#${p.tag_line}`;
export const info = (title: string, description: string, color: number = COLORS.info): Embed => ({ title, description, color });
const only = (embed: Embed): Reply => ({ embed, files: [] });

function ranksText(entries: LeagueEntryDto[]): string {
  const rs = entries
    .filter((e) => QUEUE_NAME[e.queueType])
    .map((e) => `${QUEUE_NAME[e.queueType]}: **${formatRank({ tier: e.tier, division: e.rank, lp: e.leaguePoints })}** (${e.wins}W ${e.losses}L)`);
  return rs.join('\n') || 'Unranked';
}

export function helpEmbed(p: string): Embed {
  const c = (s: string) => `\`${p}${s}\``;
  const slash = p === '/';
  // Prefix users get the short aliases; slash users see the plain names.
  const a = (...names: string[]) => (slash ? '' : ` · ${names.map((n) => `\`${p}${n}\``).join(' ')}`);
  return {
    title: 'Zeke commands',
    color: COLORS.info,
    description: [
      `Every command works as \`/name\` or \`$name\`.`,
      `With nothing after it, a command uses **your main account**. Add \`@user\` or \`Name#TAG\` to see someone else.`,
    ].join('\n'),
    fields: [
      {
        name: '🔗 Accounts',
        value: [
          `${c('link')} add, remove or pick your main account`,
          `${c('unlink [Name#TAG]')} remove a linked account`,
          `${c('mode solo|flex|5s')} your default queue`,
        ].join('\n'),
      },
      {
        name: '📊 Stats',
        value: [
          `${c('profile')} rank, ladder spot, top champions${a('p')}`,
          `${c('recent')} latest game, across all your accounts${a('rs')}`,
          `${c('daily [24h]')} today, or the past 24 hours${a('d')}`,
          `${c('weekly')} the past 7 days${a('w')}`,
          `${c('graph [games]')} LP graph${a('g')}`,
        ].join('\n'),
      },
      {
        name: '🛡️ Scout',
        value: `${c('scout Name#TAG [region]')} a Ranked 5s / Flex team's roles, best champs and bans${a('ban')}`,
      },
      {
        name: '🏆 Server',
        value: [
          `${c('leaderboard [daily|weekly]')} server LP leaderboard${a('lb')}`,
          `${c('track add|remove|list')} accounts on the leaderboard (Manage Server)`,
        ].join('\n'),
      },
      {
        name: '💡 Queues',
        value: `Put \`solo\`, \`flex\` or \`5s\` last, e.g. ${c('daily flex')}. Without one, your ${c('mode')} is used (Solo/Duo by default).`,
      },
    ],
    footer: { text: `Regions: ${Object.values(PLATFORM_LABEL).join(' · ')}` },
  };
}

export async function runCommand(service: Service, req: CommandRequest): Promise<Reply> {
  const p = req.style;
  let newNote = '';
  const target = async () => {
    if (req.riotId) {
      const r = await service.lookup(req.riotId, req.region);
      if (r.isNew) newNote = `Started tracking **${tag(r.player)}**; their games are recorded from now on.`;
      return r.player;
    }
    const id = req.targetUserId ?? req.callerId;
    return service.linkedOrThrow(id, id === req.callerId, p);
  };
  /** First lookup of a new account: mention that tracking started (graphs/recaps fill from now). */
  const withNote = (r: Reply): Reply => {
    if (newNote) r.embed.description = [r.embed.description, `_${newNote}_`].filter(Boolean).join('\n');
    return r;
  };
  const needGuild = () => {
    if (!req.guildId) throw new UserError('This command only works in a server.');
    return req.guildId;
  };
  const need = (v: string | undefined, usage: string) => {
    if (!v) throw new UserError(`Usage: \`${p}${usage}\``);
    return v;
  };

  // Explicit queue, else the caller's /mode, else Solo/Duo. Ranked 5s is resolved per command (needs a player).
  const queue = service.queueFor(req.callerId, req.queue);

  switch (req.name) {
    case 'mode': {
      if (req.queue === undefined) {
        return only(info(`Default mode: ${queueName(queue)}`, `Stats commands use **${queueName(queue)}** unless you add a queue.\nChange it with \`${p}mode solo\`, \`${p}mode flex\` or \`${p}mode 5s\`.`));
      }
      service.setDefaultQueue(req.callerId, req.queue);
      return only(info(`Default mode set to ${queueName(req.queue)}`, `\`${p}daily\`, \`${p}weekly\`, \`${p}graph\` and \`${p}leaderboard\` now use **${queueName(req.queue)}** when you don't name a queue (\`${p}recent\` always shows the latest ranked game). Add \`${req.queue === FLEX || req.queue === FIVES ? 'solo' : 'flex'}\` at the end to override once.`, COLORS.win));
    }

    case 'help':
      return only(helpEmbed(p));

    case 'link': {
      // No Riot ID: just the panel (accounts + Add / Remove / Set main buttons).
      if (!req.riotId) return linkPanel(service, req.callerId, p);
      const r = await service.linkUser(req.callerId, req.region, req.riotId);
      return linkPanel(service, req.callerId, p, { status: linkedStatus(r) });
    }

    case 'unlink': {
      // Several accounts and none named: open the panel's remove picker.
      if (!req.account && service.linkedAccounts(req.callerId).length > 1) return linkPanel(service, req.callerId, p, { mode: 'remove' });
      const r = service.unlinkUser(req.callerId, req.account);
      return linkPanel(service, req.callerId, p, { status: unlinkedStatus(r) });
    }

    case 'profile':
      return withNote(await service.profile(await target()));

    case 'recent':
      // A Discord user (self or @mention): newest game across all their linked accounts.
      if (!req.riotId) {
        const id = req.targetUserId ?? req.callerId;
        return service.recentAcross(service.linkedAllOrThrow(id, id === req.callerId, p), req.queue);
      }
      // No queue given: newest ranked game of any queue; /mode deliberately doesn't apply.
      return withNote(await service.recent(await target(), req.queue));

    case 'graph': {
      const pl = await target();
      try {
        return withNote(await service.graph(pl, await service.resolveQueue(queue, pl), Math.min(200, Math.max(5, req.games ?? 50))));
      } catch (e) {
        if (newNote && e instanceof UserError) throw new UserError(`${newNote} The graph fills up as they play.`);
        throw e;
      }
    }

    case 'daily':
    case 'weekly':
    {
      const pl = await target();
      return withNote(await service.personalRecap(pl, req.name, await service.resolveQueue(queue, pl), req.window ?? 'today'));
    }

    case 'scout':
      return service.banPlan(need(req.riotId, 'scout <Name#TAG> [region]'), req.region);

    case 'leaderboard':
      return service.leaderboard(needGuild(), req.period ?? 'daily', await service.resolveQueue(queue));

    case 'track': {
      const guildId = needGuild();
      const sub = req.sub ?? 'list';
      if (sub !== 'list' && !req.canManageGuild) throw new UserError('You need the **Manage Server** permission to change tracked accounts.');
      if (sub === 'add') {
        const usage = 'track add <region> <Name#TAG>';
        const r = await service.addPlayer(guildId, need(req.region, usage), need(req.riotId, usage), req.callerId);
        const title = r.alreadyTracked ? `Already tracking ${tag(r.player)}` : `Now tracking ${tag(r.player)} · ${PLATFORM_LABEL[r.player.platform]}`;
        return only(info(title, ranksText(r.entries), r.alreadyTracked ? COLORS.info : COLORS.win));
      }
      if (sub === 'remove') {
        const acc = need(req.account, 'track remove <Name#TAG>');
        const pl = acc.includes('#') ? service.removePlayer(guildId, acc) : service.removeTracked(guildId, acc);
        return only(info('Removed from this server', `**${tag(pl)}** is off this server's leaderboard. Their history is kept and they're still tracked globally.`));
      }
      const rows = service.listPlayers(guildId);
      const body = rows.length
        ? rows.map((r) => `**${tag(r.player)}** · ${PLATFORM_LABEL[r.player.platform]} — ${r.ranks.filter((x) => QUEUE_NAME[x.queue]).map((x) => `${QUEUE_NAME[x.queue]}: ${x.rank}`).join(' · ') || 'Unranked'}`).join('\n')
        : `Nothing tracked yet. Use \`${p}track add\`.`;
      return only(info(`Tracked accounts (${rows.length})`, body.slice(0, 4000)));
    }
  }
}
