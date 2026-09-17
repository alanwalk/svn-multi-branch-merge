import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { mergeBranch, checkWorkspaces, commitAfterSummary, formatCommitMessage } from '../src/merger.js';
import { svnReadStatusAsync, svnMergedRevisions, svnEligibleRevisions, svnLogsForRevisions } from '../src/svn.js';
import { dirtyEntries } from '../src/workspace.js';

const quiet = () => {};

test('dirty-workspace classification respects ignore-on-commit but never ignores conflicts', () => {
  const entry = { path: 'file', text: 'M', property: ' ', treeConflict: false };
  assert.equal(dirtyEntries([entry]).length, 1);
  assert.equal(dirtyEntries([{ ...entry, changelist: 'ignore-on-commit' }]).length, 0);
  assert.equal(dirtyEntries([{ ...entry, text: '?', changelist: 'other' }]).length, 1);
  assert.equal(dirtyEntries([{ ...entry, text: 'C', changelist: 'ignore-on-commit' }]).length, 1);
});

test('real SVN: filter merged revisions, protect ignored changes and commit only planned paths', { timeout: 120000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'svn-workspace-test-'));
  const run = (command: string, args: string[]) => {
    const result = spawnSync(command, args, { encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return result.stdout.trim();
  };
  const svn = (...args: string[]) => run('svn', ['--non-interactive', ...args]);
  try {
    const repo = join(root, 'repo');
    run('svnadmin', ['create', repo]);
    const url = pathToFileURL(repo).href;
    const seed = join(root, 'seed');
    mkdirSync(seed);
    for (const file of ['a.txt', 'b.txt', 'ignored.txt', 'properties.txt']) writeFileSync(join(seed, file), 'base\n');
    svn('import', seed, `${url}/trunk`, '-m', 'seed');
    for (const branch of ['target', 'touch', 'props', 'clean-ignore', 'dirty', 'update-touch', 'partial']) svn('copy', `${url}/trunk`, `${url}/${branch}`, '-m', branch);
    const source = join(root, 'source');
    svn('checkout', `${url}/trunk`, source);
    const paths = Object.fromEntries(['target', 'touch', 'props', 'clean-ignore', 'dirty', 'update-touch', 'partial'].map(branch => [branch, join(root, branch)]));
    for (const [branch, path] of Object.entries(paths)) svn('checkout', `${url}/${branch}`, path);
    const commitSource = (file: string, content: string, message: string) => {
      writeFileSync(join(source, file), content);
      svn('commit', source, '-m', message);
      svn('update', source);
      return svn('info', source, '--show-item', 'revision');
    };
    const r1 = commitSource('a.txt', 'first\n', 'FIRST BODY');
    const r2 = commitSource('b.txt', 'second\n', 'SECOND BODY');
    svn('merge', '-c', r1, `${url}/trunk`, paths.target);
    svn('commit', paths.target, '-m', 'already merged first');
    svn('update', paths.target);
    assert.ok((await svnMergedRevisions(`${url}/trunk`, paths.target, [r1, r2])).has(r1));
    const eligible = await svnEligibleRevisions(`${url}/trunk@${r2}`, paths.target, r2);
    assert.ok(!eligible.includes(r1) && eligible.includes(r2));
    const eligibleLogs = await svnLogsForRevisions(`${url}/trunk@${r2}`, eligible);
    assert.ok(eligibleLogs.some(entry => entry.rev === r2 && entry.msg === 'SECOND BODY'));

    writeFileSync(join(paths.target, 'ignored.txt'), 'private local work\n');
    svn('changelist', 'ignore-on-commit', join(paths.target, 'ignored.txt'));
    assert.deepEqual(await checkWorkspaces([{ branch: 'target', path: paths.target }]), []);
    const result = await mergeBranch('target', paths.target, `${url}/trunk`, ['-c', `${r1},${r2}`], quiet);
    assert.equal(result.status, 'ready', JSON.stringify(result));
    assert.deepEqual(result.revisions, [r2]);
    assert.deepEqual(result.skippedRevisions, [r1]);
    assert.ok(result.changes.every(entry => !entry.path.endsWith('ignored.txt')));
    const logs = [{ rev: r1, msg: 'FIRST BODY', author: '', date: '' }, { rev: r2, msg: 'SECOND BODY', author: '', date: '' }];
    result.commitMessage = formatCommitMessage('trunk', logs.filter(entry => result.revisions!.includes(entry.rev)));
    await commitAfterSummary([result], 'wrong global message', true, async () => assert.fail('no conflict expected'), quiet);
    assert.equal(result.status, 'committed', JSON.stringify(result));
    const saved = run('svnlook', ['log', repo]);
    assert.ok(saved.includes('SECOND BODY') && !saved.includes('FIRST BODY'));
    assert.equal(svn('cat', `${url}/target/ignored.txt`), 'base');
    assert.equal(readFileSync(join(paths.target, 'ignored.txt'), 'utf8'), 'private local work\n');
    assert.ok((await svnReadStatusAsync(paths.target)).some(entry => entry.changelist === 'ignore-on-commit' && entry.text === 'M'));
    const repeated = await mergeBranch('target', paths.target, `${url}/trunk`, ['-c', `${r1},${r2}`], quiet);
    assert.equal(repeated.status, 'unchanged');
    assert.deepEqual(repeated.revisions, []);

    writeFileSync(join(paths.dirty, 'a.txt'), 'uncommitted ordinary work\n');
    assert.equal((await checkWorkspaces([{ branch: 'dirty', path: paths.dirty }])).length, 1);
    const blocked = await mergeBranch('dirty', paths.dirty, `${url}/trunk`, ['-c', r2], quiet);
    assert.equal(blocked.status, 'error');
    assert.equal(readFileSync(join(paths.dirty, 'b.txt'), 'utf8'), 'base\n');

    const touchedRevision = commitSource('ignored.txt', 'incoming ignored content\n', 'touch ignored');
    writeFileSync(join(paths.touch, 'ignored.txt'), 'keep my changes\n');
    for (const branch of ['touch', 'clean-ignore']) svn('changelist', 'ignore-on-commit', join(paths[branch], 'ignored.txt'));
    for (const branch of ['touch', 'clean-ignore']) {
      const touched = await mergeBranch(branch, paths[branch], `${url}/trunk`, ['-c', touchedRevision], quiet);
      assert.equal(touched.status, 'conflict', JSON.stringify(touched));
      assert.ok(touched.conflicts.some(entry => entry.reason?.includes('ignore-on-commit')));
      let prompts = 0;
      await commitAfterSummary([touched], 'never commit', true, async () => { prompts++; return true; }, quiet);
      assert.equal(prompts, 1);
      assert.equal(touched.status, 'conflict');
    }

    svn('propset', 'custom', 'incoming', join(source, 'properties.txt'));
    svn('commit', source, '-m', 'property-only change');
    svn('update', source);
    const propertyRevision = svn('info', source, '--show-item', 'revision');
    svn('changelist', 'ignore-on-commit', join(paths.props, 'properties.txt'));
    const props = await mergeBranch('props', paths.props, `${url}/trunk`, ['-c', propertyRevision], quiet);
    assert.equal(props.status, 'conflict', JSON.stringify(props));

    const remote = join(root, 'remote');
    svn('checkout', `${url}/update-touch`, remote);
    writeFileSync(join(remote, 'ignored.txt'), 'remote update\n');
    svn('commit', remote, '-m', 'remote update');
    svn('changelist', 'ignore-on-commit', join(paths['update-touch'], 'ignored.txt'));
    const updated = await mergeBranch('update-touch', paths['update-touch'], `${url}/trunk`, ['-c', r2], quiet);
    assert.equal(updated.status, 'conflict', JSON.stringify(updated));
    assert.equal(readFileSync(join(paths['update-touch'], 'b.txt'), 'utf8'), 'base\n', 'must stop after protected update');

    writeFileSync(join(source, 'a.txt'), 'multi a\n');
    const multi = commitSource('b.txt', 'multi b\n', 'multiple paths');
    svn('merge', '-c', multi, `${url}/trunk/a.txt`, join(paths.partial, 'a.txt'), '--accept', 'theirs-full');
    svn('commit', paths.partial, '-m', 'partial merge');
    svn('update', paths.partial);
    assert.equal((await svnMergedRevisions(`${url}/trunk`, paths.partial, [multi])).has(multi), false, 'partial merges must remain eligible\n' +
      svn('mergeinfo', '--show-revs', 'eligible', '--depth', 'infinity', '-r', multi, `${url}/trunk`, paths.partial) + '\n' +
      svn('proplist', '--verbose', '--recursive', paths.partial) + '\n' + svn('log', '--verbose', '-r', multi, `${url}/trunk`));
    const partial = await mergeBranch('partial', paths.partial, `${url}/trunk`, ['-c', multi], quiet);
    assert.deepEqual(partial.revisions, [multi]);
    assert.equal(partial.status, 'ready', JSON.stringify(partial));
    // Stale explicit subtree mergeinfo must not expand the default full-merge plan.
    svn('propset', 'svn:mergeinfo', `/trunk/a.txt:1`, join(paths.partial, 'a.txt'));
    svn('commit', paths.partial, '-m', 'retain historical subtree mergeinfo');
    svn('update', paths.partial);
    const recursive = svn('mergeinfo', '--show-revs', 'eligible', '--depth', 'infinity', '-r', multi, `${url}/trunk`, paths.partial);
    assert.match(recursive, new RegExp(`r${multi}\\*`));
    const full = await svnEligibleRevisions(`${url}/trunk@${multi}`, paths.partial, multi);
    assert.ok(full.includes(multi), 'recursive full merge includes historical subtree gaps');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
