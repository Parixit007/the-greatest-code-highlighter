// src/types.ts

export type HighlightColor = 'red' | 'blue' | 'green' | 'pink' | 'cyan' | 'yellow';

export interface HighlightRange {
  startLine: number;
  startChar: number;
  endLine: number;
  endChar: number;
}

export interface HighlightContext {
  lineBefore: string;
  lineAfter: string;
}

export interface Highlight {
  id: string;
  filePath: string;          // workspace-relative path, e.g. "src/app.js"
  color: HighlightColor;
  range: HighlightRange;
  textSnapshot: string;      // exact text of the highlighted block
  context: HighlightContext;
  orphaned?: boolean;        // set true if reconciler can't find the block
  dirty?: boolean;           // in-memory only: range updated but not yet saved
}

export interface HighlightFile {
  version: 1;
  highlights: Highlight[];
}

// What VS Code's onDidChangeTextDocument gives us per edit
export interface EditDelta {
  startLine: number;
  startChar: number;
  endLine: number;
  endChar: number;
  linesAdded: number;    // negative = lines removed
  text: string;
}