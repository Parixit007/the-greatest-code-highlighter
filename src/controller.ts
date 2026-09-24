// src/controller.ts
//
// Wires everything together: one HighlightStore per workspace folder, one
// DocumentSession per open document inside a folder, and the editor events
// that keep them in sync and painted.

import * as vscode from 'vscode';
import * as path from 'path';
import { HighlightColor, HighlightRange } from './core/types';
import { SIDECAR_FILENAME } from './core/sidecar';
import { DocumentSession, fromVscodeRange } from './documentSession';
import { HighlightStore } from './highlightStore';
import { DecorationManager } from './decorationManager';
import { log } from './logger';

/** How long to let a file reload from disk (git checkout, File: Revert) settle before re-finding its highlights. */
const RELOAD_SETTLE_MS = 300;

/** What `activate()` returns; used by the integration tests. */
export interface CodeHighlighterApi {
  getHighlights(uri: vscode.Uri): Array<{ id: string; color: HighlightColor; range: HighlightRange; lost: boolean }>;
  /** Waits for pending highlight.json writes. */
  flush(): Promise<void>;
}

export class Controller implements vscode.Disposable {
  private loading: Promise<void>;
  private readonly stores = new Map<string, HighlightStore>();
  private readonly sessions = new Map<string, DocumentSession>();
  private readonly decorations = new DecorationManager();
  private readonly pendingResets = new Map<DocumentSession, ReturnType<typeof setTimeout>>();
  private readonly reportedLost = new Set<string>();
  private readonly contextKeys = new Map<string, boolean>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor() {
    this.disposables.push(
      this.decorations,
      vscode.workspace.onDidOpenTextDocument(doc => this.sessionFor(doc)),
      vscode.workspace.onDidCloseTextDocument(doc => this.onDidClose(doc)),
      vscode.workspace.onDidChangeTextDocument(e => this.onDidChange(e)),
      vscode.workspace.onDidSaveTextDocument(doc => this.existingSession(doc)?.onDidSave()),
      vscode.workspace.onDidRenameFiles(e => this.onDidRename(e)),
      vscode.workspace.onDidChangeWorkspaceFolders(() => { this.loading = this.syncFolders(); }),
      vscode.window.onDidChangeVisibleTextEditors(editors => {
        for (const editor of editors) this.paintEditor(editor);
        this.updateContextKeys();
      }),
      vscode.window.onDidChangeActiveTextEditor(() => this.updateContextKeys()),
      vscode.window.onDidChangeTextEditorSelection(e => {
        if (e.textEditor === vscode.window.activeTextEditor) this.updateContextKeys();
      }),
    );
    this.loading = this.syncFolders();
  }

  /** Resolves once every workspace folder's highlight.json has been loaded. */
  get ready(): Promise<void> {
    return this.loading;
  }

  // ─── Used by commands ───────────────────────────────────────────────────

