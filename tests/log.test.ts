import assert from 'node:assert/strict';
import test from 'node:test';
import { parseLog } from '../src/svn.js';

test('XML log preserves full messages, whitespace, special characters and numeric strings', () => {
  const entries = parseLog(`<?xml version="1.0" encoding="UTF-8"?>
<log><logentry revision="96908"><author>001</author><date>2026-09-17T00:00:00Z</date><msg>#104692 中文
https://ones.example/?a=1&amp;b=2

  feat: &lt;icon&gt;
--------
r123 | author | 2026-01-01
末行  </msg></logentry><logentry revision="96911"><msg>123</msg></logentry></log>`);
  assert.equal(entries[0].msg, '#104692 中文\nhttps://ones.example/?a=1&b=2\n\n  feat: <icon>\n--------\nr123 | author | 2026-01-01\n末行  ');
  assert.equal(entries[0].author, '001');
  assert.equal(entries[0].rev, '96908');
  assert.equal(entries[1].msg, '123');
  assert.deepEqual(parseLog('<log/>'), []);
  assert.throws(() => parseLog('<log>'));
});
