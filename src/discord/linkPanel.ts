import type { Reply, Service } from '../core/service.ts';
import { MAX_LINKS } from '../core/service.ts';
import { COLORS } from '../render/embed.ts';
import { PLATFORM_LABEL } from '../riot/regions.ts';

/**
 * /link panel: the user's linked accounts plus buttons. Custom ids carry the owner's
 * Discord id ("link:<action>:<userId>") so only they can press anything on it.
 */
export type PanelMode = 'view' | 'remove' | 'main';

export const LINK_PREFIX = 'link:';
export const linkId = (action: string, userId: string) => `${LINK_PREFIX}${action}:${userId}`;
export function parseLinkId(customId: string): { action: string; owner: string } | null {
  const m = /^link:([a-z]+):([^:]+)$/.exec(customId);
  return m ? { action: m[1]!, owner: m[2]! } : null;
}

const BUTTON = 2, SELECT = 3, ROW = 1, TEXT_INPUT = 4;
const STYLE = { primary: 1, secondary: 2, success: 3, danger: 4 } as const;

export function linkPanel(service: Service, userId: string, style: string, opts: { status?: string; ok?: boolean; mode?: PanelMode } = {}): Reply {
  const accounts = service.linkPanelData(userId);
  const mode = opts.mode ?? 'view';
  const lines = accounts.map((a) =>
    `${a.isMain ? '⭐' : '▫️'} **${a.player.game_name}#${a.player.tag_line}** · ${PLATFORM_LABEL[a.player.platform]}${a.rank ? ` · ${a.rank}` : ''}${a.isMain ? ' · **main**' : ''}`);
  const body = accounts.length
    ? lines.join('\n')
    : `No accounts linked yet. Press **Add account**${style === '/' ? '' : ` or use \`${style}link <region> <Name#TAG>\``}.`;
  const status = opts.status ? `${opts.ok === false ? '❌' : '✅'} ${opts.status}\n\n` : '';
  const hint = mode === 'remove' ? '\n\n**Pick the account to remove.**' : mode === 'main' ? '\n\n**Pick your new main account.**' : '';

  const embed = {
    title: accounts.length > 1 ? `Linked accounts (${accounts.length}/${MAX_LINKS})` : 'Linked account',
    description: status + body + hint,
    color: opts.ok === false ? COLORS.loss : COLORS.info,
    footer: { text: accounts.length > 1 ? 'Main is used for @mentions and stats · /recent shows your newest game on any account' : 'Add more accounts as alts; the first one is your main' },
  };

  let components: object[];
  if (mode === 'view') {
    components = [{
      type: ROW,
      components: [
        { type: BUTTON, style: STYLE.success, label: 'Add account', emoji: { name: '➕' }, custom_id: linkId('add', userId), disabled: accounts.length >= MAX_LINKS },
        { type: BUTTON, style: STYLE.danger, label: 'Remove account', emoji: { name: '✖️' }, custom_id: linkId('remove', userId), disabled: !accounts.length },
        ...(accounts.length > 1 ? [{ type: BUTTON, style: STYLE.secondary, label: 'Set main', emoji: { name: '⭐' }, custom_id: linkId('main', userId) }] : []),
      ],
    }];
  } else {
    const choices = mode === 'main' ? accounts.filter((a) => !a.isMain) : accounts;
    components = [
      {
        type: ROW,
        components: [{
          type: SELECT,
          custom_id: linkId(mode === 'main' ? 'mainpick' : 'rmpick', userId),
          placeholder: mode === 'main' ? 'New main account' : 'Account to remove',
          options: choices.slice(0, 25).map((a) => ({
            label: `${a.player.game_name}#${a.player.tag_line}`.slice(0, 100),
            description: `${PLATFORM_LABEL[a.player.platform]}${a.isMain ? ' · main' : ''}`,
            value: a.player.puuid.slice(0, 100),
          })),
        }],
      },
      { type: ROW, components: [{ type: BUTTON, style: STYLE.secondary, label: 'Cancel', custom_id: linkId('cancel', userId) }] },
    ];
  }
  return { embed, files: [], components };
}

/** "Add account" form. Region is prefilled with the main account's (or the default) region. */
export function addAccountModal(userId: string, regionPrefill: string) {
  return {
    title: 'Link a Riot account',
    custom_id: linkId('modal', userId),
    components: [
      { type: ROW, components: [{ type: TEXT_INPUT, custom_id: 'riot_id', label: 'Riot ID', style: 1, placeholder: 'Name#TAG', required: true, min_length: 3, max_length: 30 }] },
      { type: ROW, components: [{ type: TEXT_INPUT, custom_id: 'region', label: 'Region', style: 1, placeholder: 'EUW, EUNE, NA, KR…', required: false, max_length: 10, ...(regionPrefill ? { value: regionPrefill } : {}) }] },
    ],
  };
}

/** Status line after linking. */
export function linkedStatus(r: { player: { game_name: string; tag_line: string }; added: boolean; isMain: boolean }): string {
  const name = `**${r.player.game_name}#${r.player.tag_line}**`;
  if (!r.added) return `${name} is already linked.`;
  return r.isMain ? `Linked ${name} as your main account.` : `Linked ${name} as an alt.`;
}

export function unlinkedStatus(r: { player: { game_name: string; tag_line: string }; newMain: { game_name: string; tag_line: string } | null }): string {
  return `Removed **${r.player.game_name}#${r.player.tag_line}**.${r.newMain ? ` **${r.newMain.game_name}#${r.newMain.tag_line}** is your main now.` : ''}`;
}
