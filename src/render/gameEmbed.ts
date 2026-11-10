import type { GameResult } from '../core/events.ts';
import { formatLpDelta, formatRank, formatTierDiv } from '../core/rank.ts';
import { PLATFORM_LABEL } from '../riot/regions.ts';
import { QUEUE_LABEL, type ParticipantDto } from '../riot/types.ts';
import { championIcon, ddVersion, patchLabel } from './ddragon.ts';
import { COLORS, type Embed } from './embed.ts';
import { cell, fmtDuration, fmtK, kdaRatio } from './format.ts';

function scoreboard(team: ParticipantDto[], highlight: Set<string>): string {
  const rows = team.map((p) => {
    const mark = highlight.has(p.puuid) ? '▶' : ' ';
    const name = p.riotIdGameName || p.summonerName || '?';
    const kda = `${p.kills}/${p.deaths}/${p.assists}`;
    const cs = p.totalMinionsKilled + p.neutralMinionsKilled;
    return `${mark}${cell(p.championName, 9)} ${cell(name, 10)} ${cell(kda, 8, 'right')} ${cell(String(cs), 3, 'right')} ${cell(fmtK(p.totalDamageDealtToChampions), 5, 'right')}`;
  });
  return '```\n' + rows.join('\n') + '\n```';
}

function lpLine(r: GameResult): string {
  if (r.remake) return 'Remake · no LP change';
  switch (r.note) {
    case 'placement':
      return r.rankAfter ? `Placed into **${formatRank(r.rankAfter)}**` : 'Placement game';
    case 'unranked':
      return 'Placement game · not ranked yet';
    case 'pending':
      return 'LP updating… (ladder hasn\'t caught up yet)';
    case 'unrecorded':
      return `LP not recorded (played before tracking started)${r.rankAfter ? ` · ${formatRank(r.rankAfter)}` : ''}`;
    case 'norank':
      return '';
    case 'unknown':
      return `LP change unavailable${r.rankAfter ? ` · ${formatRank(r.rankAfter)}` : ''}`;
    case 'batched':
      return r.lpDelta !== null
        ? `**${formatLpDelta(r.lpDelta)}** over last ${r.batchSize} games → ${formatRank(r.rankAfter)}`
        : `LP included in a ${r.batchSize}-game batch`;
    case 'promoted':
      return `**${formatLpDelta(r.lpDelta)}** · ⬆ Promoted to **${formatTierDiv(r.rankAfter!)}** (${formatRank(r.rankAfter)})`;
    case 'demoted':
      return `**${formatLpDelta(r.lpDelta)}** · ⬇ Demoted to **${formatTierDiv(r.rankAfter!)}** (${formatRank(r.rankAfter)})`;
    default:
      return `**${formatLpDelta(r.lpDelta)}** → ${formatRank(r.rankAfter)}`;
  }
}

/**
 * @param alsoTracked other tracked players' puuids in this guild, highlighted in the scoreboard
 */
export function buildGameEmbed(r: GameResult, alsoTracked: Set<string> = new Set()): Embed {
  const { info, metadata } = r.match;
  const me = info.participants.find((p) => p.puuid === r.player.puuid)!;
  const ver = ddVersion(info.gameVersion);
  const minutes = info.gameDuration / 60;
  const cs = me.totalMinionsKilled + me.neutralMinionsKilled;
  const teamKills = info.participants.filter((p) => p.teamId === me.teamId).reduce((n, p) => n + p.kills, 0);
  const kp = teamKills ? Math.round(((me.kills + me.assists) / teamKills) * 100) : 0;

  const result = r.remake ? 'Remake' : r.win ? 'Victory' : 'Defeat';
  const color = r.remake ? COLORS.remake : r.note === 'promoted' ? COLORS.promoted : r.win ? COLORS.win : COLORS.loss;

  const multi = me.pentaKills ? 'PENTAKILL' : me.quadraKills ? 'Quadra kill' : me.tripleKills ? 'Triple kill' : null;

  const highlight = new Set([r.player.puuid, ...alsoTracked]);
  const blue = info.participants.filter((p) => p.teamId === 100);
  const red = info.participants.filter((p) => p.teamId === 200);
  const blueWon = info.teams.find((t) => t.teamId === 100)?.win;
  const trophy = (team: 100 | 200) => (r.remake ? '' : (team === 100) === !!blueWon ? '🏆 ' : '');
  const teamKillsOf = (ps: ParticipantDto[]) => ps.reduce((n, p) => n + p.kills, 0);

  const embed: Embed = {
    author: { name: `${r.player.game_name}#${r.player.tag_line} · ${PLATFORM_LABEL[r.player.platform]}` },
    title: `${result} · ${me.championName}`,
    url: `https://www.leagueofgraphs.com/match/${PLATFORM_LABEL[r.player.platform].toLowerCase()}/${metadata.matchId.split('_')[1]}`,
    description: [lpLine(r), multi ? `🔥 **${multi}**` : ''].filter(Boolean).join('\n') || undefined,
    color,
    thumbnail: { url: championIcon(ver, me.championName) },
    fields: r.remake ? [] : [
      { name: 'KDA', value: `${me.kills}/${me.deaths}/${me.assists} (${kdaRatio(me.kills, me.deaths, me.assists)}) · ${kp}% KP`, inline: true },
      { name: 'CS', value: `${cs} (${(cs / minutes).toFixed(1)}/m)`, inline: true },
      { name: 'Damage', value: fmtK(me.totalDamageDealtToChampions), inline: true },
      { name: 'Gold', value: fmtK(me.goldEarned), inline: true },
      { name: 'Vision', value: String(me.visionScore), inline: true },
      { name: 'Duration', value: fmtDuration(info.gameDuration), inline: true },
    ],
  };
  if (!r.remake) {
    embed.fields!.push(
      { name: `${trophy(100)}Blue · ${teamKillsOf(blue)} kills`, value: scoreboard(blue, highlight) },
      { name: `${trophy(200)}Red · ${teamKillsOf(red)} kills`, value: scoreboard(red, highlight) },
    );
  } else {
    embed.fields!.push({ name: 'Duration', value: fmtDuration(info.gameDuration), inline: true });
  }
  Object.assign(embed, {
    footer: { text: `${QUEUE_LABEL[info.queueId] ?? `Queue ${info.queueId}`} · Patch ${patchLabel(info.gameVersion)} · ${metadata.matchId}` },
    timestamp: new Date(info.gameEndTimestamp ?? info.gameStartTimestamp + info.gameDuration * 1000).toISOString(),
  });
  return embed;
}
