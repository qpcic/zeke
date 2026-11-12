import { ActivityType, type Client } from 'discord.js';

/** Bot status line, e.g. "$help | 12 users" (users = Discord users with a linked account). */
export function presenceText(prefix: string, users: number): string {
  return `${prefix ? `${prefix}help` : '/help'} | ${users} user${users === 1 ? '' : 's'}`;
}

/** Set the status and refresh the count every few minutes (only re-sent when it changes). */
export function startPresence(client: Client, prefix: string, countUsers: () => number, everyMs = 5 * 60_000): () => void {
  let last = '';
  const show = () => {
    const state = presenceText(prefix, countUsers());
    if (state === last) return;
    last = state;
    client.user?.setPresence({ status: 'online', activities: [{ type: ActivityType.Custom, name: 'custom', state }] });
  };
  show();
  const t = setInterval(show, everyMs);
  t.unref();
  return () => clearInterval(t);
}
