import { MessageFlags, type ButtonInteraction, type ModalSubmitInteraction, type StringSelectMenuInteraction } from 'discord.js';
import { UserError, type Service } from '../core/service.ts';
import { config } from '../config.ts';
import { PLATFORM_LABEL } from '../riot/regions.ts';
import type { CommandLogger } from './commandLog.ts';
import { payload } from './handlers.ts';
import { addAccountModal, linkedStatus, linkPanel, parseLinkId, unlinkedStatus, type PanelMode } from './linkPanel.ts';

export { LINK_PREFIX } from './linkPanel.ts';

type LinkInteraction = ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction;

/** Buttons, selects and the add-account form on a /link panel. */
export async function onLinkComponent(service: Service, i: LinkInteraction, log: (m: string) => void, cmdLog?: CommandLogger): Promise<void> {
  const id = parseLinkId(i.customId);
  if (!id) return;
  const started = Date.now();
  const style = i.message?.interactionMetadata ? '/' : config.prefix || '/';
  const audit = (what: string, ok = true, error?: string) =>
    cmdLog?.({ text: `[link panel] ${what}`, name: 'link-panel', style: 'panel', userId: i.user.id, userName: i.user.username, guildId: i.guildId, guildName: i.guild?.name, channelId: i.channelId, ok, error, ms: Date.now() - started });

  try {
    if (i.user.id !== id.owner) {
      await i.reply({ content: `This panel belongs to <@${id.owner}>. Use \`/link\` for your own.`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
      return;
    }
    const panel = (opts: { status?: string; ok?: boolean; mode?: PanelMode } = {}) => payload(linkPanel(service, id.owner, style, opts));

    switch (id.action) {
      case 'add': {
        if (!i.isButton()) return;
        const main = service.linkedAccounts(id.owner)[0];
        await i.showModal(addAccountModal(id.owner, main ? PLATFORM_LABEL[main.platform] : config.defaultRegion));
        return;
      }
      case 'modal': {
        if (!i.isModalSubmit()) return;
        const riotId = i.fields.getTextInputValue('riot_id').trim();
        const region = i.fields.getTextInputValue('region').trim() || undefined;
        // Riot lookups can take a few seconds: acknowledge first, then edit the panel.
        if (i.isFromMessage()) await i.deferUpdate();
        else await i.deferReply({ flags: MessageFlags.Ephemeral });
        try {
          const r = await service.linkUser(id.owner, region, riotId);
          audit(`add ${riotId}`);
          await i.editReply(panel({ status: linkedStatus(r) }));
        } catch (e) {
          if (!(e instanceof UserError)) log(`link panel add failed: ${(e as Error).stack}`);
          audit(`add ${riotId}`, false, (e as Error).message);
          await i.editReply(panel({ status: e instanceof UserError ? e.message : 'Riot or Discord had a hiccup. Try again in a minute.', ok: false }));
        }
        return;
      }
      case 'remove':
      case 'main':
        if (i.isButton()) await i.update(panel({ mode: id.action }));
        return;
      case 'cancel':
        if (i.isButton()) await i.update(panel());
        return;
      case 'rmpick': {
        if (!i.isStringSelectMenu()) return;
        try {
          const r = service.unlinkUser(id.owner, i.values[0]);
          audit(`remove ${r.player.game_name}#${r.player.tag_line}`);
          await i.update(panel({ status: unlinkedStatus(r) }));
        } catch (e) {
          await i.update(panel({ status: (e as Error).message, ok: false }));
        }
        return;
      }
      case 'mainpick': {
        if (!i.isStringSelectMenu()) return;
        try {
          const p = service.setMainAccount(id.owner, i.values[0]!);
          audit(`main ${p.game_name}#${p.tag_line}`);
          await i.update(panel({ status: `**${p.game_name}#${p.tag_line}** is your main account now.` }));
        } catch (e) {
          await i.update(panel({ status: (e as Error).message, ok: false }));
        }
        return;
      }
    }
  } catch (e) {
    log(`link panel ${id.action} failed: ${(e as Error).stack}`);
    try {
      if (!i.replied && !i.deferred) await i.reply({ content: 'That panel expired. Run `/link` again.', flags: MessageFlags.Ephemeral });
    } catch {
      /* interaction expired */
    }
  }
}
