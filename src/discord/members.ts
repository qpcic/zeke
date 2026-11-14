import type { Guild } from 'discord.js';

/**
 * Which of the given Discord users are in a server, with their display names.
 * Looks each one up individually (no privileged member-list intent needed) and
 * caches the answer for a while, so /ladder doesn't hit Discord every time.
 */
const TTL = 15 * 60_000;
const cache = new Map<string, { at: number; name: string | null }>();

export async function membersOf(guild: Guild, userIds: string[], now = Date.now()): Promise<{ id: string; name: string }[]> {
  const out: { id: string; name: string }[] = [];
  const todo: string[] = [];
  for (const id of userIds) {
    const live = guild.members.cache.get(id);
    if (live) {
      out.push({ id, name: live.displayName });
      continue;
    }
    const c = cache.get(`${guild.id}:${id}`);
    if (c && now - c.at < TTL) {
      if (c.name) out.push({ id, name: c.name });
    } else todo.push(id);
  }
  // A few at a time: discord.js queues these against the REST rate limit.
  for (let i = 0; i < todo.length; i += 5) {
    await Promise.all(todo.slice(i, i + 5).map(async (id) => {
      const m = await guild.members.fetch({ user: id, cache: true }).catch(() => null);
      cache.set(`${guild.id}:${id}`, { at: now, name: m?.displayName ?? null });
      if (m) out.push({ id, name: m.displayName });
    }));
  }
  return out;
}
