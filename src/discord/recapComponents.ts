import { MessageFlags, PermissionFlagsBits, type ButtonInteraction, type ChannelSelectMenuInteraction, type GuildBasedChannel } from 'discord.js';
import type { Service } from '../core/service.ts';
import { previousDay } from '../core/time.ts';
import type { CommandLogger } from './commandLog.ts';
import { payload } from './handlers.ts';
import { GLOG_PREFIX, logPanel, parseGlogId, parseRecapId, recapPanel } from './recapPanel.ts';

/** Permissions the bot needs in the recap channel; returns what's missing. */
export function missingRecapPerms(ch: GuildBasedChannel, botId: string): string[] {
  const perms = ch.permissionsFor(botId);
  const need: [bigint, string][] = [
    [PermissionFlagsBits.ViewChannel, 'View Channel'],
    [PermissionFlagsBits.SendMessages, 'Send Messages'],
    [PermissionFlagsBits.EmbedLinks, 'Embed Links'],
    [PermissionFlagsBits.AttachFiles, 'Attach Files'],
  ];
  return need.filter(([p]) => !perms?.has(p)).map(([, n]) => n);
}

export async function onRecapComponent(service: Service, i: ButtonInteraction | ChannelSelectMenuInteraction, log: (m: string) => void, cmdLog?: CommandLogger): Promise<void> {
  if (i.customId.startsWith(GLOG_PREFIX)) return onLogComponent(service, i, log, cmdLog);
  const id = parseRecapId(i.customId);
  if (!id) return;
  const started = Date.now();
  const audit = (what: string) =>
    cmdLog?.({ text: `[recap panel] ${what}`, name: 'recap-panel', style: 'panel', userId: i.user.id, userName: i.user.username, guildId: i.guildId, guildName: i.guild?.name, channelId: i.channelId, ok: true, ms: Date.now() - started });
  try {
    if (i.guildId !== id.guildId || !i.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await i.reply({ content: 'You need the **Manage Server** permission to change the daily recap.', flags: MessageFlags.Ephemeral });
      return;
    }
    if (id.action === 'channel' && i.isChannelSelectMenu()) {
      const ch = i.guild?.channels.cache.get(i.values[0]!) ?? (await i.guild?.channels.fetch(i.values[0]!).catch(() => null));
      const missing = ch ? missingRecapPerms(ch, i.client.user.id) : ['View Channel'];
      if (missing.length) {
        await i.update(payload(recapPanel(service, id.guildId, { status: `I can't post in <#${i.values[0]}>: missing **${missing.join(', ')}**.`, ok: false })));
        return;
      }
      service.setRecapChannel(id.guildId, i.values[0]!);
      audit(`channel #${i.values[0]}`);
      await i.update(payload(recapPanel(service, id.guildId, { status: `Daily recap will be posted in <#${i.values[0]}>.` })));
      return;
    }
    if (id.action === 'off' && i.isButton()) {
      service.setRecapChannel(id.guildId, null);
      audit('off');
      await i.update(payload(recapPanel(service, id.guildId, { status: 'Daily recap turned off.' })));
      return;
    }
    if (id.action === 'preview' && i.isButton()) {
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      const g = service.guild(id.guildId);
      const replies = await service.dailyRecap(id.guildId, previousDay(Date.now(), g.timezone));
      await i.editReply(recapMessage(replies));
      return;
    }
  } catch (e) {
    log(`recap panel ${id.action} failed: ${(e as Error).stack}`);
  }
}

/** Several leaderboard replies (one per queue) as one Discord message. */
export function recapMessage(replies: import('../core/service.ts').Reply[]) {
  const parts = replies.slice(0, 10).map(payload);
  return { embeds: parts.flatMap((p) => p.embeds), files: parts.flatMap((p) => p.files) };
}

/** /log panel: channel picker and Turn off for the server's game log. */
async function onLogComponent(service: Service, i: ButtonInteraction | ChannelSelectMenuInteraction, log: (m: string) => void, cmdLog?: CommandLogger): Promise<void> {
  const id = parseGlogId(i.customId);
  if (!id) return;
  const started = Date.now();
  const audit = (what: string) =>
    cmdLog?.({ text: `[log panel] ${what}`, name: 'log-panel', style: 'panel', userId: i.user.id, userName: i.user.username, guildId: i.guildId, guildName: i.guild?.name, channelId: i.channelId, ok: true, ms: Date.now() - started });
  try {
    if (i.guildId !== id.guildId || !i.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await i.reply({ content: 'You need the **Manage Server** permission to change the game log.', flags: MessageFlags.Ephemeral });
      return;
    }
    if (id.action === 'channel' && i.isChannelSelectMenu()) {
      const ch = i.guild?.channels.cache.get(i.values[0]!) ?? (await i.guild?.channels.fetch(i.values[0]!).catch(() => null));
      const missing = ch ? missingRecapPerms(ch, i.client.user.id) : ['View Channel'];
      if (missing.length) {
        await i.update(payload(logPanel(service, id.guildId, { status: `I can't post in <#${i.values[0]}>: missing **${missing.join(', ')}**.`, ok: false })));
        return;
      }
      service.setLogChannel(id.guildId, i.values[0]!);
      audit(`channel #${i.values[0]}`);
      await i.update(payload(logPanel(service, id.guildId, { status: `New games will be logged in <#${i.values[0]}>.` })));
      return;
    }
    if (id.action === 'off' && i.isButton()) {
      service.setLogChannel(id.guildId, null);
      audit('off');
      await i.update(payload(logPanel(service, id.guildId, { status: 'Game log turned off.' })));
    }
  } catch (e) {
    log(`log panel ${id.action} failed: ${(e as Error).stack}`);
  }
}
