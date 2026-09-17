import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseArguments } from '../src/cli.js';
import type { Config } from '../src/types.js';

const config: Config = {
  branches: Object.fromEntries(['source', 'child', 'leaf', 'disabled'].map(branch => [branch, { local_path: branch, enabled: branch !== 'disabled' }])),
  tree: { source: ['child', 'disabled'], child: ['leaf'] },
};

test('quick arguments default to full merge and preserve revision and option parsing', () => {
  assert.equal(parseArguments([], config).quick, false);
  assert.equal(parseArguments(['--skip-summary-confirm'], config).quick, false);
  assert.deepEqual(parseArguments(['source'], config), { source: 'source', revisions: undefined, quick: true, concurrency: 6, skipConfirmation: false });
  assert.deepEqual(parseArguments(['--concurrency', '2', 'source', ' 12 , 14-16 '], config).revisions, ['12', '14', '15', '16']);
  assert.equal(parseArguments(['source', '--concurrency=3'], config).concurrency, 3);
  for (const args of [['missing'], ['leaf'], ['source', ''], ['source', '3-1'], ['source', '1', '2'], ['source', '--bad'], ['--concurrency', 'source']]) {
    assert.throws(() => parseArguments(args, config), args.join(' '));
  }
});

test('quick CLI automatically commits direct children in full and explicit revision modes', { timeout: 120000 }, () => {
  const root = mkdtempSync(join(tmpdir(), 'svn-quick-test-'));
  const run = (command: string, args: string[], cwd = root) => {
    const result = spawnSync(command, args, { cwd, env: { ...process.env, HOME: root, USERPROFILE: root }, encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, `${command}: ${result.stdout}\n${result.stderr}`);
    return result.stdout;
  };
  const svn = (...args: string[]) => run('svn', ['--non-interactive', ...args]);
  try {
    const repo = join(root, 'repo');
    run('svnadmin', ['create', repo]);
    const url = pathToFileURL(repo).href;
    const seed = join(root, 'seed');
    mkdirSync(seed);
    writeFileSync(join(seed, 'file.txt'), 'initial\n');
    svn('import', seed, `${url}/source`, '-m', 'initial');
    svn('copy', `${url}/source`, `${url}/child`, '-m', 'child');
    svn('copy', `${url}/child`, `${url}/leaf`, '-m', 'leaf');
    const branches: Config['branches'] = {};
    for (const branch of ['source', 'child', 'leaf']) {
      const path = join(root, branch);
      svn('checkout', `${url}/${branch}`, path);
      branches[branch] = { local_path: path, enabled: true };
    }
    mkdirSync(join(root, '.svnmbm'));
    writeFileSync(join(root, '.svnmbm/config.jsonc'), JSON.stringify({ branches, tree: { source: ['child'], child: ['leaf'] } }));
    const launch = (...args: string[]) => run(process.execPath, ['--import', pathToFileURL(resolve('node_modules/tsx/dist/loader.mjs')).href, resolve('src/main.ts'), 'source', ...args]);
    for (const [index, mode] of ['all', 'explicit'].entries()) {
      writeFileSync(join(root, 'source', 'file.txt'), `change ${index}\n`);
      svn('commit', join(root, 'source'), '-m', `change ${index}`);
      const revision = run('svnlook', ['youngest', repo]).trim();
      const output = mode === 'all' ? launch() : launch(revision);
      assert.match(output, /提交成功/);
      assert.doesNotMatch(output, /确认执行？|确认以上合并汇总/);
      assert.equal(svn('cat', `${url}/child/file.txt`).trim(), `change ${index}`);
      assert.equal(svn('cat', `${url}/leaf/file.txt`).trim(), 'initial');
    }
    const before = run('svnlook', ['youngest', repo]).trim();
    assert.match(launch(), /无需执行/);
    assert.equal(run('svnlook', ['youngest', repo]).trim(), before);
    const launchBlocked = () => spawnSync(process.execPath, [
      '--import', pathToFileURL(resolve('node_modules/tsx/dist/loader.mjs')).href,
      resolve('src/main.ts'), 'source', '--skip-summary-confirm',
    ], { cwd: root, env: { ...process.env, HOME: root, USERPROFILE: root }, encoding: 'utf8', timeout: 30000 });
    writeFileSync(join(root, 'child', 'file.txt'), 'local change\n');
    const dirty = launchBlocked();
    assert.equal(dirty.status, 1);
    assert.match(dirty.stderr, /工作副本需要人工处理/);
    assert.equal(run('svnlook', ['youngest', repo]).trim(), before);
    svn('commit', join(root, 'child'), '-m', 'diverge child');
    writeFileSync(join(root, 'source', 'file.txt'), 'conflicting source\n');
    svn('commit', join(root, 'source'), '-m', 'diverge source');
    const beforeConflict = run('svnlook', ['youngest', repo]).trim();
    const conflict = launchBlocked();
    assert.equal(conflict.status, 1);
    assert.match(conflict.stderr, /合并存在异常，需要人工确认/);
    assert.equal(run('svnlook', ['youngest', repo]).trim(), beforeConflict);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
