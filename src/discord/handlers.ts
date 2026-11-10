import {
  MessageFlags,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type Interaction,
} from 'discord.js';
import { formatRank } from '../core/rank.ts';
import { UserError, type Service } from '../core/service.ts';
import type { PlayerRow } from '../db/repo.ts';
import { COLORS, type Embed } from '../render/embed.ts';
import { PLATFORM_LABEL } from '../riot/regions.ts';
import type { LeagueEntryDto } from '../riot/types.ts';

const QUEUE_NAME: Record<string, string> = { RANKED_SOLO_5x5: 'Solo/Duo', RANKED_FLEX_SR: 'Flex' };

const tag = (p: PlayerRow) => `${p.game_name}#${p.tag_line}`;

function ranksText(entries: LeagueEntryDto[]): string {
  const rs = entries
    .filter((e) => QUEUE_NAME[e.queueType])
    .map((e) => `${QUEUE_NAME[e.queueType]}: **${formatRank({ tier: e.tier, division: e.rank, lp: e.leaguePoints })}** (${e.wins}W ${e.losses}L)`);
  return rs.join('\n') || 'Unranked';
}

const info = (title: string, description: string, color: number = COLORS.info): Embed => ({ title, description, color });

export function createInteractionHandler(service: Service, log: (m: string) => void) {
  async function onCommand(i: ChatInputCommandInteraction) {
    const selfOrTarget = () => {
      const u = i.options.getUser('user');
      return service.linkedOrThrow(u?.id ?? i.user.id, !u || u.id === i.user.id);
    };

    switch (i.commandName) {
      case 'link': {
        await i.deferReply({ flags: MessageFlags.Ephemeral });
        const r = await service.linkUser(i.user.id, i.options.getString('region', true), i.options.getString('riot_id', true));
        const prev = r.previous ? `\nReplaced previous link **${tag(r.previous)}**.` : '';
        await i.editReply({ embeds: [info(`Linked ${tag(r.player)} · ${PLATFORM_LABEL[r.player.platform]}`, ranksText(r.entries) + prev + '\n\nGames from now on are recorded for `/daily`, `/weekly` and `/recent`.', COLORS.win)] });
        return;
      }
      case 'unlink': {
        const p = service.unlinkUser(i.user.id);
        await i.reply({ flags: MessageFlags.Ephemeral, embeds: [info('Unlinked', `**${tag(p)}** is no longer linked to you.`)] });
        return;
      }
      case 'recent': {
        const player = selfOrTarget();
        await i.deferReply();
        await i.editReply({ embeds: [await service.recent(player)] });
        return;
      }
      case 'daily':
      case 'weekly': {
        const player = selfOrTarget();
        await i.reply({ embeds: [service.personalRecap(player, i.commandName)] });
        return;
      }
      case 'leaderboard': {
        const period = i.options.getString('period', true) === 'weekly' ? 'weekly' : 'daily';
        await i.reply({ embeds: [service.leaderboard(i.guildId!, period)] });
        return;
      }
      case 'track': {
        const guildId = i.guildId!;
        const sub = i.options.getSubcommand();
        if (sub === 'add') {
          await i.deferReply();
          const r = await service.addPlayer(guildId, i.options.getString('region', true), i.options.getString('riot_id', true), i.user.id);
          const title = r.alreadyTracked ? `Already tracking ${tag(r.player)}` : `Now tracking ${tag(r.player)} · ${PLATFORM_LABEL[r.player.platform]}`;
          await i.editReply({ embeds: [info(title, ranksText(r.entries), r.alreadyTracked ? COLORS.info : COLORS.win)] });
        } else if (sub === 'remove') {
          const p = service.removeTracked(guildId, i.options.getString('account', true));
          await i.reply({ embeds: [info('Stopped tracking', `**${tag(p)}**`)] });
        } else {
          const rows = service.listPlayers(guildId);
          const body = rows.length
            ? rows.map((r) => `**${tag(r.player)}** · ${PLATFORM_LABEL[r.player.platform]} — ${r.ranks.filter((x) => QUEUE_NAME[x.queue]).map((x) => `${QUEUE_NAME[x.queue]}: ${x.rank}`).join(' · ') || 'Unranked'}`).join('\n')
            : 'Nothing tracked yet. Use `/track add`.';
          await i.reply({ embeds: [info(`Tracked accounts (${rows.length})`, body.slice(0, 4000))] });
        }
        return;
      }
    }
  }

  async function onAutocomplete(i: AutocompleteInteraction) {
    if (i.commandName !== 'track' || !i.guildId) return i.respond([]);
    const q = i.options.getFocused().toLowerCase();
    const choices = service.listPlayers(i.guildId)
      .map((r) => r.player)
      .filter((p) => tag(p).toLowerCase().includes(q))
      .slice(0, 25)
      .map((p) => ({ name: `${tag(p)} (${PLATFORM_LABEL[p.platform]})`, value: p.puuid.slice(0, 100) }));
    await i.respond(choices);
  }

  return async function handle(i: Interaction) {
    if (i.isAutocomplete()) {
      await onAutocomplete(i).catch((e) => log(`autocomplete failed: ${(e as Error).message}`));
      return;
    }
    if (!i.isChatInputCommand()) return;
    try {
      await onCommand(i);
    } catch (e) {
      const user = e instanceof UserError;
      if (!user) log(`/${i.commandName} failed: ${(e as Error).stack}`);
      const msg = { embeds: [info(user ? 'Hmm' : 'Something went wrong', user ? (e as Error).message : 'Riot or Discord had a hiccup. Try again in a minute.', COLORS.loss)] };
      try {
        if (i.deferred || i.replied) await i.editReply(msg);
        else await i.reply({ ...msg, flags: MessageFlags.Ephemeral });
      } catch {
        /* interaction expired */
      }
    }
  };
}
