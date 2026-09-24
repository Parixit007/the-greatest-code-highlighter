// src/commands.ts

import * as vscode from 'vscode';
import { COLORS, COLOR_STYLES, isHighlightColor } from './core/colors';
import { HighlightColor, HighlightRange } from './core/types';
import { Controller } from './controller';
import { fromVscodeRange } from './documentSession';

export function registerCommands(controller: Controller): vscode.Disposable[] {
  // Position in the cycle: red → remove → blue → remove → … → yellow → remove → red.
  let cycleIndex = 0;

  /** Highlight: Pick Color. Takes an optional color name, e.g. from a keybinding's "args". */
  const highlightSelection = async (color?: unknown) => {
    const target = await controller.activeTarget();
    if (!target) return;
    if (!selectedRanges(target.editor).length) {
      info('Select some code to highlight first.');
      return;
    }
    let chosen: HighlightColor | undefined = isHighlightColor(color) ? color : undefined;
    if (!chosen) {
      const pick = await vscode.window.showQuickPick(
        COLORS.map(c => ({ label: COLOR_STYLES[c].label, color: c })),
        { placeHolder: 'Pick a highlight color' },
      );
      if (!pick) return;
      chosen = pick.color;
    }
    if (!controller.isLive(target.session)) return;
    target.session.paint(selectedRanges(target.editor), chosen);
    controller.refresh(target.session);
  };

  /** Highlight: Cycle Color. Each press highlights the selection in the next color, or removes the highlight that's there. */
  const cycleHighlight = async () => {
    const target = await controller.activeTarget();
    if (!target) return;
    const { editor, session } = target;

    let removed = 0;
    const toPaint: HighlightRange[] = [];
    for (const sel of editor.selections) {
      const existing = sel.isEmpty
        ? session.highlightAt({ line: sel.active.line, char: sel.active.character })
        : session.exactly(fromVscodeRange(sel));
      if (existing) {
        session.remove([existing]);
        removed++;
      } else if (!sel.isEmpty) {
        toPaint.push(fromVscodeRange(sel));
      }
    }
    if (toPaint.length) session.paint(toPaint, COLORS[cycleIndex]);
    if (removed) cycleIndex = (cycleIndex + 1) % COLORS.length;
    if (!removed && !toPaint.length) info('Select some code to highlight.');
    controller.refresh(session);
  };

  /** Highlight: Remove Selected. Removes the highlight at the cursor, or un-highlights the selected text. */
  const removeSelected = async () => {
    const target = await controller.activeTarget();
    if (!target) return;
    const { editor, session } = target;

    let count = 0;
    for (const sel of editor.selections) {
      if (sel.isEmpty) {
        const existing = session.highlightAt({ line: sel.active.line, char: sel.active.character });
        if (existing) {
          session.remove([existing]);
          count++;
        }
      } else {
        count += session.erase([fromVscodeRange(sel)]);
      }
    }
    controller.refresh(session);
    if (!count) info(editor.selections.every(s => s.isEmpty) ? 'No highlight at the cursor.' : 'No highlights in the selection.');
  };

  /** Highlight: Remove All in File, with an Undo button. */
  const removeAll = async () => {
    const target = await controller.activeTarget();
    if (!target) return;
    const { session } = target;

    const removed = session.removeAll();
    controller.refresh(session);
    if (!removed.length) {
      info('No highlights in this file.');
      return;
    }
    void vscode.window.showInformationMessage(
      `Removed ${plural(removed.length, 'highlight')} from ${session.filePath}.`, 'Undo',
    ).then(choice => {
      if (choice !== 'Undo') return;
      if (!controller.isLive(session)) {
        info('Can\'t undo: the file has been closed.');
        return;
      }
      session.restore(removed);
      controller.refresh(session);
    });
  };

  /** Highlight: Clear Orphans. Removes lost highlights from the active file, or from `uri` when given. */
  const clearOrphans = async (uri?: unknown) => {
    const session = uri instanceof vscode.Uri
      ? await controller.sessionForUri(uri)
      : (await controller.activeTarget())?.session;
    if (!session) return;
    const count = session.clearLost();
    controller.refresh(session);
    info(count ? `Cleared ${plural(count, 'lost highlight')}.` : 'No lost highlights in this file.');
  };

  return [
    vscode.commands.registerCommand('codeHighlighter.highlightSelection', highlightSelection),
    vscode.commands.registerCommand('codeHighlighter.cycleHighlight', cycleHighlight),
    vscode.commands.registerCommand('codeHighlighter.removeSelected', removeSelected),
    vscode.commands.registerCommand('codeHighlighter.removeAll', removeAll),
    vscode.commands.registerCommand('codeHighlighter.clearOrphans', clearOrphans),
  ];
}

function selectedRanges(editor: vscode.TextEditor): HighlightRange[] {
  return editor.selections.filter(sel => !sel.isEmpty).map(fromVscodeRange);
}

function info(message: string): void {
  void vscode.window.showInformationMessage(message);
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}
