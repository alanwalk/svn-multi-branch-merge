import assert from 'node:assert/strict';
import test from 'node:test';
import { parseRevisionInput } from '../src/revisions.js';
import { mergeBranch, mergeBranches } from '../src/merger.js';

test('manual revisions ignore whitespace and expand inclusive hyphen ranges', () => {
  assert.deepEqual(parseRevisionInput('12312 , 12314,12316 - 12319'), ['12312', '12314', '12316', '12317', '12318', '12319']);
  assert.deepEqual(parseRevisionInput(' 4,2-4,\n1\t,2'), ['1', '2', '3', '4']);
  assert.deepEqual(parseRevisionInput('001, 3-3'), ['1', '3']);
  assert.deepEqual(parseRevisionInput('0:3'), ['1', '2', '3']);
  assert.deepEqual(parseRevisionInput('10:12'), ['11', '12']);
  for (const invalid of ['', '0', '-1', '3-1', '1,,2', 'abc', '1.5', '1-200000', '9007199254740992']) {
    assert.throws(() => parseRevisionInput(invalid), invalid);
  }
});

test('full mode uses each branch eligible revisions and skips empty branches', async () => {
  const calls: string[][] = [];
  const results = await mergeBranches([
    { branch: 'a', path: 'test-all/a', revisions: ['10', '12'] },
    { branch: 'b', path: 'test-all/b', revisions: ['11'] },
    { branch: 'c', path: 'test-all/c', revisions: [] },
  ], 'source@20', ['-c', '10,11,12'], 6, () => {}, async (branch, path, _source, args) => {
    calls.push([branch, ...args]);
    return { branch, path, status: 'ready', changes: [], conflicts: [] };
  });
  assert.deepEqual(calls, [['a', '-c', '10,12'], ['b', '-c', '11']]);
  assert.equal(results[2].status, 'unchanged');
});

test('large merges are batched without changing the requested revision set', async () => {
  const calls: string[] = [];
  const revisions = Array.from({ length: 205 }, (_, index) => String(index + 1));
  const result = await mergeBranch('a', 'fake', 'source', ['-c', revisions.join(',')], () => {}, {
    exists: () => true, status: () => [], update: async () => true, merged: async () => new Set(),
    merge: async (_source, args) => { calls.push(args[1]); return true; },
  });
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.flatMap(value => value.split(',')), revisions);
  assert.deepEqual(result.revisions, revisions);
});
