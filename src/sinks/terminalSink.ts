import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { GuildRow } from '../db/repo.ts';
import { validateEmbed, type Embed } from '../render/embed.ts';
import { renderPreviewPage, type PreviewMessage } from '../render/htmlPreview.ts';
import { renderEmbedToTerminal } from '../render/terminal.ts';
import type { Sink } from './sink.ts';

/**
 * Prints embeds to stdout, and writes:
 *  - previews/<guild>/<n>-<label>.json : Discohook / webhook payload ({ embeds: [...] })
 *  - previews/index.html               : offline Discord-style preview of every message so far
 */
export class TerminalSink implements Sink {
  private readonly logPath: string;

  constructor(private readonly dir: string, private readonly print = true) {
    mkdirSync(dir, { recursive: true });
    this.logPath = join(dir, 'messages.json');
  }

  async send(guild: GuildRow, kind: 'game' | 'digest' | 'notice', embeds: Embed[], meta?: { label?: string }): Promise<void> {
    for (const e of embeds) {
      const errs = validateEmbed(e);
      if (errs.length) console.warn(`⚠ embed would be rejected by Discord: ${errs.join(', ')}`);
    }
    if (this.print) {
      console.log(`\n── [${guild.guild_id}] #${guild.log_channel_id ?? 'log'} · ${kind} ──`);
      for (const e of embeds) console.log(renderEmbedToTerminal(e));
    }

    const gdir = join(this.dir, guild.guild_id.replace(/[^\w.-]/g, '_'));
    mkdirSync(gdir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const label = (meta?.label ?? kind).replace(/[^\w.-]/g, '_');
    writeFileSync(join(gdir, `${stamp}-${label}.json`), JSON.stringify({ content: null, embeds }, null, 2));

    const log: PreviewMessage[] = existsSync(this.logPath) ? JSON.parse(readFileSync(this.logPath, 'utf8')) : [];
    log.push({ at: Date.now(), channel: `${guild.guild_id}/${guild.log_channel_id ?? 'log'}`, embeds });
    const trimmed = log.slice(-200);
    writeFileSync(this.logPath, JSON.stringify(trimmed));
    writeFileSync(join(this.dir, 'index.html'), renderPreviewPage([...trimmed].reverse()));
  }
}
