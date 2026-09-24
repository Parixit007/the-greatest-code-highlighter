// src/test/integration/extension.test.ts
//
// End-to-end tests that drive the extension inside a real VS Code window.
// Each test works on its own file; they share the workspace's highlight.json.

import * as assert from 'assert';
import * as vscode from 'vscode';
import { CodeHighlighterApi } from '../../controller';

export const tests: Array<{ name: string; fn: () => Promise<void> }> = [];
const test = (name: string, fn: () => Promise<void>) => tests.push({ name, fn });

// ─── Helpers ──────────────────────────────────────────────────────────────

let api: CodeHighlighterApi;
const root = () => vscode.workspace.workspaceFolders![0].uri;
const fileUri = (name: string) => vscode.Uri.joinPath(root(), name);
const sidecarUri = () => fileUri('highlight.json');

async function extension(): Promise<CodeHighlighterApi> {
  return api ??= await vscode.extensions.getExtension<CodeHighlighterApi>('parixit007.the-greatest-code-highlighter')!.activate();
}

async function writeFile(name: string, text: string): Promise<void> {
  await vscode.workspace.fs.writeFile(fileUri(name), Buffer.from(text, 'utf8'));
}

async function readSidecar(): Promise<{ highlights: Array<{ id: string; filePath: string; color: string; range: Range; textSnapshot: string }> }> {
  await api.flush();
  return JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(sidecarUri())).toString('utf8'));
}

async function sidecarFor(name: string) {
  return (await readSidecar()).highlights.filter(h => h.filePath === name);
}

async function open(name: string, text: string): Promise<vscode.TextEditor> {
  await writeFile(name, text);
  const editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(fileUri(name)));
  await waitFor(() => vscode.window.activeTextEditor === editor, 'editor to become active');
  return editor;
}

interface Range { startLine: number; startChar: number; endLine: number; endChar: number }
const r = (startLine: number, startChar: number, endLine: number, endChar: number): Range => ({ startLine, startChar, endLine, endChar });

function highlightsIn(editor: vscode.TextEditor) {
  return api.getHighlights(editor.document.uri);
}

function select(editor: vscode.TextEditor, ...ranges: Range[]): void {
  editor.selections = ranges.map(x => new vscode.Selection(x.startLine, x.startChar, x.endLine, x.endChar));
}

async function highlight(editor: vscode.TextEditor, range: Range, color = 'yellow'): Promise<void> {
  select(editor, range);
  await vscode.commands.executeCommand('codeHighlighter.highlightSelection', color);
}

async function waitFor<T>(check: () => T | Promise<T>, what: string, timeout = 8000): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

async function closeAll(): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
}

const sample = [
  'import { price } from "./shop";',
  'let total = foo(bar);',
  'console.log("checking out");',
  'export default total;',
].join('\n');

// ─── Tests ────────────────────────────────────────────────────────────────

test('Pick Color highlights the selection and writes highlight.json right away', async () => {
  await extension();
  const editor = await open('pick.ts', sample);
  await highlight(editor, r(1, 12, 1, 15), 'green');

  const [h] = highlightsIn(editor);
  assert.deepStrictEqual({ color: h.color, range: h.range, lost: h.lost }, { color: 'green', range: r(1, 12, 1, 15), lost: false });
  const [saved] = await sidecarFor('pick.ts');
  assert.strictEqual(saved.color, 'green');
  assert.strictEqual(saved.textSnapshot, 'let total = foo(bar);');
  await closeAll();
});

test('typing before a highlight on its own line keeps it on the same characters', async () => {
  const editor = await open('same-line.ts', sample);
  await highlight(editor, r(1, 12, 1, 15));
  await editor.edit(b => b.insert(new vscode.Position(1, 0), '    '));

  assert.deepStrictEqual(highlightsIn(editor)[0].range, r(1, 16, 1, 19));
  assert.strictEqual(editor.document.getText(new vscode.Range(1, 16, 1, 19)), 'foo');
  // Not written until the file is saved.
  assert.deepStrictEqual((await sidecarFor('same-line.ts'))[0].range, r(1, 12, 1, 15));
  await editor.document.save();
  assert.deepStrictEqual((await sidecarFor('same-line.ts'))[0].range, r(1, 16, 1, 19));
  await closeAll();
});

test('editing inside a highlight keeps it findable after switching tabs', async () => {
  const text = 'const a = 1;\n\nconst API_URL = "https://example.com";\n\nconst b = 2;';
  const editor = await open('inside.ts', text);
  await highlight(editor, r(2, 16, 2, 37));
  await editor.edit(b => b.insert(new vscode.Position(2, 27), '2'));
  await editor.document.save();

  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(fileUri('pick.ts')));
  await vscode.window.showTextDocument(editor.document);
  const [h] = highlightsIn(editor);
  assert.strictEqual(h.lost, false);
  assert.deepStrictEqual(h.range, r(2, 16, 2, 38));
  await closeAll();
});

