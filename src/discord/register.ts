import { REST, Routes } from 'discord.js';
import { config, requireDiscord } from '../config.ts';
import { asGuildCommands, commands } from './commands.ts';

/**
 * npm run register            -> global commands (needed for user-install / DMs)
 * npm run register -- --guild -> DEV_GUILD_ID only, instant updates, server-install only
 * npm run register -- --clear-guild -> remove guild copies (avoid duplicates after switching to global)
 */
const { token, clientId } = requireDiscord();
const rest = new REST().setToken(token);
const args = new Set(process.argv.slice(2));

if (args.has('--guild') || args.has('--clear-guild')) {
  if (!config.devGuildId) throw new Error('DEV_GUILD_ID is not set');
  const body = args.has('--clear-guild') ? [] : asGuildCommands();
  const res = (await rest.put(Routes.applicationGuildCommands(clientId, config.devGuildId), { body })) as unknown[];
  console.log(`${args.has('--clear-guild') ? 'Cleared' : 'Registered'} ${res.length} guild commands in ${config.devGuildId}`);
} else {
  const res = (await rest.put(Routes.applicationCommands(clientId), { body: commands })) as unknown[];
  console.log(`Registered ${res.length} global commands: ${commands.map((c) => '/' + c.name).join(' ')}`);
}
