// src/documentSession.ts
//
// The live highlights of one open document: moves them with every edit, finds
// them again when the text is replaced from outside, and saves them to the
// folder's highlight.json.
//
// When highlight.json is written:
//   - highlight commands (add, recolor, remove) write immediately;
//   - positions moved by typing are written when the document is saved, so the
//     file always describes code that exists on disk.

import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import { HighlightColor, HighlightRange, HighlightRecord, Position, TextChange } from './core/types';
import {
  changedLineSpans, comparePositions, mapPosition, rangeContains, rangeTouches, rangesEqual, rangesOverlap,
  startOf, subtractRange, transformRange,
} from './core/ranges';
import { clampPosition, contextOf, normalizeRange, snapshotOf, splitLines } from './core/text';
import { reconcile } from './core/reconciler';
import { HighlightStore } from './highlightStore';
import { log } from './logger';

export interface LiveHighlight {
  readonly id: string;
  color: HighlightColor;
  /** Where the highlight is now. For a lost highlight: where it was when its code disappeared. */
  range: HighlightRange;
  /** Full text of the lines under `range`, kept current so a lost highlight is recognized if its code comes back. */
  text: string;
  /** Set while the highlighted code is gone. Follows edits and marks where the code used to be. */
  lostAt?: Position;
  /** What highlight.json holds for this highlight; undefined until it has been written. */
  saved?: HighlightRecord;
}

export class DocumentSession {
  highlights: LiveHighlight[] = [];
  /** Typing has moved highlights since this file's entries were last written. */
  private moved = false;

  constructor(
    readonly document: vscode.TextDocument,
    readonly store: HighlightStore,
    readonly filePath: string,
  ) {}

  /**
   * Rebuilds the highlights from highlight.json, finding each one in the
   * document's current text. Returns the highlights whose code is gone.
   */
  reset(): LiveHighlight[] {
    const records = this.store.getRecords(this.filePath);
    this.moved = false;
    if (!records.length) {
      this.highlights = [];
      return [];
    }
    const lines = this.lines();
    const matches = reconcile(records, lines);
    let changed = false;

    this.highlights = records.map((record, i) => {
      const match = matches[i];
      if (!match) {
        return {
          id: record.id, color: record.color, range: record.range, text: record.textSnapshot,
          lostAt: clampPosition(startOf(record.range), lines), saved: record,
        };
      }
      if (match.kind !== 'exact' || !rangesEqual(match.range, record.range)) {
        log.debug(`${this.filePath}: highlight ${record.id} found (${match.kind})`);
        changed = true;
      }
      return { id: record.id, color: record.color, range: match.range, text: snapshotOf(lines, match.range), saved: record };
    });

    if (changed) {
      // Only record new positions for text that is on disk; otherwise wait for the save.
      if (this.document.isDirty) this.moved = true;
      else this.write(lines);
    }
    return this.highlights.filter(h => h.lostAt);
  }

  /** Moves highlights through the edits of one change event. Returns true if any highlight changed. */
  applyEdits(contentChanges: readonly vscode.TextDocumentContentChangeEvent[]): boolean {
    if (!this.highlights.length || !contentChanges.length) return false;
    let changed = false;
    const edited = new Set<LiveHighlight>();
    const changes: TextChange[] = [];

    for (const c of contentChanges) {
      // Each change is expressed against the text left by the previous one.
      const change: TextChange = { range: fromVscodeRange(c.range), text: c.text };
      changes.push(change);
      for (const h of this.highlights) {
        if (h.lostAt) {
          h.lostAt = mapPosition(h.lostAt, change, 'before');
          continue;
        }
        const touchesLines = change.range.startLine <= h.range.endLine && change.range.endLine >= h.range.startLine;
        const next = transformRange(h.range, change);
        if (!next) {
          h.lostAt = mapPosition(startOf(h.range), change, 'before');
          changed = true;
          continue;
        }
        if (!rangesEqual(next, h.range)) {
          h.range = next;
          changed = true;
        }
        if (touchesLines) edited.add(h);
      }
    }

    for (const h of edited) if (!h.lostAt) h.text = this.textOfLines(h.range);
    if (this.highlights.some(h => h.lostAt) && this.restoreLost(changedLineSpans(changes))) changed = true;
    if (changed) this.moved = true;
    return changed;
  }

