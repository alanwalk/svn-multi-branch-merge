import assert from 'node:assert/strict';
import test from 'node:test';
import { parseConfig } from '../src/config.js';

test('JSONC accepts comments and trailing commas without altering string contents', () => {
  const config = parseConfig(`\uFEFF{
    // 本地分支
    "branches": {
      "dev": { "local_path": "//server/share/*literal*/", "enabled": true },
    },
    /* 暂停向生产分支同步 */
    "tree": { "dev": [], },
  }`);
  assert.equal(config.branches.dev.local_path, '//server/share/*literal*/');
  assert.deepEqual(config.tree, { dev: [] });
});

test('JSONC rejects syntax errors instead of returning a partial configuration', () => {
  assert.throws(() => parseConfig('{\n "branches": { broken }\n}'), /config\.jsonc:2:\d+ 配置语法错误/);
});
