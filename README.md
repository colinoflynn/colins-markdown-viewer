# mdview

A fast local Markdown viewer for reading LLM output. One Python file serves a
browser UI; no packages to install.

## Run

```bash
python server.py D:\some\folder D:\another\folder
```

or, from the folder you want to browse:

```bash
D:\Dropbox\academic\claude_research\markdown-viewer\mdview.cmd
```

The server binds to `127.0.0.1` only and can only read, and in edit mode
write, files under the roots you pass. It opens Edge or Chrome in app mode (no browser chrome) if either is
installed; pass `--browser` for a normal tab, `--no-open` to just serve.
Default port is 8765, and the next free port is used if that one is taken.

Run `python vendor.py` once to download the rendering libraries into
`static/vendor` so everything works offline. Until then the UI falls back to
the CDN.

## Using it

- **Sidebar**: a lazy-loaded tree of every folder, showing only `.md` files
  (tick *show non-.md text files* to include `.txt`, `.json`, `.py` and so on).
  Above it, **Recently modified** lists the newest Markdown files across all
  roots, so whatever an LLM just wrote is one click away.
- **Click** a file to preview it in an italic tab that the next click reuses.
  **Double-click**, or press Alt+Enter, to keep it open. Ctrl+click or
  middle-click opens it to the side in a split pane.
- **Tabs** drag to reorder or to move between panes. Middle-click closes.
  Right-click for close others / close to the right / move to the side.
- **Windows**: the ⧉ button (or right-click → Open in new window) pops the
  file out into its own window that stays live.
- **Live reload**: open files are re-read within a second of changing on disk,
  keeping your scroll position. With *follow* ticked in the status bar, a file
  you have scrolled to the end of keeps auto-scrolling as it grows, which is
  what you want while an LLM is still writing it.
- **Outline** on the right tracks the current heading; click to jump.
- **Rendering**: GitHub-flavoured Markdown, code highlighting with a copy
  button, `$…$` / `$$…$$` math via KaTeX, ```mermaid diagrams, task lists,
  tables, footnote-free front matter, and `> [!NOTE]` style alerts. Relative
  links to other Markdown files open in the viewer; relative images work.
- **Tables** with long text (the kind LLMs produce for ledgers and matrices)
  get a small toolbar above them with four views and two toggles:
  *Table* gives the long column most of the width and keeps the header stuck
  to the top while you scroll; *Cards* turns each row into a card with the
  short columns as a meta line; *Rows* shows label / value pairs per row;
  *Collapse* trims long cells to three lines so you can scan the bold leads
  and click a row to expand it. Tables are not held to the reading column:
  one that needs more room grows past it, centred, up to the edges of the
  pane, and *Wide* forces the full pane width. Click a header to sort, type in the filter box to keep only matching
  rows. Choices persist per table. The *Long-text tables* setting picks the
  default view (Auto uses Cards for prose-heavy tables, Table otherwise).
  Rows that an LLM separated from their table with a blank line, and so lost
  their header, are re-attached automatically, and a stray unescaped `|` in a
  cell's prose is folded back into the cell instead of silently eating the
  columns after it.
- **Section mode** (§, Alt+S): shows one top-level section at a time with
  previous / next controls, so a long document reads like pages that break at
  the author's headings rather than at arbitrary screen heights. The outline
  still lists every heading and clicking one switches section. Alt+↑ / Alt+↓
  step through headings in either mode.
- **Reading position**: a thin progress bar across the top of each pane and a
  percentage in the status bar.
- **Edit mode** (✎, Alt+E): a plain textarea over the file for fixing small
  things. Ctrl+S saves, *Done* saves and returns to reading, Esc or *Cancel*
  discards (asking first if there are unsaved changes). The caret starts at
  the heading you were reading. Saving keeps the file's own line endings and
  BOM. If the file changed on disk while you were editing, saving does not
  overwrite it: the editor shows a diff of what changed on disk and lets you
  overwrite with your text or take the disk version instead. Only Markdown and the text types the viewer lists can
  be saved, and only under the roots you passed.
- **Settings** (⚙): theme (Light, Paper, Dark, Dim, or follow the OS; *System*
  and the ◐ toggle use whichever light and dark variants you picked last), font
  size, serif or sans, content width, line height, scroll or section reading,
  default table view. Content width is also in the toolbar. Widths scale with
  the font size: *Normal* is about 70 characters per line, the measure reading
  research favours; *Wide* is roughly the old default, and *Full* uses the
  whole pane. Space above headings grows a little with the width. Everything, including open tabs and scroll positions, persists in
  the browser per set of roots.

## Shortcuts

| Keys | Action |
| --- | --- |
| Ctrl+P | Quick open: fuzzy search every Markdown file |
| Ctrl+B | Toggle sidebar |
| Ctrl+Shift+O | Toggle outline |
| Ctrl+\ | Open the current file to the side |
| Alt+W | Close tab |
| Alt+[ / Alt+] | Previous / next tab |
| Alt+1 … Alt+9 | Jump to tab |
| Alt+Enter | Keep preview tab open |
| Alt+R | Toggle raw source |
| Alt+E | Edit the file (Ctrl+S save, Esc close) |
| Alt+↑ / Alt+↓ | Previous / next heading |
| Alt+PgUp / Alt+PgDn | Previous / next section (section mode) |
| Alt+S | Toggle section mode |
| Esc | Close popups |

## Files

- `server.py` — the whole backend (stdlib only)
- `static/index.html`, `static/app.js`, `static/style.css` — the UI
- `static/vendor/` — marked, DOMPurify, highlight.js, KaTeX, mermaid (via `vendor.py`)
- `samples/demo.md` — a test document that exercises every feature
