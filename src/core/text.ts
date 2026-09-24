// src/core/text.ts
//
// Helpers for working with a document as an array of lines (no line breaks).

import { HighlightContext, HighlightRange, Position } from './types';
import { comparePositions, endOf, makeRange, startOf } from './ranges';

/** Splits text into lines the same way VS Code numbers them. */
export function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

/** The full text of the lines a range touches — what highlight.json stores as `textSnapshot`. */
export function snapshotOf(lines: readonly string[], range: HighlightRange): string {
  return lines.slice(range.startLine, range.endLine + 1).join('\n');
}

export function contextOf(lines: readonly string[], range: HighlightRange): HighlightContext {
  return {
    lineBefore: range.startLine > 0 ? lines[range.startLine - 1].trim() : '',
    lineAfter:  range.endLine < lines.length - 1 ? lines[range.endLine + 1].trim() : '',
  };
}

export function clampPosition(pos: Position, lines: readonly string[]): Position {
  const line = Math.min(Math.max(pos.line, 0), lines.length - 1);
  return { line, char: Math.min(Math.max(pos.char, 0), lines[line].length) };
}

/**
 * Clamps a range to the document and trims edges that only cover a line
 * break: a start at the end of a line moves to the next line, and an end at
 * column 0 moves back to the end of the previous line. Returns undefined when
 * nothing is left to highlight.
 */
export function normalizeRange(range: HighlightRange, lines: readonly string[]): HighlightRange | undefined {
  let start = clampPosition(startOf(range), lines);
  let end = clampPosition(endOf(range), lines);
  if (comparePositions(start, end) > 0) [start, end] = [end, start];
  if (start.line < end.line && start.char === lines[start.line].length) {
    start = { line: start.line + 1, char: 0 };
  }
  if (end.line > start.line && end.char === 0) {
    end = { line: end.line - 1, char: lines[end.line - 1].length };
  }
  return comparePositions(start, end) < 0 ? makeRange(start, end) : undefined;
}

/** A line with leading/trailing whitespace removed and inner runs collapsed to one space. */
export function normalizeWhitespace(line: string): string {
  return line.trim().replace(/\s+/g, ' ');
}