test('deleting highlighted code marks it lost, and undo brings it back', async () => {
  const editor = await open('undo.ts', sample);
  await highlight(editor, r(2, 0, 2, 28));
  await editor.edit(b => b.delete(new vscode.Range(2, 0, 3, 0)));
  assert.strictEqual(highlightsIn(editor)[0].lost, true);

  await vscode.commands.executeCommand('undo');
  await waitFor(() => editor.document.lineAt(2).text === 'console.log("checking out");', 'undo');
  const [h] = highlightsIn(editor);
  assert.deepStrictEqual({ lost: h.lost, range: h.range }, { lost: false, range: r(2, 0, 2, 28) });
  await editor.document.save();
  await closeAll();
});

test('cutting a highlighted line and pasting it elsewhere moves the highlight with it', async () => {
  const editor = await open('cut-paste.ts', sample);
  await highlight(editor, r(1, 4, 1, 9), 'red');
  await editor.edit(b => b.delete(new vscode.Range(1, 0, 2, 0)));
  assert.strictEqual(highlightsIn(editor)[0].lost, true);
  await editor.edit(b => b.insert(new vscode.Position(2, 21), '\nlet total = foo(bar);'));

  const [h] = highlightsIn(editor);
  assert.deepStrictEqual({ lost: h.lost, range: h.range }, { lost: false, range: r(3, 4, 3, 9) });
  await editor.document.save();
  await closeAll();
});

test('Cycle Color goes red → remove → blue on the same selection', async () => {
  const editor = await open('cycle.ts', sample);
  select(editor, r(0, 9, 0, 14));
  const colors = [];
  for (let i = 0; i < 3; i++) {
    await vscode.commands.executeCommand('codeHighlighter.cycleHighlight');
    colors.push(highlightsIn(editor).map(h => h.color).join(',') || 'none');
  }
  assert.deepStrictEqual(colors, ['red', 'none', 'blue']);
  await closeAll();
});

test('painting over part of a highlight replaces that part instead of overlapping', async () => {
  const editor = await open('overlap.ts', sample);
  await highlight(editor, r(1, 0, 1, 21), 'red');
  await highlight(editor, r(1, 4, 1, 9), 'blue');

  const parts = highlightsIn(editor).map(h => `${h.color}:${h.range.startChar}-${h.range.endChar}`).sort();
  assert.deepStrictEqual(parts, ['blue:4-9', 'red:0-4', 'red:9-21']);
  await closeAll();
});

test('Remove Selected splits a highlight around the selection', async () => {
  const editor = await open('split.ts', sample);
  await highlight(editor, r(1, 0, 1, 21), 'pink');
  select(editor, r(1, 4, 1, 9));
  await vscode.commands.executeCommand('codeHighlighter.removeSelected');

  const parts = highlightsIn(editor).map(h => `${h.range.startChar}-${h.range.endChar}`).sort();
  assert.deepStrictEqual(parts, ['0-4', '9-21']);
  assert.strictEqual((await sidecarFor('split.ts')).length, 2);
  await closeAll();
});

test('multiple cursors highlight every selection', async () => {
  const editor = await open('multi.ts', sample);
  select(editor, r(0, 0, 0, 6), r(3, 0, 3, 6));
  await vscode.commands.executeCommand('codeHighlighter.highlightSelection', 'cyan');
  assert.deepStrictEqual(highlightsIn(editor).map(h => h.range.startLine).sort(), [0, 3]);
  await closeAll();
});

test('File: Revert throws away moved positions and re-finds the highlights', async () => {
  const editor = await open('revert.ts', sample);
  await highlight(editor, r(3, 0, 3, 6));
  await editor.edit(b => b.insert(new vscode.Position(0, 0), '// one\n// two\n'));
  assert.strictEqual(highlightsIn(editor)[0].range.startLine, 5);

  await vscode.commands.executeCommand('workbench.action.files.revert');
  await waitFor(() => highlightsIn(editor)[0]?.range.startLine === 3, 'highlight back on line 3');
  await closeAll();
});

