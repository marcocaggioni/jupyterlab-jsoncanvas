// jupyterlab-jsoncanvas — viewer for JSON Canvas (.canvas) files, with
// Markdown file nodes rendered through the JupyterLab contents API.
//
// Rendering is done by the Hesprs JSON Canvas Viewer library
// (https://github.com/Hesprs/JSON-Canvas-Viewer, MIT), which implements
// 100% of the JSON Canvas 1.0 spec (jsoncanvas.org): text / file / link /
// group nodes, edges, pan / zoom, light / dark themes, plus the Controls
// and Minimap modules for the chrome. This file only wires the library
// into JupyterLab: the document widget, feeding the parsed .canvas JSON
// from the document model to the viewer, theme following, and error
// handling.
//
// File nodes: the library renders a file node by fetching its path over
// HTTP, which cannot work for files that only exist in a JupyterLite
// drive (drive files are served by the contents API, not the web
// server). So the panel overrides the library's Markdown file-node
// component with its own: the node path is resolved against the canvas
// file's folder, the file is fetched through the contents API (which
// works on every drive — R2 and local alike), and the Markdown is
// rendered inside the card, with an Open link and double-click to open
// the file itself. Anything that is not a plain `.md` file, or cannot be
// fetched, keeps the bare filename label. The fetched content is only
// ever displayed — the canvas file itself is never rewritten.
//
// JSON editing: the viewer and the text editor share the same document
// model (both use the `text` model factory), so editing the `.canvas`
// JSON in a second pane re-renders the board live, with no save needed.
// Saving is the standard JupyterLab Ctrl+S, through the contents API to
// whichever drive the file is on.

import { Contents } from '@jupyterlab/services';
import { CommandRegistry } from '@lumino/commands';
import { PathExt } from '@jupyterlab/coreutils';
import {
  ABCWidgetFactory,
  DocumentRegistry,
  DocumentWidget
} from '@jupyterlab/docregistry';
import { Message } from '@lumino/messaging';
import { Widget } from '@lumino/widgets';
import {
  Controls,
  JSONCanvasViewer,
  Minimap,
  parser,
  type JSONCanvas,
  type JSONCanvasFileNode,
  type JSONCanvasViewerInterface
} from 'json-canvas-viewer';

import { canvasIcon } from './icons';

type CanvasViewer = JSONCanvasViewerInterface<
  [typeof Controls, typeof Minimap]
>;

/** What a canvas panel needs from the app: the contents API for
 * Markdown file nodes, and the command registry to open files. */
export interface ICanvasPanelOptions {
  contents: Contents.IManager;
  commands: CommandRegistry;
}

/** JupyterLab's light/dark flag, from the body attribute it maintains. */
function currentTheme(): 'light' | 'dark' {
  return document.body.dataset.jpThemeLight === 'false' ? 'dark' : 'light';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** YAML frontmatter (`--- ... ---` at the top), stripped the way the
 * library's own Markdown component does, so it never renders as text. */
const FRONTMATTER = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;

function stripFrontmatter(markdown: string): string {
  const match = FRONTMATTER.exec(markdown);
  return match ? match[2] : markdown;
}

/**
 * Parse the file content into the canvas object the library expects.
 * Only the top-level shape is checked here (a JSON object whose
 * `nodes` / `edges`, when present, are arrays); the library itself
 * validates and renders the nodes and edges. Returns an error string
 * instead of throwing.
 */
function parseCanvas(
  content: string
): { data: JSONCanvas | null; error: string | null } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    return {
      data: null,
      error: `Not valid JSON: ${e instanceof Error ? e.message : String(e)}`
    };
  }
  const root = asRecord(parsed);
  if (!root) {
    return { data: null, error: 'Canvas file must be a JSON object.' };
  }
  if (
    ('nodes' in root && !Array.isArray(root.nodes)) ||
    ('edges' in root && !Array.isArray(root.edges))
  ) {
    return {
      data: null,
      error: 'Canvas file must have `nodes` and `edges` arrays.'
    };
  }
  // The library's type marks edge sides required, but the spec leaves
  // them optional, so the raw object goes through untouched.
  return { data: parsed as unknown as JSONCanvas, error: null };
}

/**
 * The panel that hosts one library viewer for one canvas file.
 */
