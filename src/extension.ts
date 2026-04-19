// src/extension.ts

import * as vscode from 'vscode';
import { HighlightManager }   from './highlightManager';
import { DecorationManager }  from './decorationManager';
import { Reconciler }         from './reconciler';
import { ShadowTracker }      from './shadowTracker';
import { ContextMenuHandler } from './contextMenu';
import { log }                from './logger';

export function activate(context: vscode.ExtensionContext): void {
  log.separator('ACTIVATE');
  log.info('Extension', 'Code Highlighter activating...');

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    log.warn('Extension', 'No workspace folder open — extension inactive');
    return;
  }

  log.info('Extension', 'Workspace root', { workspaceRoot });

  const manager     = new HighlightManager(workspaceRoot);
  const decorations = new DecorationManager();
  const reconciler  = new Reconciler(manager);
  const tracker     = new ShadowTracker(manager, decorations);
  const contextMenu = new ContextMenuHandler(manager, decorations);

  manager.load();
  contextMenu.register(context);
  tracker.start();

  log.info('Extension', 'Boot sequence complete');

  const reconcileAndPaint = (editor: vscode.TextEditor): void => {
    const filePath   = manager.toRelativePath(editor.document.uri.fsPath);
    const highlights = manager.getForFile(filePath);

    log.info('Extension', `reconcileAndPaint called`, { filePath, highlightCount: highlights.length });

    if (highlights.length === 0) return;

    const orphanCount = reconciler.reconcileFile(filePath, editor.document.getText());

    const hasDirty = manager.hasDirty(filePath);
    if (hasDirty) {
      log.info('Extension', 'Saving reconciler range updates to disk');
      manager.clearDirty(filePath);
      manager.save();
    }

    if (orphanCount > 0) {
      log.warn('Extension', `${orphanCount} highlight(s) became orphaned`, { filePath });
      vscode.window.showWarningMessage(
        `Code Highlighter: ${orphanCount} highlight${orphanCount > 1 ? 's were' : ' was'} lost due to file changes. ` +
        `Run "Highlight: Clear Orphans" to clean up.`,
        'Clear Now'
      ).then(choice => {
        if (choice === 'Clear Now') {
          vscode.commands.executeCommand('codeHighlighter.clearOrphans');
        }
      });
    }

    decorations.applyToEditor(editor, manager.getForFile(filePath));
    log.info('Extension', 'Decorations applied', { filePath });
  };

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(editor => {
      if (editor) {
        log.info('Extension', 'Active editor changed', { file: editor.document.fileName });
        reconcileAndPaint(editor);
      }
    }),
    vscode.window.onDidChangeVisibleTextEditors(editors => {
      log.info('Extension', `Visible editors changed — repainting ${editors.length} editor(s)`);
      for (const editor of editors) reconcileAndPaint(editor);
    })
  );

  if (vscode.window.activeTextEditor) {
    log.info('Extension', 'Painting already-open editor on activation');
    reconcileAndPaint(vscode.window.activeTextEditor);
  }

  context.subscriptions.push(decorations, tracker, contextMenu);
  log.info('Extension', 'All subscriptions registered — activation complete');
}

export function deactivate(): void {
  log.info('Extension', 'Deactivating');
  log.dispose();
}