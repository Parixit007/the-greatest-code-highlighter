// src/highlightStore.ts
//
// The highlight.json of one workspace folder. Keeps its records in memory,
// reloads when the file changes on disk (git pull, branch switch, a teammate's
// edit), and writes changes back without clobbering anyone else's: every write
// re-reads the file and only replaces the entries of files changed here.

import * as vscode from 'vscode';
import { HighlightRecord } from './core/types';
import { SIDECAR_FILENAME, SidecarError, parseSidecar, sameRecords, serializeSidecar } from './core/sidecar';
import { log } from './logger';

const WRITE_DELAY_MS = 50;
const RELOAD_DELAY_MS = 100;

export class HighlightStore implements vscode.Disposable {
  readonly uri: vscode.Uri;
  /** True once the file has been read for the first time. */
  loaded = false;

  private records = new Map<string, HighlightRecord[]>();
  private unknown: unknown[] = [];
  /** The file's text as last read or written; undefined when it doesn't exist. */
  private diskText: string | undefined;
  private brokenReason: string | undefined;
  /** Files whose records changed here and haven't been written yet. */
  private readonly unsaved = new Set<string>();
  private queue: Promise<void> = Promise.resolve();
  private writeTimer: ReturnType<typeof setTimeout> | undefined;
  private reloadTimer: ReturnType<typeof setTimeout> | undefined;
  private reportedWriteError = false;
  private readonly changed = new vscode.EventEmitter<ReadonlySet<string>>();
  private readonly disposables: vscode.Disposable[] = [this.changed];

  /** Fires with the files whose records changed because highlight.json changed on disk. */
  readonly onDidChangeOnDisk = this.changed.event;

