import type { PlayerRow, Repo } from '../db/repo.ts';
import { renderInhouse } from '../render/image/inhouse.ts';
import type { RiotClient } from '../riot/client.ts';
import { ForcedRolesError, generate, MODES, parseRole, rankValue, ratingChanges, ROLE_LABEL, ROLES, type InhousePlayer, type Matchup, type Mode, type Role, type Seat } from './inhouse.ts';
import { formatRank, type Rank } from './rank.ts';
import { UserError, type Reply, type Service } from './service.ts';

/** `$admin 5v5 …`: the list, tonight's pool, and team generation. Owner console only. */

export const INHOUSE_PREFIX = 'ih:';
/** The pool is the ten people playing right now. */
export const POOL_MAX = 10;
const SOLO = 'RANKED_SOLO_5x5';
const COLOR = 0x5865f2;

interface Deps { service: Service; repo: Repo; riot: RiotClient; now: () => number; log: (m: string) => void }
type Listed = PlayerRow & { main_role: string; in_pool: number; rating: number; wins: number; losses: number; forced_roles: string };
const forced = (p: Listed): Role[] => (p.forced_roles ? (p.forced_roles.split(',') as Role[]) : []);
const roleList = (rs: Role[]) => rs.map((r) => ROLE_LABEL[r]).join(' / ');

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

  private line(p: Listed, opts: { pool?: boolean } = {}): string {
    const pool = opts.pool && p.in_pool ? '✅ ' : '';
    const games = p.wins + p.losses;
    const f = p.in_pool ? forced(p) : [];
    return `${pool}\`${ROLE_LABEL[p.main_role as Role].padEnd(7)}\` **${p.game_name}**#${p.tag_line} · ${formatRank(this.rank(p.puuid))} · **${p.rating}**${games ? ` (${p.wins}W ${p.losses}L)` : ''}${f.length ? ` · 🔒 ${roleList(f)}` : ''}`;
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
        const inPool = this.poolPlayers().some((x) => x.puuid === p.puuid);
        if (!inPool && this.poolPlayers().length >= POOL_MAX) {
          throw new UserError(`**${p.game_name}** ${listed ? '' : 'is on the list now, but '}didn't fit: the pool is full (${POOL_MAX}/${POOL_MAX}).`);
        }
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
          `\nPool: **${size}/${POOL_MAX}**${size === POOL_MAX ? ' · ready: `$admin 5v5 generate [tryhard|random|offrole]`' : ''}`,
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

  /**
   * The pool panel: who's playing now, with menus to pick from the list (25 names per menu)
   * and buttons to generate or clear. Picking in a menu sets the pool for those names.
   */
  pool(note?: string): Reply {
    const all = this.d.repo.inhouseList();
    const inPool = all.filter((p) => p.in_pool).sort((a, b) => this.byRoleThenRank(a, b));
    const chunks = this.chunks(all);
    const ready = inPool.length === POOL_MAX;
    return {
      embed: {
        title: `5v5 pool · ${inPool.length}/${POOL_MAX}`,
        color: ready ? 0x3fb950 : inPool.length > POOL_MAX ? 0xf85149 : COLOR,
        description: [
          note ? `${note}\n` : '',
          inPool.length ? inPool.map((p) => this.line(p)).join('\n') : 'Nobody yet.',
          inPool.length > POOL_MAX ? `\n⚠️ Only ${POOL_MAX} can play: untick ${inPool.length - POOL_MAX}.` : '',
          all.length ? `\n-# Pick who's playing in the menu${chunks.length > 1 ? 's' : ''} below (${all.length} on the list).` : '\nThe list is empty: add people with `$admin 5v5 add <name> <role>`.',
        ].filter(Boolean).join('\n'),
      },
      files: [],
      components: [
        ...chunks.slice(0, 4).map((c, k) => ({
          type: 1,
          components: [{
            type: 3,
            custom_id: `${INHOUSE_PREFIX}pool:${k}`,
            placeholder: chunks.length > 1 ? `Players ${c[0]!.game_name} – ${c[c.length - 1]!.game_name}` : 'Who is playing?',
            min_values: 0,
            max_values: Math.min(POOL_MAX, c.length),
            options: c.map((p) => ({
              label: `${p.game_name}#${p.tag_line}`.slice(0, 100),
              value: p.puuid,
              description: `${ROLE_LABEL[p.main_role as Role]} · ${formatRank(this.rank(p.puuid))} · ${p.rating} rating`.slice(0, 100),
              default: !!p.in_pool,
            })),
          }],
        })),
        {
          type: 1,
          components: [
            { type: 2, style: 1, label: 'Generate teams', custom_id: `${INHOUSE_PREFIX}new:tryhard`, disabled: !ready },
            { type: 2, style: 2, label: 'Random', custom_id: `${INHOUSE_PREFIX}new:random`, disabled: !ready },
            { type: 2, style: 2, label: 'Off-role', custom_id: `${INHOUSE_PREFIX}new:offrole`, disabled: !ready },
            { type: 2, style: 2, label: 'Force roles', custom_id: `${INHOUSE_PREFIX}force`, disabled: !inPool.length },
            { type: 2, style: 4, label: 'Clear pool', custom_id: `${INHOUSE_PREFIX}clear`, disabled: !inPool.length },
          ],
        },
      ],
    };
  }

  /** The list in menu order (by name), 25 per menu. */
  private chunks(all: Listed[]): Listed[][] {
    const sorted = [...all].sort((a, b) => a.game_name.localeCompare(b.game_name, undefined, { sensitivity: 'base' }));
    const out: Listed[][] = [];
    for (let i = 0; i < sorted.length; i += 25) out.push(sorted.slice(i, i + 25));
    return out;
  }

  /** A pool menu was changed: its names are now exactly the ones picked. */
  setPoolFromMenu(menu: number, picked: string[]): Reply {
    const all = this.d.repo.inhouseList();
    const chunk = new Set((this.chunks(all)[menu] ?? []).map((p) => p.puuid));
    const next = [...all.filter((p) => p.in_pool && !chunk.has(p.puuid)).map((p) => p.puuid), ...picked.filter((x) => chunk.has(x))];
    if (next.length > POOL_MAX) {
      throw new UserError(`That's ${next.length} players: the pool holds ${POOL_MAX}. Untick someone first.`);
    }
    this.d.repo.inhousePoolSet(next, this.d.now());
    return this.pool();
  }

  /**
   * Force roles: pick someone from the pool, then tick the roles they may play (generate keeps
   * them in one of those). Nothing or everything ticked = any role. Leaving the pool drops it.
   */
  forcePanel(selected?: string, note?: string): Reply {
    const pool = this.poolPlayers().sort((a, b) => this.byRoleThenRank(a, b));
    if (!pool.length) throw new UserError('The pool is empty: pick who is playing in `$admin 5v5 pool` first.');
    const sel = pool.find((p) => p.puuid === selected);
    const withForce = pool.filter((p) => forced(p).length);
    return {
      embed: {
        title: sel ? `Force roles · ${sel.game_name}` : 'Force roles',
        color: COLOR,
        description: [
          note ? `${note}\n` : '',
          sel
            ? `Main: **${ROLE_LABEL[sel.main_role as Role]}**. Tick the roles **${sel.game_name}** may play; teams will put them on one of those. Untick everything for any role.`
            : 'Pick a player, then tick the roles they may play.',
          '',
          withForce.length ? withForce.map((p) => `🔒 **${p.game_name}**: ${roleList(forced(p))}`).join('\n') : '-# Nobody has forced roles.',
        ].filter((x) => x !== '').join('\n'),
      },
      files: [],
      components: [
        {
          type: 1,
          components: [{
            type: 3, custom_id: `${INHOUSE_PREFIX}fp`, placeholder: 'Player', min_values: 1, max_values: 1,
            options: pool.map((p) => ({
              label: `${p.game_name}#${p.tag_line}`.slice(0, 100), value: p.puuid, default: p.puuid === sel?.puuid,
              description: `Main ${ROLE_LABEL[p.main_role as Role]}${forced(p).length ? ` · forced: ${roleList(forced(p))}` : ''}`.slice(0, 100),
            })),
          }],
        },
        ...(sel ? [{
          type: 1,
          components: [{
            type: 3, custom_id: `${INHOUSE_PREFIX}fr:${sel.puuid}`, placeholder: 'Any role', min_values: 0, max_values: ROLES.length,
            options: ROLES.map((r) => ({
              label: ROLE_LABEL[r], value: r, default: forced(sel).includes(r),
              description: r === sel.main_role ? 'main role' : undefined,
            })),
          }],
        }] : []),
        {
          type: 1,
          components: [
            { type: 2, style: 4, label: 'Clear all forced roles', custom_id: `${INHOUSE_PREFIX}fclear`, disabled: !withForce.length },
            { type: 2, style: 1, label: 'Generate teams', custom_id: `${INHOUSE_PREFIX}new:tryhard`, disabled: pool.length !== POOL_MAX },
          ],
        },
      ],
    };
  }

  setForce(puuid: string, roles: string[]): Reply {
    const rs = ROLES.filter((r) => roles.includes(r));
    const list = rs.length === ROLES.length ? [] : rs; // all ticked = any
    if (!this.d.repo.inhouseForce(puuid, list)) throw new UserError("They aren't in the pool any more.");
    const p = this.poolPlayers().find((x) => x.puuid === puuid);
    return this.forcePanel(puuid, p ? (list.length ? `🔒 **${p.game_name}** will play ${roleList(list)}.` : `**${p.game_name}** can play any role.`) : undefined);
  }

  clearForces(): Reply {
    this.d.repo.inhouseForceClear();
    return this.forcePanel(undefined, 'Forced roles cleared.');
  }

  /** Rating table: everyone on the list who has played. */
  top(): Reply {
    const all = this.d.repo.inhouseList().sort((a, b) => b.rating - a.rating || b.wins - a.wins);
    const played = all.filter((p) => p.wins + p.losses);
    const medal = ['🥇', '🥈', '🥉'];
    return {
      embed: {
        title: '5v5 rating',
        color: 0xf5c542,
        description: played.length
          ? played.slice(0, 30).map((p, i) => `${medal[i] ?? `\`${String(i + 1).padStart(2)}.\``} **${p.game_name}** · **${p.rating}** · ${p.wins}W ${p.losses}L (${Math.round((p.wins / (p.wins + p.losses)) * 100)}%)`).join('\n')
          : 'No games decided yet. Generate teams and press **Blue won** / **Red won** after the game.',
        footer: { text: 'Everyone starts at 1000 · ±25 for even teams, more for upsets · half on your main role' },
      },
      files: [],
    };
  }

  /** Two teams from the pool (exactly 10), saved so the result can be set from the buttons. */
  async generate(mode: Mode): Promise<Reply> {
    const pool = this.poolPlayers();
    if (pool.length !== POOL_MAX) {
      throw new UserError(pool.length < POOL_MAX
        ? `The pool has ${pool.length}/${POOL_MAX} players. Add more with \`$admin 5v5 pool\`.`
        : `The pool has ${pool.length} players but only ${POOL_MAX} can play: untick ${pool.length - POOL_MAX} in \`$admin 5v5 pool\`.`);
    }
    await this.refreshRanks(pool);
    let m: Matchup;
    try {
      m = generate(pool.map((p) => this.toPlayer(p)), mode);
    } catch (e) {
      if (e instanceof ForcedRolesError) throw new UserError(e.message);
      throw e;
    }
    const seats = (t: Seat[]) => JSON.stringify(t.map((x) => ({ puuid: x.player.puuid, role: x.role })));
    const id = this.d.repo.inhouseMatchCreate({ mode, blue: seats(m.blue), red: seats(m.red) }, this.d.now());
    return this.matchReply(id);
  }

  private toPlayer(p: Listed): InhousePlayer {
    return { puuid: p.puuid, name: p.game_name, tag: p.tag_line, main: p.main_role as Role, rank: this.rank(p.puuid), rating: p.rating, allowed: forced(p) };
  }

  /** A saved game, rebuilt from the list (current ratings), as its card + buttons. */
  private async matchReply(id: number): Promise<Reply> {
    const row = this.d.repo.inhouseMatch(id);
    if (!row) throw new UserError('That 5v5 game is gone.');
    const byId = new Map(this.d.repo.inhouseList().map((p) => [p.puuid, p]));
    const team = (json: string): Seat[] => (JSON.parse(json) as { puuid: string; role: Role }[]).map((s) => {
      const p = byId.get(s.puuid);
      if (!p) throw new UserError('Someone from that game was taken off the list.');
      return { player: this.toPlayer(p), role: s.role };
    });
    const blue = team(row.blue), red = team(row.red);
    const avg = (t: Seat[]) => t.reduce((s, x) => s + (rankValue(x.player.rank) ?? 1200), 0) / 5;
    const m: Matchup = {
      mode: row.mode as Mode, blue, red, blueAvg: avg(blue), redAvg: avg(red),
      onMain: [...blue, ...red].filter((s) => s.player.main === s.role).length, bench: [],
    };
    const result = row.winner ? { winner: row.winner, deltas: JSON.parse(row.deltas ?? '{}') as Record<string, number> } : null;
    const png = await renderInhouse(m, this.d.service.assetSource(), result);
    const rerolls = {
      type: 1,
      components: MODES.map((k) => ({
        type: 2, style: !result && k === row.mode ? 1 : 2, custom_id: `${INHOUSE_PREFIX}${result ? 'new:' : ''}${k}`,
        label: result
          ? `New ${k === 'offrole' ? 'off-role' : k} teams`
          : k === row.mode ? `Reroll ${k}` : k === 'offrole' ? 'Off-role' : k.charAt(0).toUpperCase() + k.slice(1),
      })),
    };
    const outcome = result
      ? { type: 1, components: [{ type: 2, style: 2, label: 'Undo result', custom_id: `${INHOUSE_PREFIX}undo:${id}` }] }
      : {
          type: 1,
          components: [
            { type: 2, style: 1, label: 'Blue won', custom_id: `${INHOUSE_PREFIX}win:${id}:blue` },
            { type: 2, style: 4, label: 'Red won', custom_id: `${INHOUSE_PREFIX}win:${id}:red` },
          ],
        };
    return {
      embed: { color: result ? (result.winner === 'blue' ? 0x4c8dff : 0xff5a5f) : COLOR, image: { url: 'attachment://5v5.png' } },
      files: [{ name: '5v5.png', data: png }],
      components: [outcome, rerolls],
    };
  }

  /** Blue won / Red won: rating for everyone (half on your main role). Pressing the other side switches it. */
  async setWinner(id: number, winner: 'blue' | 'red'): Promise<Reply> {
    const row = this.d.repo.inhouseMatch(id);
    if (!row) throw new UserError('That 5v5 game is gone.');
    if (row.winner === winner) return this.matchReply(id);
    if (row.winner) this.undoRow(row);
    const byId = new Map(this.d.repo.inhouseList().map((p) => [p.puuid, p]));
    const side = (json: string) => (JSON.parse(json) as { puuid: string; role: Role }[]).flatMap((s) => {
      const p = byId.get(s.puuid);
      return p ? [{ puuid: p.puuid, rating: p.rating, onMain: p.main_role === s.role }] : [];
    });
    this.d.repo.inhouseResult(id, winner, ratingChanges(side(row.blue), side(row.red), winner), 1, this.d.now());
    return this.matchReply(id);
  }

  async undo(id: number): Promise<Reply> {
    const row = this.d.repo.inhouseMatch(id);
    if (!row) throw new UserError('That 5v5 game is gone.');
    if (row.winner) this.undoRow(row);
    return this.matchReply(id);
  }

  private undoRow(row: NonNullable<ReturnType<Repo['inhouseMatch']>>) {
    const deltas = JSON.parse(row.deltas ?? '{}') as Record<string, number>;
    const winners = new Set((JSON.parse(row.winner === 'blue' ? row.blue : row.red) as { puuid: string }[]).map((s) => s.puuid));
    this.d.repo.inhouseResult(row.id, null, Object.entries(deltas).map(([puuid, delta]) => ({ puuid, delta, won: winners.has(puuid) })), -1, this.d.now());
  }
}
