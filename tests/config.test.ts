import assert from 'node:assert/strict';
import test from 'node:test';
import { parseConfig, loadConfig, configPath } from '../src/config.js';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, existsSync, writeFileSync, rmSync } from 'node:fs';

test('home configuration is required, missing file explains format without creating anything', () => {
  assert.equal(configPath(), join(homedir(), '.svnmbm', 'config.jsonc'));
  const root = mkdtempSync(join(tmpdir(), 'svnmbm-config-'));
  const path = join(root, 'config.jsonc');
  try {
    assert.throws(() => loadConfig(path), error => {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes(path));
      assert.match(error.message, /请先创建/);
      assert.match(error.message, /"branches"/);
      assert.match(error.message, /"local_path"/);
      assert.match(error.message, /"tree"/);
      return true;
    });
    assert.equal(existsSync(path), false);
    writeFileSync(path, '{ "branches": { "dev": { "local_path": "copies/dev", "enabled": true } }, "tree": {} }');
    assert.equal(loadConfig(path).branches.dev.local_path, join(root, 'copies/dev'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

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
