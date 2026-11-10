import type { GuildRow } from '../db/repo.ts';
import type { Embed } from '../render/embed.ts';
import type { Sink } from './sink.ts';

/** Commands-only mode: nothing is posted; resolved games just get one log line. */
export class LogSink implements Sink {
  constructor(private readonly log: (m: string) => void) {}
  async send(_guild: GuildRow, kind: string, embeds: Embed[]): Promise<void> {
    for (const e of embeds) this.log(`${kind}: ${e.author?.name ?? ''} ${e.title ?? ''} ${e.description?.split('\n')[0]?.replace(/\*\*/g, '') ?? ''}`.trim());
  }
}
