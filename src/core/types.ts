// src/core/types.ts
//
// Everything under src/core is plain TypeScript with no `vscode` import, so it
// can be unit tested with Node alone.

export type HighlightColor = 'red' | 'blue' | 'green' | 'pink' | 'cyan' | 'yellow';

/** A zero-based line/character position. */
export interface Position {
  line: number;
  char: number;
}

/** A zero-based, end-exclusive range (same meaning as a VS Code Range). */
export interface HighlightRange {
  startLine: number;
  startChar: number;
  endLine: number;
  endChar: number;
}

/** Trimmed text of the lines just above and below a highlight ('' at the edges of the file). */
export interface HighlightContext {
  lineBefore: string;
  lineAfter: string;
}

/** One highlight as stored in highlight.json. */
export interface HighlightRecord {
  id: string;
  filePath: string;          // relative to the workspace folder, forward slashes, e.g. "src/app.ts"
  color: HighlightColor;
  range: HighlightRange;
  textSnapshot: string;      // full text of lines startLine..endLine, joined with '\n'
  context: HighlightContext;
}

/** One edit from a document change event: the text in `range` was replaced by `text`. */
export interface TextChange {
  range: HighlightRange;
  text: string;
}
