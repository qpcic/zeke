import {
  AttachmentBuilder,
  MessageFlags,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type Interaction,
} from 'discord.js';
import { UserError, type Reply, type Service } from '../core/service.ts';
import { COLORS } from '../render/embed.ts';
import { PLATFORM_LABEL } from '../riot/regions.ts';
import { info, PRIVATE, runCommand, tag, type CommandName, type CommandRequest } from './actions.ts';
import type { CommandLogger } from './commandLog.ts';
import { LINK_PREFIX, onLinkComponent } from './linkComponents.ts';
import { onRecapComponent } from './recapComponents.ts';
import { membersOf } from './members.ts';
import { BET_PREFIX } from '../core/bets.ts';
import { onBetComponent } from './betComponents.ts';
import { GLOG_PREFIX, RECAP_PREFIX } from './recapPanel.ts';

export const payload = (r: Reply) => ({
  embeds: [r.embed],
  files: r.files.map((f) => new AttachmentBuilder(f.data, { name: f.name })),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- raw API component JSON
  ...(r.components ? { components: r.components as any[] } : {}),
});

export const errorEmbed = (e: unknown) => {
  const user = e instanceof UserError;
  return info(user ? 'Hmm' : 'Something went wrong', user ? (e as Error).message : 'Riot or Discord had a hiccup. Try again in a minute.', COLORS.loss);
};

function toRequest(i: ChatInputCommandInteraction): CommandRequest {
  const o = i.options;
  const sub = i.commandName === 'track' ? (o.getSubcommand() as CommandRequest['sub']) : undefined;
  return {
    name: i.commandName as CommandName,
    callerId: i.user.id,
    targetUserId: o.getUser('user')?.id,
    guildId: i.guildId,
    guildName: i.guild?.name,
    serverCount: i.client.guilds.cache.size,
    champion: i.commandName === 'champ' ? o.getString('champion') ?? undefined : undefined,
    riotIds: i.commandName === 'scout'
      ? [o.getString('riot_id'), o.getString('player_2'), o.getString('player_3'), o.getString('player_4'), o.getString('player_5')].filter((x): x is string => !!x)
      : undefined,
    // Discord enforces default_member_permissions (Manage Server) on /track itself.
    canManageGuild: true,
    style: '/',
    region: o.getString('region') ?? undefined,
    riotId: o.getString('riot_id') ?? undefined,
    period: o.getString('period') === 'weekly' ? 'weekly' : o.getString('period') ? 'daily' : undefined,
    queue: o.getString('queue') ? Number(o.getString('queue')) : undefined,
    games: o.getInteger('games') ?? undefined,
    window: o.getString('window') === '24h' ? '24h' : o.getString('window') === 'today' ? 'today' : undefined,
    sub,
    account: sub === 'remove' || i.commandName === 'unlink' ? o.getString('account') ?? undefined : undefined,
    compare: i.commandName === 'graph' && o.getString('compare')
      ? o.getString('compare')!.replace(/(<@!?\d+>)/g, ',$1,').split(',').map((x) => x.trim()).filter(Boolean)
      : undefined,
    compareWithTarget: i.commandName === 'graph' ? true : undefined,
    days: i.commandName === 'graph' ? o.getInteger('days') ?? undefined : undefined,
    channelId: ['recap', 'log', 'bets'].includes(i.commandName) ? o.getChannel('channel')?.id : undefined,
    off: ['recap', 'log', 'bets'].includes(i.commandName) ? o.getBoolean('off') ?? undefined : undefined,
  };
}

export function createInteractionHandler(service: Service, log: (m: string) => void, cmdLog?: CommandLogger) {
  async function onAutocomplete(i: AutocompleteInteraction) {
    if (i.commandName === 'champ') {
      const q = i.options.getFocused().toLowerCase().replace(/[^a-z0-9]/g, '');
      const names = await service.championNames();
      return i.respond(names.filter((n) => n.toLowerCase().replace(/[^a-z0-9]/g, '').includes(q)).slice(0, 25).map((n) => ({ name: n, value: n })));
    }
    if (i.commandName === 'unlink') {
      const q = i.options.getFocused().toLowerCase();
      return i.respond(service.linkedAccounts(i.user.id)
        .filter((p) => tag(p).toLowerCase().includes(q))
        .slice(0, 25)
        .map((p) => ({ name: `${tag(p)} (${PLATFORM_LABEL[p.platform]})${p.is_main ? ' · main' : ''}`, value: p.puuid.slice(0, 100) })));
    }
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
    if ((i.isButton() || i.isStringSelectMenu() || i.isModalSubmit()) && i.customId.startsWith(LINK_PREFIX)) {
      await onLinkComponent(service, i, log, cmdLog);
      return;
    }
    if ((i.isButton() || i.isChannelSelectMenu()) && (i.customId.startsWith(RECAP_PREFIX) || i.customId.startsWith(GLOG_PREFIX))) {
      await onRecapComponent(service, i, log, cmdLog);
      return;
    }
    if ((i.isButton() || i.isModalSubmit()) && i.customId.startsWith(BET_PREFIX)) {
      await onBetComponent(service, i, log, cmdLog);
      return;
    }
    if (!i.isChatInputCommand()) return;
    const req = toRequest(i);
    const started = Date.now();
    const audit = (ok: boolean, error?: string) =>
      cmdLog?.({
        text: i.toString(),
        name: i.commandName,
        style: '/',
        userId: i.user.id,
        userName: i.user.username,
        guildId: i.guildId,
        guildName: i.guild?.name,
        channelId: i.channelId,
        ok,
        error,
        ms: Date.now() - started,
      });
    try {
      // Defer first: Riot calls + rendering can exceed Discord's 3s reply window.
      await i.deferReply(PRIVATE.has(req.name) ? { flags: MessageFlags.Ephemeral } : {});
      if (req.name === 'ladder' && i.guild) req.members = await membersOf(i.guild, service.linkedUserIds());
      const reply = await runCommand(service, req);
      await i.editReply(payload(reply));
      // LP not in yet: edit this reply when it is (interaction tokens last 15 min).
      if (reply.watch) service.watchRecent(reply.watch, (r) => i.editReply({ ...payload(r), attachments: [] }), 14 * 60_000);
      audit(true);
    } catch (e) {
      audit(false, (e as Error).message);
      if (!(e instanceof UserError)) log(`/${i.commandName} failed: ${(e as Error).stack}`);
      try {
        if (i.deferred || i.replied) await i.editReply({ embeds: [errorEmbed(e)], files: [] });
        else await i.reply({ embeds: [errorEmbed(e)], flags: MessageFlags.Ephemeral });
      } catch {
        /* interaction expired */
      }
    }
  };
}