  constructor(readonly folder: vscode.WorkspaceFolder) {
    this.uri = vscode.Uri.joinPath(folder.uri, SIDECAR_FILENAME);
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, SIDECAR_FILENAME));
    const onEvent = () => this.scheduleReload();
    this.disposables.push(watcher, watcher.onDidChange(onEvent), watcher.onDidCreate(onEvent), watcher.onDidDelete(onEvent));
  }

  /** Why highlight.json can't be used right now, or undefined if it's fine. */
  get problem(): string | undefined {
    return this.brokenReason;
  }

  async load(): Promise<void> {
    await this.refresh();
    this.loaded = true;
  }

  /** Reads the file now instead of waiting for the file watcher. */
  refresh(): Promise<void> {
    return this.enqueue(async () => {
      const text = await this.read();
      if (!this.loaded || text !== this.diskText) this.absorb(text);
    });
  }

  getRecords(filePath: string): readonly HighlightRecord[] {
    return this.records.get(filePath) ?? [];
  }

  /** Replaces the records of one file and schedules a write. */
  setRecords(filePath: string, records: readonly HighlightRecord[]): void {
    if (records.length) this.records.set(filePath, [...records]);
    else this.records.delete(filePath);
    this.unsaved.add(filePath);
    this.scheduleWrite();
  }

  /** Removes and returns the records of `path`, and of everything under it if it's a folder. */
  extract(path: string): Map<string, HighlightRecord[]> {
    const taken = new Map<string, HighlightRecord[]>();
    for (const [filePath, records] of this.records) {
      if (filePath === path || filePath.startsWith(path + '/')) taken.set(filePath, records);
    }
    for (const filePath of taken.keys()) this.setRecords(filePath, []);
    return taken;
  }

  /** Writes pending changes now and waits for all queued disk work. */
  flush(): Promise<void> {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = undefined;
      return this.enqueue(() => this.write());
    }
    return this.enqueue(async () => undefined);
  }

  dispose(): void {
    clearTimeout(this.writeTimer);
    clearTimeout(this.reloadTimer);
    for (const d of this.disposables) d.dispose();
  }

  // ─── Disk I/O ───────────────────────────────────────────────────────────

  private scheduleWrite(): void {
    clearTimeout(this.writeTimer);
    this.writeTimer = setTimeout(() => {
      this.writeTimer = undefined;
      void this.enqueue(() => this.write());
    }, WRITE_DELAY_MS);
  }

  private scheduleReload(): void {
    clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => void this.refresh(), RELOAD_DELAY_MS);
  }

  /** Runs disk work one task at a time so reads and writes never interleave. */
  private enqueue(task: () => Promise<void>): Promise<void> {
    this.queue = this.queue.then(task).catch(err => log.error(`highlight.json in "${this.folder.name}": ${err}`));
    return this.queue;
  }

  private async read(): Promise<string | undefined> {
    try {
      return new TextDecoder().decode(await vscode.workspace.fs.readFile(this.uri));
    } catch (err) {
      if (isNotFound(err)) return undefined;
      throw err;
    }
  }

  private async write(): Promise<void> {
    if (!this.unsaved.size) return;

    // Take in whatever changed on disk since we last looked, so it isn't overwritten.
    const current = await this.read();
    if (current !== this.diskText && !this.absorb(current)) return;
    if (this.brokenReason) return;

    const pending = new Set(this.unsaved);
    this.unsaved.clear();
    const all = [...this.records.values()].flat();
    const text = serializeSidecar(all, this.unknown);
    if (text === current) return;
    if (current === undefined && all.length === 0 && this.unknown.length === 0) return;

    try {
      await vscode.workspace.fs.writeFile(this.uri, new TextEncoder().encode(text));
      this.diskText = text;
      this.reportedWriteError = false;
      log.debug(`Wrote ${all.length} highlight(s) to ${this.uri.fsPath}`);
    } catch (err) {
      for (const filePath of pending) this.unsaved.add(filePath);
      log.error(`Couldn't write ${this.uri.fsPath}: ${err}`);
      if (!this.reportedWriteError) {
        this.reportedWriteError = true;
        void vscode.window.showErrorMessage(`Code Highlighter: couldn't save highlight.json — ${(err as Error).message}`);
      }
    }
  }

  /**
   * Adopts the file's contents. Files with unwritten local changes keep them;
   * every other file takes what's on disk. Returns false if the file can't be parsed.
   */
  private absorb(text: string | undefined): boolean {
    let contents;
    try {
      contents = parseSidecar(text);
    } catch (err) {
      const reason = err instanceof SidecarError ? err.message : String(err);
      this.diskText = text;
      if (this.brokenReason !== reason) {
        this.brokenReason = reason;
        log.warn(`Can't read ${this.uri.fsPath}: ${reason}`);
        void vscode.window.showWarningMessage(
          `Code Highlighter: can't read highlight.json in "${this.folder.name}" because ${reason}. ` +
          `Highlights there are paused, and the file won't be changed until it's fixed.`,
          'Open highlight.json',
        ).then(choice => { if (choice) void vscode.window.showTextDocument(this.uri); });
      }
      return false;
    }

    if (this.brokenReason) log.info(`${this.uri.fsPath} is readable again`);
    this.brokenReason = undefined;
    this.diskText = text;
    this.unknown = contents.unknown;
    if (contents.unknown.length) {
      log.warn(`${this.uri.fsPath} has ${contents.unknown.length} entr(ies) this version can't read; they're kept as-is`);
    }

    const incoming = new Map<string, HighlightRecord[]>();
    for (const record of contents.records) {
      const list = incoming.get(record.filePath);
      if (list) list.push(record); else incoming.set(record.filePath, [record]);
    }

    const changedFiles = new Set<string>();
    for (const filePath of new Set([...incoming.keys(), ...this.records.keys()])) {
      if (this.unsaved.has(filePath)) continue;
      const before = this.records.get(filePath) ?? [];
      const after = incoming.get(filePath) ?? [];
      if (sameRecords(before, after)) continue;
      changedFiles.add(filePath);
      if (after.length) this.records.set(filePath, after); else this.records.delete(filePath);
    }

    if (changedFiles.size) {
      log.info(`highlight.json in "${this.folder.name}" changed on disk (${changedFiles.size} file(s) affected)`);
      this.changed.fire(changedFiles);
    }
    if (this.unsaved.size) this.scheduleWrite();
    return true;
  }
}

function isNotFound(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code;
  return code === 'FileNotFound' || code === 'EntryNotFound' || code === 'ENOENT';
}
