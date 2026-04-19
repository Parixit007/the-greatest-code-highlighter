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
- Highlights survive file edits — if you add lines above a highlight, it moves down. If you edit inside it, it stretches. If you delete it entirely, it gets marked as lost.
- All highlight data lives in a `highlight.json` sidecar file next to your code. Commit it, share it, do whatever you want with it.
- Works offline. No servers. No accounts. No telemetry. Nothing phoning home.

---

## Installation

Clone the repo and run:

```bash
npm install
npx tsc
```

Then hit `F5` in VS Code to launch the Extension Development Host. Or package it properly with `vsce` if you know what you're doing.

---

## Usage

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

Each press either applies the next color or removes the existing one. Simple.

### Right-Click Menu

Right-click in the editor for:

- **Highlight: Pick Color** — opens a dropdown to directly pick a color (only visible when you have a selection)
- **Highlight: Remove All** — nukes every highlight in the current file

---

## How Highlights Survive Edits

This is the part that actually required thought.

When you edit a file, highlights don't just sit at fixed line numbers and break. The extension tracks changes in real time:

- **Edit above a highlight** → the whole highlight shifts down/up by the number of lines added/removed
- **Edit inside a highlight** → the highlight stretches or shrinks to match, and the stored snapshot updates
- **Close and reopen the file** → the extension reconciles stored positions against actual file content using a 4-step process:

  - **Step A** — stored coordinates still point to the right text? Perfect, nothing to do.
  - **Step B** — text moved up or down? Searches ±500 lines to find where it went.
  - **Step C** — text was slightly modified? Finds it using the surrounding lines as context.
  - **Step D** — completely gone? Marks it as orphaned and tells you.

Orphaned highlights show up with a strikethrough. Use **Highlight: Clear Orphans** from the command palette to clean them up.

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

---

## Known Limitations

- One color per line. Overlapping highlights on the same line don't fully work yet.
- Fuzzy matching (Levenshtein distance) is planned but not implemented — Step B/C use exact text matching for now.
- No UI panel. Everything is keyboard shortcuts and right-click. This is a feature.

---

## Project Structure

```
src/
├── extension.ts        # Entry point
├── highlightManager.ts # Load/save/CRUD on highlight data
├── reconciler.ts       # The A→D reconciliation logic
├── shadowTracker.ts    # Real-time edit delta tracking
├── decorationManager.ts# VS Code decoration types and painting
├── contextMenu.ts      # Command registration and handlers
└── types.ts            # Shared TypeScript interfaces
```

---

## Contributing

Open an issue. Or don't and just fix it yourself — the codebase is 7 files.

---

## License

MIT. Do whatever you want.