import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { mergeBranch, mergeBranches, commitAfterSummary, formatMergeSummary, formatCommitMessage, requiresConfirmation, type MergeResult } from '../src/merger.js';
import { parseStatus, isConflict, isChange, svnReadStatus, svnGetSourceName, svnFetchRevisionLogs, svnUpdate, svnMerge, svnResolve, svnCommit } from '../src/svn.js';

const quiet = () => {};
const ready = (): MergeResult => ({ branch: 'target', path: 'target', status: 'ready', changes: parseStatus('M       target/file'), conflicts: [] });

test('status includes tree conflicts, property-only changes and spaced paths', () => {
  const entries = parseStatus('      C branch/file name\n M      branch\nC       branch/text\n      > description\n');
  assert.equal(entries.length, 3);
  assert.equal(entries[0].path, 'branch/file name');
  assert.ok(isConflict(entries[0]));
  assert.ok(isChange(entries[1]));
  assert.ok(isConflict(entries[2]));
});

test('skip flag never bypasses historical or unresolved conflicts', () => {
  assert.equal(requiresConfirmation([ready()], false), true);
  assert.equal(requiresConfirmation([ready()], true), false);
  for (const resolution of ['theirs-full', 'working', 'unresolved'] as const) {
    const result = ready();
    result.conflicts.push({ path: 'file', tree: true, resolution });
    assert.equal(requiresConfirmation([result], true), true);
  }
});

test('cancellation commits nothing; failed and conflicted branches are excluded', async () => {
  const calls: string[] = [];
  const ops = {
    exists: () => true, update: svnUpdate, merge: svnMerge, resolve: svnResolve,
    status: () => parseStatus('M       target/file'), commit: async (path: string) => { calls.push(path); return true; },
  };
  const results = [ready(), { ...ready(), status: 'error' as const }, { ...ready(), status: 'conflict' as const }];
  assert.equal(await commitAfterSummary(results, 'test', false, async () => false, quiet, ops), false);
  assert.deepEqual(calls, []);
  let prompted = false;
  await commitAfterSummary(results, 'test', true, async () => { prompted = true; return true; }, quiet, ops);
  assert.equal(prompted, true);
  assert.deepEqual(calls, ['target']);
});

test('status failure prevents committing', async () => {
  const result = ready();
  const ops = {
    exists: () => true, update: svnUpdate, merge: svnMerge, resolve: svnResolve,
    status: () => { throw new Error('status failed'); },
    commit: async () => { assert.fail('must not commit'); return true; },
  };
  await commitAfterSummary([result], 'test', true, async () => assert.fail('unexpected prompt'), quiet, ops);
  assert.equal(result.status, 'error');
});

test('clean summary can skip confirmation', async () => {
  const result = ready();
  const ops = {
    exists: () => true, update: svnUpdate, merge: svnMerge, resolve: svnResolve,
    status: () => parseStatus('M       target/file'), commit: async () => true,
  };
  await commitAfterSummary([result], 'test', true, async () => assert.fail('unexpected prompt'), quiet, ops);
  assert.equal(result.status, 'committed');
});

test('one failed branch pauses the entire batch even when confirmation skipping is requested', async () => {
  const good = ready();
  const failed: MergeResult = { ...ready(), branch: 'failed', status: 'error' };
  let prompts = 0;
  await commitAfterSummary([good, failed], '', true, async () => { prompts++; return false; }, quiet, {
    commit: async () => { assert.fail('no branch may commit before batch confirmation'); return true; },
  });
  assert.equal(prompts, 1);
  assert.equal(good.status, 'ready');
});

test('unresolved ordinary conflict never falls back to working or commits', async () => {
  let merged = false;
  const resolutions: string[] = [];
  const ops = {
    exists: () => true, update: async () => true,
    merged: async () => new Set<string>(),
    merge: async () => { merged = true; return true; },
    resolve: async (_path: string, accept: string) => { resolutions.push(accept); return false; },
    status: () => merged ? parseStatus('C       target/file') : [],
    commit: svnCommit,
  };
  const result = await mergeBranch('target', 'target', 'source', ['-c', '10'], quiet, ops);
  assert.equal(result.status, 'conflict');
  assert.deepEqual(resolutions, ['theirs-full']);
  assert.equal(result.conflicts[0].resolution, 'unresolved');
});

test('failed merge is not ready even if its partial changes have no conflicts', async () => {
  let attempted = false;
  const ops = {
    exists: () => true, update: async () => true, merged: async () => new Set<string>(), merge: async () => { attempted = true; return false; },
    resolve: svnResolve, status: () => attempted ? parseStatus('M       target/file') : [], commit: svnCommit,
  };
  const result = await mergeBranch('target', 'target', 'source', ['-c', '10'], quiet, ops);
  assert.equal(result.status, 'error');
  assert.equal(result.changes.length, 1);
});

