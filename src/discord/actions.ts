import { formatRank } from '../core/rank.ts';
import { FLEX, queueName, UserError, type Reply, type Service } from '../core/service.ts';
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

const QUEUE_NAME: Record<string, string> = { RANKED_SOLO_5x5: 'Solo/Duo', RANKED_FLEX_SR: 'Flex' };
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
  return info('Zeke commands', [
    `${c('link <region> <Name#TAG>')} link your Riot account`,
    `${c('unlink')} remove your link`,
    `${c('mode [solo|flex]')} your default queue for stats commands (default Solo/Duo)`,
    `${c('profile [@user | Name#TAG [region]]')} rank, W/L, ladder position, top champions`,
    `${c('recent [@user | Name#TAG [region]] [solo|flex]')} latest game scoreboard`,
    `${c('graph [@user | Name#TAG [region]] [games] [solo|flex]')} LP graph`,
    `${c('daily [24h]')} today's games and LP, or the past 24h · ${c('weekly')} past 7 days (same arguments as recent)`,
    '_Accounts are tracked globally: once anyone adds or looks one up, its games are recorded everywhere._',
    `${c('scout <Name#TAG> [region]')} Scout a Ranked 5s / Flex team: roles, best champs, bans (aliases ${c('banfor')}, ${c('ban')})`,
    '',
    '**Server only**',
    `${c('leaderboard [daily|weekly] [solo|flex]')} LP leaderboard`,
    `${c('track add <region> <Name#TAG>')} · ${c('track remove <Name#TAG>')} · ${c('track list')} (Manage Server)`,
    '',
    `_Queue is always the last argument; without one, your ${c('mode')} is used (Solo/Duo unless changed)._`,
    `Regions: ${Object.values(PLATFORM_LABEL).join(' ')}`,
  ].join('\n'));
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

  const queue = service.queueFor(req.callerId, req.queue);

  switch (req.name) {
    case 'mode': {
      if (req.queue === undefined) {
        return only(info(`Default mode: ${queueName(queue)}`, `Stats commands use **${queueName(queue)}** unless you add a queue.\nChange it with \`${p}mode solo\` or \`${p}mode flex\`.`));
      }
      service.setDefaultQueue(req.callerId, req.queue);
      return only(info(`Default mode set to ${queueName(req.queue)}`, `\`${p}recent\`, \`${p}daily\`, \`${p}weekly\`, \`${p}graph\` and \`${p}leaderboard\` now use **${queueName(req.queue)}** when you don't name a queue. Add \`${req.queue === FLEX ? 'solo' : 'flex'}\` at the end to override once.`, COLORS.win));
    }

    case 'help':
      return only(helpEmbed(p));

    case 'link': {
      const r = await service.linkUser(req.callerId, need(req.region, 'link <region> <Name#TAG>'), need(req.riotId, 'link <region> <Name#TAG>'));
      const prev = r.previous ? `\nReplaced previous link **${tag(r.previous)}**.` : '';
      return only(info(`Linked ${tag(r.player)} · ${PLATFORM_LABEL[r.player.platform]}`,
        `${ranksText(r.entries)}${prev}\n\nGames from now on are recorded for \`${p}daily\`, \`${p}weekly\` and \`${p}graph\`.`, COLORS.win));
    }

    case 'unlink': {
      const pl = service.unlinkUser(req.callerId);
      return only(info('Unlinked', `**${tag(pl)}** is no longer linked to you.`));
    }

    case 'profile':
      return withNote(await service.profile(await target()));

    case 'recent':
      return withNote(await service.recent(await target(), queue));

    case 'graph': {
      const pl = await target();
      try {
        return withNote(await service.graph(pl, queue, Math.min(200, Math.max(5, req.games ?? 50))));
      } catch (e) {
        if (newNote && e instanceof UserError) throw new UserError(`${newNote} The graph fills up as they play.`);
        throw e;
      }
    }

    case 'daily':
    case 'weekly':
      return withNote(await service.personalRecap(await target(), req.name, queue, req.window ?? 'today'));

    case 'scout':
      return service.banPlan(need(req.riotId, 'scout <Name#TAG> [region]'), req.region);

    case 'leaderboard':
      return service.leaderboard(needGuild(), req.period ?? 'daily', queue);

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
