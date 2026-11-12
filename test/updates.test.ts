import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commitFromEnv, stripTrailers, updateEmbed } from '../src/discord/updates.ts';

const env = {
  RAILWAY_GIT_COMMIT_SHA: 'd0beb8f5c55b36df7d674d55965a23b8d54ad69b',
  RAILWAY_GIT_COMMIT_MESSAGE: 'Multi-account linking\n\n- Up to 10 accounts\n- Set main button\n\nCo-Authored-By: Someone <x@y.z>\nClaude-Session: https://example.com/s/1',
  RAILWAY_GIT_AUTHOR: 'qpcic', RAILWAY_GIT_BRANCH: 'main', RAILWAY_GIT_REPO_OWNER: 'qpcic', RAILWAY_GIT_REPO_NAME: 'zeke',
};

test('update post: subject as title, body without trailers, link to the commit', () => {
  const e = updateEmbed(commitFromEnv(env)!);
  assert.equal(e.title, '🛠️ Multi-account linking');
  assert.equal(e.description, '- Up to 10 accounts\n- Set main button');
  assert.equal(e.url, 'https://github.com/qpcic/zeke/commit/d0beb8f5c55b36df7d674d55965a23b8d54ad69b');
  assert.equal(e.footer.text, 'd0beb8f · qpcic · main');
  assert.equal(commitFromEnv({}), null);
  assert.equal(stripTrailers('Fix typo'), 'Fix typo');
});
