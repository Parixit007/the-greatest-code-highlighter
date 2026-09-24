# The Greatest Code Highlighter

A VS Code extension that highlights code blocks and stores them in a shareable JSON file. Yes, that's it. No AI. No blockchain. Just colors on your code.

![VS Code](https://img.shields.io/badge/VS%20Code-^1.80.0-blue)
![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue)
![License](https://img.shields.io/badge/license-MIT-green)

---

## What It Does

You select code. You press a shortcut. It gets colored. You can share that color data with your team. They open the same file, same colors appear. Revolutionary 💡.

More specifically:

- Highlight any code block in 6 colors: red, blue, green, pink, cyan, yellow
- Highlights stick to the code, character for character — type above it, beside it or inside it and the highlight follows. Delete the code and it gets marked as lost; undo and it comes right back.
- All highlight data lives in a `highlight.json` sidecar file next to your code. Commit it, share it, do whatever you want with it.
- Pull a teammate's `highlight.json` and their highlights show up. Nobody's highlights get overwritten.
- Works offline. No servers. No accounts. No telemetry. Nothing phoning home.

---

## Installation

1. Download the `.vsix` file from the [latest release](https://github.com/Parixit007/the-greatest-code-highlighter/releases/latest).
2. In VS Code, open the Extensions view, click the `...` menu at the top right and choose **Install from VSIX...**
3. Pick the file you downloaded. That's it, it's up and running.

Prefer the terminal? `code --install-extension the-greatest-code-highlighter-0.1.0.vsix`

---

## Usage

Open a folder first — highlights are saved to `highlight.json` in the root of each workspace folder.

### Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Cmd+Shift+H` / `Ctrl+Shift+H` | Cycle highlight color on selection |
| `Cmd+Shift+Alt+L` / `Ctrl+Shift+Alt+L` | Remove all highlights in current file |

### The Cycle

Press `Cmd+Shift+H` on a selection repeatedly:

```
red → remove → blue → remove → green → remove → pink → remove → cyan → remove → yellow → remove → repeat
```

Each press either applies the next color or removes the existing one. With no selection, it removes the highlight under the cursor. Simple.

### Right-Click Menu

Right-click in the editor for:

- **Highlight: Pick Color** — pick a color for the selection (only shown when you have a selection)
- **Highlight: Remove Selected** — remove the highlight under the cursor, or un-highlight just the selected part (only shown when there's a highlight there)
- **Highlight: Remove All in File** — nukes every highlight in the current file. Changed your mind? Hit **Undo** on the notification.

Everything works with multiple cursors, and highlighting over an existing highlight replaces that part instead of stacking colors.

### Your Own Shortcut per Color

**Highlight: Pick Color** takes a color name, so you can bind a key straight to one. In `keybindings.json`:

```json
{ "key": "cmd+alt+y", "command": "codeHighlighter.highlightSelection", "args": "yellow", "when": "editorTextFocus" }
```

---

## How Highlights Survive Edits

This is the part that actually required thought.

**While you type**, every edit moves the highlights with it:

- **Edit above or before a highlight** (even on the same line) → it shifts with its text
- **Edit inside a highlight** → it stretches or shrinks; text typed at its edges isn't added to it
- **Delete all of it** → it's marked as lost. Undo, or paste the code back somewhere, and the highlight returns

**When the file changed without VS Code watching** — edited in another program, `git pull`, switching branches — the extension finds each highlight again using a 4-step process:

- **Step A** — stored position still has the same text? Perfect, nothing to do.
- **Step B** — text moved up or down? Finds where it went (the nearest copy wins), even if it was re-indented.
- **Step C** — text was slightly modified? Finds the most similar nearby block, trusting it more when the lines around it still match.
- **Step D** — completely gone? Marks it as lost and tells you.

Lost highlights show a **⚠ lost highlight** label where the code used to be — hover it to see what was highlighted. Use **Highlight: Clear Orphans** from the command palette (or **Clear Now** on the warning) to clean them up. If the code comes back later (say, you switch back to the branch), so does the highlight.

Renaming or moving a file inside VS Code takes its highlights along.

---

## The `highlight.json` File

This is what gets saved:

```json
{
  "version": 1,
  "highlights": [
    {
      "id": "uuid-here",
      "filePath": "src/app.ts",
      "color": "yellow",
      "range": {
        "startLine": 45,
        "startChar": 0,
        "endLine": 50,
        "endChar": 15
      },
      "textSnapshot": "function calculateTotal() {\n  return a + b;\n}",
      "context": {
        "lineBefore": "// calculate the cart total",
        "lineAfter": "export default calculateTotal;"
      }
    }
  ]
}
```

Commit this file to share highlights with your team. They install the extension, open the repo, highlights appear. That's the whole sharing mechanism.

- Lines and characters are zero-based. `textSnapshot` is the full text of the highlighted lines, which is how highlights are found again after the code changes.
- Adding or removing a highlight writes the file right away. Positions that moved because you typed are written when you save the source file, so the file always describes code that's actually on disk.
- Entries are sorted and the format is stable, so diffs stay small.
- The file is reloaded whenever it changes on disk. Every write re-reads it first and only replaces the files you changed, so a teammate's highlights never get clobbered.
- If the file has git merge conflicts (or is otherwise broken), you get a warning and the extension won't touch it until it's fixed.

---

## Known Limitations

- Only files inside an open workspace folder can be highlighted.
- Renames done outside VS Code (terminal, `git mv`) aren't tracked — the highlights stay under the old path.
- Undo brings back a highlight that was deleted entirely, but not one that was only partly trimmed.
- No UI panel. Everything is keyboard shortcuts and right-click. This is a feature.

---

## Development

Requires Node.js 22 or newer.

```bash
npm install
npm run compile            # TypeScript → out/
npm run watch              # recompile on save
npm test                   # unit tests (no VS Code needed)
npm run test:integration   # end-to-end tests in a real VS Code window
npm run lint
npx @vscode/vsce package   # build the .vsix
```

Press `F5` in VS Code to launch an Extension Development Host with the extension loaded. Logs go to the **Code Highlighter** output channel (use **Developer: Set Log Level...** to see debug messages).

The integration tests use the VS Code installed on your machine; set `VSCODE_EXECUTABLE` to the VS Code binary if it isn't in the default location.

---

## Project Structure

```
src/
├── extension.ts         # Entry point
├── controller.ts        # Wires folders, open documents and editor events together
├── commands.ts          # Command handlers
├── documentSession.ts   # Live highlights of one open file: follows edits, saves
├── highlightStore.ts    # highlight.json of one folder: load, watch, merge, write
├── decorationManager.ts # Painting highlights in the editor
├── logger.ts            # Output channel logging
└── core/                # Plain TypeScript, no VS Code API — unit tested
    ├── ranges.ts        # Moving ranges through edits
    ├── reconciler.ts    # The A→D search
    ├── sidecar.ts       # Reading and writing highlight.json
    ├── text.ts          # Line and snapshot helpers
    ├── colors.ts        # The six colors
    └── types.ts         # Shared types
```

---

## Contributing

Open an issue. Or don't and just fix it yourself — `npm test` will tell you if you broke something.

---

## License

MIT. Do whatever you want.
