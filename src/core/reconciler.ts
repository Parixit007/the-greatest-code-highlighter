// src/core/reconciler.ts
//
// Finds stored highlights again in a document whose text may have changed
// since highlight.json was written: edited in another program, switched by
// git, pulled from a teammate, or changed while VS Code wasn't watching.

import { HighlightRange, HighlightRecord } from './types';
import { normalizeRange, normalizeWhitespace } from './text';

/** How far (in lines) from its stored position a changed highlight is looked for. */
const SEARCH_RADIUS = 500;
/** How far small changed snippets are compared line by line when nothing else points to them. */
const BLIND_RADIUS = 100;
/** How many lines a changed highlight may have grown or shrunk by. */
const SIZE_TOLERANCE = 5;
/** Changed snippets shorter than this (ignoring whitespace) are too ambiguous to match fuzzily. */
const MIN_FUZZY_LENGTH = 10;
/** Snapshot lines shorter than this ("}", "") are too common to line a search up on. */
const MIN_ANCHOR_LENGTH = 8;

export type MatchKind = 'exact' | 'moved' | 'reindented' | 'fuzzy';

export interface Match {
  range: HighlightRange;
  kind: MatchKind;
}

export interface ReconcileOptions {
  /** Only accept matches that overlap one of these inclusive line spans. */
  within?: ReadonlyArray<readonly [number, number]>;
  /** Set to false to skip step C and only accept exact (or whitespace-only) matches. */
  fuzzy?: boolean;
}

/**
 * Finds each record in `lines` (the document's current text). Returns one entry
 * per record, in order: where it is now, or undefined if its code is gone.
 *
 *   A  exact       the snapshot is still at the stored lines
 *   B  moved       the snapshot appears elsewhere, unchanged (nearest wins)
 *   B' reindented  same, ignoring changes in whitespace
 *   C  fuzzy       a nearby block is similar enough; blocks sitting between the
 *                  old neighbouring lines need less similarity
 *   D  lost        none of the above
 */
export function reconcile(
  records: readonly HighlightRecord[],
  lines: readonly string[],
  options: ReconcileOptions = {},
): Array<Match | undefined> {
  const doc = new DocumentIndex(lines);
  const within = options.within;
  const allowed = (start: number, end: number) => !within || within.some(([a, b]) => start <= b && end >= a);

  // Two highlights with the same text must not both land on the same lines,
  // unless they shared those lines to begin with (e.g. two words on one line).
  const claims = new Map<string, number>();
  const claimKey = (start: number, record: HighlightRecord) => `${start}\u0000${record.textSnapshot}`;
  const claim = (start: number, record: HighlightRecord) => {
    if (!claims.has(claimKey(start, record))) claims.set(claimKey(start, record), record.range.startLine);
  };
  const claimable = (start: number, record: HighlightRecord) => {
    const owner = claims.get(claimKey(start, record));
    return owner === undefined || owner === record.range.startLine;
  };

  const snapshots = records.map(r => r.textSnapshot.split('\n'));
  const results: Array<Match | undefined> = records.map(() => undefined);
  const settle = (i: number, start: number, range: HighlightRange | undefined, kind: MatchKind) => {
    if (!range) return;
    results[i] = { range, kind };
    claim(start, records[i]);
  };

  // A first, so highlights that didn't move claim their lines before moved ones search.
  records.forEach((record, i) => {
    const snap = snapshots[i];
    const start = record.range.startLine;
    const end = start + snap.length - 1;
    if (record.range.endLine === end && allowed(start, end) && doc.matches(start, snap, false)) {
      settle(i, start, keepColumns(record, start, snap, lines), 'exact');
    }
  });

  for (const ignoreSpace of [false, true]) {
    records.forEach((record, i) => {
      if (results[i]) return;
      const snap = snapshots[i];
      const start = doc.findBlock(snap, record.range.startLine, ignoreSpace,
        s => allowed(s, s + snap.length - 1) && claimable(s, record));
      if (start === undefined) return;
      settle(i, start, ignoreSpace
        ? mapColumns(record, snap, start, start + snap.length - 1, lines)
        : keepColumns(record, start, snap, lines),
        ignoreSpace ? 'reindented' : 'moved');
    });
  }

  if (options.fuzzy === false) return results;
  records.forEach((record, i) => {
    if (results[i]) return;
    const block = findSimilarBlock(record, snapshots[i], doc, allowed);
    if (block) settle(i, block.start, mapColumns(record, snapshots[i], block.start, block.end, lines), 'fuzzy');
  });

  return results;
}

// ─── Column mapping ─────────────────────────────────────────────────────────

function keepColumns(record: HighlightRecord, start: number, snap: readonly string[], lines: readonly string[]) {
  const end = start + snap.length - 1;
  return normalizeRange({ startLine: start, startChar: record.range.startChar, endLine: end, endChar: record.range.endChar }, lines)
    ?? wholeLines(start, end, lines);
}

