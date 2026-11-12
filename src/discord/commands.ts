import {
  ApplicationIntegrationType,
  InteractionContextType,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
  type SlashCommandOptionsOnlyBuilder,
} from 'discord.js';
import { PLATFORM_LABEL, PLATFORMS } from '../riot/regions.ts';

/**
 * Personal commands work everywhere (server, bot DM, group DMs) when the app is
 * user-installed. Server commands need the bot installed in that server.
 */
const EVERYWHERE = {
  integrations: [ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall],
  contexts: [InteractionContextType.Guild, InteractionContextType.BotDM, InteractionContextType.PrivateChannel],
};
const SERVER_ONLY = {
  integrations: [ApplicationIntegrationType.GuildInstall],
  contexts: [InteractionContextType.Guild],
};

const regionChoices = PLATFORMS.map((p) => ({ name: PLATFORM_LABEL[p], value: p }));

/** Who to show: a Discord user's linked account, or any Riot ID (+region if the bot hasn't seen it). */
/** Queue option: always added LAST so it's the final argument in every command. */
const queueOpt = (b: SlashCommandOptionsOnlyBuilder) =>
  b.addStringOption((o) => o.setName('queue').setDescription('Queue (default: your /mode, else Solo/Duo)')
    .addChoices({ name: 'Solo/Duo', value: '420' }, { name: 'Flex', value: '440' }, { name: 'Ranked 5s', value: '5' }));

const userOpt = (b: SlashCommandOptionsOnlyBuilder) =>
  b
    .addUserOption((o) => o.setName('user').setDescription('Show a Discord user (their /link-ed account)'))
    .addStringOption((o) => o.setName('riot_id').setDescription('Or any Riot ID, e.g. Faker#KR1').setMinLength(5).setMaxLength(22))
    .addStringOption((o) => o.setName('region').setDescription('Region, only needed for accounts the bot has never seen').addChoices(...regionChoices));

export const commands: RESTPostAPIChatInputApplicationCommandsJSONBody[] = [
  new SlashCommandBuilder().setName('link').setDescription('Your linked Riot accounts: add, remove, pick a main')
    .addStringOption((o) => o.setName('riot_id').setDescription('Add this account right away, e.g. Faker#KR1').setMinLength(3).setMaxLength(30))
    .addStringOption((o) => o.setName('region').setDescription('Server the account plays on (not needed for accounts the bot knows)').addChoices(...regionChoices))
    .setIntegrationTypes(EVERYWHERE.integrations).setContexts(EVERYWHERE.contexts).toJSON(),

  new SlashCommandBuilder().setName('unlink').setDescription('Remove one of your linked Riot accounts')
    .addStringOption((o) => o.setName('account').setDescription('Which account (leave empty to pick from a list)').setAutocomplete(true))
    .setIntegrationTypes(EVERYWHERE.integrations).setContexts(EVERYWHERE.contexts).toJSON(),

  queueOpt(new SlashCommandBuilder().setName('mode').setDescription('Your default queue for stats commands (Solo/Duo, Flex or Ranked 5s); leave empty to see it'))
    .setIntegrationTypes(EVERYWHERE.integrations).setContexts(EVERYWHERE.contexts).toJSON(),

  userOpt(new SlashCommandBuilder().setName('profile').setDescription('Rank, W/L, ladder position and top champions'))
    .setIntegrationTypes(EVERYWHERE.integrations).setContexts(EVERYWHERE.contexts).toJSON(),

  queueOpt(userOpt(new SlashCommandBuilder().setName('recent').setDescription('Latest ranked game (any queue unless you pick one)')))
    .setIntegrationTypes(EVERYWHERE.integrations).setContexts(EVERYWHERE.contexts).toJSON(),

  queueOpt(userOpt(new SlashCommandBuilder().setName('graph').setDescription('LP graph over recorded games'))
    .addIntegerOption((o) => o.setName('games').setDescription('How many recent games (default 50)').setMinValue(5).setMaxValue(200)))
    .setIntegrationTypes(EVERYWHERE.integrations).setContexts(EVERYWHERE.contexts).toJSON(),

  queueOpt(userOpt(new SlashCommandBuilder().setName('daily').setDescription("Today's games and LP (or the past 24 hours)"))
    .addStringOption((o) => o.setName('window').setDescription('Time window (default Today)')
      .addChoices({ name: 'Today', value: 'today' }, { name: 'Past 24 hours', value: '24h' })))
    .setIntegrationTypes(EVERYWHERE.integrations).setContexts(EVERYWHERE.contexts).toJSON(),

  queueOpt(userOpt(new SlashCommandBuilder().setName('weekly').setDescription('Games and LP from the past 7 days')))
    .setIntegrationTypes(EVERYWHERE.integrations).setContexts(EVERYWHERE.contexts).toJSON(),

  new SlashCommandBuilder().setName('scout').setDescription("Scout a player's Ranked 5s / Flex team: roles, best champs, bans")
    .addStringOption((o) => o.setName('riot_id').setDescription('Any player on the enemy team, e.g. Faker#KR1').setRequired(true).setMinLength(5).setMaxLength(22))
    .addStringOption((o) => o.setName('region').setDescription('Region (needed if the bot has never seen them)').addChoices(...regionChoices))
    .setIntegrationTypes(EVERYWHERE.integrations).setContexts(EVERYWHERE.contexts).toJSON(),

  new SlashCommandBuilder().setName('track').setDescription('Manage accounts tracked in this server')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setIntegrationTypes(SERVER_ONLY.integrations).setContexts(SERVER_ONLY.contexts)
    .addSubcommand((s) =>
      s.setName('add').setDescription('Track an account in this server')
        .addStringOption((o) => o.setName('region').setDescription('Server the account plays on').setRequired(true).addChoices(...regionChoices))
        .addStringOption((o) => o.setName('riot_id').setDescription('Riot ID, e.g. Faker#KR1').setRequired(true).setMinLength(5).setMaxLength(22)))
    .addSubcommand((s) =>
      s.setName('remove').setDescription('Stop tracking an account')
        .addStringOption((o) => o.setName('account').setDescription('Tracked account').setRequired(true).setAutocomplete(true)))
    .addSubcommand((s) => s.setName('list').setDescription('List tracked accounts'))
    .toJSON(),

  queueOpt(new SlashCommandBuilder().setName('leaderboard').setDescription('LP leaderboard for accounts tracked in this server')
    .addStringOption((o) => o.setName('period').setDescription('Time window').setRequired(true)
      .addChoices({ name: 'Past 24 hours', value: 'daily' }, { name: 'Past 7 days', value: 'weekly' })))
    .setIntegrationTypes(SERVER_ONLY.integrations).setContexts(SERVER_ONLY.contexts)
    .toJSON(),
];

/** Guild-scoped registration only supports guild install; strip user-install bits for --guild dev mode. */
export function asGuildCommands(): RESTPostAPIChatInputApplicationCommandsJSONBody[] {
  return commands.map(({ integration_types: _i, contexts: _c, ...rest }) => rest);
}