test('real SVN: resolve text/property/tree conflicts, summarize, then commit', { timeout: 120000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'svn-multi-merge-test-'));
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
    writeFileSync(join(seed, '中文 file.txt'), 'base\n');
    svn('import', seed, `${url}/source`, '-m', 'seed');
    for (const branch of ['normal', 'tree', 'clean']) svn('copy', `${url}/source`, `${url}/${branch}`, '-m', branch);
    const source = join(root, 'source');
    svn('checkout', `${url}/source`, source);
    const paths = ['normal', 'tree', 'clean'].map(branch => join(root, branch));
    for (const path of paths) svn('checkout', `${url}/${path.split(/[\\/]/).at(-1)}`, path);
    writeFileSync(join(paths[0], '中文 file.txt'), 'target\n');
    svn('propset', 'custom', 'target', join(paths[0], '中文 file.txt'));
    svn('commit', paths[0], '-m', 'target edit');
    svn('delete', join(paths[1], '中文 file.txt'));
    svn('commit', paths[1], '-m', 'target delete');
    writeFileSync(join(source, '中文 file.txt'), 'incoming\n');
    svn('propset', 'custom', 'incoming', join(source, '中文 file.txt'));
    svn('commit', source, '-m', 'source edit');
    svn('update', source);
    const revision = svn('info', source, '--show-item', 'revision');
    const fullLogs = svnFetchRevisionLogs(source, ['-c', revision]);
    assert.equal(fullLogs[0].msg, 'source edit');
    assert.deepEqual(svnFetchRevisionLogs(source, ['-r', (Number(revision) - 1) + ':' + revision]), fullLogs);
    assert.equal(svnGetSourceName(source), 'source');
    const commitMessage = formatCommitMessage('source', fullLogs) + '\n' + '完整中文长日志\n'.repeat(5000);
    const before = run('svnlook', ['youngest', repo]);
    const results = await mergeBranches(paths.map(path => ({ branch: path, path })), `${url}/source`, ['-c', revision], 3, quiet);
    assert.deepEqual(results.map(result => result.status), ['ready', 'ready', 'ready'], JSON.stringify(results));
    assert.equal(results[0].conflicts[0].resolution, 'theirs-full');
    assert.equal(readFileSync(join(paths[0], '中文 file.txt'), 'utf8'), 'incoming\n');
    assert.equal(svn('propget', 'custom', join(paths[0], '中文 file.txt')), 'incoming');
    assert.equal(results[1].conflicts[0].resolution, 'working');
    assert.equal(results[2].conflicts.length, 0);
    assert.equal(run('svnlook', ['youngest', repo]), before, 'merge phase must not commit');
    const summary = formatMergeSummary('source', revision, results);
    assert.match(summary, /发生冲突 2/);
    assert.match(summary, /working/);
    assert.equal(await commitAfterSummary(results, commitMessage, true, async () => false, quiet), false);
    assert.equal(run('svnlook', ['youngest', repo]), before);
    let confirmations = 0;
    await commitAfterSummary(results, commitMessage, true, async () => { confirmations++; return true; }, quiet);
    assert.equal(confirmations, 1);
    assert.ok(results.every(result => result.status === 'committed'), JSON.stringify(results));
    assert.ok(paths.every(path => svnReadStatus(path).length === 0));
    assert.ok(run('svnlook', ['log', repo]).replace(/\r\n/g, '\n') === commitMessage.trim(), '完整长日志应原样保存（允许平台换行转换）');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test('full merge message is identical for every target and preserves repeated bodies', async () => {
  const body = '#104692 中文\nhttps://ones.example/task/123\n\nfeat: 第一行\n第二行';
  const entries = [
    { rev: '20', msg: body, author: 'a', date: '' },
    { rev: '10', msg: body, author: 'a', date: '' },
  ];
  const message = formatCommitMessage('trunk', entries);
  assert.equal(message, 'Merged revision(s) 10, 20 from trunk:\n' + body + '\n........\n' + body + '\n........');
  const results = [ready(), { ...ready(), branch: 'other', path: 'other' }];
  const messages: string[] = [];
  const ops = {
    exists: () => true, update: svnUpdate, merge: svnMerge, resolve: svnResolve,
    status: () => parseStatus('M       target/file'), commit: async (_path: string, value: string) => { messages.push(value); return true; },
  };
  await commitAfterSummary(results, message, true, async () => true, quiet, ops);
  assert.deepEqual(messages, [message, message]);
});