  /** The document was saved: record the positions that typing has moved. */
  onDidSave(): void {
    if (this.moved) this.write();
  }

  // ─── Queries ────────────────────────────────────────────────────────────

  /** The highlight at `pos` (inside it or on an edge), preferring one that contains it. */
  highlightAt(pos: Position): LiveHighlight | undefined {
    const touching = this.highlights.filter(h => !h.lostAt && rangeTouches(h.range, pos));
    return touching.find(h => rangeContains(h.range, pos)) ?? touching[0];
  }

  /** The highlight covering exactly `range` (after trimming line-break-only edges). */
  exactly(range: HighlightRange): LiveHighlight | undefined {
    const target = normalizeRange(range, this.lines());
    return target && this.highlights.find(h => !h.lostAt && rangesEqual(h.range, target));
  }

  /** True if a highlight overlaps `range`, or touches it when `range` is empty. */
  hasHighlightIn(range: HighlightRange): boolean {
    const empty = comparePositions(startOf(range), { line: range.endLine, char: range.endChar }) === 0;
    return this.highlights.some(h => !h.lostAt && (empty ? rangeTouches(h.range, startOf(range)) : rangesOverlap(h.range, range)));
  }

  // ─── Changes (each one writes highlight.json) ───────────────────────────

  /** Highlights each range in `color`, replacing any highlighting already there. Returns how many were applied. */
  paint(ranges: readonly HighlightRange[], color: HighlightColor): number {
    const lines = this.lines();
    let count = 0;
    for (const raw of ranges) {
      const range = normalizeRange(raw, lines);
      if (!range) continue;
      count++;
      const same = this.highlights.find(h => !h.lostAt && rangesEqual(h.range, range));
      if (same) {
        same.color = color;
        continue;
      }
      this.carve(range, lines);
      this.highlights.push({ id: randomUUID(), color, range, text: snapshotOf(lines, range) });
    }
    if (count) this.write(lines);
    return count;
  }

  /** Removes highlighting inside the ranges, trimming or splitting highlights that extend past them. */
  erase(ranges: readonly HighlightRange[]): number {
    const lines = this.lines();
    let count = 0;
    for (const raw of ranges) {
      const range = normalizeRange(raw, lines);
      if (range) count += this.carve(range, lines);
    }
    if (count) this.write(lines);
    return count;
  }

  remove(highlights: readonly LiveHighlight[]): void {
    const doomed = new Set(highlights);
    this.highlights = this.highlights.filter(h => !doomed.has(h));
    this.write();
  }

  /** Removes every highlight, lost ones included, and returns them (for undo). */
  removeAll(): LiveHighlight[] {
    const removed = this.highlights;
    if (removed.length) {
      this.highlights = [];
      this.write();
    }
    return removed;
  }

  /** Removes the lost highlights. Returns how many there were. */
  clearLost(): number {
    const lost = this.highlights.filter(h => h.lostAt);
    if (lost.length) this.remove(lost);
    return lost.length;
  }

  /** Puts back highlights removed earlier, finding them in the current text. Returns how many came back. */
  restore(removed: readonly LiveHighlight[]): number {
    const lines = this.lines();
    const candidates = removed.filter(h => !this.highlights.some(o => o.id === h.id));
    const matches = reconcile(candidates.map(h => this.toRecord(h, h.range, h.text)), lines);
    let count = 0;
    candidates.forEach((h, i) => {
      const match = matches[i];
      if (h.lostAt) {
        this.highlights.push({ ...h });
      } else if (match && !this.highlights.some(o => !o.lostAt && rangesOverlap(o.range, match.range))) {
        this.highlights.push({ ...h, range: match.range, text: snapshotOf(lines, match.range) });
      } else {
        return;
      }
      count++;
    });
    if (count) this.write(lines);
    return count;
  }

