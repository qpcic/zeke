import { parseArgs } from 'node:util';
import { bootstrap } from './bootstrap.ts';
import { UserError } from './core/service.ts';
import { isValidTimeZone } from './core/time.ts';
import { PLATFORM_LABEL } from './riot/regions.ts';
import { formatRank } from './core/rank.ts';
import { buildDigestEmbed } from './render/digestEmbed.ts';
import { renderEmbedToTerminal } from './render/terminal.ts';

/**
 * Stand-in for slash commands until Discord is wired up.
 *   npm run cli -- add EUW "Faker#KR1"         [--guild local]
 *   npm run cli -- remove "Faker#KR1"
 *   npm run cli -- list
 *   npm run cli -- poll                        (one tick, prints any new games)
 *   npm run cli -- digest daily|weekly         (prints without marking as run)
 *   npm run cli -- tz Europe/Ljubljana
 */
const USAGE = `usage: cli <add REGION "Name#TAG" | remove "Name#TAG" | list | poll | digest daily|weekly | tz ZONE> [--guild ID]
regions: ${Object.values(PLATFORM_LABEL).join(' ')}`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { guild: { type: 'string', short: 'g', default: 'local' } },
});
const guildId = values.guild!;
const [cmd, ...args] = positionals;

const { service, db } = bootstrap();

async function main() {
  switch (cmd) {
    case 'add': {
      const [region, riotId] = args;
      if (!region || !riotId) throw new UserError(USAGE);
      const r = await service.addPlayer(guildId, region, riotId, 'cli');
      const ranks = r.entries.map((e) => `${e.queueType}: ${formatRank({ tier: e.tier, division: e.rank, lp: e.leaguePoints })} (${e.wins}W ${e.losses}L)`);
      console.log(`${r.alreadyTracked ? 'Already tracking' : 'Now tracking'} ${r.player.game_name}#${r.player.tag_line} [${r.player.platform}]`);
      console.log(`  puuid ${r.player.puuid}`);
      console.log(ranks.length ? ranks.map((s) => '  ' + s).join('\n') : '  Unranked');
      break;
    }
    case 'remove': {
      if (!args[0]) throw new UserError(USAGE);
      const p = service.removePlayer(guildId, args[0]);
      console.log(`Stopped tracking ${p.game_name}#${p.tag_line}`);
      break;
    }
    case 'list': {
      const rows = service.listPlayers(guildId);
      if (!rows.length) console.log(`No players tracked in guild "${guildId}"`);
      for (const r of rows) {
        console.log(`${r.player.game_name}#${r.player.tag_line} [${PLATFORM_LABEL[r.player.platform]}]  ${r.ranks.map((x) => `${x.queue}: ${x.rank}`).join(' · ') || 'Unranked'}`);
      }
      break;
    }
    case 'poll': {
      const r = await service.tick();
      console.log(`\n${r.games} new game(s), ${r.requests} Riot requests`);
      break;
    }
    case 'digest': {
      const kind = args[0] === 'weekly' ? 'weekly' : 'daily';
      console.log(renderEmbedToTerminal(buildDigestEmbed(service.digest(guildId, kind))));
      break;
    }
    case 'tz': {
      const tz = args[0];
      if (!tz || !isValidTimeZone(tz)) throw new UserError(`Invalid IANA timezone "${tz ?? ''}"`);
      service.guild(guildId);
      service.setTimezone(guildId, tz);
      console.log(`Guild ${guildId} timezone set to ${tz}`);
      break;
    }
    default:
      console.log(USAGE);
  }
}

main()
  .catch((e) => {
    console.error(e instanceof UserError ? `✖ ${e.message}` : e);
    process.exitCode = 1;
  })
  .finally(() => db.close());
