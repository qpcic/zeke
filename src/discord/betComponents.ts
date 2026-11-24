import { MessageFlags, type ButtonInteraction, type ModalSubmitInteraction } from 'discord.js';
import { BET_PREFIX, BetError } from '../core/bets.ts';
import type { Service } from '../core/service.ts';
import type { CommandLogger } from './commandLog.ts';
import { editPayload, payload } from './handlers.ts';

/**
 * Bet buttons on a round post: Win / Lose open a modal for the amount, My points answers privately.
 * Custom ids: bet:w:<round> / bet:l:<round> / bet:p:<round>, modal bet:m:<w|l>:<round>.
 */
export function betModal(side: 'w' | 'l', roundId: number, balance: number) {
  return {
    title: side === 'w' ? 'Bet on a win' : 'Bet on a loss',
    custom_id: `${BET_PREFIX}m:${side}:${roundId}`,
    components: [{
      type: 1,
      components: [{
        type: 4, custom_id: 'amount', style: 1, required: true, max_length: 12,
        label: `Points (you have ${balance.toLocaleString('en-US')})`,
        placeholder: '100, 1k, half or all',
        value: String(Math.min(100, Math.max(1, balance))),
      }],
    }],
  };
}

export async function onBetComponent(service: Service, i: ButtonInteraction | ModalSubmitInteraction, log: (m: string) => void, cmdLog?: CommandLogger) {
  const parts = i.customId.slice(BET_PREFIX.length).split(':');
  const guildId = i.guildId;
  const started = Date.now();
  const audit = (text: string, ok = true, error?: string) => cmdLog?.({
    text, name: 'bet', style: 'panel', userId: i.user.id, userName: i.user.username,
    guildId, guildName: i.guild?.name, channelId: i.channelId, ok, error, ms: Date.now() - started,
  });
  if (!guildId) return;
  try {
    if (i.isButton()) {
      const [kind, id] = parts;
      if (kind === 'p') {
        await i.reply({ ...payload(service.bets.pointsReply(guildId, i.user.id)), flags: MessageFlags.Ephemeral });
        return;
      }
      if (kind === 'w' || kind === 'l') {
        await i.showModal(betModal(kind, Number(id), service.bets.balance(guildId, i.user.id)));
      }
      return;
    }
    // modal: bet:m:<w|l>:<round>
    const [, side, id] = parts;
    const amount = i.fields.getTextInputValue('amount');
    const r = service.bets.place(Number(id), i.user.id, side === 'w' ? 'win' : 'loss', amount);
    if (i.isFromMessage()) await i.update(editPayload(r.reply)); // keeps the draft image
    else await i.deferUpdate();
    await i.followUp({ content: r.note, flags: MessageFlags.Ephemeral });
    audit(`bet ${side === 'w' ? 'win' : 'loss'} ${amount} on round ${id}`);
  } catch (e) {
    const msg = e instanceof BetError ? e.message : 'Something went wrong placing that bet.';
    if (!(e instanceof BetError)) log(`bet failed: ${(e as Error).stack}`);
    audit(i.customId, false, (e as Error).message);
    const r = { content: msg, flags: MessageFlags.Ephemeral } as const;
    if (i.replied || i.deferred) await i.followUp(r).catch(() => {});
    else await i.reply(r).catch(() => {});
  }
}