  /** The active editor and its session, or undefined after telling the user why highlighting isn't available. */
  async activeTarget(): Promise<{ editor: vscode.TextEditor; session: DocumentSession } | undefined> {
    await this.ready;
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      void vscode.window.showInformationMessage('Open a file to highlight code in it.');
      return undefined;
    }
    const session = this.sessionFor(editor.document);
    if (!session) {
      void vscode.window.showInformationMessage(this.whyUnavailable(editor.document.uri));
      return undefined;
    }
    if (session.store.problem) {
      void vscode.window.showErrorMessage(
        `Code Highlighter: can't change highlights in "${session.store.folder.name}" because highlight.json ${session.store.problem}.`);
      return undefined;
    }
    return { editor, session };
  }

  /** The session of an open document, by URI. */
  async sessionForUri(uri: vscode.Uri): Promise<DocumentSession | undefined> {
    await this.ready;
    const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
    return doc && this.sessionFor(doc);
  }

  /** False once the session's document has been closed. */
  isLive(session: DocumentSession): boolean {
    return this.existingSession(session.document) === session;
  }

  /** Repaints a session and updates menus after its highlights changed. */
  refresh(session: DocumentSession): void {
    this.paintSession(session);
    this.updateContextKeys();
  }

  api(): CodeHighlighterApi {
    return {
      getHighlights: uri => {
        const session = [...this.sessions.values()].find(s => s.document.uri.toString() === uri.toString());
        return (session?.highlights ?? []).map(h => ({ id: h.id, color: h.color, range: { ...h.range }, lost: !!h.lostAt }));
      },
      flush: () => this.flush(),
    };
  }

  async flush(): Promise<void> {
    await this.ready;
    await Promise.all([...this.stores.values()].map(store => store.flush()));
  }

  dispose(): void {
    for (const timer of this.pendingResets.values()) clearTimeout(timer);
    for (const d of this.disposables) d.dispose();
    for (const store of this.stores.values()) store.dispose();
    this.stores.clear();
    this.sessions.clear();
  }

  // ─── Sessions ───────────────────────────────────────────────────────────

  /** The session for a document, created on first use if the document is inside a loaded workspace folder. */
  private sessionFor(doc: vscode.TextDocument): DocumentSession | undefined {
    const place = doc.isClosed ? undefined : this.locate(doc.uri);
    const existing = this.sessions.get(doc.uri.toString());
    if (existing) {
      if (place && existing.document === doc && existing.store === place.store && existing.filePath === place.filePath) {
        return existing;
      }
      this.drop(existing);
    }
    if (!place?.store.loaded) return undefined;

    const session = new DocumentSession(doc, place.store, place.filePath);
    this.sessions.set(doc.uri.toString(), session);
    this.reset(session);
    return session;
  }

  private existingSession(doc: vscode.TextDocument): DocumentSession | undefined {
    const session = this.sessions.get(doc.uri.toString());
    return session?.document === doc ? session : undefined;
  }

  private drop(session: DocumentSession): void {
    const key = session.document.uri.toString();
    if (this.sessions.get(key) === session) this.sessions.delete(key);
    clearTimeout(this.pendingResets.get(session));
    this.pendingResets.delete(session);
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document === session.document) this.decorations.clear(editor);
    }
  }

  /** Re-finds a session's highlights from highlight.json, repaints, and reports any that were lost. */
  private reset(session: DocumentSession): void {
    const lost = session.reset();
    this.refresh(session);

    const fresh = lost.filter(h => !this.reportedLost.has(h.id));
    if (!fresh.length) return;
    for (const h of fresh) this.reportedLost.add(h.id);
    const n = fresh.length;
    log.info(`${session.filePath}: ${n} highlight(s) lost`);
    void vscode.window.showWarningMessage(
      `Code Highlighter: ${n === 1 ? '1 highlight' : `${n} highlights`} in ${session.filePath} ` +
      `${n === 1 ? 'was' : 'were'} lost because the code changed. ${n === 1 ? 'It is' : 'They are'} marked "⚠ lost" in the editor.`,
      'Clear Now',
    ).then(choice => {
      if (choice) void vscode.commands.executeCommand('codeHighlighter.clearOrphans', session.document.uri);
    });
  }

  private scheduleReset(session: DocumentSession): void {
    clearTimeout(this.pendingResets.get(session));
    this.pendingResets.set(session, setTimeout(async () => {
      this.pendingResets.delete(session);
      // A checkout may have replaced highlight.json too; read it before searching.
      await session.store.refresh();
      if (this.isLive(session)) this.reset(session);
    }, RELOAD_SETTLE_MS));
  }

  // ─── Events ─────────────────────────────────────────────────────────────

  private onDidChange(e: vscode.TextDocumentChangeEvent): void {
    if (!e.contentChanges.length) return;
    const session = this.existingSession(e.document);
    if (!session) return;
    const changed = session.applyEdits(e.contentChanges);
    // A change that leaves the document clean without being an undo/redo is the
    // text being reloaded from disk (another program, a git checkout, File: Revert).
    if (!e.document.isDirty && e.reason === undefined && session.highlights.length) this.scheduleReset(session);
    if (changed) this.paintSession(session);
    if (e.document === vscode.window.activeTextEditor?.document) this.updateContextKeys();
  }

  private onDidClose(doc: vscode.TextDocument): void {
    // Changing a document's language closes and reopens the same document, so
    // wait a tick and only drop the session if the document is really gone.
    setTimeout(() => {
      const session = this.existingSession(doc);
      if (session && doc.isClosed) this.drop(session);
    }, 0);
  }

  private onStoreChanged(store: HighlightStore, files: ReadonlySet<string>): void {
    for (const session of this.sessions.values()) {
      if (session.store === store && files.has(session.filePath)) this.scheduleReset(session);
    }
  }

  /** Files renamed or moved inside VS Code take their highlights with them. */
  private onDidRename(e: vscode.FileRenameEvent): void {
    const arrived: Array<{ store: HighlightStore; filePath: string }> = [];
    for (const { oldUri, newUri } of e.files) {
      const from = this.locate(oldUri);
      if (!from) continue;
      for (const session of [...this.sessions.values()]) {
        const p = session.document.uri.path;
        if (p === oldUri.path || p.startsWith(oldUri.path + '/')) this.drop(session);
      }
      const taken = from.store.extract(from.filePath);
      const to = this.locate(newUri);
      for (const [filePath, records] of taken) {
        if (!to) {
          from.store.setRecords(filePath, records);   // moved out of the workspace: leave them be
          continue;
        }
        const newPath = to.filePath + filePath.slice(from.filePath.length);
        to.store.setRecords(newPath, records.map(r => ({ ...r, filePath: newPath })));
        arrived.push({ store: to.store, filePath: newPath });
        log.info(`Moved ${records.length} highlight(s) from ${filePath} to ${newPath}`);
      }
    }
    for (const session of this.sessions.values()) {
      if (arrived.some(a => a.store === session.store && a.filePath === session.filePath)) this.reset(session);
    }
  }

  private async syncFolders(): Promise<void> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const keep = new Set(folders.map(f => f.uri.toString()));
    for (const [key, store] of this.stores) {
      if (keep.has(key)) continue;
      this.stores.delete(key);
      void store.flush().finally(() => store.dispose());
    }

    const loads: Promise<void>[] = [];
    for (const folder of folders) {
      if (this.stores.has(folder.uri.toString())) continue;
      const store = new HighlightStore(folder);
      this.stores.set(folder.uri.toString(), store);
      store.onDidChangeOnDisk(files => this.onStoreChanged(store, files));
      loads.push(store.load().then(() => this.syncSessions()));
    }
    this.syncSessions();
    await Promise.all(loads);
  }

  /** Creates sessions for open documents and drops the ones that no longer belong to a folder. */
  private syncSessions(): void {
    for (const session of [...this.sessions.values()]) this.sessionFor(session.document);
    for (const doc of vscode.workspace.textDocuments) this.sessionFor(doc);
  }

  /** Which folder's highlight.json covers `uri`, and the path it's stored under. */
  private locate(uri: vscode.Uri): { store: HighlightStore; filePath: string } | undefined {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder || folder.uri.scheme !== uri.scheme || folder.uri.authority !== uri.authority) return undefined;
    const store = this.stores.get(folder.uri.toString());
    const filePath = path.posix.relative(folder.uri.path, uri.path);
    if (!store || !filePath || filePath.startsWith('..') || filePath === SIDECAR_FILENAME) return undefined;
    return { store, filePath };
  }

  private whyUnavailable(uri: vscode.Uri): string {
    if (!vscode.workspace.workspaceFolders?.length) {
      return 'Open a folder to use Code Highlighter — highlights are saved to highlight.json in that folder.';
    }
    if (uri.scheme === 'untitled') return 'Save this file inside your workspace folder to highlight it.';
    if (path.posix.basename(uri.path) === SIDECAR_FILENAME) return 'highlight.json itself can\'t be highlighted.';
    return 'Only files inside an open workspace folder can be highlighted.';
  }

  // ─── Painting and menus ─────────────────────────────────────────────────

  private paintSession(session: DocumentSession): void {
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document === session.document) this.decorations.paint(editor, session.highlights);
    }
  }

  private paintEditor(editor: vscode.TextEditor): void {
    const session = this.existingSession(editor.document);
    if (session) this.decorations.paint(editor, session.highlights);
    else this.decorations.clear(editor);
  }

  private updateContextKeys(): void {
    const editor = vscode.window.activeTextEditor;
    const session = editor && this.existingSession(editor.document);
    this.setContext('codeHighlighter.fileHasHighlights', !!session?.highlights.length);
    this.setContext('codeHighlighter.selectionHasHighlight',
      !!session && editor!.selections.some(sel => session.hasHighlightIn(fromVscodeRange(sel))));
  }

  private setContext(key: string, value: boolean): void {
    if (this.contextKeys.get(key) === value) return;
    this.contextKeys.set(key, value);
    void vscode.commands.executeCommand('setContext', key, value);
  }
}
