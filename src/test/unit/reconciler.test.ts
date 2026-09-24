import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { reconcile } from '../../core/reconciler';
import { contextOf, snapshotOf } from '../../core/text';
import { HighlightRange, HighlightRecord } from '../../core/types';

const r = (startLine: number, startChar: number, endLine: number, endChar: number): HighlightRange =>
  ({ startLine, startChar, endLine, endChar });

/** A record as the extension would have written it for `range` in `lines`. */
function record(lines: string[], range: HighlightRange, id = 'h1'): HighlightRecord {
  return { id, filePath: 'src/cart.ts', color: 'yellow', range, textSnapshot: snapshotOf(lines, range), context: contextOf(lines, range) };
}

const base = [
  'import { sum } from "./math";',          // 0
  '',                                        // 1
  'export function total(items) {',          // 2
  '  let result = 0;',                       // 3
  '  for (const item of items) {',           // 4
  '    result += item.price * item.qty;',    // 5
  '  }',                                     // 6
  '  return result;',                        // 7
  '}',                                       // 8
  '',                                        // 9
  'export function average(items) {',        // 10
  '  return total(items) / items.length;',   // 11
  '}',                                       // 12
];

describe('reconcile', () => {
  test('A: unchanged text is found where it was', () => {
    const [m] = reconcile([record(base, r(5, 14, 5, 35))], base);
    assert.deepEqual(m, { range: r(5, 14, 5, 35), kind: 'exact' });
  });

  test('B: text that moved is found at its new lines with the same columns', () => {
    const edited = ['// header', '// more', '', ...base];
    const [m] = reconcile([record(base, r(4, 2, 6, 3))], edited);
    assert.deepEqual(m, { range: r(7, 2, 9, 3), kind: 'moved' });
  });

  test('B: with duplicates, the copy nearest the old position wins', () => {
    const old = ['a', 'return 1;', 'b', 'c', 'return 1;', 'd'];
    const [m] = reconcile([record(old, r(4, 0, 4, 9))], ['new', ...old]);
    assert.deepEqual(m?.range, r(5, 0, 5, 9));
  });

  test('B: two highlights on the same line move together', () => {
    const edited = ['', ...base];
    const matches = reconcile([record(base, r(5, 14, 5, 24), 'a'), record(base, r(5, 27, 5, 35), 'b')], edited);
    assert.deepEqual(matches.map(m => m?.range), [r(6, 14, 6, 24), r(6, 27, 6, 35)]);
  });

  test('B: when one of two identical lines is deleted, only one highlight can claim the survivor', () => {
    const old = ['a', '  break;', 'b', '  break;', 'c'];
    const matches = reconcile([record(old, r(1, 2, 1, 8), 'first'), record(old, r(3, 2, 3, 8), 'second')], ['a', '  break;', 'b', 'c']);
    assert.deepEqual(matches[0]?.range, r(1, 2, 1, 8));
    assert.equal(matches[1], undefined);
  });

  test("B': re-indented code is found and the columns follow the text", () => {
    const edited = [...base.slice(0, 3), '  if (items) {', ...base.slice(3, 8).map(l => '  ' + l), '  }', ...base.slice(8)];
    const [m] = reconcile([record(base, r(5, 14, 5, 35))], edited);
    assert.deepEqual(m, { range: r(6, 16, 6, 37), kind: 'reindented' });
    assert.equal(edited[6].slice(16, 37), 'item.price * item.qty');
  });

  test('C: a slightly edited line between its old neighbours is found', () => {
    const edited = [...base];
    edited[5] = '    result += item.price * item.quantity;';
    const [m] = reconcile([record(base, r(5, 4, 5, 36))], edited);
    assert.deepEqual(m, { range: r(5, 4, 5, 41), kind: 'fuzzy' });
  });

  test('C: a slightly edited line is found even with blank lines around it', () => {
    const old = ['const a = 1;', '', 'const API_URL = "https://example.com";', '', 'const b = 2;'];
    const edited = [...old];
    edited[2] = 'const API_URL = "https://example2.com";';
    const [m] = reconcile([record(old, r(2, 16, 2, 37))], edited);
    assert.equal(m?.kind, 'fuzzy');
    assert.equal(m?.range.startLine, 2);
  });

  test('D: deleted code is lost instead of jumping to whatever follows a blank line', () => {
    const old = ['const a = 1;', '', 'const API_URL = "https://example.com";', '', 'const b = 2;'];
    const [m] = reconcile([record(old, r(2, 16, 2, 37))], ['const a = 1;', '', '', 'const b = 2;']);
    assert.equal(m, undefined);
  });

  test('D: deleted code is not re-attached to different code between the same common neighbours', () => {
    const old = ['{', '  return this.foo(bar);', '}', '{', '  return this.baz(qux);', '}'];
    const [m] = reconcile([record(old, r(1, 2, 1, 23))], old.slice(3));
    assert.equal(m, undefined);
  });

  test('within: only matches overlapping the given line spans count', () => {
    const edited = ['x', ...base];
    const rec = record(base, r(5, 14, 5, 35));
    assert.equal(reconcile([rec], edited, { within: [[0, 2]] })[0], undefined);
    assert.deepEqual(reconcile([rec], edited, { within: [[6, 6]] })[0]?.range, r(6, 14, 6, 35));
  });

  test('fuzzy: false accepts only exact or whitespace-only matches', () => {
    const edited = [...base];
    edited[5] = '    result += item.price * item.quantity;';
    assert.equal(reconcile([record(base, r(5, 4, 5, 36))], edited, { fuzzy: false })[0], undefined);
  });

  test('ranges written by older versions that end at column 0 are tightened', () => {
    const [m] = reconcile([record(base, r(2, 0, 9, 0))], base);
    assert.deepEqual(m, { range: r(2, 0, 8, 1), kind: 'exact' });
  });

  test('stays fast on a large file with many highlights that are gone', () => {
    const big = Array.from({ length: 20_000 }, (_, i) => `  const value${i} = compute(${i}, "${i % 7}");`);
    const lostRecords = Array.from({ length: 20 }, (_, i) => ({
      ...record(big, r(i * 900, 2, i * 900 + 4, 10), `h${i}`),
      textSnapshot: `  something(${i});\n  entirely(${i});\n  different(${i});\n  here();\n  now();`,
    }));
    const started = Date.now();
    const matches = reconcile(lostRecords, big);
    assert.ok(matches.every(m => m === undefined));
    assert.ok(Date.now() - started < 2000, `took ${Date.now() - started}ms`);
  });
});
