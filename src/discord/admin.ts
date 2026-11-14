import { statSync } from 'node:fs';
import type { Client } from 'discord.js';
import type { Service } from '../core/service.ts';
import { health } from '../core/health.ts';
import type { Embed } from '../render/embed.ts';
import { COLORS } from '../render/embed.ts';

/** `$admin health` and `$admin stats`: owner console embeds. */

const dur = (ms: number) => {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : m ? `${m}m ${s % 60}s` : `${s}s`;
};
const mb = (b: number) => `${(b / 1024 / 1024).toFixed(1)} MB`;
const n = (x: number) => x.toLocaleString('en-US');
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '—');
const ts = (ms: number, style = 'R') => `<t:${Math.floor(ms / 1000)}:${style}>`;

function fileSize(path: string): number {
  let total = 0;
  for (const p of [path, `${path}-wal`, `${path}-shm`]) {
    try {
      total += statSync(p).size;
    } catch {
      /* missing wal/shm is fine */
    }
  }
  return total;
}

export function healthEmbed(service: Service, client: Client, o: { dbPath: string; pollIntervalSec: number }, now = Date.now()): Embed {
  const { api, limits } = service.riotHealth();
  const { counts: c, backlog } = service.dbHealth();
  const mem = process.memoryUsage();
  const t = health.lastTick;
  const late = backlog.oldestDueAt ? now - backlog.oldestDueAt : 0;
  const lateWarn = late > 3 * o.pollIntervalSec * 1000;
  const errorsApi = api.rateLimited + api.server + api.network + api.otherClient;
  const bad = lateWarn || (t && !t.ok) || api.rateLimited > 0 || (api.total > 20 && errorsApi / api.total > 0.05);
  const sha = process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7);

  const limitLines = limits.slice(0, 3).map((l) => `\`${l.host}\` ${l.used}/${l.count} per ${l.windowMs >= 60_000 ? `${l.windowMs / 60_000}m` : `${l.windowMs / 1000}s`}`);
  const topMethods = api.methods.slice(0, 5).map(([m, x]) => `\`${m}\` ${n(x.n)}${x.errors ? ` · ${x.errors} err` : ''}`);
  const errors = health.recentErrors(4).map((e) => `${ts(e.at)} ${e.msg.replace(/`/g, "'")}`);

  return {
    title: `${bad ? '🟠' : '🟢'} Health`,
    color: bad ? 0xd29922 : COLORS.win,
    fields: [
      {
        name: 'Process',
        value: [
          `Up **${dur(now - health.startedAt)}** · since ${ts(health.startedAt, 'f')}`,
          `Memory ${mb(mem.rss)} (heap ${mb(mem.heapUsed)}) · Node ${process.version}`,
          sha ? `Version \`${sha}\`` : null,
        ].filter(Boolean).join('\n'),
        inline: false,
      },
      {
        name: 'Discord',
        value: `Ping **${client.ws.ping >= 0 ? `${client.ws.ping} ms` : '—'}** · ${n(client.guilds.cache.size)} servers`,
        inline: true,
      },
      {
        name: 'Polling',
        value: [
          t ? `Last tick ${ts(t.at)} · ${(t.ms / 1000).toFixed(1)}s · ${t.ok ? 'ok' : '**failed**'}` : 'No tick yet',
          `${n(health.ticks)} ticks${health.failedTicks ? ` · **${health.failedTicks} failed**` : ''} · every ${o.pollIntervalSec}s`,
          `Queue: **${backlog.due}** due${backlog.due ? ` · oldest ${dur(late)} late${lateWarn ? ' ⚠️' : ''}` : ''}`,
          `${c.pending} game${c.pending === 1 ? '' : 's'} waiting for LP`,
        ].join('\n'),
        inline: true,
      },
      {
        name: 'Riot API · last hour',
        value: api.total
          ? [
            `**${n(api.total)}** requests · ${pct(api.ok, api.total)} ok · ${n(api.notFound)} not found`,
            `429: **${api.rateLimited}** · 5xx: ${api.server} · network: ${api.network}${api.otherClient ? ` · other 4xx: ${api.otherClient}` : ''}`,
            `Latency p50 ${api.p50} ms · p95 ${api.p95} ms`,
          ].join('\n')
          : 'No requests in the last hour',
        inline: false,
      },
      ...(topMethods.length ? [{ name: 'Busiest endpoints', value: topMethods.join('\n'), inline: true }] : []),
      ...(limitLines.length ? [{ name: 'Rate limit now', value: limitLines.join('\n'), inline: true }] : []),
      {
        name: 'Database',
        value: [
          `**${mb(fileSize(o.dbPath))}** · ${n(c.players)} players · ${n(c.linkedUsers)} linked users (${n(c.links)} links)`,
          `${n(c.tracked)} server tracks in ${n(c.guilds)} servers · recap on in ${c.recapGuilds} · log on in ${c.logGuilds}`,
          `${n(c.matches)} recorded games · ${n(c.cachedMatches)} cached matches · ${n(c.lpEvents)} LP entries`,
        ].join('\n'),
        inline: false,
      },
      { name: 'Recent errors', value: errors.length ? errors.join('\n').slice(0, 1000) : 'None since start 🎉', inline: false },
    ],
  };
}

