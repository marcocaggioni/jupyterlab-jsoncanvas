# Using jupyterlab-jsoncanvas in JupyterLite

This extension is a standard prebuilt federated JupyterLab extension, so it
works in JupyterLite the same way it works in JupyterLab — the only
difference is how it gets into the site build.

## Adding it to a JupyterLite site

The site build installs Python packages from `requirements.txt` (or
equivalent), so add this repo as a pip requirement:

```text
jupyterlab-jsoncanvas @ git+https://github.com/marcocaggioni/jupyterlab-jsoncanvas.git
```

Then rebuild the site (`jupyter lite build`). The extension's
`labextension` is bundled into the site like any other federated
extension, and `.canvas` files in the site's content open in the viewer
on double-click.

If your site pins extensions in `jupyter-lite.json` instead, the
federated extension entry is the usual one produced by the build
(name `jupyterlab-jsoncanvas`, with the generated `remoteEntry.*.js`).

> **No PyPI release yet.** Until the package is published, installs must
> come from this Git repo (or from a wheel built from it — see below).

## Building a wheel

From a checkout of this repo:

```bash
npm install
jupyter labextension build --core-version 4.4.10 .
python -m build --wheel
```

This produces `dist/jupyterlab_jsoncanvas-0.2.0-py3-none-any.whl`. A wheel
can be installed into a site build directly
(`pip install /path/to/jupyterlab_jsoncanvas-0.2.0-py3-none-any.whl`) or
served from a URL as the site's requirement.

## Verifying the install

After building the site, check the built `jupyter-lite.json`: it should
list `jupyterlab-jsoncanvas` under `federated_extensions`. Then open the
site, find a `.canvas` file in the file browser, and double-click it —
the board should render with the minimap and zoom controls.

## Live demo

A JupyterLite site with the extension installed, including the demo board:

- Site: https://marcocaggioni.github.io/jupyterlite-r2/
- Demo board: https://marcocaggioni.github.io/jupyterlite-r2/files/json-canvas-demo.canvas

## Known limitations

See the [main README](../README.md#known-limitations): file nodes render
as bare labels (attachments are not remapped), the fullscreen button does
nothing inside Lab, and the viewer registration was once seen to be flaky
on the very first load after a fresh deploy (a full reload fixed it).
