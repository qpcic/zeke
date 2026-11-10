import { bootstrap } from '../src/bootstrap.ts';
import type { GuildRow } from '../src/db/repo.ts';
import { MockRiot, mulberry32 } from '../src/dev/mockRiot.ts';
import type { Embed } from '../src/render/embed.ts';
import type { Sink } from '../src/sinks/sink.ts';

export class CaptureSink implements Sink {
  sent: { guild: string; kind: string; embeds: Embed[] }[] = [];
  async send(guild: GuildRow, kind: 'game' | 'digest' | 'notice', embeds: Embed[]) {
    this.sent.push({ guild: guild.guild_id, kind, embeds });
  }
  take() {
    const s = this.sent;
    this.sent = [];
    return s;
  }
}


export function setup(startMs = Date.UTC(2026, 10, 10, 12, 0, 0)) {
  let t = startMs;
  const clock = { now: () => t, advance: (ms: number) => { t += ms; } };
  const mock = new MockRiot(clock, mulberry32(42));
  const sink = new CaptureSink();
  const app = bootstrap({
    dbPath: ':memory:',
    now: clock.now,
    sink,
    riot: { apiKey: 'test', fetch: mock.fetch, baseUrl: (h) => `http://mock/${h}` },
  });
  return { clock, mock, sink, ...app };
}
