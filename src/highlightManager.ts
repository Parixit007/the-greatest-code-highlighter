// src/highlightManager.ts

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { Highlight, HighlightColor, HighlightFile, HighlightRange } from './types';
import { log } from './logger';

const SIDECAR_FILENAME = 'highlight.json';

export class HighlightManager {
  private highlights: Map<string, Highlight[]> = new Map();
  private sidecarPath: string;

  constructor(private workspaceRoot: string) {
    this.sidecarPath = path.join(workspaceRoot, SIDECAR_FILENAME);
    log.info('HighlightManager', 'Initialized', { workspaceRoot, sidecarPath: this.sidecarPath });
  }

  load(): void {
    log.separator('LOAD');
    if (!fs.existsSync(this.sidecarPath)) {
      log.info('HighlightManager', 'No highlight.json found — fresh start');
      return;
    }

    try {
      const raw    = fs.readFileSync(this.sidecarPath, 'utf-8');
      const parsed: HighlightFile = JSON.parse(raw);
      log.info('HighlightManager', `Parsed highlight.json — ${parsed.highlights.length} highlights found`);

      this.highlights.clear();

      for (const h of parsed.highlights) {
        if (!this.highlights.has(h.filePath)) {
          this.highlights.set(h.filePath, []);
        }
        this.highlights.get(h.filePath)!.push(h);
        log.debug('HighlightManager', `Loaded highlight`, {
          id: h.id, filePath: h.filePath, color: h.color, range: h.range
        });
      }

      log.info('HighlightManager', `Load complete — ${this.highlights.size} file(s) have highlights`);
    } catch (err) {
      log.error('HighlightManager', 'Failed to parse highlight.json', err);
      vscode.window.showWarningMessage(
        `Code Highlighter: Failed to parse highlight.json — ${(err as Error).message}`
      );
    }
  }

  save(): void {
    const all: Highlight[] = [];

    for (const highlights of this.highlights.values()) {
      for (const h of highlights) {
        const { dirty, ...clean } = h;
        all.push(clean as Highlight);
      }
    }

    const file: HighlightFile = { version: 1, highlights: all };

    try {
      fs.writeFileSync(this.sidecarPath, JSON.stringify(file, null, 2), 'utf-8');
      log.info('HighlightManager', `Saved highlight.json — ${all.length} total highlights`);
    } catch (err) {
      log.error('HighlightManager', 'Failed to save highlight.json', err);
      vscode.window.showErrorMessage(
        `Code Highlighter: Failed to save highlight.json — ${(err as Error).message}`
      );
    }
  }

  add(filePath: string, color: HighlightColor, range: HighlightRange, documentText: string): Highlight {
    const lines        = documentText.split('\n');
    const textSnapshot = lines.slice(range.startLine, range.endLine + 1).join('\n');
    const lineBefore   = range.startLine > 0 ? lines[range.startLine - 1].trim() : '';
    const lineAfter    = range.endLine < lines.length - 1 ? lines[range.endLine + 1].trim() : '';

    const highlight: Highlight = {
      id: uuidv4(),
      filePath,
      color,
      range,
      textSnapshot,
      context: { lineBefore, lineAfter },
    };

    if (!this.highlights.has(filePath)) {
      this.highlights.set(filePath, []);
    }
    this.highlights.get(filePath)!.push(highlight);

    log.info('HighlightManager', `Added highlight`, {
      id: highlight.id, color, range, textSnapshot, lineBefore, lineAfter
    });

    return highlight;
  }

  remove(id: string): void {
    for (const [filePath, list] of this.highlights.entries()) {
      const idx = list.findIndex(h => h.id === id);
      if (idx !== -1) {
        const removed = list.splice(idx, 1)[0];
        log.info('HighlightManager', `Removed highlight`, { id, filePath, color: removed.color, range: removed.range });
        if (list.length === 0) {
          this.highlights.delete(filePath);
          log.debug('HighlightManager', `No highlights left for file — removed entry`, { filePath });
        }
        return;
      }
    }
    log.warn('HighlightManager', `remove() called but id not found`, { id });
  }

  removeAllForFile(filePath: string): void {
    const count = this.highlights.get(filePath)?.length ?? 0;
    this.highlights.delete(filePath);
    log.info('HighlightManager', `Removed all highlights for file`, { filePath, count });
  }

  updateRange(id: string, newRange: HighlightRange): void {
    const h = this.findById(id);
    if (h) {
      log.debug('HighlightManager', `updateRange`, { id, oldRange: h.range, newRange });
      h.range = newRange;
      h.dirty = true;
    } else {
      log.warn('HighlightManager', `updateRange() — id not found`, { id });
    }
  }

  updateColor(id: string, color: HighlightColor): void {
    const h = this.findById(id);
    if (h) {
      log.info('HighlightManager', `updateColor`, { id, oldColor: h.color, newColor: color });
      h.color = color;
      h.dirty = true;
    } else {
      log.warn('HighlightManager', `updateColor() — id not found`, { id });
    }
  }

  markOrphaned(id: string): void {
    const h = this.findById(id);
    if (h) {
      log.warn('HighlightManager', `Marking highlight as orphaned`, { id, range: h.range });
      h.orphaned = true;
      h.dirty    = true;
    } else {
      log.warn('HighlightManager', `markOrphaned() — id not found`, { id });
    }
  }

