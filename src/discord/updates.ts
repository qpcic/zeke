import type { Client } from 'discord.js';
import type { Repo } from '../db/repo.ts';
import { COLORS } from '../render/embed.ts';

/**
 * "What changed" post on startup: Railway exposes the deploying commit as
 * RAILWAY_GIT_* variables. Posted once per commit (kv), so crash restarts and
 * $import restarts don't repeat it.
 */
export interface CommitInfo { sha: string; message: string; author?: string; branch?: string; repo?: string }

export function commitFromEnv(env = process.env): CommitInfo | null {
  const sha = env.RAILWAY_GIT_COMMIT_SHA?.trim();
  const message = env.RAILWAY_GIT_COMMIT_MESSAGE?.trim();
  if (!sha || !message) return null;
  const repo = env.RAILWAY_GIT_REPO_OWNER && env.RAILWAY_GIT_REPO_NAME ? `${env.RAILWAY_GIT_REPO_OWNER}/${env.RAILWAY_GIT_REPO_NAME}` : undefined;
  return { sha, message, author: env.RAILWAY_GIT_AUTHOR || undefined, branch: env.RAILWAY_GIT_BRANCH || undefined, repo };
}

/** Drop git trailers (Co-Authored-By, Signed-off-by, session links) from the end of a message. */
export function stripTrailers(message: string): string {
  const lines = message.replace(/\r\n/g, '\n').split('\n');
  while (lines.length && (/^\s*$/.test(lines.at(-1)!) || /^[A-Za-z][\w-]*: \S/.test(lines.at(-1)!))) lines.pop();
  return lines.join('\n').trim();
}

export function updateEmbed(c: CommitInfo) {
  const [subject, ...rest] = stripTrailers(c.message).split('\n');
  const body = rest.join('\n').trim();
  const short = c.sha.slice(0, 7);
  return {
    title: `🛠️ ${subject ?? 'Update'}`.slice(0, 256),
    url: c.repo ? `https://github.com/${c.repo}/commit/${c.sha}` : undefined,
    description: (body || '_No details._').slice(0, 4000),
    color: COLORS.info,
    footer: { text: [short, c.author, c.branch].filter(Boolean).join(' · ') },
    timestamp: new Date().toISOString(),
  };
}

export async function announceUpdate(client: Client, repo: Repo, channelId: string, log: (m: string) => void, env = process.env): Promise<void> {
  if (!channelId) return;
  const c = commitFromEnv(env);
  if (!c) return log('updates: no RAILWAY_GIT_COMMIT_* variables (not a GitHub deploy?), nothing to announce');
  if (repo.getKv('announced_commit') === c.sha) return; // restart of the same deploy
  try {
    const ch = await client.channels.fetch(channelId);
    if (!ch?.isSendable()) throw new Error(`channel ${channelId} not found or not sendable`);
    await ch.send({ embeds: [updateEmbed(c)], allowedMentions: { parse: [] } });
    repo.setKv('announced_commit', c.sha);
    log(`updates: announced ${c.sha.slice(0, 7)}`);
  } catch (e) {
    log(`updates: could not post: ${(e as Error).message}`);
  }
}