test('a file changed on disk while open (git checkout) has its highlights re-found', async () => {
  const editor = await open('checkout.ts', sample);
  await highlight(editor, r(3, 0, 3, 6));
  await writeFile('checkout.ts', '// added by git\n// another line\n' + sample);

  await waitFor(() => highlightsIn(editor)[0]?.range.startLine === 5, 'highlight to follow the reloaded text');
  await waitFor(async () => (await sidecarFor('checkout.ts'))[0]?.range.startLine === 5, 'highlight.json to be updated');
  await closeAll();
});

test('highlight.json changed on disk is reloaded, and later writes keep those changes', async () => {
  const editor = await open('pulled.ts', sample);
  const before = await readSidecar();
  const teammate = {
    id: 'from-a-teammate', filePath: 'pulled.ts', color: 'blue', range: r(0, 0, 0, 6),
    textSnapshot: 'import { price } from "./shop";', context: { lineBefore: '', lineAfter: 'let total = foo(bar);' },
  };
  await vscode.workspace.fs.writeFile(sidecarUri(), Buffer.from(JSON.stringify({ version: 1, highlights: [...before.highlights, teammate] }, null, 2)));
  await waitFor(() => highlightsIn(editor).some(h => h.id === 'from-a-teammate'), 'teammate highlight to appear');

  const other = await open('local-change.ts', sample);
  await highlight(other, r(1, 0, 1, 3));
  const ids = (await readSidecar()).highlights.map(h => h.id);
  assert.ok(ids.includes('from-a-teammate'), 'teammate highlight survived a local write');
  await closeAll();
});

test('a highlight.json with merge conflicts is never overwritten', async () => {
  const good = Buffer.from(await vscode.workspace.fs.readFile(sidecarUri())).toString('utf8');
  const conflicted = `<<<<<<< HEAD\n${good}=======\n{}\n>>>>>>> theirs\n`;
  await api.flush();
  await vscode.workspace.fs.writeFile(sidecarUri(), Buffer.from(conflicted));

  const editor = await open('conflict.ts', sample);
  await new Promise(resolve => setTimeout(resolve, 400));
  await highlight(editor, r(1, 0, 1, 3));
  await api.flush();
  assert.strictEqual(Buffer.from(await vscode.workspace.fs.readFile(sidecarUri())).toString('utf8'), conflicted);
  assert.strictEqual(highlightsIn(editor).length, 0, 'no highlight was added while the file was broken');

  // Once the conflict is resolved, highlighting works again.
  await vscode.workspace.fs.writeFile(sidecarUri(), Buffer.from(good));
  await waitFor(async () => {
    await highlight(editor, r(1, 0, 1, 3));
    return (await sidecarFor('conflict.ts')).length === 1;
  }, 'highlighting to work again after the fix');
  await closeAll();
});

test('renaming a file takes its highlights along', async () => {
  const editor = await open('old-name.ts', sample);
  await highlight(editor, r(1, 0, 1, 3), 'pink');
  await editor.document.save();
  await closeAll();

  const edit = new vscode.WorkspaceEdit();
  edit.renameFile(fileUri('old-name.ts'), fileUri('new-name.ts'));
  assert.ok(await vscode.workspace.applyEdit(edit));
  await waitFor(async () => (await sidecarFor('new-name.ts')).length === 1, 'highlight to move to new-name.ts');
  assert.strictEqual((await sidecarFor('old-name.ts')).length, 0);

  const renamed = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(fileUri('new-name.ts')));
  assert.strictEqual(highlightsIn(renamed)[0]?.color, 'pink');
  await closeAll();
});

test('changing the language of a file keeps its highlights and pending moves', async () => {
  const editor = await open('language.ts', sample);
  await highlight(editor, r(3, 0, 3, 6));
  await editor.edit(b => b.insert(new vscode.Position(0, 0), '\n'));
  await vscode.languages.setTextDocumentLanguage(editor.document, 'plaintext');
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.strictEqual(highlightsIn(editor)[0]?.range.startLine, 4);
  await editor.document.save();
  assert.strictEqual((await sidecarFor('language.ts'))[0].range.startLine, 4);
  await closeAll();
});

test('Remove All in File clears the file, lost highlights included', async () => {
  const editor = await open('remove-all.ts', sample);
  await highlight(editor, r(0, 0, 0, 6));
  await highlight(editor, r(2, 0, 2, 7), 'red');
  await editor.edit(b => b.delete(new vscode.Range(2, 0, 3, 0)));
  assert.deepStrictEqual(highlightsIn(editor).map(h => h.lost).sort(), [false, true]);

  await vscode.commands.executeCommand('codeHighlighter.removeAll');
  assert.strictEqual(highlightsIn(editor).length, 0);
  assert.strictEqual((await sidecarFor('remove-all.ts')).length, 0);
  await editor.document.save();
  await closeAll();
});
