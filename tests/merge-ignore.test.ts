import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { loadMergeIgnores, isMergeIgnored } from '../src/merge-ignore.js';
import { mergeBranch, commitAfterSummary, checkWorkspaces } from '../src/merger.js';
import { cleanWorkspace } from '../src/workspace.js';

test('ignore YAML is isolated per workspace, matches directories and rejects unsafe rules', () => {
  const root = mkdtempSync(join(tmpdir(), 'svn-ignore-config-'));
  try {
    assert.deepEqual(loadMergeIgnores(root), []);
    writeFileSync(join(root, 'svnmerge.yaml'), 'ignore:\n  - Doc\n  - file.txt\n');
    const rules = loadMergeIgnores(root);
    assert.ok(isMergeIgnored(join(root, 'Doc/sub/file'), rules));
    assert.ok(!isMergeIgnored(join(root, 'Document/file'), rules));
    for (const yaml of ['ignore: text', 'ignore: [../outside]', 'ignore: [.]', 'ignore: [.svn]', 'ignore: [']) {
      writeFileSync(join(root, 'svnmerge.yaml'), yaml);
      assert.throws(() => loadMergeIgnores(root));
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('real SVN per-branch ignores revert conflicts/additions/deletions/properties and never commit ignored paths', { timeout: 120000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'svn-ignore-merge-'));
  const run = (command: string, args: string[]) => {
    const result = spawnSync(command, args, { encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return result.stdout.trim();
  };
  const svn = (...args: string[]) => run('svn', ['--non-interactive', ...args]);
  const quiet = () => {};
  try {
    const repo = join(root, 'repo');
    run('svnadmin', ['create', repo]);
    const url = pathToFileURL(repo).href;
    const seed = join(root, 'seed');
    mkdirSync(join(seed, 'Doc'), { recursive: true });
    mkdirSync(join(seed, 'Doc/tree'));
    writeFileSync(join(seed, 'Doc/tree/file'), 'base\n');
    for (const file of ['Doc/conflict', 'Doc/deleted', 'Doc/property', 'normal']) writeFileSync(join(seed, file), 'base\n');
    svn('import', seed, `${url}/source`, '-m', 'seed');
    const source = join(root, 'source');
    svn('checkout', `${url}/source`, source);
    const targets = ['a', 'b'].map(branch => ({ branch, path: join(root, branch) }));
    for (const target of targets) {
      svn('copy', `${url}/source`, `${url}/${target.branch}`, '-m', 'branch');
      svn('checkout', `${url}/${target.branch}`, target.path);
      writeFileSync(join(target.path, 'svnmerge.yaml'), `ignore:\n  - svnmerge.yaml\n${target.branch === 'a' ? '  - Doc\n' : ''}`);
    }
    writeFileSync(join(targets[0].path, 'Doc/conflict'), 'branch content\n');
    svn('commit', join(targets[0].path, 'Doc/conflict'), '-m', 'diverge');
    writeFileSync(join(targets[0].path, 'Doc/tree/file'), 'branch tree content\n');
    svn('commit', join(targets[0].path, 'Doc/tree/file'), '-m', 'diverge tree');
    writeFileSync(join(source, 'Doc/conflict'), 'incoming\n');
    writeFileSync(join(source, 'normal'), 'incoming normal\n');
    writeFileSync(join(source, 'Doc/added'), 'incoming addition\n');
    svn('add', join(source, 'Doc/added'));
    svn('delete', join(source, 'Doc/deleted'));
    svn('delete', join(source, 'Doc/tree'));
    svn('propset', 'custom', 'incoming', join(source, 'Doc/property'));
    svn('commit', source, '-m', 'source changes');
    const revision = run('svnlook', ['youngest', repo]);
    assert.deepEqual(await checkWorkspaces(targets), []);
    // Explicit cleanup must preserve ignored local config.
    writeFileSync(join(targets[0].path, 'scratch'), 'remove me');
    await cleanWorkspace(targets[0].path, quiet);
    assert.ok(existsSync(join(targets[0].path, 'svnmerge.yaml')));
    const results = [];
    for (const target of targets) results.push(await mergeBranch(target.branch, target.path, `${url}/source`, ['-c', revision], quiet));
    assert.deepEqual(results.map(result => result.status), ['ready', 'ready'], JSON.stringify(results));
    assert.deepEqual(results[0].conflicts, []);
    assert.ok(results[0].changes.every(entry => !entry.path.includes('Doc')));
    assert.equal(readFileSync(join(targets[0].path, 'Doc/conflict'), 'utf8'), 'branch content\n');
    assert.ok(existsSync(join(targets[0].path, 'Doc/deleted')));
    assert.ok(!existsSync(join(targets[0].path, 'Doc/added')));
    assert.equal(readFileSync(join(targets[0].path, 'Doc/tree/file'), 'utf8'), 'branch tree content\n');
    await commitAfterSummary(results, 'merge', true, async () => assert.fail('ignored conflicts do not require confirmation'), quiet);
    assert.deepEqual(results.map(result => result.status), ['committed', 'committed']);
    assert.equal(svn('cat', `${url}/a/Doc/conflict`), 'branch content');
    assert.equal(svn('cat', `${url}/b/Doc/conflict`), 'incoming');
    assert.equal(svn('cat', `${url}/a/normal`), 'incoming normal');
    assert.ok(!svn('proplist', `${url}/a/Doc/property`).includes('custom'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
