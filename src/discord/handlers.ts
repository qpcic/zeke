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
  };
}

export function createInteractionHandler(service: Service, log: (m: string) => void, cmdLog?: CommandLogger) {
  async function onAutocomplete(i: AutocompleteInteraction) {
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
    if (!i.isChatInputCommand()) return;
    const req = toRequest(i);
    const started = Date.now();
    const audit = (ok: boolean, error?: string) =>
      cmdLog?.({
        text: i.toString(),
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
      await i.editReply(payload(await runCommand(service, req)));
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
