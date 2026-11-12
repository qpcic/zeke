import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateEmbed } from '../src/render/embed.ts';
import { zekeEmbed } from '../src/discord/actions.ts';
import { presenceText } from '../src/discord/presence.ts';

test('/zeke: intro, get-started steps, links incl. invite, stats footer', () => {
  const e = zekeEmbed('$', { players: 13, linkedUsers: 4, servers: 2 }, { DISCORD_CLIENT_ID: '1234', RAILWAY_GIT_COMMIT_SHA: 'abcdef123456' });
  assert.deepEqual(validateEmbed(e), []);
  const links = e.fields!.find((f) => f.name.includes('Links'))!.value;
  assert.match(links, /discord\.gg\/Zf6zYWEJNK/);
  assert.match(links, /client_id=1234/);
  assert.match(links, /privacy-policy\.md/);
  assert.equal(e.footer!.text, '13 players tracked · 4 linked users · 2 servers · version abcdef1 · $help for all commands');
  assert.doesNotMatch(zekeEmbed('/', { players: 1, linkedUsers: 1 }, {}).fields![2]!.value, /Add Zeke/, 'no invite without a client id');
});

test('presence: fixed "$help | N users"', () => {
  assert.equal(presenceText('$', 12), '$help | 12 users');
  assert.equal(presenceText('', 1), '/help | 1 user');
});
