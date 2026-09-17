import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import cliTruncate from 'cli-truncate';
import { commitAfterSummary, mergeBranches, checkWorkspaces, readConcurrency, validateMergeTargets, type MergeResult } from '../src/merger.js';
import { parseStatus } from '../src/svn.js';
import { cleanWorkspaces } from '../src/workspace.js';
import { createBranchProgress, formatProgress } from '../src/progress.js';

test('preparation phases retain only final statuses and reset completion counts', t => {
  const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false });
  t.after(() => {
    if (ttyDescriptor) Object.defineProperty(process.stdout, 'isTTY', ttyDescriptor);
    else Reflect.deleteProperty(process.stdout, 'isTTY');
  });
  const output: string[] = [];
  t.mock.method(console, 'log', (line: string) => { output.push(line); });
  const progress = createBranchProgress(['a', 'b'], '清理');
  progress.update(0, '清理完成', { status: 'success' });
  progress.update(1, '清理完成', { status: 'success' });
  progress.setPhase('检查');
  progress.update(0, '检查通过', { status: 'success' });
  progress.update(1, '检查通过', { status: 'success' });
  progress.setPhase('版本检查');
  progress.update(0, '待合并 1 个版本', { status: 'success' });
  progress.update(1, '查询待合并版本');
  assert.deepEqual(output, []);
  progress.finish();
  assert.equal(output.length, 1);
  assert.match(output[0], /版本检查进度 1\/2 · 进行中 1/);
  assert.match(output[0], /a  待合并 1 个版本/);
  assert.match(output[0], /b  查询待合并版本/);
  assert.doesNotMatch(output[0], /清理完成|检查通过/);
});

test('bounded workers overlap, isolate failures and wait for all results in target order', async () => {
  const targets = ['a', 'b', 'c', 'd'].map(branch => ({ branch, path: `test-targets/${branch}` }));
  const release = new Map<string, () => void>();
  const events: string[] = [];
  let active = 0;
  let peak = 0;
  let completed = false;
  const task = mergeBranches(targets, 'source', ['-c', '10'], 2, (index, _line, result) => {
    if (result) events.push(targets[index].branch);
  }, async (branch, path) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise<void>(resolve => release.set(branch, resolve));
    active--;
    if (branch === 'a') throw new Error('a failed');
    return { branch, path, status: 'ready', changes: [], conflicts: [] };
  }).then(results => { completed = true; return results; });
  assert.deepEqual([...release.keys()], ['a', 'b']);
  release.get('b')!();
  await setImmediate();
  assert.ok(release.has('c'));
  release.get('a')!();
  await setImmediate();
  assert.ok(release.has('d'));
  release.get('d')!();
  await setImmediate();
  assert.equal(completed, false, 'must wait for the last running branch');
  release.get('c')!();
  const results = await task;
  assert.equal(peak, 2);
  assert.deepEqual(events, ['b', 'a', 'd', 'c']);
  assert.deepEqual(results.map(result => result.branch), ['a', 'b', 'c', 'd']);
  assert.deepEqual(results.map(result => result.status), ['error', 'ready', 'ready', 'ready']);
});

test('commits wait for confirmation, overlap within limit, isolate failure and await every branch', async () => {
  const results: MergeResult[] = ['a', 'b', 'c', 'skip'].map(branch => ({
    branch, path: branch, status: branch === 'skip' ? 'unchanged' : 'ready',
    changes: parseStatus(`M       ${branch}/file`), conflicts: [],
  }));
  const gates = new Map<string, () => void>();
  const finished: number[] = [];
  const messages = new Map<number, string>();
  let active = 0, peak = 0, returned = false, started = false;
  let confirm!: (answer: boolean) => void;
  const task = commitAfterSummary(results, 'message', false,
    () => new Promise<boolean>(resolve => { confirm = resolve; }),
    () => assert.fail('worker output must stay in progress display'), {
      status: path => parseStatus(`M       ${path}/file`),
      commit: async (path, _message, onLine, paths) => {
        assert.deepEqual(paths, [`${path}/file`]);
        active++;
        peak = Math.max(peak, active);
        onLine(`Sending ${path}/file`);
        await new Promise<void>(resolve => gates.set(path, resolve));
        active--;
        if (path === 'a') throw new Error('commit failed');
        return true;
      },
    }, 2, async run => {
      started = true;
      await run((index, line, result) => {
        messages.set(index, line);
        if (result) finished.push(index);
      });
    }).then(() => { returned = true; });
  await setImmediate();
  assert.equal(started, false);
  assert.equal(gates.size, 0);
  confirm(true);
  await setImmediate();
  assert.deepEqual([...gates.keys()], ['a', 'b']);
  assert.equal(messages.get(0), 'Sending a/file');
  assert.equal(messages.get(1), 'Sending b/file');
  gates.get('a')!();
  await setImmediate();
  assert.ok(gates.has('c'));
  gates.get('c')!();
  await setImmediate();
  assert.equal(returned, false);
  gates.get('b')!();
  await task;
  assert.equal(peak, 2);
  assert.deepEqual(results.map(result => result.status), ['error', 'committed', 'committed', 'unchanged']);
  assert.deepEqual(finished, [0, 2, 3, 1]);
});

