import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { contextOf, normalizeRange, snapshotOf, splitLines } from '../../core/text';
import { HighlightRange } from '../../core/types';

const r = (startLine: number, startChar: number, endLine: number, endChar: number): HighlightRange =>
  ({ startLine, startChar, endLine, endChar });

const lines = ['function add(a, b) {', '  return a + b;', '}', '', 'export default add;'];

describe('splitLines', () => {
  test('handles LF, CRLF and a trailing newline like VS Code', () => {
    assert.deepEqual(splitLines('a\r\nb\nc\r\n'), ['a', 'b', 'c', '']);
  });
});

describe('snapshotOf / contextOf', () => {
  test('the snapshot is the full text of every line the range touches', () => {
    assert.equal(snapshotOf(lines, r(0, 9, 1, 8)), 'function add(a, b) {\n  return a + b;');
  });

  test('context is the trimmed neighbouring lines, empty at the file edges', () => {
    assert.deepEqual(contextOf(lines, r(1, 2, 1, 15)), { lineBefore: 'function add(a, b) {', lineAfter: '}' });
    assert.deepEqual(contextOf(lines, r(0, 0, 0, 3)), { lineBefore: '', lineAfter: 'return a + b;' });
    assert.deepEqual(contextOf(lines, r(4, 0, 4, 6)), { lineBefore: '', lineAfter: '' });
  });
});

describe('normalizeRange', () => {
  test('a selection of whole lines (ending at column 0) ends on the last selected line', () => {
    assert.deepEqual(normalizeRange(r(0, 0, 2, 0), lines), r(0, 0, 1, 15));
  });

  test('a start at the end of a line moves to the next line', () => {
    assert.deepEqual(normalizeRange(r(0, 20, 1, 8), lines), r(1, 0, 1, 8));
  });

  test('out-of-range positions are clamped', () => {
    assert.deepEqual(normalizeRange(r(2, 0, 99, 99), lines), r(2, 0, 4, 19));
  });

  test('nothing but a line break, or an empty selection, gives undefined', () => {
    assert.equal(normalizeRange(r(2, 1, 3, 0), lines), undefined);
    assert.equal(normalizeRange(r(1, 4, 1, 4), lines), undefined);
  });

  test('a reversed range is put in order', () => {
    assert.deepEqual(normalizeRange(r(1, 8, 1, 2), lines), r(1, 2, 1, 8));
  });
});
