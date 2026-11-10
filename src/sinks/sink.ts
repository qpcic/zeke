import type { GuildRow } from '../db/repo.ts';
import type { Embed } from '../render/embed.ts';

/**
 * Where messages go. TerminalSink now; a DiscordSink later implements the same
 * interface (channel = guild.log_channel_id) and nothing upstream changes.
 */
export interface Sink {
  send(guild: GuildRow, kind: 'game' | 'digest' | 'notice', embeds: Embed[], meta?: { label?: string }): Promise<void>;
}