test('duplicate or nested targets are rejected before any merge starts', async () => {
  assert.throws(() => validateMergeTargets([{ branch: 'a', path: 'same' }, { branch: 'b', path: 'same/.' }]));
  assert.throws(() => validateMergeTargets([{ branch: 'a', path: 'same' }, { branch: 'b', path: 'same/child' }]));
  assert.doesNotThrow(() => validateMergeTargets([{ branch: 'a', path: 'same' }, { branch: 'b', path: 'same-other' }]));
  await assert.rejects(mergeBranches([{ branch: 'a', path: 'same' }, { branch: 'b', path: 'same' }], 'source', [], 2, () => {}, async () => {
    assert.fail('must reject before mutating working copies');
  }));
});

test('concurrency defaults and validation', () => {
  assert.equal(readConcurrency([]), 6);
  assert.equal(readConcurrency(['--concurrency', '2']), 2);
  assert.equal(readConcurrency(['--concurrency=6']), 6);
  for (const value of ['0', '-1', 'NaN', '1.5', '']) assert.throws(() => readConcurrency([`--concurrency=${value}`]));
});

test('compact progress fits narrow short terminals and keeps active tasks visible', () => {
  const result: MergeResult = { branch: 'done', path: '', status: 'ready', changes: [], conflicts: [] };
  const items = Array.from({ length: 12 }, (_, index) => ({
    branch: `branch-${index}`, latest: '合并中文文件 '.repeat(20) + '\n\x1b[2J',
    running: index === 11, result: index === 11 ? undefined : result,
  }));
  const output = formatProgress(items, 40, 8);
  assert.ok(output.includes('branch-11'));
  assert.ok(output.includes('11/12'));
  assert.ok(output.includes('另有'));
  assert.ok(output.split('\n').length < 8);
  assert.ok(!output.includes('\x1b'));
  for (const line of output.split('\n')) assert.equal(cliTruncate(line, 39), line);
});

for (const phase of ['检查', '清理']) {
  test(`${phase} uses bounded parallel workers and finishes all branches before returning issues`, async () => {
    const targets = ['a', 'b', 'c'].map(branch => ({ branch, path: `test-workspaces/${branch}` }));
    const gates = new Map<string, () => void>();
    const completed: number[] = [];
    let active = 0, peak = 0, returned = false;
    const run = async (path: string) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise<void>(resolve => gates.set(path, resolve));
      active--;
      if (path.endsWith('/a')) throw new Error('branch failure');
      return [];
    };
    const progress = (index: number, _line: string, result?: { status: string }) => {
      if (result) completed.push(index);
    };
    const task = (phase === '检查'
      ? checkWorkspaces(targets, 2, progress, run)
      : cleanWorkspaces(targets, 2, progress, async path => { await run(path); })
    ).then(issues => { returned = true; return issues; });
    assert.equal(gates.size, 2);
    gates.get(targets[0].path)!();
    await setImmediate();
    assert.equal(gates.size, 3, 'failure must not block remaining branches');
    gates.get(targets[2].path)!();
    await setImmediate();
    assert.equal(returned, false);
    gates.get(targets[1].path)!();
    const issues = await task;
    assert.equal(peak, 2);
    assert.deepEqual(completed, [0, 2, 1]);
    assert.equal(issues.length, 1);
    assert.match(issues[0], /a:.*branch failure/);
    assert.match(formatProgress([{ branch: 'a', latest: '完成', running: false, result: { status: 'success' } }], 80, 24, phase), new RegExp(`^${phase}进度 1/1`));
  });
}
