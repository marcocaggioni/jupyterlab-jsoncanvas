# Changelog

## 0.2.0 — 2026-11-07

- The renderer is now the [Hesprs JSON Canvas Viewer](https://github.com/Hesprs/JSON-Canvas-Viewer)
  (`json-canvas-viewer` 4.3.2, MIT), which implements 100% of the JSON Canvas 1.0 spec.
  The extension only wires the library into JupyterLab: file-type registration, the
  document widget, feeding the parsed `.canvas` JSON to the viewer, theme following,
  and error handling.
- The library's own **Controls** (zoom in/out, slider, fullscreen, reset view) and
  **Minimap** modules provide the viewer chrome; the hand-rolled toolbar is gone.
- Theme follows JupyterLab's light / dark mode.
- The board is fit to view on first load.
- The demo board was re-laid out (bigger link card, roomier text cards, clear edge
  corridors) and the file node was removed, since file nodes are not rendered as
  cards by the library.
- Dropped the now-unused `@jupyterlab/rendermime` dependencies.

## 0.1.0 — 2026-11-07

- Initial release: read-only viewer for `.canvas` files with a from-scratch
  SVG/DOM renderer. Superseded by 0.2.0 — the custom renderer was replaced at
  the author's direction by the maintained open-source Hesprs viewer.
