// src/shadowTracker.ts

import * as vscode from 'vscode';
import { Highlight, HighlightRange } from './types';
import { HighlightManager } from './highlightManager';
import { DecorationManager } from './decorationManager';
import { log } from './logger';

export class ShadowTracker {
  private disposables: vscode.Disposable[] = [];

  constructor(
    private manager: HighlightManager,
    private decorations: DecorationManager
  ) {}

  start(): void {
    log.info('ShadowTracker', 'Starting — subscribing to document change + save events');
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument(this.onTextChanged, this),
      vscode.workspace.onDidSaveTextDocument(this.onFileSaved, this)
    );
  }

  private onTextChanged(event: vscode.TextDocumentChangeEvent): void {
    const filePath   = this.manager.toRelativePath(event.document.uri.fsPath);
    const highlights = this.manager.getForFile(filePath);

    if (highlights.length === 0 || event.contentChanges.length === 0) return;

    log.separator('TEXT CHANGE');
    log.info('ShadowTracker', `Document changed`, {
      filePath,
      changeCount: event.contentChanges.length,
      highlightCount: highlights.length
    });

    for (const change of event.contentChanges) {
      const linesAdded =
        change.text.split('\n').length - 1 -
        (change.range.end.line - change.range.start.line);

      log.debug('ShadowTracker', `Processing change`, {
        editRange: {
          start: { line: change.range.start.line, char: change.range.start.character },
          end:   { line: change.range.end.line,   char: change.range.end.character   },
        },
        insertedText: change.text.slice(0, 50),
        linesAdded,
      });

      for (const h of highlights) {
        if (h.orphaned) continue;
        this.applyDelta(h, change, linesAdded, event.document);
      }
    }

    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document === event.document) {
      decorations: this.decorations.applyToEditor(editor, highlights);
      log.debug('ShadowTracker', 'Repainted decorations after change');
    }
  }

  private applyDelta(
    h: Highlight,
    change: vscode.TextDocumentContentChangeEvent,
    linesAdded: number,
    document: vscode.TextDocument
  ): void {
    const editStart  = change.range.start.line;
    const editEnd    = change.range.end.line;
    const { startLine, endLine } = h.range;

    if (editStart > endLine) {
      log.debug('ShadowTracker', `Case 1: edit AFTER highlight — no shift needed`, { id: h.id });
      return;
    }

    if (editEnd < startLine) {
      if (linesAdded === 0) {
        log.debug('ShadowTracker', `Case 2: edit BEFORE highlight, same-line edit — no shift`, { id: h.id });
        return;
      }
      log.info('ShadowTracker', `Case 2: edit BEFORE highlight — shifting`, {
        id: h.id, linesAdded, oldStart: startLine, newStart: startLine + linesAdded
      });
      h.range = { ...h.range, startLine: startLine + linesAdded, endLine: endLine + linesAdded };
      h.dirty = true;
      return;
    }

    if (editEnd === startLine && change.range.end.character <= h.range.startChar) {
      if (linesAdded === 0) return;
      log.info('ShadowTracker', `Case 3: edit on start line before startChar — shifting`, {
        id: h.id, linesAdded
      });
      h.range = { ...h.range, startLine: startLine + linesAdded, endLine: endLine + linesAdded };
      h.dirty = true;
      return;
    }

    const newEndLine = Math.max(startLine, endLine + linesAdded);
    log.info('ShadowTracker', `Case 4: edit INSIDE highlight — stretching/shrinking`, {
      id: h.id, oldEndLine: endLine, newEndLine, linesAdded
    });
    h.range = { ...h.range, endLine: newEndLine };

    const newSnapshot = this.extractSnapshot(document, h.range);
    if (newSnapshot !== null) {
      log.debug('ShadowTracker', `Updated textSnapshot`, { id: h.id, snapshot: newSnapshot.slice(0, 80) });
      h.textSnapshot = newSnapshot;
    } else {
      log.warn('ShadowTracker', `Failed to extract snapshot after inside-edit`, { id: h.id });
    }

    h.dirty = true;
  }

  private onFileSaved(document: vscode.TextDocument): void {
    const filePath = this.manager.toRelativePath(document.uri.fsPath);
    log.info('ShadowTracker', `File saved`, { filePath });

    if (!this.manager.hasDirty(filePath)) {
      log.debug('ShadowTracker', 'No dirty highlights — skipping save');
      return;
    }

    this.manager.clearDirty(filePath);
    this.manager.save();
    log.info('ShadowTracker', 'Persisted dirty highlights to disk');
  }

  private extractSnapshot(document: vscode.TextDocument, range: HighlightRange): string | null {
    try {
      const vscRange = new vscode.Range(
        range.startLine, range.startChar,
        range.endLine,   range.endChar
      );
      return document.getText(vscRange);
    } catch (err) {
      log.error('ShadowTracker', 'extractSnapshot threw', err);
      return null;
    }
  }

  dispose(): void {
    log.info('ShadowTracker', 'Disposing');
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }
}