# Changelog

## 0.4.3 — 2026-11-09

- **Tab switches keep the exact pan / zoom.** 0.4.2 fixed half the
  bug: the board no longer goes blank, but it re-fit on every return
  instead of keeping the user's view (3/3 tab switches in a live
  check). Cause: showing the tab re-renders the panel, and every
  `load()` re-fits the board — and the re-fit was captured into the
  viewport stash itself, because the library fires `onRefresh`
  synchronously while it re-fits. Every restore after that faithfully
  put back the fit view. The stash is now frozen while a load is in
  flight (a counter, so overlapping loads cannot clear each other's
  freeze), and the post-load restore puts back the last viewport the
  user actually chose. If a load changes the board's geometry, the
  fresh fit stands and the stash is pointed at it, so it stays
  truthful for the new board.
- In-place text editing, Markdown file cards, and JSON-pane live
  editing are unchanged.

## 0.4.2 — 2026-11-09

- **Tab switches keep the board in view — for real this time.**
  The 0.4.1 fix did not hold in a live check (3/3 tab switches left
  the board off-screen, zoom kept, pan lost). Two things were wrong,
  and both are fixed here. First, the 0.4.1 restore went through the
  library's own pan / zoom commands, which are animated by an
  internal lubricator: a dispatched pan / zoom is applied a quarter
  at a time over many frames, and a pending one is thrown away if the
  pointer handling stops — so a restore could land late, land twice,
  or never land, and the viewport stash could be re-captured
  mid-animation, still shifted. Restores now write the pan / zoom
  straight into the library's DataManager and redraw at once: exact,
  synchronous, and idempotent, so the resize hook, the show hook,
  and the post-load restore can never fight each other. Second, the
  post-load restore could re-apply a viewport captured while the
  panel was hidden (already shifted) over a good one; it now prefers
  the last viewport seen while visible. A panel-show hook
  (`onAfterShow`) restores the last visible viewport as a second
  trigger alongside the resize hook. The panel also stamps its
  version (`data-jsoncanvas-version`) on its own node, so a live
  check can read which version is actually running from the page.
  (One live-check caveat also stands: the 0.4.1 check ran two minutes
  after the deploy, inside GitHub Pages' 10-minute CDN cache window,
  so it may have run the 0.4.0 bundle instead of 0.4.1 — the new
  version stamp exists so the next check can tell.)
- In-place text editing, Markdown file cards, and JSON-pane live
  editing are unchanged.

## 0.4.1 — 2026-11-08

- **The board survives tab switches.** Switching to another Lab tab
  and back used to leave the viewer blank with the board off-screen
  until Reset. Cause, in the library: its `ResizeObserver` re-centres
  the board on every container resize, including the trip to 0×0 when
  the panel is hidden — and on the way back its re-centring is a
  no-op, because its `lastResizeCenter` is 0,0, which its guard treats
  as "no previous centre". Each hide/show therefore shifted the board
  by half a viewport. The panel now keeps the last viewport seen
  while visible (via the library's own `onRefresh` hook, which fires
  on every pan / zoom / resize) and puts it back when the library
  reports a real size after a zero size (`onResize`); if there is no
  stashed viewport yet, e.g. the panel was opened in a background
  tab, it fits the board instead. No board change — code only.
- In-place text editing, Markdown file cards, and JSON-pane live
  editing are unchanged.

## 0.4.0 — 2026-11-08

- **Text cards edit in place.** Double-click a text card and it turns
  into a textarea editing the card's raw Markdown, right on the board.
  Click away or press Ctrl/Cmd+Enter to save — the new text is written
  back into the `.canvas` file through the shared document model, so
  the JSON pane stays in sync and the file is saved by the standard
  Ctrl+S / autosave. Esc cancels and the card goes back to the old
  text; a plain Enter stays a newline. The edit writes only that
  node's `text` and keeps the file's own formatting, so a card edit
  changes nothing else. Markdown file cards stay read-only (editing
  one would mean editing the `.md` file it points at), and a
  double-click on a link inside a card keeps the link's behaviour.
- **Re-renders keep the viewport.** The library re-fits the whole
  board on every `load()`, so editing the JSON in a second pane used
  to re-frame the board on each keystroke. The panel now saves the
  pan / zoom before each load and restores it afterwards — unless the
  edit changed the board's geometry, in which case the fresh fit
  stands. The same mechanism keeps the user's place after a card
  edit commits.
- The demo board's "Hello, canvas" card names the new gesture, and
  grew to 280 px so the extra bullet fits.
- Implementation: the extension now also overrides the library's
  `text` node component via its `nodeComponents` hook (the same
  sanctioned override point as the Markdown file node), and reads the
  viewport back through the library's exported `internal` modules,
  with the overlays layer's own transform as a fallback. The widget
  factory is no longer registered read-only, since the board now
  writes. Node dragging is still out of scope — the library binds
  drag to panning and exposes no node-move hook, so that stays Step 3.

## 0.3.1 — 2026-11-08

- **Markdown file cards no longer repeat the filename.** The library
  paints every file node's filename as a caption above the card (on
  its canvas, unconditionally — no option or DOM hook suppresses it),
  so the card's own header showed the same name twice, and the
  caption collided with the "renders Markdown" edge-label pill. The
  header now carries just the **Open** link; the filename is the
  library's caption.
- The demo board's Markdown file node is taller (280 px) so the whole
  note shows — at 150 px its two bullets were in the DOM but
  invisible — and sits lower (y 400) so the edge-label pill clears
  the filename caption; the group grew to match (720 px).

## 0.3.0 — 2026-11-08

- **Markdown file nodes render their content.** File nodes pointing at
  plain `.md` files now show the file's Markdown inside the card,
  instead of a bare filename. The path is resolved against the canvas
  file's folder and fetched through the JupyterLab contents API, which
  works on every drive (R2 and local alike) — the library's own
  HTTP fetch cannot reach drive files. The card keeps its file
  identity: a header shows the filename with an **Open** link, and
  double-click opens the file itself. Fetched content is cached per
  panel and dropped when the file is saved, so edits show up on the
  next render. Anything that is not a plain `.md` file, or cannot be
  fetched, keeps the bare filename label.
- **JSON editing live-updates the board.** The viewer and the text
  editor share the same document model, so editing the `.canvas` JSON
  in a second pane re-renders the board with no save needed. Saving
  stays the standard Ctrl+S, through the contents API to whichever
  drive the file is on.
- The demo board has a Markdown file node again
  (`canvas-demo-note.md`), showing the new rendering.
- Implementation: the extension overrides the library's Markdown
  file-node component via its `nodeComponents` hook (the sanctioned
  override point in `json-canvas-viewer` 4.3.2); the library itself is
  unchanged.

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
