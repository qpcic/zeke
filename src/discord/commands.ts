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

const withRegionAndId = (b: SlashCommandBuilder) =>
  b
    .addStringOption((o) => o.setName('region').setDescription('Server the account plays on').setRequired(true).addChoices(...regionChoices))
    .addStringOption((o) => o.setName('riot_id').setDescription('Riot ID, e.g. Faker#KR1').setRequired(true).setMinLength(5).setMaxLength(22));

/** Who to show: a Discord user's linked account, or any Riot ID (+region if the bot hasn't seen it). */
/** Queue option: always added LAST so it's the final argument in every command. */
const queueOpt = (b: SlashCommandOptionsOnlyBuilder) =>
  b.addStringOption((o) => o.setName('queue').setDescription('Queue (default Solo/Duo)')
    .addChoices({ name: 'Solo/Duo', value: '420' }, { name: 'Flex', value: '440' }));

const userOpt = (b: SlashCommandOptionsOnlyBuilder) =>
  b
    .addUserOption((o) => o.setName('user').setDescription('Show a Discord user (their /link-ed account)'))
    .addStringOption((o) => o.setName('riot_id').setDescription('Or any Riot ID, e.g. Faker#KR1').setMinLength(5).setMaxLength(22))
    .addStringOption((o) => o.setName('region').setDescription('Region, only needed for accounts the bot has never seen').addChoices(...regionChoices));

export const commands: RESTPostAPIChatInputApplicationCommandsJSONBody[] = [
  withRegionAndId(new SlashCommandBuilder().setName('link').setDescription('Link your Riot account to your Discord user'))
    .setIntegrationTypes(EVERYWHERE.integrations).setContexts(EVERYWHERE.contexts).toJSON(),

  new SlashCommandBuilder().setName('unlink').setDescription('Remove your linked Riot account')
    .setIntegrationTypes(EVERYWHERE.integrations).setContexts(EVERYWHERE.contexts).toJSON(),

  queueOpt(userOpt(new SlashCommandBuilder().setName('recent').setDescription('Show the most recent game')))
    .setIntegrationTypes(EVERYWHERE.integrations).setContexts(EVERYWHERE.contexts).toJSON(),

  queueOpt(userOpt(new SlashCommandBuilder().setName('graph').setDescription('LP graph over recorded games'))
    .addIntegerOption((o) => o.setName('games').setDescription('How many recent games (default 50)').setMinValue(5).setMaxValue(200)))
    .setIntegrationTypes(EVERYWHERE.integrations).setContexts(EVERYWHERE.contexts).toJSON(),

  queueOpt(userOpt(new SlashCommandBuilder().setName('daily').setDescription("Today's games and LP")))
    .setIntegrationTypes(EVERYWHERE.integrations).setContexts(EVERYWHERE.contexts).toJSON(),

  queueOpt(userOpt(new SlashCommandBuilder().setName('weekly').setDescription("This week's games and LP")))
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
      .addChoices({ name: 'Today', value: 'daily' }, { name: 'This week', value: 'weekly' })))
    .setIntegrationTypes(SERVER_ONLY.integrations).setContexts(SERVER_ONLY.contexts)
    .toJSON(),
];

/** Guild-scoped registration only supports guild install; strip user-install bits for --guild dev mode. */
export function asGuildCommands(): RESTPostAPIChatInputApplicationCommandsJSONBody[] {
  return commands.map(({ integration_types: _i, contexts: _c, ...rest }) => rest);
}
