import assert from 'node:assert/strict';
import test from 'node:test';
import { PassThrough, Writable } from 'node:stream';
import { setImmediate } from 'node:timers/promises';
import { downstreamChoices, toggleBranch, selectTargetBranches } from '../src/branch-select.js';
import type { Config } from '../src/types.js';

function fixture(): Config {
  return {
    branches: Object.fromEntries(['upstream', 'source', 'a', 'a-prod', 'b', 'other'].map(branch =>
      [branch, { local_path: `test/${branch}`, enabled: true }])),
    tree: { upstream: ['source', 'other'], source: ['a', 'b'], a: ['a-prod'] },
  };
}

test('target choices contain only direct children and exclude source from merge targets', () => {
  const choices = downstreamChoices(fixture(), 'source');
  assert.deepEqual(choices.map(node => node.branch), ['source', 'a', 'b']);
  assert.deepEqual(choices[0].targets, ['a', 'b']);
  assert.deepEqual(choices.map(node => node.depth), [0, 1, 1]);
  assert.deepEqual(downstreamChoices(fixture(), 'b')[0].targets, []);
});

test('root selects direct targets and child toggles preserve siblings', () => {
  const [root, a] = downstreamChoices(fixture(), 'source');
  assert.deepEqual(toggleBranch([], root), ['a', 'b']);
  assert.deepEqual(toggleBranch(root.targets, root), []);
  assert.deepEqual(toggleBranch(['b'], a), ['b', 'a']);
  assert.deepEqual(toggleBranch(['b'], root), ['b', 'a']);
  assert.deepEqual(toggleBranch(root.targets, a), ['b']);
});

test('disabled direct targets are excluded and invalid direct references fail clearly', () => {
  const config = fixture();
  config.branches.a.enabled = false;
  assert.deepEqual(downstreamChoices(config, 'source')[0].targets, ['b']);
  config.tree.source = ['source'];
  assert.throws(() => downstreamChoices(config, 'source'), /循环/);
  config.tree.source = ['missing'];
  assert.throws(() => downstreamChoices(config, 'source'), /未配置/);
});

test('prompt starts at source, toggles all with space, and returns only downstream branches', async () => {
  const input = new PassThrough();
  let rendered = '';
  const output = new Writable({ write(chunk, _encoding, callback) { rendered += chunk.toString(); callback(); } });
  const prompt = selectTargetBranches({ choices: downstreamChoices(fixture(), 'source'), pageSize: 8 }, { input, output });
  try {
    await setImmediate();
    input.write(' ');
    await setImmediate();
    assert.match(rendered, /\[x\] source/);
    input.write(' ');
    await setImmediate();
    input.write('\r');
    await setImmediate();
    assert.match(rendered, /请至少选择一个目标分支/);
    input.write(' ');
    await setImmediate();
    input.write('\r');
    assert.deepEqual(await prompt, ['a', 'b']);
    assert.match(rendered, /✔ 选择目标分支: a, b/);
    assert.doesNotMatch(rendered, /upstream|other|a-prod/);
  } finally {
    prompt.cancel();
    input.destroy();
    output.destroy();
  }
});
