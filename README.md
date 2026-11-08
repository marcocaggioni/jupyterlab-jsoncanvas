# jupyterlab-jsoncanvas

A viewer for [JSON Canvas](https://jsoncanvas.org/) (`.canvas`)
files in JupyterLab and JupyterLite, with in-place editing of text
cards.

Double-click a `.canvas` file and the board renders: text cards (Markdown),
file cards, link cards (clickable, with a live preview), group containers,
and edges with arrowheads — with pan, zoom, fit-to-view, a minimap, and
light / dark themes that follow JupyterLab. File cards pointing at `.md`
files render the file's Markdown inside the card. Double-click a text
card to edit it right on the board — the edit is written back into the
`.canvas` file — and saving is the standard Ctrl+S.

Rendering is done by the [Hesprs JSON Canvas Viewer](https://github.com/Hesprs/JSON-Canvas-Viewer)
(`json-canvas-viewer` on npm, MIT), which implements 100% of the JSON Canvas
1.0 spec. This extension only wires the library into JupyterLab: file-type
registration, the document widget, feeding the parsed `.canvas` JSON to the
viewer, theme following, and error handling.

## Live demo

A JupyterLite site with the extension installed, including the demo board:

- Site: https://marcocaggioni.github.io/jupyterlite-r2/
- Demo board: https://marcocaggioni.github.io/jupyterlite-r2/files/json-canvas-demo.canvas

Open the site, find `json-canvas-demo.canvas` in the file browser, and
double-click it.

## Features

- All four JSON Canvas node types: `text` (Markdown), `file`, `link`,
  `group` (labelled container).
- File nodes pointing at plain `.md` files render the file's Markdown
  inside the card, fetched through the JupyterLab contents API (so it
  works on every drive, R2 and local alike). A header shows the filename
  with an **Open** link; double-click the card to open the file itself.
  Other file types keep the bare filename label.
- Edit the `.canvas` JSON in the text editor and the board follows live
  — the viewer and the editor share the same document model, so no save
  is needed to see the change.
- Double-click a text card to edit it in place: type the card's Markdown
  right on the board, then click away or press Ctrl/Cmd+Enter to save
  (Esc cancels). The edit is written back into the `.canvas` file, so
  the JSON pane stays in sync. Markdown file cards stay read-only —
  double-click one to open the file itself instead.
- Edges with sides (`top` / `right` / `bottom` / `left`), ends
  (`none` / `arrow`), labels, and preset (`"1"`–`"6"`) or hex colors.
- Pan by dragging the background; zoom with the mouse wheel or the
  Controls (zoom in/out, slider, reset view); **Fit** frames the whole
  board; a Minimap tracks the viewport.
- Light / dark theme follows JupyterLab.
- Files that fail to parse, or are not JSON objects with `nodes` / `edges`
  arrays, are reported in the viewer instead of crashing it.
- Nodes cannot be dragged or resized in the viewer; deeper visual
  editing is a later step. The canvas file is written by card edits
  and by the standard save.

## Install

### JupyterLab

```bash
pip install git+https://github.com/marcocaggioni/jupyterlab-jsoncanvas.git
```

Then restart JupyterLab (or refresh the page). `.canvas` files open in the
viewer on double-click.

> **No PyPI release yet.** The package is only available from this repo for
> now; publishing to PyPI is a separate decision.

### JupyterLite

The extension is a standard prebuilt federated extension, so any JupyterLite
site can use it — see [docs/jupyterlite.md](docs/jupyterlite.md) for the
details. In short: add the package to your site's build (for example in
`requirements.txt`, `pip install git+https://github.com/marcocaggioni/jupyterlab-jsoncanvas.git`)
and rebuild the site; the extension is then bundled like any other
federated extension.

## Usage

Drop any `.canvas` file (JSON Canvas 1.0, as exported by Obsidian) into the
file browser and double-click it. That is all there is to it — there are no
settings. Text cards edit in place on double-click; everything else is
edited as JSON.

An example board is in [`example/`](example/): `json-canvas-demo.canvas`
exercises groups, text cards with Markdown, a link card, a Markdown file
card (`canvas-demo-note.md`), and labelled edges.
See [`example/README.md`](example/README.md) for what it shows.

## Known limitations

- **File nodes other than `.md` are not rendered as cards.** The library
  fetches file-node attachments relative to the page, so a referenced
  non-Markdown file shows as a bare label rather than a preview — the
  path is still shown on the card. Markdown files render since 0.3.0;
  images, audio, and video remain unrendered.
- **The fullscreen button does nothing inside JupyterLab.** The library's
  fullscreen control has no visible effect within the Lab layout; use the
  browser's fullscreen if needed.
- **First-load flakiness (observed once, cause not yet diagnosed).** After a
  fresh site deploy, the first double-click on a `.canvas` file opened the
  raw JSON in the text editor (the viewer did not appear in "Open With")
  until a full Lab reload, after which the viewer opened normally.

## Development

```bash
npm install
npm run build        # tsc + labextension build (dev)
```

To build the wheel:

```bash
jupyter labextension build --core-version 4.4.10 .
python -m build --wheel
```

(The `labextension/` output must exist before the wheel build; the hatch
hook skips the npm build when it is already there. The `--core-version`
flag works around a resolution failure for `@jupyterlab/core-meta` seen
in restricted-network environments.)

## Credits

- [JSON Canvas](https://jsoncanvas.org/) — the open file format for infinite
  canvas data, created by Obsidian.
- [Hesprs JSON Canvas Viewer](https://github.com/Hesprs/JSON-Canvas-Viewer) —
  the MIT-licensed viewer library this extension builds on.

## License

MIT — see [LICENSE](LICENSE).