export class CanvasPanel extends Widget {
  private _context: DocumentRegistry.IContext<DocumentRegistry.IModel>;
  private _contents: Contents.IManager;
  private _commands: CommandRegistry;
  private _host: HTMLDivElement;
  private _errorBar: HTMLDivElement;
  private _viewer: CanvasViewer | null = null;
  private _themeObserver: MutationObserver | null = null;
  private _ready = false;
  /** Fetched Markdown by resolved path, so re-renders (e.g. while the
   * canvas JSON is edited in another pane) do not re-fetch. A save of
   * the file drops its entry, so the next render picks up the edit. */
  private _mdCache = new Map<string, Promise<string>>();

  constructor(
    context: DocumentRegistry.IContext<DocumentRegistry.IModel>,
    options: ICanvasPanelOptions
  ) {
    super();
    this._context = context;
    this._contents = options.contents;
    this._commands = options.commands;
    this.addClass('jp-JSONCanvas');
    this.node.setAttribute('tabindex', '0');

    this._host = document.createElement('div');
    this._host.className = 'jp-JSONCanvas-host';
    this.node.appendChild(this._host);

    this._errorBar = document.createElement('div');
    this._errorBar.className = 'jp-JSONCanvas-error';
    this._errorBar.hidden = true;
    this.node.appendChild(this._errorBar);

    void this._context.ready.then(() => {
      this._ready = true;
      this.update();
    });
    this._context.model.contentChanged.connect(() => {
      this.update();
    }, this);
    this._context.fileChanged.connect(() => {
      this.update();
    }, this);
    this._contents.fileChanged.connect(this._onContentsChanged, this);
  }

  dispose(): void {
    this._mdCache.clear();
    this._disposeViewer();
    super.dispose();
  }

  protected onAfterAttach(msg: Message): void {
    super.onAfterAttach(msg);
    // The viewer needs a laid-out container to fit the board.
    this.update();
  }

  protected onUpdateRequest(msg: Message): void {
    super.onUpdateRequest(msg);
    if (!this._ready || !this.isAttached) {
      return;
    }
    this._render();
  }

  private _disposeViewer(): void {
    if (this._themeObserver) {
      this._themeObserver.disconnect();
      this._themeObserver = null;
    }
    if (this._viewer) {
      this._viewer.dispose();
      this._viewer = null;
    }
  }

  private _showError(message: string): void {
    this._errorBar.textContent = message;
    this._errorBar.hidden = false;
  }

  private _clearError(): void {
    this._errorBar.textContent = '';
    this._errorBar.hidden = true;
  }

  private _watchTheme(): void {
    if (this._themeObserver) {
      return;
    }
    this._themeObserver = new MutationObserver(() => {
      this._viewer?.changeTheme(currentTheme());
    });
    this._themeObserver.observe(document.body, {
      attributes: true,
      attributeFilter: ['data-jp-theme-light']
    });
  }

  /**
   * A save (or delete / rename) of a file the board shows drops its
   * cached Markdown, so the next render re-fetches it.
   */
  private _onContentsChanged(
    sender: Contents.IManager,
    args: Contents.IChangedArgs
  ): void {
    void sender;
    for (const value of [args.oldValue, args.newValue]) {
      if (value?.path) {
        this._mdCache.delete(value.path);
      }
    }
  }

  /**
   * Resolve a file node's `file` path against the canvas file's folder.
   * A leading `/` is treated as drive-rooted. Remote URLs are returned
   * unchanged (the caller treats them as unresolvable).
   */
  private _resolveFileNode(file: string): string {
    if (file.includes('://')) {
      return file;
    }
    const clean = file.startsWith('/') ? file.slice(1) : file;
    return PathExt.join(PathExt.dirname(this._context.path), clean);
  }

  /** Fetch a Markdown file's text through the contents API, cached by
   * resolved path (see `_onContentsChanged` for invalidation). A
   * failed fetch is not cached, so the next render retries. */
  private _fetchMarkdown(path: string): Promise<string> {
    const cached = this._mdCache.get(path);
    if (cached) {
      return cached;
    }
    const pending = this._contents
      .get(path, { content: true })
      .then(model => {
        if (model.type !== 'file' || typeof model.content !== 'string') {
          throw new Error(`Not a text file: ${path}`);
        }
        return model.content;
      })
      .catch((error: unknown) => {
        this._mdCache.delete(path);
        throw error;
      });
    this._mdCache.set(path, pending);
    return pending;
  }

  /** Open a file node's target with its default viewer. */
  private async _openFileNode(node: JSONCanvasFileNode): Promise<void> {
    const path = this._resolveFileNode(node.file);
    try {
      await this._commands.execute('docmanager:open', { path });
    } catch (error) {
      console.error(
        '[jupyterlab-jsoncanvas] Failed to open file node:',
        path,
        error
      );
    }
  }

