# Example board

`json-canvas-demo.canvas` is the demo board for this extension. It exercises:

- a **group** ("Welcome to JSON Canvas") holding the intro cards;
- a **text** card ("Hello, canvas") with Markdown — heading, bold text, bullets;
- a **link** card to https://jsoncanvas.org, which the viewer previews;
- a second **text** card ("Colors") showing preset and hex colors;
- a third **text** card with the pan / zoom / fit instructions;
- **edges** with sides, arrow ends, labels, and preset / hex colors
  ("read the spec", "two-way", "and so on").

There is deliberately **no file node** on this board: the viewer renders file
nodes as bare labels, not cards (see "Known limitations" in the main README),
so the demo sticks to the node types that render well.

## Try it

- **In JupyterLab or JupyterLite** with this extension installed: drop the file
  into the file browser and double-click it — the board opens in the viewer.
- **On the live demo site**: open it at
  https://marcocaggioni.github.io/jupyterlite-r2/files/json-canvas-demo.canvas
  (the same board, served by the demo JupyterLite site).
