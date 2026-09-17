import assert from 'node:assert/strict';
import test from 'node:test';
import { createSvnLineReader, decodeSvnOutput } from '../src/encoding.js';

test('decodes UTF-8 and legacy GBK Chinese output', () => {
  assert.equal(decodeSvnOutput(Buffer.from('中文提交 #105330')), '中文提交 #105330');
  assert.equal(decodeSvnOutput(Buffer.from([0xd6, 0xd0, 0xce, 0xc4])), '中文');
  assert.equal(decodeSvnOutput(Buffer.from('r99526 | author')), 'r99526 | author');
});

test('preserves UTF-8 and GBK characters at every chunk boundary', () => {
  for (const data of [
    Buffer.from('中文\r\n\r\n中文'),
    Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 13, 10, 13, 10, 0xd6, 0xd0, 0xce, 0xc4]),
  ]) {
    for (let split = 0; split <= data.length; split++) {
      const lines: string[] = [];
      const reader = createSvnLineReader(line => lines.push(line));
      reader.write(data.subarray(0, split));
      reader.write(data.subarray(split));
      reader.end();
      assert.deepEqual(lines, ['中文', '中文']);
    }
  }
});

test('keeps interleaved stdout and stderr partial lines separate', () => {
  const lines: string[] = [];
  const stdout = createSvnLineReader(line => lines.push(line));
  const stderr = createSvnLineReader(line => lines.push(line));
  stdout.write(Buffer.from('更新'));
  stderr.write(Buffer.from('错误\n'));
  stdout.write(Buffer.from('完成\n'));
  stdout.end();
  stderr.end();
  assert.deepEqual(lines, ['错误', '更新完成']);
});