  /**
   * The library's Markdown file-node component, replaced: instead of
   * fetching the file over HTTP (which cannot work for drive files),
   * fetch it through the contents API and render the Markdown in the
   * card. The card keeps its file identity — the filename is the
   * library's own caption above the card (it paints every file node's
   * name there, on its canvas), the header carries an Open link, and
   * double-click opens the file.
   * Anything that is not a plain `.md` file, or cannot be fetched,
   * keeps the bare filename label.
   */
  private _markdownFileNode = async (args: {
    container: HTMLDivElement;
    content: string;
    node: JSONCanvasFileNode;
  }): Promise<void> => {
    const { container, node } = args;
    const file = node.file;
    const name = PathExt.basename(file);
    const resolved = this._resolveFileNode(file);

    // The library centers Markdown content; stack a header above the
    // text instead.
    container.style.flexDirection = 'column';
    container.style.justifyContent = 'flex-start';
    container.style.alignItems = 'stretch';

    const body = document.createElement('div');
    body.className = 'JCV-parsed-content-wrapper';
    body.style.flex = '1 1 auto';
    body.style.minHeight = '0';
    body.style.maxHeight = 'none';

    // Remote URLs and non-Markdown files keep the filename label.
    if (resolved.includes('://') || !/\.md$/i.test(file)) {
      body.textContent = name;
      container.appendChild(body);
      return;
    }

    const header = document.createElement('div');
    header.className = 'jp-JSONCanvas-mdheader';
    const open = document.createElement('a');
    open.className = 'jp-JSONCanvas-mdheader-open';
    open.textContent = 'Open';
    open.href = '#';
    open.title = file;
    open.addEventListener('click', event => {
      event.preventDefault();
      void this._openFileNode(node);
    });
    header.appendChild(open);
    container.appendChild(header);
    container.appendChild(body);
    container.addEventListener('dblclick', () => {
      void this._openFileNode(node);
    });

    body.textContent = 'Loading…';
    try {
      const markdown = await this._fetchMarkdown(resolved);
      body.innerHTML = await parser(stripFrontmatter(markdown));
    } catch (error) {
      console.error(
        '[jupyterlab-jsoncanvas] Failed to load Markdown file node:',
        resolved,
        error
      );
      body.textContent = name;
    }
  };

  private _render(): void {
    const content = this._context.model.toString();
    const { data, error } = parseCanvas(content);
    if (!data) {
      this._disposeViewer();
      this._showError(error ?? 'Could not read this canvas file.');
      return;
    }
    this._clearError();

    if (this._viewer) {
      this._viewer.load({ canvas: data });
      return;
    }

    const viewer = new JSONCanvasViewer(
      {
        container: this._host,
        canvas: data,
        parser,
        theme: currentTheme(),
        nodeComponents: { markdown: this._markdownFileNode }
      },
      [Controls, Minimap]
    );
    this._viewer = viewer;
    this._watchTheme();
    // Frame the whole board once the viewer has started.
    viewer.onStart.subscribe(() => {
      viewer.resetView();
    });
  }
}

/**
 * The document widget wrapping a canvas panel.
 */
export class JSONCanvasDocumentWidget extends DocumentWidget<
  CanvasPanel,
  DocumentRegistry.IModel
> {
  constructor(
    context: DocumentRegistry.IContext<DocumentRegistry.IModel>,
    options: ICanvasPanelOptions
  ) {
    super({ context, content: new CanvasPanel(context, options) });
    this.addClass('jp-JSONCanvasDocument');
    this.title.label = PathExt.basename(context.localPath);
    this.title.caption = context.localPath;
    this.title.closable = true;
    this.title.icon = canvasIcon;
  }
}

/**
 * Widget factory for `.canvas` files.
 */
export class JSONCanvasWidgetFactory extends ABCWidgetFactory<
  JSONCanvasDocumentWidget,
  DocumentRegistry.IModel
> {
  private _contents: Contents.IManager;
  private _commands: CommandRegistry;

  constructor(
    options: DocumentRegistry.IWidgetFactoryOptions<JSONCanvasDocumentWidget> &
      ICanvasPanelOptions
  ) {
    super(options);
    this._contents = options.contents;
    this._commands = options.commands;
  }

  protected createNewWidget(
    context: DocumentRegistry.IContext<DocumentRegistry.IModel>
  ): JSONCanvasDocumentWidget {
    return new JSONCanvasDocumentWidget(context, {
      contents: this._contents,
      commands: this._commands
    });
  }
}
