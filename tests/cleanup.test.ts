import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { cleanWorkspace, cleanWorkspaces, dirtyEntries, assertCleanupPath } from '../src/workspace.js';
import { svnReadStatusAsync } from '../src/svn.js';

test('real SVN cleanup restores M/D/missing/additions and deletes ? across selected copies, preserving ignore-on-commit', { timeout: 120000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'svn-clean-test-'));
  const run = (command: string, args: string[]) => {
    const result = spawnSync(command, args, { encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return result.stdout;
  };
  const svn = (...args: string[]) => run('svn', ['--non-interactive', ...args]);
  try {
    const repo = join(root, 'repo');
    run('svnadmin', ['create', repo]);
    const url = pathToFileURL(repo).href;
    const seed = join(root, 'seed');
    mkdirSync(join(seed, 'dir'), { recursive: true });
    for (const file of ['modified.txt', 'missing.txt', 'ignored.txt', 'dir/deleted.txt']) writeFileSync(join(seed, file), 'original\n');
    svn('import', seed, url, '-m', 'seed');
    const targets = ['first', 'second'].map(branch => ({ branch, path: join(root, branch) }));
    for (const { path } of targets) {
      svn('checkout', url, path);
      writeFileSync(join(path, 'modified.txt'), 'discard me');
      writeFileSync(join(path, 'ignored.txt'), 'keep me');
      svn('changelist', 'ignore-on-commit', join(path, 'ignored.txt'));
      svn('propset', 'local-prop', 'discard me', path);
      svn('delete', join(path, 'dir'));
      rmSync(join(path, 'missing.txt'));
      mkdirSync(join(path, 'added'));
      writeFileSync(join(path, 'added', 'file.txt'), 'new scheduled file');
      svn('add', join(path, 'added'));
      mkdirSync(join(path, 'unversioned', 'child'), { recursive: true });
      writeFileSync(join(path, 'unversioned', 'child', 'file.txt'), 'untracked');
    }
    const output: string[] = [];
    const failures = await cleanWorkspaces(targets, 2, (_index, line) => output.push(line));
    assert.deepEqual(failures, []);
    assert.ok(!output.some(line => line.includes('清理未完成')), output.join('\n'));
    for (const { path } of targets) {
      assert.equal(readFileSync(join(path, 'modified.txt'), 'utf8'), 'original\n');
      assert.equal(readFileSync(join(path, 'missing.txt'), 'utf8'), 'original\n');
      assert.equal(readFileSync(join(path, 'dir', 'deleted.txt'), 'utf8'), 'original\n');
      assert.equal(readFileSync(join(path, 'ignored.txt'), 'utf8'), 'keep me');
      assert.equal(existsSync(join(path, 'added')), false);
      assert.equal(existsSync(join(path, 'unversioned')), false);
      const status = await svnReadStatusAsync(path);
      assert.deepEqual(dirtyEntries(status), []);
      assert.ok(status.some(entry => entry.changelist === 'ignore-on-commit' && entry.text === 'M'));
    }

    // A nested checkout is not disposable unversioned content.
    const nested = join(targets[0].path, 'nested');
    svn('checkout', url, nested);
    await assert.rejects(cleanWorkspace(targets[0].path, () => {}), /嵌套 SVN 工作副本/);
    assert.ok(existsSync(join(nested, '.svn')));
    assert.equal(readFileSync(join(nested, 'modified.txt'), 'utf8'), 'original\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('cleanup rejects root/outside paths and never traverses external junctions', async () => {
  const root = mkdtempSync(join(tmpdir(), 'svn-clean-boundary-'));
  try {
    const workspace = join(root, 'wc');
    const outside = join(root, 'wc-other');
    mkdirSync(workspace);
    mkdirSync(outside);
    writeFileSync(join(outside, 'keep.txt'), 'untouched');
    symlinkSync(outside, join(workspace, 'link'), 'junction');
    await assert.rejects(assertCleanupPath(workspace, workspace));
    await assert.rejects(assertCleanupPath(workspace, join(outside, 'keep.txt')));
    await assert.rejects(assertCleanupPath(workspace, join(workspace, 'link', 'keep.txt')), /外部链接/);
    await assertCleanupPath(workspace, join(workspace, 'link'));
    assert.equal(readFileSync(join(outside, 'keep.txt'), 'utf8'), 'untouched');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
