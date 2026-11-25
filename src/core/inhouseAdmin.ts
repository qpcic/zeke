import type { PlayerRow, Repo } from '../db/repo.ts';
import { renderInhouse } from '../render/image/inhouse.ts';
import type { RiotClient } from '../riot/client.ts';
import { generate, MODES, parseRole, rankValue, ROLE_LABEL, ROLES, type InhousePlayer, type Mode, type Role } from './inhouse.ts';
import { formatRank, type Rank } from './rank.ts';
import { UserError, type Reply, type Service } from './service.ts';

/** `$admin 5v5 …`: the list, tonight's pool, and team generation. Owner console only. */

export const INHOUSE_PREFIX = 'ih:';
const SOLO = 'RANKED_SOLO_5x5';
const COLOR = 0x5865f2;

interface Deps { service: Service; repo: Repo; riot: RiotClient; now: () => number; log: (m: string) => void }
type Listed = PlayerRow & { main_role: string; in_pool: number };

export class InhouseAdmin {
  constructor(private readonly d: Deps) {}

  private rank(puuid: string): Rank | null {
    const s = this.d.repo.getSnapshot(puuid, SOLO);
    return s && s.tier && s.tier !== 'UNRANKED' ? { tier: s.tier, division: s.division, lp: s.lp } as Rank : null;
  }

  /** Fresh Solo/Duo ranks (league-v4: platform host, not the busy match-v5 limit). */
  private async refreshRanks(players: PlayerRow[]): Promise<void> {
    await Promise.all(players.map(async (p) => {
      try {
        const e = (await this.d.riot.getLeagueEntries(p.platform, p.puuid)).find((x) => x.queueType === SOLO);
        if (e) this.d.repo.putSnapshot({ puuid: p.puuid, queue_type: SOLO, tier: e.tier, division: e.rank, lp: e.leaguePoints, wins: e.wins, losses: e.losses, taken_at: this.d.now() });
      } catch (err) {
        this.d.log(`5v5: rank refresh failed for ${p.game_name}#${p.tag_line}: ${(err as Error).message}`);
      }
    }));
  }

  private line(p: PlayerRow & { main_role: string }, opts: { pool?: boolean } = {}): string {
    const pool = opts.pool && (p as Listed).in_pool ? '✅ ' : '';
    return `${pool}\`${ROLE_LABEL[p.main_role as Role].padEnd(7)}\` **${p.game_name}**#${p.tag_line} · ${formatRank(this.rank(p.puuid))}`;
  }

