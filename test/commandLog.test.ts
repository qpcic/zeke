import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatChannel, formatStdout } from '../src/discord/commandLog.ts';

const base = { text: '/recent riot_id:Faker#KR1', userId: '42', userName: 'jan', guildId: '7', guildName: 'Zeke HQ', channelId: '9', ok: true, ms: 1234 };

test('stdout line has command, user, place, time and status', () => {
  assert.equal(formatStdout(base), 'cmd: /recent riot_id:Faker#KR1 · jan (42) · Zeke HQ (7) #9 · 1.2s · ok');
  assert.match(formatStdout({ ...base, guildId: null, ok: false, error: 'No linked account' }), /· DM · 1\.2s · failed: No linked account$/);
});

test('channel line uses timestamps, mentions and escapes backticks', () => {
  const l = formatChannel({ ...base, text: '$rs `@everyone`' }, 1_700_000_000_000);
  assert.equal(l, '<t:1700000000:T> ✅ <@42> `$rs ˋ@everyoneˋ` · Zeke HQ <#9> · 1.2s');
  assert.match(formatChannel({ ...base, ok: false, error: 'boom' }), /❌ .* · boom$/);
});
