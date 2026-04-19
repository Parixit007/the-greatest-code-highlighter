// src/contextMenu.ts

import * as vscode from 'vscode';
import { HighlightManager } from './highlightManager';
import { DecorationManager } from './decorationManager';
import { HighlightColor } from './types';

const COLORS: HighlightColor[] = ['red', 'blue', 'green', 'pink', 'cyan', 'yellow'];

const COLOR_LABELS: Record<HighlightColor, string> = {
  red:    '🔴  Red',
  blue:   '🔵  Blue',
  green:  '🟢  Green',
  pink:   '🩷  Pink',
  cyan:   '🩵  Cyan',
  yellow: '🟡  Yellow',
};

export class ContextMenuHandler {
  private disposables: vscode.Disposable[] = [];
  private cycleIndex: number = 0;

  constructor(
    private manager: HighlightManager,
    private decorations: DecorationManager
  ) {}

  // ─── Register ─────────────────────────────────────────────────────────────

  register(context: vscode.ExtensionContext): void {
    this.disposables.push(
      vscode.commands.registerCommand(
        'codeHighlighter.highlightSelection',
        () => this.handleHighlight()
      ),
      vscode.commands.registerCommand(
        'codeHighlighter.cycleHighlight',
        () => this.handleCycle()
      ),
      vscode.commands.registerCommand(
        'codeHighlighter.removeSelected',
        () => this.handleRemove()
      ),
      vscode.commands.registerCommand(
        'codeHighlighter.removeAll',
        () => this.handleRemoveAll()
      ),
      vscode.commands.registerCommand(
        'codeHighlighter.clearOrphans',
        () => this.handleClearOrphans()
      ),
    );

    for (const d of this.disposables) {
      context.subscriptions.push(d);
    }
  }

  // ─── Highlight (Right-click → pick color) ────────────────────────────────

  private async handleHighlight(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) {
      vscode.window.showInformationMessage('Select some code first.');
      return;
    }

    const picked = await vscode.window.showQuickPick(
      COLORS.map(c => ({ label: COLOR_LABELS[c], value: c })),
      { placeHolder: 'Pick a highlight color' }
    );

    if (!picked) return;

    this.applyHighlight(editor, picked.value);
  }

  // ─── Remove selected (Right-click → remove) ───────────────────────────────

  private handleRemove(): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    const filePath = this.manager.toRelativePath(editor.document.uri.fsPath);
    const sel      = editor.selection;

    if (sel.isEmpty) {
      const highlight = this.manager.findAtPosition(
        filePath, sel.active.line, sel.active.character
      );
      if (!highlight) {
        vscode.window.showInformationMessage('No highlight at cursor.');
        return;
      }
      this.manager.remove(highlight.id);
    } else {
      const overlapping = this.manager.findAllOverlapping(
        filePath,
        sel.start.line, sel.start.character,
        sel.end.line,   sel.end.character
      );
      if (overlapping.length === 0) {
        vscode.window.showInformationMessage('No highlight in selection.');
        return;
      }
      this.manager.splitAroundSelection(
        filePath,
        sel.start.line, sel.start.character,
        sel.end.line,   sel.end.character,
        editor.document.getText()
      );
    }

    this.manager.save();
    this.repaint(editor, filePath);
  }

  // ─── Remove All ───────────────────────────────────────────────────────────

  private handleRemoveAll(): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    const filePath   = this.manager.toRelativePath(editor.document.uri.fsPath);
    const highlights = this.manager.getForFile(filePath);

    if (highlights.length === 0) {
      vscode.window.showInformationMessage('No highlights in this file.');
      return;
    }

    const count = highlights.length;
    this.manager.removeAllForFile(filePath);
    this.manager.save();
    this.repaint(editor, filePath);

    vscode.window.showInformationMessage(
      `Cleared all ${count} highlight${count > 1 ? 's' : ''}.`
    );
  }

  // ─── Clear Orphans ────────────────────────────────────────────────────────

  private handleClearOrphans(): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    const filePath   = this.manager.toRelativePath(editor.document.uri.fsPath);
    const highlights = this.manager.getForFile(filePath);
    const orphans    = highlights.filter(h => h.orphaned);

    if (orphans.length === 0) {
      vscode.window.showInformationMessage('No orphaned highlights to clear.');
      return;
    }

    for (const o of orphans) {
      this.manager.remove(o.id);
    }

    this.manager.save();
    this.repaint(editor, filePath);

    vscode.window.showInformationMessage(
      `Cleared ${orphans.length} orphaned highlight${orphans.length > 1 ? 's' : ''}.`
    );
  }

  // ─── Cycle (Keyboard shortcut) ────────────────────────────────────────────

  private handleCycle(): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    const filePath = this.manager.toRelativePath(editor.document.uri.fsPath);
    const cursor   = editor.selection.active;

    const existing = this.manager.findAtPosition(
      filePath,
      cursor.line,
      cursor.character
    );

    if (existing) {
      // highlight exists → remove it, advance index for next press
      this.cycleIndex = (this.cycleIndex + 1) % this.decorations.COLORS.length;
      this.manager.remove(existing.id);
      this.manager.save();
      this.repaint(editor, filePath);
      return;
    }

    // no highlight → apply current color in cycle
    if (!editor.selection.isEmpty) {
      const color = this.decorations.COLORS[this.cycleIndex];
      this.applyHighlight(editor, color);
    } else {
      vscode.window.showInformationMessage('Select some code to highlight.');
    }
  }

  // ─── Shared: Apply Highlight ──────────────────────────────────────────────

  private applyHighlight(editor: vscode.TextEditor, color: HighlightColor): void {
    const filePath = this.manager.toRelativePath(editor.document.uri.fsPath);
    const sel      = editor.selection;

    const range = {
      startLine: sel.start.line,
      startChar: sel.start.character,
      endLine:   sel.end.line,
      endChar:   sel.end.character,
    };

    this.manager.add(filePath, color, range, editor.document.getText());
    this.manager.save();
    this.repaint(editor, filePath);
  }

  // ─── Shared: Repaint ──────────────────────────────────────────────────────

  private repaint(editor: vscode.TextEditor, filePath: string): void {
    this.decorations.applyToEditor(editor, this.manager.getForFile(filePath));
  }

  // ─── Dispose ─────────────────────────────────────────────────────────────

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }
}