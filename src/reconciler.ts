// src/reconciler.ts

import { Highlight, HighlightRange } from './types';
import { HighlightManager } from './highlightManager';
import { log } from './logger';

const SEARCH_RADIUS      = 500;
const CONTEXT_TOLERANCE  = 5;

export class Reconciler {
  constructor(private manager: HighlightManager) {}

  reconcileFile(filePath: string, documentText: string): number {
    log.separator('RECONCILE');
    log.info('Reconciler', `Reconciling file`, { filePath });

    const highlights = this.manager.getForFile(filePath);
    if (highlights.length === 0) {
      log.info('Reconciler', 'No highlights for this file — skipping');
      return 0;
    }

    const lines       = documentText.split('\n');
    let orphanCount   = 0;

    for (const h of highlights) {
      if (h.orphaned) {
        log.debug('Reconciler', `Skipping already-orphaned highlight`, { id: h.id });
        continue;
      }

      log.debug('Reconciler', `Reconciling highlight`, { id: h.id, color: h.color, range: h.range });
      const result = this.reconcileOne(h, lines);

      if (result === null) {
        log.warn('Reconciler', `Step D: highlight is ORPHANED`, { id: h.id, range: h.range });
        this.manager.markOrphaned(h.id);
        orphanCount++;
      } else if (
        result.startLine !== h.range.startLine ||
        result.startChar !== h.range.startChar ||
        result.endLine   !== h.range.endLine   ||
        result.endChar   !== h.range.endChar
      ) {
        log.info('Reconciler', `Range updated during reconciliation`, { id: h.id, oldRange: h.range, newRange: result });
        this.manager.updateRange(h.id, result);
      } else {
        log.debug('Reconciler', `Step A: exact match — no change needed`, { id: h.id });
      }
    }

    log.info('Reconciler', `Reconciliation complete`, { total: highlights.length, orphaned: orphanCount });
    return orphanCount;
  }

  private reconcileOne(h: Highlight, lines: string[]): HighlightRange | null {
    const stepA = this.stepA(h, lines);
    if (stepA) { log.debug('Reconciler', `Step A passed`, { id: h.id }); return stepA; }

    const stepB = this.stepB(h, lines);
    if (stepB) { log.debug('Reconciler', `Step B passed`, { id: h.id, newRange: stepB }); return stepB; }

    const stepC = this.stepC(h, lines);
    if (stepC) { log.debug('Reconciler', `Step C passed`, { id: h.id, newRange: stepC }); return stepC; }

    return null;
  }

  private stepA(h: Highlight, lines: string[]): HighlightRange | null {
    const { startLine, endLine } = h.range;
    if (startLine >= lines.length || endLine >= lines.length) {
      log.debug('Reconciler', `Step A: range out of bounds`, { startLine, endLine, fileLines: lines.length });
      return null;
    }
    const textAtRange = lines.slice(startLine, endLine + 1).join('\n');
    if (textAtRange === h.textSnapshot) return h.range;
    log.debug('Reconciler', `Step A: snapshot mismatch`, {
      expected: h.textSnapshot.slice(0, 80),
      got: textAtRange.slice(0, 80),
    });
    return null;
  }

  private stepB(h: Highlight, lines: string[]): HighlightRange | null {
    const snapshotLines = h.textSnapshot.split('\n');
    const blockHeight   = snapshotLines.length;
    const anchor        = h.range.startLine;
    const searchStart   = Math.max(0, anchor - SEARCH_RADIUS);
    const searchEnd     = Math.min(lines.length - blockHeight, anchor + SEARCH_RADIUS);

    log.debug('Reconciler', `Step B: searching ±${SEARCH_RADIUS} lines from anchor ${anchor}`);
    const offsets = this.expandingOffsets(anchor, searchStart, searchEnd);

    for (const startLine of offsets) {
      const candidate = lines.slice(startLine, startLine + blockHeight).join('\n');
      if (candidate === h.textSnapshot) {
        log.info('Reconciler', `Step B: found drifted highlight`, { id: h.id, originalLine: anchor, foundAt: startLine });
        return {
          startLine,
          startChar: h.range.startChar,
          endLine:   startLine + blockHeight - 1,
          endChar:   h.range.endChar,
        };
      }
    }

    log.debug('Reconciler', `Step B: no drift match found`);
    return null;
  }

  private stepC(h: Highlight, lines: string[]): HighlightRange | null {
    const { lineBefore, lineAfter } = h.context;
    if (!lineBefore && !lineAfter) {
      log.debug('Reconciler', `Step C: no context lines available — skipping`);
      return null;
    }

    log.debug('Reconciler', `Step C: searching by context`, { lineBefore, lineAfter });
    const snapshotLineCount = h.textSnapshot.split('\n').length;

    for (let i = 0; i < lines.length; i++) {
      const beforeMatch = lineBefore ? lines[i].trim() === lineBefore : true;
      if (!beforeMatch) continue;

      const windowEnd = Math.min(lines.length - 1, i + snapshotLineCount + CONTEXT_TOLERANCE);

      for (let j = i + 1; j <= windowEnd; j++) {
        const afterMatch = lineAfter ? lines[j].trim() === lineAfter : true;
        if (!afterMatch) continue;

        const newStartLine = i + 1;
        const newEndLine   = j - 1;
        if (newStartLine > newEndLine) continue;

        log.info('Reconciler', `Step C: found via context`, { id: h.id, newStartLine, newEndLine });
        return {
          startLine: newStartLine, startChar: h.range.startChar,
          endLine:   newEndLine,   endChar:   h.range.endChar,
        };
      }
    }

    log.debug('Reconciler', `Step C: no context match found`);
    return null;
  }

  private expandingOffsets(anchor: number, min: number, max: number): number[] {
    const result  : number[]     = [];
    const visited : Set<number>  = new Set();
    const push = (n: number) => {
      if (n >= min && n <= max && !visited.has(n)) { visited.add(n); result.push(n); }
    };
    push(anchor);
    for (let delta = 1; delta <= SEARCH_RADIUS; delta++) {
      push(anchor + delta);
      push(anchor - delta);
      if (result.length > max - min + 1) break;
    }
    return result;
  }
}