export type StatsPeriod = '24h' | '7d' | '30d' | 'all';
export function parseStatsPeriod(words: string[]): StatsPeriod {
  const w = words.map((x) => x.toLowerCase());
  if (w.some((x) => ['24h', 'day', 'today', '1d'].includes(x))) return '24h';
  if (w.some((x) => ['30d', 'month', 'm'].includes(x))) return '30d';
  if (w.some((x) => ['all', 'ever', 'total'].includes(x))) return 'all';
  return '7d';
}
const PERIOD_MS: Record<StatsPeriod, number> = { '24h': 86_400_000, '7d': 7 * 86_400_000, '30d': 30 * 86_400_000, all: Number.POSITIVE_INFINITY };
const PERIOD_LABEL: Record<StatsPeriod, string> = { '24h': 'last 24 hours', '7d': 'last 7 days', '30d': 'last 30 days', all: 'all time' };

const bar = (v: number, max: number, width = 10) => '█'.repeat(Math.max(v ? 1 : 0, Math.round((v / Math.max(1, max)) * width)));

export function statsEmbed(service: Service, client: Client, period: StatsPeriod, now = Date.now()): Embed {
  const since = Number.isFinite(PERIOD_MS[period]) ? now - PERIOD_MS[period] : 0;
  const u = service.usage(since);
  const t = u.totals;
  const s = service.stats();
  const guildName = (id: string | null) => (id ? client.guilds.cache.get(id)?.name ?? `server ${id}` : 'DMs / user installs');
  const max = u.byName[0]?.n ?? 0;
  const styles: Record<string, string> = { '/': 'slash', '$': 'prefix', panel: 'buttons' };

  const days = u.byDay.slice(-14);
  const dayMax = Math.max(1, ...days.map((d) => d.n));
  const spark = days.length > 1
    ? days.map((d) => `\`${d.day.slice(5)}\` ${bar(d.n, dayMax, 12)} ${d.n}`).join('\n')
    : null;

  return {
    title: `📊 Usage · ${PERIOD_LABEL[period]}`,
    color: COLORS.info,
    description: t.n
      ? `**${n(t.n)}** commands by **${n(t.users)}** user${t.users === 1 ? '' : 's'} in **${n(t.guilds)}** server${t.guilds === 1 ? '' : 's'} · ` +
        `${pct(t.errors, t.n)} errors · avg ${Math.round(t.avg_ms ?? 0)} ms\n` +
        u.byStyle.map((x) => `${styles[x.style] ?? x.style} ${pct(x.n, t.n)}`).join(' · ')
      : 'No commands in this period.',
    fields: [
      ...(u.byName.length ? [{
        name: 'Top commands',
        value: u.byName.slice(0, 10).map((x) => `\`${x.name.padEnd(12).slice(0, 12)}\` ${bar(x.n, max)} ${n(x.n)}${x.errors ? ` · ${x.errors} err` : ''}`).join('\n'),
        inline: false,
      }] : []),
      ...(u.byGuild.length ? [{
        name: 'Top servers',
        value: u.byGuild.slice(0, 5).map((x) => `${guildName(x.guild_id)} · ${n(x.n)} (${x.users} user${x.users === 1 ? '' : 's'})`).join('\n'),
        inline: true,
      }] : []),
      ...(u.byUser.length ? [{ name: 'Top users', value: u.byUser.map((x) => `<@${x.user_id}> · ${n(x.n)}`).join('\n'), inline: true }] : []),
      {
        name: 'Growth',
        value: [
          `**${n(s.players)}** players tracked · **${n(s.linkedUsers)}** linked users · **${n(client.guilds.cache.size)}** servers`,
          `This period: +${n(u.newPlayers)} players · +${n(u.newLinks)} links · ${n(u.games.n)} games recorded by ${n(u.games.players)} players`,
        ].join('\n'),
        inline: false,
      },
      ...(spark ? [{ name: 'Commands per day (UTC)', value: spark.slice(0, 1024), inline: false }] : []),
    ],
    footer: { text: 'Usage is recorded from this version on · $admin stats [24h|7d|30d|all]' },
  };
}