function mapColumns(record: HighlightRecord, snap: readonly string[], start: number, end: number, lines: readonly string[]) {
  const startChar = mapColumn(snap[0], record.range.startChar, lines[start], 'start');
  const endChar = mapColumn(snap[snap.length - 1], record.range.endChar, lines[end], 'end');
  return normalizeRange({ startLine: start, startChar, endLine: end, endChar }, lines)
    ?? wholeLines(start, end, lines);
}

/** The text of lines start..end, from the first non-blank character to the end. */
function wholeLines(start: number, end: number, lines: readonly string[]): HighlightRange | undefined {
  const indent = lines[start].length - lines[start].trimStart().length;
  return normalizeRange({ startLine: start, startChar: indent, endLine: end, endChar: lines[end].length }, lines);
}

/**
 * Carries a column from a line's old text over to its new text. Line starts and
 * ends stay put. If only whitespace changed, the column follows the same
 * non-whitespace character; otherwise it keeps its distance from the indentation.
 */
function mapColumn(oldLine: string, oldChar: number, newLine: string, edge: 'start' | 'end'): number {
  if (oldChar <= 0) return 0;
  if (oldChar >= oldLine.length) return newLine.length;

  if (normalizeWhitespace(oldLine) === normalizeWhitespace(newLine)) {
    let count = 0;
    for (let c = 0; c < oldChar; c++) if (!isSpace(oldLine[c])) count++;
    let j = 0;
    for (let seen = 0; j < newLine.length && seen < count; j++) if (!isSpace(newLine[j])) seen++;
    if (edge === 'start' && !isSpace(oldLine[oldChar])) while (j < newLine.length && isSpace(newLine[j])) j++;
    return j;
  }

  const oldIndent = oldLine.length - oldLine.trimStart().length;
  const newIndent = newLine.length - newLine.trimStart().length;
  if (oldChar <= oldIndent) return Math.min(oldChar, newIndent);
  return Math.min(newLine.length, oldChar - oldIndent + newIndent);
}

function isSpace(ch: string): boolean {
  return /\s/.test(ch);
}

// ─── Fuzzy matching ─────────────────────────────────────────────────────────

/** Similarity a changed block needs, given how many of its old neighbouring lines still surround it. */
function requiredSimilarity(textLength: number, neighbours: number): number {
  const base = neighbours === 2 ? 0.6 : neighbours === 1 ? 0.7 : 0.8;
  // Short snippets resemble each other more easily, so ask for more.
  return textLength < 40 ? base + 0.1 : base;
}

function findSimilarBlock(
  record: HighlightRecord,
  snap: readonly string[],
  doc: DocumentIndex,
  allowed: (start: number, end: number) => boolean,
): { start: number; end: number } | undefined {
  const normSnap = snap.map(normalizeWhitespace);
  const target = normSnap.join('\n');
  if (target.replace(/\s/g, '').length < MIN_FUZZY_LENGTH) return undefined;
  const targetGrams = bigrams(target);

  const n = doc.lines.length;
  const k = snap.length;
  const anchor = record.range.startLine;
  const lo = Math.max(0, anchor - SEARCH_RADIUS);
  const hi = Math.min(n - 1, anchor + k - 1 + SEARCH_RADIUS);
  const { lineBefore, lineAfter } = record.context;

  const candidates = new Map<string, [number, number]>();
  const add = (start: number, end: number) => {
    const size = end - start + 1;
    if (start < lo || end > hi || size < Math.max(1, k - SIZE_TOLERANCE) || size > k + SIZE_TOLERANCE) return;
    candidates.set(`${start}:${end}`, [start, end]);
  };

  // Blocks sitting between lines that match the old neighbours.
  if (lineBefore) {
    for (const q of doc.trimmedOccurrences(lineBefore)) {
      if (!lineAfter) { add(q + 1, q + k); continue; }
      for (let r = q + 2; r <= Math.min(n - 1, q + 1 + k + SIZE_TOLERANCE); r++) {
        if (doc.trimmed(r) === lineAfter) add(q + 1, r - 1);
      }
    }
  } else if (lineAfter) {
    for (const r of doc.trimmedOccurrences(lineAfter)) add(r - k, r - 1);
  }

  // Blocks lined up on a distinctive snapshot line that still exists unchanged.
  const sizes = [k, k - 1, k + 1].filter(size => size >= 1);
  normSnap.forEach((text, p) => {
    if (text.length < MIN_ANCHOR_LENGTH) return;
    for (const q of doc.occurrences(text, true)) {
      for (const size of sizes) add(q - p, q - p + size - 1);
    }
  });

  // Small snippets are cheap enough to compare against every window close by.
  if (k <= 3) {
    const last = Math.min(hi, anchor + BLIND_RADIUS);
    for (let start = Math.max(lo, anchor - BLIND_RADIUS); start <= last; start++) {
      for (const size of sizes) add(start, start + size - 1);
    }
  }

  const normalized = doc.normalized();
  let best: { start: number; end: number; score: number; distance: number } | undefined;
  for (const [start, end] of candidates.values()) {
    if (!allowed(start, end)) continue;
    const neighbours =
      (lineBefore && start > 0 && doc.trimmed(start - 1) === lineBefore ? 1 : 0) +
      (lineAfter && end < n - 1 && doc.trimmed(end + 1) === lineAfter ? 1 : 0);
    const required = requiredSimilarity(target.length, neighbours);
    const text = normalized.slice(start, end + 1).join('\n');
    // Texts of very different lengths can't be similar enough; skip the full comparison.
    const textGrams = Math.max(0, text.length - 1);
    if ((2 * Math.min(targetGrams.total, textGrams)) / (targetGrams.total + textGrams || 1) < required) continue;
    const similarity = dice(targetGrams, text);
    if (similarity < required) continue;
    const score = similarity + 0.1 * neighbours;
    const distance = Math.abs(start - anchor);
    if (!best || score > best.score + 1e-9 || (score > best.score - 1e-9 && distance < best.distance)) {
      best = { start, end, score, distance };
    }
  }
  return best && { start: best.start, end: best.end };
}

