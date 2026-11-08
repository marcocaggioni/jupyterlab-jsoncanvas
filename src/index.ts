// jupyterlab-jsoncanvas — viewer for JSON Canvas (.canvas) files.
//
// Registers the `.canvas` file type (JSON Canvas 1.0, jsoncanvas.org) and
// a document widget that renders the board with the Hesprs JSON Canvas
// Viewer library: text cards (Markdown), file cards, link cards, groups,
// and edges, with pan / zoom / fit-to-view, a minimap, and light / dark
// themes. File nodes pointing at `.md` files render the file's content
// inside the card (fetched through the contents API), with an Open link
// and double-click to open the file. Text cards are editable in place:
// double-click one and type; the edit is written back into the `.canvas`
// file. Deeper visual editing (dragging nodes, resizing) is not in the
// viewer — edit the `.canvas` JSON in the text editor and the board
// follows live, and save with the standard Ctrl+S.

import { JupyterFrontEnd, JupyterFrontEndPlugin } from '@jupyterlab/application';

import { JSONCanvasWidgetFactory } from './canvas';
import { canvasIcon } from './icons';
import '../style/index.js';

/**
 * The JSON Canvas viewer plugin.
 */
const plugin: JupyterFrontEndPlugin<void> = {
  id: 'jupyterlab-jsoncanvas:plugin',
  description:
    'Viewer for JSON Canvas (.canvas) files, powered by the Hesprs JSON Canvas Viewer library. Markdown file nodes render their content, fetched through the contents API.',
  autoStart: true,
  activate: (app: JupyterFrontEnd): void => {
    app.docRegistry.addFileType({
      name: 'jsoncanvas',
      displayName: 'JSON Canvas',
      contentType: 'file',
      fileFormat: 'text',
      extensions: ['.canvas'],
      mimeTypes: ['application/json'],
      icon: canvasIcon
    });
    const factory = new JSONCanvasWidgetFactory({
      name: 'JSON Canvas',
      fileTypes: ['jsoncanvas'],
      defaultFor: ['jsoncanvas'],
      readOnly: false,
      contents: app.serviceManager.contents,
      commands: app.commands
    });
    app.docRegistry.addWidgetFactory(factory);
  }
};

export default plugin;
