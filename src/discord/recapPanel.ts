import type { Reply, Service } from '../core/service.ts';
import { RECAP_DELAY_MS } from '../core/service.ts';
import { COLORS } from '../render/embed.ts';

/**
 * /recap panel (Manage Server): Discord's channel picker for the daily recap channel,
 * plus Turn off and Preview. Custom ids: "recap:<action>:<guildId>".
 */
export const RECAP_PREFIX = 'recap:';
export const recapId = (action: string, guildId: string) => `${RECAP_PREFIX}${action}:${guildId}`;
export function parseRecapId(customId: string): { action: string; guildId: string } | null {
  const m = /^recap:([a-z]+):([^:]+)$/.exec(customId);
  return m ? { action: m[1]!, guildId: m[2]! } : null;
}

const ROW = 1, BUTTON = 2, CHANNEL_SELECT = 8;
const GUILD_TEXT = 0, GUILD_ANNOUNCEMENT = 5;

export function recapPanel(service: Service, guildId: string, opts: { status?: string; ok?: boolean } = {}): Reply {
  const g = service.guild(guildId);
  const ch = g.recap_channel_id;
  const at = `00:${String(RECAP_DELAY_MS / 60_000).padStart(2, '0')}`;
  const status = opts.status ? `${opts.ok === false ? '❌' : '✅'} ${opts.status}\n\n` : '';
  return {
    embed: {
      title: 'Daily recap',
      color: opts.ok === false ? COLORS.loss : COLORS.info,
      description:
        status +
        (ch ? `Posting to <#${ch}>` : '**Off.** Pick a channel below to turn it on.') +
        `\n\nEvery day at **${at}** (${g.timezone}) the server leaderboard for the day that just ended is posted there: ` +
        'LP gained, W/L and games for every tracked account that played, one image per queue.',
      footer: { text: 'Accounts come from /track add · needs Manage Server' },
    },
    files: [],
    components: [
      {
        type: ROW,
        components: [{
          type: CHANNEL_SELECT,
          custom_id: recapId('channel', guildId),
          channel_types: [GUILD_TEXT, GUILD_ANNOUNCEMENT],
          placeholder: ch ? 'Move the recap to another channel' : 'Pick the recap channel',
          min_values: 1,
          max_values: 1,
          ...(ch ? { default_values: [{ id: ch, type: 'channel' }] } : {}),
        }],
      },
      {
        type: ROW,
        components: [
          { type: BUTTON, style: 4, label: 'Turn off', custom_id: recapId('off', guildId), disabled: !ch },
          { type: BUTTON, style: 2, label: "Preview yesterday's recap", emoji: { name: '👀' }, custom_id: recapId('preview', guildId) },
        ],
      },
    ],
  };
}

/**
 * /log panel (Manage Server): channel picker for the server's game log (every new game of
 * the tracked accounts). Custom ids: "glog:<action>:<guildId>".
 */
export const GLOG_PREFIX = 'glog:';
export const glogId = (action: string, guildId: string) => `${GLOG_PREFIX}${action}:${guildId}`;
export function parseGlogId(customId: string): { action: string; guildId: string } | null {
  const m = /^glog:([a-z]+):([^:]+)$/.exec(customId);
  return m ? { action: m[1]!, guildId: m[2]! } : null;
}

export function logPanel(service: Service, guildId: string, opts: { status?: string; ok?: boolean } = {}): Reply {
  const g = service.guild(guildId);
  const ch = g.log_channel_id;
  const status = opts.status ? `${opts.ok === false ? '❌' : '✅'} ${opts.status}\n\n` : '';
  return {
    embed: {
      title: 'Game log',
      color: opts.ok === false ? COLORS.loss : COLORS.info,
      description:
        status +
        (ch ? `Logging to <#${ch}>` : '**Off.** Pick a channel below to turn it on.') +
        '\n\nEvery new ranked game of this server\'s tracked accounts is posted there as a scoreboard with LP, ' +
        'once per game (tracked teammates share one post).',
      footer: { text: 'Accounts come from /track add · needs Manage Server' },
    },
    files: [],
    components: [
      {
        type: ROW,
        components: [{
          type: CHANNEL_SELECT,
          custom_id: glogId('channel', guildId),
          channel_types: [GUILD_TEXT, GUILD_ANNOUNCEMENT],
          placeholder: ch ? 'Move the game log to another channel' : 'Pick the game log channel',
          min_values: 1,
          max_values: 1,
          ...(ch ? { default_values: [{ id: ch, type: 'channel' }] } : {}),
        }],
      },
      { type: ROW, components: [{ type: BUTTON, style: 4, label: 'Turn off', custom_id: glogId('off', guildId), disabled: !ch }] },
    ],
  };
}
