// src/decorationManager.ts
//
// Paints highlights into editors. One decoration type per color, created once
// and reused: creating decoration types per paint leaks them.

import * as vscode from 'vscode';
import { COLORS, COLOR_STYLES } from './core/colors';
import { HighlightColor } from './core/types';
import { LiveHighlight } from './documentSession';

/** How many lines of a lost highlight's code its hover shows. */
const LOST_PREVIEW_LINES = 8;

export class DecorationManager implements vscode.Disposable {
  private readonly types = new Map<HighlightColor, vscode.TextEditorDecorationType>();
  private readonly lostType: vscode.TextEditorDecorationType;

  constructor() {
    for (const color of COLORS) {
      this.types.set(color, vscode.window.createTextEditorDecorationType({
        backgroundColor: COLOR_STYLES[color].background,
        borderRadius: '2px',
        overviewRulerColor: COLOR_STYLES[color].ruler,
        overviewRulerLane: vscode.OverviewRulerLane.Center,
        rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
      }));
    }
    this.lostType = vscode.window.createTextEditorDecorationType({
      overviewRulerColor: 'rgba(160, 160, 160, 0.8)',
      overviewRulerLane: vscode.OverviewRulerLane.Center,
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
      after: {
        color: new vscode.ThemeColor('editorCodeLens.foreground'),
        fontStyle: 'italic',
        margin: '0 0 0 2em',
      },
    });
  }

  /** Repaints every highlight in `editor`. Always pass the document's complete list. */
  paint(editor: vscode.TextEditor, highlights: readonly LiveHighlight[]): void {
    const doc = editor.document;
    const byColor = new Map<HighlightColor, vscode.Range[]>();
    const lostByLine = new Map<number, LiveHighlight[]>();

    for (const h of highlights) {
      if (h.lostAt) {
        const line = Math.min(h.lostAt.line, doc.lineCount - 1);
        lostByLine.set(line, [...(lostByLine.get(line) ?? []), h]);
        continue;
      }
      const range = doc.validateRange(new vscode.Range(h.range.startLine, h.range.startChar, h.range.endLine, h.range.endChar));
      byColor.set(h.color, [...(byColor.get(h.color) ?? []), range]);
    }

    for (const [color, type] of this.types) editor.setDecorations(type, byColor.get(color) ?? []);
    editor.setDecorations(this.lostType, [...lostByLine].map(([line, lost]) => ({
      range: doc.lineAt(line).range,
      hoverMessage: lostHover(lost, doc.languageId),
      renderOptions: {
        after: { contentText: lost.length === 1 ? '⚠ lost highlight' : `⚠ ${lost.length} lost highlights` },
      },
    })));
  }

  clear(editor: vscode.TextEditor): void {
    for (const type of this.types.values()) editor.setDecorations(type, []);
    editor.setDecorations(this.lostType, []);
  }

  dispose(): void {
    for (const type of this.types.values()) type.dispose();
    this.lostType.dispose();
  }
}

function lostHover(lost: readonly LiveHighlight[], languageId: string): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  for (const h of lost) {
    md.appendMarkdown(`**Lost ${h.color} highlight** — the code it marked was changed or deleted:\n`);
    const lines = h.text.split('\n');
    const preview = lines.slice(0, LOST_PREVIEW_LINES).join('\n') + (lines.length > LOST_PREVIEW_LINES ? '\n…' : '');
    md.appendCodeblock(preview, languageId);
  }
  md.appendMarkdown('Run **Highlight: Clear Orphans** to remove lost highlights from this file.');
  return md;
}