  /** Writes this file's highlights to highlight.json. */
  write(lines = this.lines()): void {
    if (this.store.problem) {
      log.warn(`Not saving highlights for ${this.filePath}: highlight.json ${this.store.problem}`);
      return;
    }
    // A highlight whose code vanished before it was ever saved has nothing worth keeping.
    this.highlights = this.highlights.filter(h => !h.lostAt || h.saved);
    const records = this.highlights.map(h => {
      if (h.lostAt) return { ...h.saved!, filePath: this.filePath };
      const record = this.toRecord(h, h.range, snapshotOf(lines, h.range), lines);
      h.saved = record;
      h.text = record.textSnapshot;
      return record;
    });
    this.store.setRecords(this.filePath, records);
    this.moved = false;
  }

  // ─── Helpers ────────────────────────────────────────────────────────────

  private lines(): string[] {
    return splitLines(this.document.getText());
  }

  private textOfLines(range: HighlightRange): string {
    const out: string[] = [];
    for (let line = range.startLine; line <= range.endLine && line < this.document.lineCount; line++) {
      out.push(this.document.lineAt(line).text);
    }
    return out.join('\n');
  }

  private toRecord(h: LiveHighlight, range: HighlightRange, textSnapshot: string, lines?: readonly string[]): HighlightRecord {
    return {
      id: h.id,
      filePath: this.filePath,
      color: h.color,
      range,
      textSnapshot,
      context: lines ? contextOf(lines, range) : h.saved?.context ?? { lineBefore: '', lineAfter: '' },
    };
  }

  /** Removes `cut` from every highlight it overlaps. Returns how many highlights were affected. */
  private carve(cut: HighlightRange, lines: readonly string[]): number {
    let affected = 0;
    const next: LiveHighlight[] = [];
    for (const h of this.highlights) {
      if (h.lostAt || !rangesOverlap(h.range, cut)) {
        next.push(h);
        continue;
      }
      affected++;
      const parts = subtractRange(h.range, cut)
        .map(part => normalizeRange(part, lines))
        .filter((part): part is HighlightRange => !!part);
      parts.forEach((part, k) => next.push(k === 0
        ? { ...h, range: part, text: snapshotOf(lines, part) }
        : { id: randomUUID(), color: h.color, range: part, text: snapshotOf(lines, part) }));
    }
    this.highlights = next;
    return affected;
  }

  /**
   * Brings back lost highlights whose exact code an edit (undo, paste,
   * reformatting) just put back. Only the lines around the edit are searched,
   * so this stays cheap while typing. Returns true if any came back.
   */
  private restoreLost(spans: Array<[number, number]>): boolean {
    const lost = this.highlights.filter(h => h.lostAt);
    const tallest = Math.max(...lost.map(h => h.range.endLine - h.range.startLine + 1));
    const first = Math.max(0, Math.min(...spans.map(s => s[0])) - tallest);
    const last = Math.min(this.document.lineCount - 1, Math.max(...spans.map(s => s[1])) + tallest);
    const lines: string[] = [];
    for (let line = first; line <= last; line++) lines.push(this.document.lineAt(line).text);
    const shift = (range: HighlightRange, by: number): HighlightRange =>
      ({ ...range, startLine: range.startLine + by, endLine: range.endLine + by });
    const within = spans.map(([a, b]) => [a - first, b - first] as const);

    let restored = false;
    // Try the text as it was just before it vanished, then as it was last saved.
    for (const pick of [(h: LiveHighlight) => h.text, (h: LiveHighlight) => h.saved?.textSnapshot]) {
      const candidates = this.highlights.filter(h => h.lostAt && pick(h) !== undefined);
      if (!candidates.length) break;
      const records = candidates.map(h => this.toRecord(h, shift(h.range, -first), pick(h)!));
      const matches = reconcile(records, lines, { within, fuzzy: false });
      candidates.forEach((h, i) => {
        const match = matches[i];
        if (!match) return;
        const range = shift(match.range, first);
        if (this.highlights.some(o => o !== h && !o.lostAt && rangesOverlap(o.range, range))) return;
        h.range = range;
        h.text = snapshotOf(lines, match.range);
        h.lostAt = undefined;
        restored = true;
      });
    }
    return restored;
  }
}

export function fromVscodeRange(range: vscode.Range): HighlightRange {
  return { startLine: range.start.line, startChar: range.start.character, endLine: range.end.line, endChar: range.end.character };
}
