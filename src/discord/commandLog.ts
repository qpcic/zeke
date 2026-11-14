import type { Client } from 'discord.js';

/**
 * Audit trail of every command: one line to stdout (Railway logs) and, when
 * CONSOLE_CHANNEL_ID is set, the same line in that Discord channel.
 * Channel lines are batched (one message every few seconds) to stay well clear
 * of Discord's rate limits.
 */
export interface CommandLogEntry {
  /** What was typed, e.g. "/recent riot_id:Faker#KR1" or "$rs flex". */
  text: string;
  /** Command name for usage stats, e.g. "recent", "link-panel". */
  name?: string;
  /** How it was run: "/" slash, "$" prefix, "panel" button/menu. */
  style?: string;
  userId: string;
  userName: string;
  guildId: string | null;
  guildName?: string;
  channelId: string | null;
  ok: boolean;
  /** Short reason when ok is false. */
  error?: string;
  ms: number;
}

export type CommandLogger = (e: CommandLogEntry) => void;

const FLUSH_MS = 4000;
const MAX_MESSAGE = 1900;

const oneLine = (s: string, max: number) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
};
/** Keep user-typed text from breaking out of inline code. */
const code = (s: string) => '`' + s.replace(/`/g, 'ˋ') + '`';

export function formatStdout(e: CommandLogEntry): string {
  const where = e.guildId ? `${e.guildName ?? 'server'} (${e.guildId}) #${e.channelId}` : 'DM';
  const status = e.ok ? 'ok' : `failed: ${oneLine(e.error ?? 'error', 120)}`;
  return `cmd: ${oneLine(e.text, 200)} · ${e.userName} (${e.userId}) · ${where} · ${(e.ms / 1000).toFixed(1)}s · ${status}`;
}

export function formatChannel(e: CommandLogEntry, at = Date.now()): string {
  const where = e.guildId ? `${oneLine(e.guildName ?? 'server ' + e.guildId, 40)}${e.channelId ? ` <#${e.channelId}>` : ''}` : 'DM';
  const status = e.ok ? '✅' : '❌';
  const err = e.ok ? '' : ` · ${oneLine(e.error ?? 'error', 80)}`;
  return `<t:${Math.floor(at / 1000)}:T> ${status} <@${e.userId}> ${code(oneLine(e.text, 120))} · ${where} · ${(e.ms / 1000).toFixed(1)}s${err}`;
}

export function createCommandLogger(client: Client, consoleChannelId: string, log: (m: string) => void, record?: (e: CommandLogEntry) => void): CommandLogger {
  let queue: string[] = [];
  let timer: NodeJS.Timeout | undefined;

  async function flush() {
    timer = undefined;
    const lines = queue;
    queue = [];
    if (!lines.length) return;
    try {
      const ch = await client.channels.fetch(consoleChannelId);
      if (!ch || !ch.isSendable()) return;
      // Split into messages under Discord's 2000-char limit.
      let buf = '';
      for (const l of lines) {
        if (buf && buf.length + l.length + 1 > MAX_MESSAGE) {
          await ch.send({ content: buf, allowedMentions: { parse: [] } });
          buf = '';
        }
        buf += (buf ? '\n' : '') + l;
      }
      if (buf) await ch.send({ content: buf, allowedMentions: { parse: [] } });
    } catch (e) {
      log(`command log: could not post to console channel: ${(e as Error).message}`);
    }
  }

  return (e) => {
    log(formatStdout(e));
    try {
      record?.(e);
    } catch (err) {
      log(`command log: could not record usage: ${(err as Error).message}`);
    }
    if (!consoleChannelId) return;
    queue.push(formatChannel(e));
    if (queue.length > 200) queue = queue.slice(-200);
    timer ??= setTimeout(() => void flush(), FLUSH_MS);
  };
}

/** Logger for tests / CLI: stdout only. */
export const stdoutCommandLogger = (log: (m: string) => void): CommandLogger => (e) => log(formatStdout(e));
