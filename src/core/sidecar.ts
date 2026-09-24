// src/core/sidecar.ts
//
// Reading and writing highlight.json. The file is meant to be committed and
// shared, so writes are deterministic (sorted, stable key order, trailing
// newline) to keep git diffs small, and entries this version can't read are
// carried through untouched instead of being dropped.

import { HighlightRange, HighlightRecord } from './types';
import { isHighlightColor } from './colors';

export const SIDECAR_FILENAME = 'highlight.json';
export const SIDECAR_VERSION = 1;

/** highlight.json exists but can't be used; the message completes "can't read highlight.json because …". */
export class SidecarError extends Error {}

export interface SidecarContents {
  records: HighlightRecord[];
  /** Entries this version can't read. Written back as-is so nothing is lost. */
  unknown: unknown[];
}

export function parseSidecar(text: string | undefined): SidecarContents {
  if (text === undefined || text.trim() === '') return { records: [], unknown: [] };

  let data: unknown;
  try {
    data = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (err) {
    if (/^(<{7}|={7}|>{7})/m.test(text)) throw new SidecarError('it has unresolved git merge conflicts');
    throw new SidecarError(`it isn't valid JSON (${(err as Error).message})`);
  }

  if (!isObject(data) || !Array.isArray(data.highlights)) {
    throw new SidecarError('it doesn\'t look like a highlight file');
  }
  if (data.version !== SIDECAR_VERSION) {
    throw new SidecarError(typeof data.version === 'number' && data.version > SIDECAR_VERSION
      ? `it was written by a newer version of this extension (format ${data.version})`
      : `its format version (${JSON.stringify(data.version)}) isn't supported`);
  }

  const records: HighlightRecord[] = [];
  const unknown: unknown[] = [];
  const ids = new Set<string>();
  for (const entry of data.highlights) {
    const record = toRecord(entry);
    if (record && !ids.has(record.id)) {
      ids.add(record.id);
      records.push(record);
    } else {
      unknown.push(entry);
    }
  }
  return { records, unknown };
}

export function serializeSidecar(records: readonly HighlightRecord[], unknown: readonly unknown[] = []): string {
  const highlights = [...records].sort(compareRecords).map(r => ({
    id: r.id,
    filePath: r.filePath,
    color: r.color,
    range: {
      startLine: r.range.startLine,
      startChar: r.range.startChar,
      endLine: r.range.endLine,
      endChar: r.range.endChar,
    },
    textSnapshot: r.textSnapshot,
    context: { lineBefore: r.context.lineBefore, lineAfter: r.context.lineAfter },
  }));
  return JSON.stringify({ version: SIDECAR_VERSION, highlights: [...highlights, ...unknown] }, null, 2) + '\n';
}

/** True when both lists hold the same records, ignoring order. */
export function sameRecords(a: readonly HighlightRecord[], b: readonly HighlightRecord[]): boolean {
  return a.length === b.length && serializeSidecar(a) === serializeSidecar(b);
}

function compareRecords(a: HighlightRecord, b: HighlightRecord): number {
  if (a.filePath !== b.filePath) return a.filePath < b.filePath ? -1 : 1;
  return a.range.startLine - b.range.startLine || a.range.startChar - b.range.startChar ||
         a.range.endLine - b.range.endLine || a.range.endChar - b.range.endChar ||
         (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function toRecord(entry: unknown): HighlightRecord | undefined {
  if (!isObject(entry)) return undefined;
  const { id, filePath, color, range, textSnapshot, context } = entry;
  if (typeof id !== 'string' || !id) return undefined;
  if (typeof filePath !== 'string' || !filePath) return undefined;
  if (!isHighlightColor(color)) return undefined;
  if (typeof textSnapshot !== 'string') return undefined;
  const validRange = toRange(range);
  if (!validRange) return undefined;

  const ctx = isObject(context) ? context : {};
  return {
    id,
    filePath: filePath.replace(/\\/g, '/').replace(/^\.\//, ''),
    color,
    range: validRange,
    // Files written by earlier versions could keep a '\r' at the end of each line.
    textSnapshot: textSnapshot.split('\n').map(line => line.replace(/\r$/, '')).join('\n'),
    context: {
      lineBefore: typeof ctx.lineBefore === 'string' ? ctx.lineBefore.trim() : '',
      lineAfter:  typeof ctx.lineAfter === 'string' ? ctx.lineAfter.trim() : '',
    },
  };
}

function toRange(value: unknown): HighlightRange | undefined {
  if (!isObject(value)) return undefined;
  const { startLine, startChar, endLine, endChar } = value;
  const nums = [startLine, startChar, endLine, endChar];
  if (!nums.every(n => typeof n === 'number' && Number.isInteger(n) && n >= 0)) return undefined;
  const range = { startLine, startChar, endLine, endChar } as HighlightRange;
  const ordered = range.startLine < range.endLine ||
    (range.startLine === range.endLine && range.startChar <= range.endChar);
  return ordered ? range : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