  getForFile(filePath: string): Highlight[] {
    const result = this.highlights.get(filePath) ?? [];
    log.debug('HighlightManager', `getForFile`, { filePath, count: result.length });
    return result;
  }

  findById(id: string): Highlight | undefined {
    for (const list of this.highlights.values()) {
      const found = list.find(h => h.id === id);
      if (found) return found;
    }
    return undefined;
  }

  findAtPosition(filePath: string, line: number, char: number): Highlight | undefined {
    const result = this.getForFile(filePath).find(h => {
      const { startLine, startChar, endLine, endChar } = h.range;
      if (line < startLine || line > endLine) return false;
      if (line === startLine && char < startChar) return false;
      if (line === endLine && char > endChar) return false;
      return true;
    });
    log.debug('HighlightManager', `findAtPosition`, { filePath, line, char, found: result?.id ?? 'NONE' });
    return result;
  }

  findAllOverlapping(filePath: string, startLine: number, startChar: number, endLine: number, endChar: number): Highlight[] {
    const sStart = startLine * 100000 + startChar;
    const sEnd   = endLine   * 100000 + endChar;

    const results = this.getForFile(filePath).filter(h => {
      const hStart = h.range.startLine * 100000 + h.range.startChar;
      const hEnd   = h.range.endLine   * 100000 + h.range.endChar;
      return hStart <= sEnd && hEnd >= sStart;
    });

    log.debug('HighlightManager', `findAllOverlapping`, {
      filePath, startLine, startChar, endLine, endChar,
      found: results.map(h => ({ id: h.id, range: h.range }))
    });

    return results;
  }

  splitAroundSelection(filePath: string, selStartLine: number, selStartChar: number, selEndLine: number, selEndChar: number, documentText: string): void {
    log.separator('SPLIT');
    log.info('HighlightManager', `splitAroundSelection`, { selStartLine, selStartChar, selEndLine, selEndChar });

    const highlights = this.findAllOverlapping(filePath, selStartLine, selStartChar, selEndLine, selEndChar);
    log.info('HighlightManager', `Highlights overlapping selection: ${highlights.length}`);

    for (const h of highlights) {
      const hStart = h.range.startLine * 100000 + h.range.startChar;
      const hEnd   = h.range.endLine   * 100000 + h.range.endChar;
      const sStart = selStartLine      * 100000 + selStartChar;
      const sEnd   = selEndLine        * 100000 + selEndChar;

      if (sStart <= hStart && sEnd >= hEnd) {
        log.info('HighlightManager', `Case 1: selection covers entire highlight — removing`, { id: h.id });
        this.remove(h.id);
        continue;
      }

      if (sStart > hStart && sEnd >= hEnd) {
        log.info('HighlightManager', `Case 2: selection overlaps END — trimming right`, { id: h.id });
        this.updateRange(h.id, {
          startLine: h.range.startLine, startChar: h.range.startChar,
          endLine: selStartLine, endChar: selStartChar,
        });
        this.refreshSnapshot(h.id, documentText);
        continue;
      }

      if (sStart <= hStart && sEnd < hEnd) {
        log.info('HighlightManager', `Case 3: selection overlaps START — trimming left`, { id: h.id });
        this.updateRange(h.id, {
          startLine: selEndLine, startChar: selEndChar,
          endLine: h.range.endLine, endChar: h.range.endChar,
        });
        this.refreshSnapshot(h.id, documentText);
        continue;
      }

      log.info('HighlightManager', `Case 4: selection in MIDDLE — splitting into two`, { id: h.id });
      const leftRange  = { startLine: h.range.startLine, startChar: h.range.startChar, endLine: selStartLine, endChar: selStartChar };
      const rightRange = { startLine: selEndLine, startChar: selEndChar, endLine: h.range.endLine, endChar: h.range.endChar };
      log.debug('HighlightManager', `Split result`, { leftRange, rightRange });

      this.updateRange(h.id, leftRange);
      this.refreshSnapshot(h.id, documentText);
      this.add(filePath, h.color, rightRange, documentText);
    }
  }

  private refreshSnapshot(id: string, documentText: string): void {
    const h = this.findById(id);
    if (!h) { log.warn('HighlightManager', `refreshSnapshot — id not found`, { id }); return; }

    const lines      = documentText.split('\n');
    h.textSnapshot   = lines.slice(h.range.startLine, h.range.endLine + 1).join('\n');
    h.context.lineBefore = h.range.startLine > 0 ? lines[h.range.startLine - 1].trim() : '';
    h.context.lineAfter  = h.range.endLine < lines.length - 1 ? lines[h.range.endLine + 1].trim() : '';

    log.debug('HighlightManager', `Refreshed snapshot`, { id, textSnapshot: h.textSnapshot });
  }

  hasDirty(filePath: string): boolean {
    return this.getForFile(filePath).some(h => h.dirty);
  }

  clearDirty(filePath: string): void {
    for (const h of this.getForFile(filePath)) { delete h.dirty; }
    log.debug('HighlightManager', `Cleared dirty flags`, { filePath });
  }

  toRelativePath(absolutePath: string): string {
    return path.relative(this.workspaceRoot, absolutePath).replace(/\\/g, '/');
  }
}