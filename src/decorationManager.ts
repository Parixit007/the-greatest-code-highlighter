// src/decorationManager.ts

import * as vscode from 'vscode';
import { Highlight, HighlightColor } from './types';

// ─── Color Definitions ───────────────────────────────────────────────────────
// One DecorationType per color, created once and reused forever.
// Never create these inside a loop — VS Code leaks them.

const COLOR_STYLES: Record<HighlightColor, vscode.DecorationRenderOptions> = {
  red:   { backgroundColor: 'rgba(255, 99,  99,  0.25)', borderRadius: '2px' },
  blue:  { backgroundColor: 'rgba(99,  149, 255, 0.25)', borderRadius: '2px' },
  green: { backgroundColor: 'rgba(99,  255, 132, 0.25)', borderRadius: '2px' },
  pink:  { backgroundColor: 'rgba(255, 99,  220, 0.25)', borderRadius: '2px' },
  cyan:  { backgroundColor: 'rgba(99,  229, 255, 0.25)', borderRadius: '2px' },
  yellow: { backgroundColor: 'rgba(255, 220, 50,  0.25)', borderRadius: '2px' },
};

// Decoration type for orphaned highlights — strikethrough + muted
const ORPHAN_STYLE: vscode.DecorationRenderOptions = {
  backgroundColor: 'rgba(180, 180, 180, 0.2)',
  borderRadius: '2px',
  textDecoration: 'line-through',
  after: {
    contentText: ' ⚠ lost',
    color: 'rgba(180, 180, 180, 0.8)',
    fontStyle: 'italic',
    margin: '0 0 0 6px',
  },
};

export class DecorationManager {
  private types: Record<HighlightColor, vscode.TextEditorDecorationType>;
  private orphanType: vscode.TextEditorDecorationType;

  constructor() {
    this.types = {
      red:   vscode.window.createTextEditorDecorationType(COLOR_STYLES.red),
      blue:  vscode.window.createTextEditorDecorationType(COLOR_STYLES.blue),
      green: vscode.window.createTextEditorDecorationType(COLOR_STYLES.green),
      pink:  vscode.window.createTextEditorDecorationType(COLOR_STYLES.pink),
      cyan:  vscode.window.createTextEditorDecorationType(COLOR_STYLES.cyan),
     yellow: vscode.window.createTextEditorDecorationType(COLOR_STYLES.yellow),
    };
    this.orphanType = vscode.window.createTextEditorDecorationType(ORPHAN_STYLE);
  }

  // ─── Apply ───────────────────────────────────────────────────────────────
  // Call this any time highlights change for an editor.
  // It clears all existing decorations and repaints from scratch.

  applyToEditor(editor: vscode.TextEditor, highlights: Highlight[]): void {
    // Bucket highlights by color (skip orphans — handled separately)
    const buckets = new Map<HighlightColor, vscode.Range[]>();
    const orphanRanges: vscode.Range[] = [];

    for (const h of highlights) {
      const range = this.toVscodeRange(h);

      if (h.orphaned) {
        orphanRanges.push(range);
        continue;
      }

      if (!buckets.has(h.color)) {
        buckets.set(h.color, []);
      }
      buckets.get(h.color)!.push(range);
    }

    // Paint each color bucket
    for (const color of Object.keys(this.types) as HighlightColor[]) {
      editor.setDecorations(this.types[color], buckets.get(color) ?? []);
    }

    // Paint orphans
    editor.setDecorations(this.orphanType, orphanRanges);
  }

  // ─── Clear ───────────────────────────────────────────────────────────────
  // Wipe all highlights from an editor without touching the data layer.

  clearEditor(editor: vscode.TextEditor): void {
    for (const type of Object.values(this.types)) {
      editor.setDecorations(type, []);
    }
    editor.setDecorations(this.orphanType, []);
  }

  // ─── Cycle Color ─────────────────────────────────────────────────────────
  // Used by the keyboard shortcut. Returns the next color in sequence,
  // or undefined if the cycle has passed through "no color".

 readonly COLORS: HighlightColor[] = ['red', 'blue', 'green', 'pink', 'cyan', 'yellow'];

  // ─── Dispose ─────────────────────────────────────────────────────────────
  // Call on extension deactivate. Prevents VS Code decoration leaks.

  dispose(): void {
    for (const type of Object.values(this.types)) {
      type.dispose();
    }
    this.orphanType.dispose();
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  private toVscodeRange(h: Highlight): vscode.Range {
    return new vscode.Range(
      h.range.startLine, h.range.startChar,
      h.range.endLine,   h.range.endChar
    );
  }
}