// src/core/ranges.ts
//
// Position and range arithmetic, including how a highlight moves when the
// document is edited.

import { HighlightRange, Position, TextChange } from './types';

export function comparePositions(a: Position, b: Position): number {
  return a.line - b.line || a.char - b.char;
}

export function startOf(range: HighlightRange): Position {
  return { line: range.startLine, char: range.startChar };
}

export function endOf(range: HighlightRange): Position {
  return { line: range.endLine, char: range.endChar };
}

export function makeRange(start: Position, end: Position): HighlightRange {
  return { startLine: start.line, startChar: start.char, endLine: end.line, endChar: end.char };
}

export function rangesEqual(a: HighlightRange, b: HighlightRange): boolean {
  return a.startLine === b.startLine && a.startChar === b.startChar &&
         a.endLine === b.endLine && a.endChar === b.endChar;
}

/** True when the two ranges share at least one character. */
export function rangesOverlap(a: HighlightRange, b: HighlightRange): boolean {
  return comparePositions(startOf(a), endOf(b)) < 0 && comparePositions(startOf(b), endOf(a)) < 0;
}

/** True when `pos` is inside `range` or on one of its edges. */
export function rangeTouches(range: HighlightRange, pos: Position): boolean {
  return comparePositions(startOf(range), pos) <= 0 && comparePositions(pos, endOf(range)) <= 0;
}

/** True when `pos` is strictly inside `range`, not on an edge. */
export function rangeContains(range: HighlightRange, pos: Position): boolean {
  return comparePositions(startOf(range), pos) < 0 && comparePositions(pos, endOf(range)) < 0;
}

/** The parts of `range` that lie outside `cut`: zero, one or two ranges. */
export function subtractRange(range: HighlightRange, cut: HighlightRange): HighlightRange[] {
  if (!rangesOverlap(range, cut)) return [range];
  const parts: HighlightRange[] = [];
  if (comparePositions(startOf(range), startOf(cut)) < 0) parts.push(makeRange(startOf(range), startOf(cut)));
  if (comparePositions(endOf(cut), endOf(range)) < 0) parts.push(makeRange(endOf(cut), endOf(range)));
  return parts;
}

/** Where the text inserted by `change` ends, in post-change coordinates. */
export function insertedEnd(change: TextChange): Position {
  const lines = change.text.split(/\r\n|\r|\n/);
  const last = lines[lines.length - 1];
  return lines.length === 1
    ? { line: change.range.startLine, char: change.range.startChar + last.length }
    : { line: change.range.startLine + lines.length - 1, char: last.length };
}

/** Moves a position that lies after the replaced text. */
function shiftPast(pos: Position, change: TextChange, newEnd: Position): Position {
  const oldEnd = endOf(change.range);
  return pos.line === oldEnd.line
    ? { line: newEnd.line, char: newEnd.char + (pos.char - oldEnd.char) }
    : { line: pos.line + (newEnd.line - oldEnd.line), char: pos.char };
}

/**
 * Maps a position through `change`. A position inside the replaced text, or on
 * its edges, lands on the start of the change ('before') or just after the
 * inserted text ('after').
 */
export function mapPosition(pos: Position, change: TextChange, bias: 'before' | 'after'): Position {
  if (comparePositions(pos, startOf(change.range)) < 0) return pos;
  const newEnd = insertedEnd(change);
  if (comparePositions(pos, endOf(change.range)) > 0) return shiftPast(pos, change, newEnd);
  return bias === 'before' ? startOf(change.range) : newEnd;
}

/**
 * Moves a highlight through one document change.
 *
 * Text typed or pasted inside the highlight becomes part of it; text added at
 * either edge does not. Replacing part of the highlighted text keeps the
 * replacement highlighted. Returns undefined when every highlighted character
 * was deleted or replaced — the highlight is lost.
 */
export function transformRange(range: HighlightRange, change: TextChange): HighlightRange | undefined {
  const a = startOf(range);
  const b = endOf(range);
  const s = startOf(change.range);
  const e = endOf(change.range);
  const newEnd = insertedEnd(change);

  // A non-empty replacement that stays within the highlight (touching at most
  // one edge) edits the highlighted text itself.
  const editsInside =
    comparePositions(s, e) < 0 &&
    comparePositions(a, s) <= 0 && comparePositions(e, b) <= 0 &&
    !(comparePositions(a, s) === 0 && comparePositions(e, b) === 0);

  let start: Position;
  if (comparePositions(a, s) < 0) start = a;
  else if (comparePositions(a, e) > 0) start = shiftPast(a, change, newEnd);
  else start = editsInside && comparePositions(a, s) === 0 ? s : newEnd;

  let end: Position;
  if (comparePositions(b, s) < 0) end = b;
  else if (comparePositions(b, e) > 0) end = shiftPast(b, change, newEnd);
  else end = editsInside && comparePositions(b, e) === 0 ? newEnd : s;

  return comparePositions(start, end) < 0 ? makeRange(start, end) : undefined;
}

/** The inclusive line spans, in final coordinates, that a sequence of changes wrote to. */
export function changedLineSpans(changes: readonly TextChange[]): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  for (const change of changes) {
    const newEndLine = insertedEnd(change).line;
    const delta = newEndLine - change.range.endLine;
    for (const span of spans) {
      if (span[1] < change.range.startLine) continue;
      if (span[0] > change.range.endLine) {
        span[0] += delta;
        span[1] += delta;
      } else {
        span[0] = Math.min(span[0], change.range.startLine);
        span[1] = Math.max(span[1] > change.range.endLine ? span[1] + delta : newEndLine, newEndLine);
      }
    }
    spans.push([change.range.startLine, newEndLine]);
  }
  return spans;
}