  /** Someone on the list first (short names), else any known account, @user or Riot ID. */
  private async resolve(input: string): Promise<PlayerRow> {
    const q = input.trim();
    const m = /^<@!?(\d+)>$/.exec(q);
    if (m) return this.d.service.linkedOrThrow(m[1]!, false);
    if (q.includes('#')) {
      const r = /^(.*#\S+)\s+(\S+)$/.exec(q); // "Name#TAG eune"
      return (await this.d.service.lookup(r ? r[1]! : q, r ? r[2] : undefined)).player;
    }
    const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
    const listed = this.d.repo.inhouseList();
    const exact = listed.filter((p) => norm(p.game_name) === norm(q));
    const partial = listed.filter((p) => norm(p.game_name).includes(norm(q)));
    if (exact.length === 1) return exact[0]!;
    if (!exact.length && partial.length === 1) return partial[0]!;
    if (partial.length > 1 && !exact.length) {
      throw new UserError(`**${q}** matches ${partial.length} people on the list: ${partial.slice(0, 5).map((p) => `\`${p.game_name}#${p.tag_line}\``).join(', ')}. Be more specific.`);
    }
    return this.d.service.findKnown(q);
  }

  /** Comma-separated people, each optionally ending in a role: "kitten mid, Ferk#MANGO top, @user". */
  private parts(text: string): { who: string; role: Role | null }[] {
    return text.split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
      const words = s.split(/\s+/);
      const role = words.length > 1 ? parseRole(words[words.length - 1]) : null;
      return { who: (role ? words.slice(0, -1) : words).join(' '), role };
    });
  }

  /** add: into the pool. Not on the list yet → needs a role, and gets listed too. A role on someone listed updates it. */
  async add(text: string): Promise<Reply> {
    const parts = this.parts(text);
    if (!parts.length) throw new UserError('Usage: `$admin 5v5 add <name> [role], <name> [role] …` (a role is needed the first time).');
    const done: string[] = [], errors: string[] = [];
    const fresh: PlayerRow[] = [];
    for (const { who, role } of parts) {
      try {
        const p = await this.resolve(who);
        const listed = this.d.repo.inhouseList().find((x) => x.puuid === p.puuid);
        if (!listed && !role) throw new UserError(`**${p.game_name}** isn't on the list yet: add their main role, e.g. \`${p.game_name} mid\`.`);
        if (role) this.d.repo.inhouseSet(p.puuid, role, this.d.now());
        if (!listed) fresh.push(p);
        const added = this.d.repo.inhousePoolAdd(p.puuid, this.d.now());
        done.push(`${p.game_name}${!listed ? ' (new on the list)' : role && listed.main_role !== role ? ` (main now ${ROLE_LABEL[role]})` : ''}${added ? '' : ' (already in)'}`);
      } catch (e) {
        if (!(e instanceof UserError)) throw e;
        errors.push(e.message);
      }
    }
    await this.refreshRanks(fresh);
    const size = this.poolPlayers().length;
    return {
      embed: {
        title: done.length ? `Added to the pool` : 'Nobody added',
        color: errors.length && !done.length ? 0xf85149 : COLOR,
        description: [
          done.length ? done.map((d) => `• ${d}`).join('\n') : '',
          errors.length ? errors.map((e) => `⚠️ ${e}`).join('\n') : '',
          `\nPool: **${size}/10**${size >= 10 ? ' · ready: `$admin 5v5 generate [tryhard|random|offrole]`' : ''}`,
        ].filter(Boolean).join('\n'),
      },
      files: [],
    };
  }

  async remove(text: string): Promise<Reply> {
    const parts = this.parts(text);
    if (!parts.length) throw new UserError('Usage: `$admin 5v5 remove <name>[, <name> …]`');
    const out: string[] = [];
    for (const { who } of parts) {
      const p = await this.resolve(who);
      out.push(this.d.repo.inhousePoolRemove(p.puuid) ? `• ${p.game_name}` : `• ${p.game_name} wasn't in the pool`);
    }
    return { embed: { title: 'Removed from the pool', color: COLOR, description: `${out.join('\n')}\n\nPool: **${this.poolPlayers().length}/10**` }, files: [] };
  }

  async unlist(text: string): Promise<Reply> {
    const parts = this.parts(text);
    if (!parts.length) throw new UserError('Usage: `$admin 5v5 unlist <name>[, <name> …]`');
    const out: string[] = [];
    for (const { who } of parts) {
      const p = await this.resolve(who);
      out.push(this.d.repo.inhouseUnlist(p.puuid) ? `• ${p.game_name}` : `• ${p.game_name} wasn't on the list`);
    }
    return { embed: { title: 'Taken off the 5v5 list', color: COLOR, description: out.join('\n') }, files: [] };
  }

  clear(): Reply {
    const n = this.d.repo.inhousePoolClear();
    return { embed: { title: 'Pool cleared', color: COLOR, description: `${n} player${n === 1 ? '' : 's'} removed. The list is unchanged.` }, files: [] };
  }

  private poolPlayers(): Listed[] {
    return this.d.repo.inhouseList().filter((p) => p.in_pool);
  }

  private byRoleThenRank(a: Listed, b: Listed) {
    return ROLES.indexOf(a.main_role as Role) - ROLES.indexOf(b.main_role as Role) || (rankValue(this.rank(b.puuid)) ?? -1) - (rankValue(this.rank(a.puuid)) ?? -1);
  }

  /** Everyone on the list, by main role; ✅ = in tonight's pool. */
  list(): Reply {
    const all = this.d.repo.inhouseList().sort((a, b) => this.byRoleThenRank(a, b));
    const per = ROLES.map((r) => all.filter((p) => p.main_role === r).length).map((n, i) => `${ROLE_LABEL[ROLES[i]!]} ${n}`).join(' · ');
    return {
      embed: {
        title: `5v5 list (${all.length})`,
        color: COLOR,
        description: all.length
          ? `${all.map((p) => this.line(p, { pool: true })).join('\n').slice(0, 3900)}\n\n-# ${per} · ✅ in the pool`
          : 'Nobody yet. Add people with `$admin 5v5 add <name> <role>`.',
      },
      files: [],
    };
  }

  /** Tonight's pool, and who else from the list could join. */
  pool(): Reply {
    const all = this.d.repo.inhouseList().sort((a, b) => this.byRoleThenRank(a, b));
    const inPool = all.filter((p) => p.in_pool), rest = all.filter((p) => !p.in_pool);
    const fields = [];
    if (rest.length) fields.push({ name: `Can be added (${rest.length})`, value: rest.map((p) => this.line(p)).join('\n').slice(0, 1020), inline: false });
    return {
      embed: {
        title: `5v5 pool · ${inPool.length}/10`,
        color: inPool.length >= 10 ? 0x3fb950 : COLOR,
        description: inPool.length
          ? `${inPool.map((p) => this.line(p)).join('\n')}${inPool.length > 10 ? `\n\n-# ${inPool.length - 10} will sit out (picked at random)` : ''}`
          : 'Empty. Add people with `$admin 5v5 add <name>[, <name> …]`.',
        fields,
      },
      files: [],
    };
  }

  /** Two teams from the pool; buttons generate again in any mode. */
  async generate(mode: Mode): Promise<Reply> {
    const pool = this.poolPlayers();
    if (pool.length < 10) throw new UserError(`The pool has ${pool.length}/10 players. Add more with \`$admin 5v5 add <name>\`.`);
    await this.refreshRanks(pool);
    const players: InhousePlayer[] = pool.map((p) => ({ puuid: p.puuid, name: p.game_name, tag: p.tag_line, main: p.main_role as Role, rank: this.rank(p.puuid) }));
    const m = generate(players, mode);
    const png = await renderInhouse(m, this.d.service.assetSource());
    return {
      embed: { color: COLOR, image: { url: 'attachment://5v5.png' } },
      files: [{ name: '5v5.png', data: png }],
      components: [{
        type: 1,
        components: MODES.map((k) => ({
          type: 2, style: k === mode ? 1 : 2, custom_id: `${INHOUSE_PREFIX}${k}`,
          label: k === mode ? `Reroll ${k}` : k === 'offrole' ? 'Off-role' : k.charAt(0).toUpperCase() + k.slice(1),
        })),
      }],
    };
  }
}
