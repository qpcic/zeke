import { formatRank } from '../core/rank.ts';
import { UserError, type Reply, type Service } from '../core/service.ts';
import type { PlayerRow } from '../db/repo.ts';
import { COLORS, type Embed } from '../render/embed.ts';
import { PLATFORM_LABEL } from '../riot/regions.ts';
import type { LeagueEntryDto } from '../riot/types.ts';

/**
 * Transport-agnostic command logic. Slash commands and $prefix messages both
 * parse into a CommandRequest and render the returned Reply.
 */
export type CommandName = 'link' | 'unlink' | 'recent' | 'graph' | 'daily' | 'weekly' | 'leaderboard' | 'track' | 'help';

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
  /** track remove: puuid (slash autocomplete) or "Name#TAG" (prefix). */
  account?: string;
}

/** Replies that should only be visible to the caller where the transport supports it. */
export const PRIVATE: ReadonlySet<CommandName> = new Set(['link', 'unlink', 'help']);

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
  return info('LeagueBot commands', [
    `${c('link <region> <Name#TAG>')} link your Riot account`,
    `${c('unlink')} remove your link`,
    `${c('recent [@user]')} latest game scoreboard`,
    `${c('graph [solo|flex] [games] [@user]')} LP graph`,
    `${c('daily [@user]')} · ${c('weekly [@user]')} your games and LP`,
    '',
    '**Server only**',
    `${c('leaderboard [daily|weekly]')} LP leaderboard`,
    `${c('track add <region> <Name#TAG>')} · ${c('track remove <Name#TAG>')} · ${c('track list')} (Manage Server)`,
    '',
    `Regions: ${Object.values(PLATFORM_LABEL).join(' ')}`,
  ].join('\n'));
}

export async function runCommand(service: Service, req: CommandRequest): Promise<Reply> {
  const p = req.style;
  const target = () => {
    const id = req.targetUserId ?? req.callerId;
    return service.linkedOrThrow(id, id === req.callerId, p);
  };
  const needGuild = () => {
    if (!req.guildId) throw new UserError('This command only works in a server.');
    return req.guildId;
  };
  const need = (v: string | undefined, usage: string) => {
    if (!v) throw new UserError(`Usage: \`${p}${usage}\``);
    return v;
  };

  switch (req.name) {
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

    case 'recent':
      return service.recent(target());

    case 'graph':
      return service.graph(target(), req.queue ?? 420, Math.min(200, Math.max(5, req.games ?? 50)));

    case 'daily':
    case 'weekly':
      return only(service.personalRecap(target(), req.name));

    case 'leaderboard':
      return only(service.leaderboard(needGuild(), req.period ?? 'daily'));

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
        return only(info('Stopped tracking', `**${tag(pl)}**`));
      }
      const rows = service.listPlayers(guildId);
      const body = rows.length
        ? rows.map((r) => `**${tag(r.player)}** · ${PLATFORM_LABEL[r.player.platform]} — ${r.ranks.filter((x) => QUEUE_NAME[x.queue]).map((x) => `${QUEUE_NAME[x.queue]}: ${x.rank}`).join(' · ') || 'Unranked'}`).join('\n')
        : `Nothing tracked yet. Use \`${p}track add\`.`;
      return only(info(`Tracked accounts (${rows.length})`, body.slice(0, 4000)));
    }
  }
}