interface Bigrams {
  counts: Map<string, number>;
  total: number;
}

function bigrams(text: string): Bigrams {
  const counts = new Map<string, number>();
  for (let i = 0; i < text.length - 1; i++) {
    const gram = text.slice(i, i + 2);
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  return { counts, total: Math.max(0, text.length - 1) };
}

/** Sørensen–Dice similarity of `text` to the target, from 0 (nothing shared) to 1 (identical). */
function dice(target: Bigrams, text: string): number {
  const other = bigrams(text);
  let common = 0;
  for (const [gram, count] of other.counts) common += Math.min(count, target.counts.get(gram) ?? 0);
  const total = target.total + other.total;
  return total === 0 ? 0 : (2 * common) / total;
}

// ─── Document index ─────────────────────────────────────────────────────────

/** Lazily built lookups over a document's lines. */
class DocumentIndex {
  private normalizedLines?: string[];
  private trimmedLines?: string[];
  private readonly indexes = new Map<string, Map<string, number[]>>();

  constructor(readonly lines: readonly string[]) {}

  normalized(): string[] {
    return this.normalizedLines ??= this.lines.map(normalizeWhitespace);
  }

  trimmed(i: number): string {
    return (this.trimmedLines ??= this.lines.map(line => line.trim()))[i];
  }

  /** Line numbers whose text (or whitespace-normalized text) equals `text`. */
  occurrences(text: string, ignoreSpace: boolean): readonly number[] {
    return this.index(ignoreSpace ? 'normalized' : 'exact', () => ignoreSpace ? this.normalized() : this.lines).get(text) ?? [];
  }

  trimmedOccurrences(text: string): readonly number[] {
    return this.index('trimmed', () => this.lines.map((_, i) => this.trimmed(i))).get(text) ?? [];
  }

  matches(start: number, snap: readonly string[], ignoreSpace: boolean): boolean {
    if (start < 0 || start + snap.length > this.lines.length) return false;
    const source = ignoreSpace ? this.normalized() : this.lines;
    return snap.every((text, k) => source[start + k] === text);
  }

  /** Start of the block equal to `snap` that is nearest to `anchor` and passes `accept`. */
  findBlock(snap: readonly string[], anchor: number, ignoreSpace: boolean, accept: (start: number) => boolean): number | undefined {
    const target = ignoreSpace ? snap.map(normalizeWhitespace) : snap;
    // Look the block up by its longest line instead of scanning every line.
    let key = 0;
    for (let k = 1; k < target.length; k++) if (target[k].length > target[key].length) key = k;
    if (ignoreSpace && target[key] === '') return undefined;

    let best: number | undefined;
    for (const line of this.occurrences(target[key], ignoreSpace)) {
      const start = line - key;
      if (best !== undefined && Math.abs(start - anchor) >= Math.abs(best - anchor)) continue;
      if (this.matches(start, target, ignoreSpace) && accept(start)) best = start;
    }
    return best;
  }

  private index(name: string, source: () => readonly string[]): Map<string, number[]> {
    let index = this.indexes.get(name);
    if (!index) {
      index = new Map();
      source().forEach((text, i) => {
        const list = index!.get(text);
        if (list) list.push(i); else index!.set(text, [i]);
      });
      this.indexes.set(name, index);
    }
    return index;
  }
}
