import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { changedLineSpans, mapPosition, subtractRange, transformRange } from '../../core/ranges';
import { HighlightRange, TextChange } from '../../core/types';

const r = (startLine: number, startChar: number, endLine: number, endChar: number): HighlightRange =>
  ({ startLine, startChar, endLine, endChar });
const edit = (startLine: number, startChar: number, endLine: number, endChar: number, text: string): TextChange =>
  ({ range: r(startLine, startChar, endLine, endChar), text });
const insert = (line: number, char: number, text: string) => edit(line, char, line, char, text);

describe('transformRange', () => {
  // Highlight "foo" in `let x = foo(bar);` → chars 8..11 on line 3.
  const foo = r(3, 8, 3, 11);

  test('typing earlier on the same line shifts the highlight right', () => {
    assert.deepEqual(transformRange(foo, insert(3, 0, '  ')), r(3, 10, 3, 13));
  });

  test('deleting earlier on the same line shifts the highlight left', () => {
    assert.deepEqual(transformRange(foo, edit(3, 0, 3, 4, '')), r(3, 4, 3, 7));
  });

  test('pressing Enter before the highlight on its line moves it to the next line', () => {
    assert.deepEqual(transformRange(foo, insert(3, 4, '\n')), r(4, 4, 4, 7));
  });

  test('lines added or removed above shift it vertically', () => {
    assert.deepEqual(transformRange(foo, insert(0, 0, 'a\nb\n')), r(5, 8, 5, 11));
    assert.deepEqual(transformRange(foo, edit(0, 0, 2, 0, '')), r(1, 8, 1, 11));
  });

  test('edits after the highlight leave it alone', () => {
    assert.deepEqual(transformRange(foo, insert(3, 12, 'zzz')), foo);
    assert.deepEqual(transformRange(foo, insert(9, 0, '\n\n')), foo);
  });

  test('text typed at either edge is not highlighted', () => {
    assert.deepEqual(transformRange(foo, insert(3, 8, 'my')), r(3, 10, 3, 13));
    assert.deepEqual(transformRange(foo, insert(3, 11, 'Bar')), foo);
  });

  test('text typed inside grows the highlight', () => {
    assert.deepEqual(transformRange(foo, insert(3, 9, 'xx')), r(3, 8, 3, 13));
    assert.deepEqual(transformRange(foo, insert(3, 9, 'a\nbc')), r(3, 8, 4, 4));
  });

  test('deleting part of the text shrinks it', () => {
    assert.deepEqual(transformRange(foo, edit(3, 9, 3, 10, '')), r(3, 8, 3, 10));
  });

  test('replacing the first or last part keeps the replacement highlighted', () => {
    assert.deepEqual(transformRange(foo, edit(3, 8, 3, 9, 'FF')), r(3, 8, 3, 12));
    assert.deepEqual(transformRange(foo, edit(3, 10, 3, 11, 'OO')), r(3, 8, 3, 12));
  });

  test('an edit straddling an edge trims the highlight', () => {
    assert.deepEqual(transformRange(foo, edit(3, 6, 3, 9, 'Z')), r(3, 7, 3, 9));
    assert.deepEqual(transformRange(foo, edit(3, 10, 3, 14, '')), r(3, 8, 3, 10));
  });

  test('deleting or replacing every highlighted character loses it', () => {
    assert.equal(transformRange(foo, edit(3, 8, 3, 11, '')), undefined);
    assert.equal(transformRange(foo, edit(3, 8, 3, 11, 'baz')), undefined);
    assert.equal(transformRange(foo, edit(2, 0, 4, 0, '')), undefined);
  });

  test('multi-line highlights follow edits on their last line', () => {
    const block = r(10, 2, 12, 5);
    assert.deepEqual(transformRange(block, insert(12, 0, '\t')), r(10, 2, 12, 6));
    assert.deepEqual(transformRange(block, edit(11, 0, 12, 0, '')), r(10, 2, 11, 5));
  });

  test('CRLF line breaks in inserted text count as one line', () => {
    assert.deepEqual(transformRange(foo, insert(0, 0, 'a\r\nb\r\n')), r(5, 8, 5, 11));
  });
});

describe('mapPosition', () => {
  test('bias decides where a position inside the replaced text lands', () => {
    const change = edit(2, 2, 2, 6, 'xy');
    assert.deepEqual(mapPosition({ line: 2, char: 4 }, change, 'before'), { line: 2, char: 2 });
    assert.deepEqual(mapPosition({ line: 2, char: 4 }, change, 'after'), { line: 2, char: 4 });
    assert.deepEqual(mapPosition({ line: 2, char: 9 }, change, 'before'), { line: 2, char: 7 });
  });
});

describe('subtractRange', () => {
  const h = r(1, 0, 5, 10);

  test('a cut in the middle splits the range', () => {
    assert.deepEqual(subtractRange(h, r(2, 0, 3, 4)), [r(1, 0, 2, 0), r(3, 4, 5, 10)]);
  });

  test('cuts over an edge trim it', () => {
    assert.deepEqual(subtractRange(h, r(0, 0, 2, 3)), [r(2, 3, 5, 10)]);
    assert.deepEqual(subtractRange(h, r(4, 0, 9, 0)), [r(1, 0, 4, 0)]);
  });

  test('a covering cut removes it; a touching one does not', () => {
    assert.deepEqual(subtractRange(h, r(0, 0, 9, 0)), []);
    assert.deepEqual(subtractRange(h, r(5, 10, 6, 0)), [h]);
  });

  test('works on lines longer than 100000 characters', () => {
    const wide = r(0, 50_000, 0, 250_000);
    assert.deepEqual(subtractRange(wide, r(0, 100_000, 0, 150_000)), [r(0, 50_000, 0, 100_000), r(0, 150_000, 0, 250_000)]);
  });
});

describe('changedLineSpans', () => {
  test('reports the lines each change wrote, in final coordinates', () => {
    // A multi-cursor edit arrives bottom-up; the insert at line 2 pushes the first span down one line.
    assert.deepEqual(changedLineSpans([insert(10, 0, 'x\ny\n'), insert(2, 0, 'z\n')]), [[11, 13], [2, 3]]);
  });

  test('a later change above shifts earlier spans down', () => {
    assert.deepEqual(changedLineSpans([insert(10, 0, 'x'), insert(2, 0, 'a\nb\n')]), [[12, 12], [2, 4]]);
  });
});
