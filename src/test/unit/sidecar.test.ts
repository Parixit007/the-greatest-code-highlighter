import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { SidecarError, parseSidecar, sameRecords, serializeSidecar } from '../../core/sidecar';
import { HighlightRecord } from '../../core/types';

const rec = (id: string, filePath: string, startLine: number, extra: Partial<HighlightRecord> = {}): HighlightRecord => ({
  id,
  filePath,
  color: 'red',
  range: { startLine, startChar: 0, endLine: startLine, endChar: 4 },
  textSnapshot: 'text',
  context: { lineBefore: '', lineAfter: '' },
  ...extra,
});

describe('parseSidecar', () => {
  test('a missing or empty file means no highlights', () => {
    assert.deepEqual(parseSidecar(undefined), { records: [], unknown: [] });
    assert.deepEqual(parseSidecar('  \n'), { records: [], unknown: [] });
  });

  test('round-trips what serializeSidecar writes', () => {
    const records = [rec('b', 'src/b.ts', 3), rec('a', 'src/a.ts', 9, { color: 'cyan' })];
    const parsed = parseSidecar(serializeSidecar(records));
    assert.ok(sameRecords(parsed.records, records));
  });

  test('reads files written by earlier versions', () => {
    const legacy = JSON.stringify({
      version: 1,
      highlights: [{
        id: 'x', filePath: 'src\\win\\path.ts', color: 'pink', orphaned: true,
        range: { startLine: 1, startChar: 0, endLine: 2, endChar: 3 },
        textSnapshot: 'line one\r\nline two\r',
        context: { lineBefore: '  // above  ', lineAfter: '' },
      }],
    });
    const [r] = parseSidecar(legacy).records;
    assert.equal(r.filePath, 'src/win/path.ts');
    assert.equal(r.textSnapshot, 'line one\nline two');
    assert.equal(r.context.lineBefore, '// above');
    assert.equal('orphaned' in r, false);
  });

  test('a byte-order mark at the start is ignored', () => {
    assert.deepEqual(parseSidecar('﻿{"version":1,"highlights":[]}'), { records: [], unknown: [] });
  });

  test('merge conflict markers are reported as such', () => {
    const text = '{\n<<<<<<< HEAD\n  "version": 1,\n=======\n  "version": 1,\n>>>>>>> theirs\n}';
    assert.throws(() => parseSidecar(text), (err: Error) => err instanceof SidecarError && /merge conflicts/.test(err.message));
  });

  test('invalid JSON, a different shape, or a newer format is refused', () => {
    assert.throws(() => parseSidecar('{ nope'), SidecarError);
    assert.throws(() => parseSidecar('[]'), SidecarError);
    assert.throws(() => parseSidecar('{"version":2,"highlights":[]}'), /newer version/);
  });

  test('entries it cannot read are kept aside instead of dropped', () => {
    const odd = { id: 'z', filePath: 'a.ts', color: 'orange', range: {}, textSnapshot: '' };
    const dup = rec('a', 'b.ts', 1);
    const parsed = parseSidecar(JSON.stringify({ version: 1, highlights: [rec('a', 'a.ts', 1), odd, dup] }));
    assert.equal(parsed.records.length, 1);
    assert.deepEqual(parsed.unknown, [odd, dup]);
    assert.deepEqual(JSON.parse(serializeSidecar(parsed.records, parsed.unknown)).highlights.slice(1), [odd, dup]);
  });
});

describe('serializeSidecar', () => {
  test('output is sorted, has a stable key order and ends with a newline', () => {
    const text = serializeSidecar([rec('2', 'src/z.ts', 1), rec('1', 'src/a.ts', 7), rec('0', 'src/a.ts', 2)]);
    const parsed = JSON.parse(text);
    assert.deepEqual(parsed.highlights.map((h: HighlightRecord) => h.id), ['0', '1', '2']);
    assert.deepEqual(Object.keys(parsed.highlights[0]), ['id', 'filePath', 'color', 'range', 'textSnapshot', 'context']);
    assert.ok(text.endsWith('}\n'));
  });

  test('same records in any order serialize identically', () => {
    const a = [rec('1', 'x.ts', 1), rec('2', 'x.ts', 2)];
    assert.equal(serializeSidecar(a), serializeSidecar([...a].reverse()));
    assert.ok(sameRecords(a, [...a].reverse()));
    assert.ok(!sameRecords(a, [a[0]]));
  });
});
