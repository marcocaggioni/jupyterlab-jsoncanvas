// jupyterlab-jsoncanvas — viewer for JSON Canvas (.canvas) files, with
// Markdown file nodes rendered through the JupyterLab contents API and
// in-place editing of text cards.
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
// Text nodes: the panel also overrides the library's text-node
// component, so a double-click on a text card turns it into a textarea
// editing the node's raw Markdown. Committing writes the new text back
// into the shared document model (so the JSON pane stays in sync and
// the file is saved by the standard Ctrl+S / autosave), and the board
// re-renders. Markdown file cards stay read-only — editing one would
// mean editing the `.md` file it points at.
//
// JSON editing: the viewer and the text editor share the same document
// model (both use the `text` model factory), so editing the `.canvas`
// JSON in a second pane re-renders the board live, with no save needed.
// Saving is the standard JupyterLab Ctrl+S, through the contents API to
// whichever drive the file is on.
//
// View: the library re-fits the whole board on every `load()`, so a
// re-render would drop the user back to the fit view. The panel saves
// the pan / zoom before each load and restores it afterwards (unless
// the board's geometry changed, in which case the fresh fit stands).
// The same stash also covers tab switches: the library's
// ResizeObserver re-centres the board on every container resize,
// including the trip to 0×0 when the panel is hidden — and on the way
// back its re-centring is a no-op (its lastResizeCenter is 0,0, which
// its guard treats as "no previous centre"), so each hide/show would
// leave the board shifted by half a viewport. The panel keeps the
// last viewport seen while visible and puts it back when a real size
// returns, using the library's own `onResize` / `onRefresh` hooks —
// and when the panel itself is shown again, as a second trigger.
// Restores write the pan / zoom straight into the library's
// DataManager instead of going through its pan / zoom commands: those
// are animated by an internal lubricator (a dispatched pan / zoom is
// applied a quarter at a time over many frames, and a pending one is
// thrown away if the pointer handling stops), so a restore through
// them can land late, land twice, or never land at all — and the
// stash can be re-captured mid-animation, still shifted. A direct
// write lands exactly, at once, and is idempotent — restoring twice
// is the same as restoring once — so the resize hook, the show hook,
// and the post-load restore can never fight each other.

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
  internal,
  parser,
  type Hook,
  type JSONCanvas,
  type JSONCanvasFileNode,
  type JSONCanvasTextNode,
  type JSONCanvasViewerInterface
} from 'json-canvas-viewer';

import { canvasIcon } from './icons';

type CanvasViewer = JSONCanvasViewerInterface<
  [typeof Controls, typeof Minimap]
>;

/** The plugin version, stamped on the panel node so a live check can
 * read which version is actually running from the page. Keep in sync
 * with package.json. */
const VERSION = '0.4.2';

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

/** The board's viewport: pan offsets, zoom, and the bounds of its
 * nodes, as the library's DataManager holds them. */
interface ICanvasView {
  offsetX: number;
  offsetY: number;
  scale: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  /** False when the view came from the overlays layer's transform,
   * which carries no bounds — the caller then restores blind. */
  boundsKnown: boolean;
}

/**
 * Serialize a canvas object back to text in the file's own shape: a
 * single-line file stays single-line, a pretty-printed file keeps its
 * indent, and a trailing newline is preserved when there was one — so
 * a card edit changes only the edited text, not the whole file.
 */
function stringifyCanvas(parsed: unknown, raw: string): string {
  const trailing = raw.endsWith('\n') ? '\n' : '';
  if (!raw.includes('\n')) {
    return JSON.stringify(parsed) + trailing;
  }
  const indent = /\n( +)"/.exec(raw);
  return JSON.stringify(parsed, null, indent ? indent[1].length : 2) + trailing;
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
  /** The viewport as last seen while the panel was visible — kept
   * fresh by the library's own `onRefresh` hook, which fires on
   * every pan / zoom / resize — so a tab switch can put it back. */
  private _lastVisibleView: ICanvasView | null = null;
  /** True once the library has reported a zero-size resize, i.e. the
   * panel was hidden; cleared when a real size returns. */
  private _hiddenByResize = false;

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
    this.node.setAttribute('data-jsoncanvas-version', VERSION);

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

  protected onAfterShow(msg: Message): void {
    super.onAfterShow(msg);
    // Second trigger for the tab-switch restore, alongside the
    // library's resize hook: if anything re-fit the board while the
    // panel was hidden, put the last visible viewport back once the
    // panel is laid out again. Two animation frames land after the
    // layout has settled; the restore is a direct write, so running
    // it twice (here and from the resize hook) is harmless.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (this.isDisposed || !this._viewer || !this._lastVisibleView) {
          return;
        }
        if (this._host.clientWidth > 0 && this._host.clientHeight > 0) {
          this._restoreView(this._lastVisibleView);
        }
      });
    });
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

  /**
   * The library's text-node component, replaced with an editable one:
   * the card renders its Markdown exactly as the library would, and a
   * double-click turns it into a textarea editing the node's raw
   * Markdown — the same gesture as the Markdown file cards, where a
   * double-click opens the file.
   *
   * Commit: click away (blur) or Ctrl/Cmd+Enter. The new text is
   * written back into the shared document model, so the JSON pane
   * stays in sync and the file is saved by the standard Ctrl+S /
   * autosave. Esc cancels and the card goes back to the old text.
   * A double-click on a link inside the card keeps the link's own
   * behaviour. Only the text is ever written — the node's position
   * and size are untouched.
   */
  private _textNode = (args: {
    container: HTMLDivElement;
    content: string;
    node: JSONCanvasTextNode;
    onBeforeUnmount: Hook;
  }): void => {
    const { container, content, node } = args;

    const view = document.createElement('div');
    view.className = 'JCV-parsed-content-wrapper';
    view.innerHTML = content;
    container.classList.add('JCV-markdown-content');
    container.appendChild(view);

    let editing = false;
    let editor: HTMLTextAreaElement | null = null;
    let editorWrap: HTMLDivElement | null = null;

    const exitEditMode = (): void => {
      editorWrap?.remove();
      editorWrap = null;
      editor = null;
      view.style.display = '';
    };

    const commit = (): void => {
      if (!editing || !editor) {
        return;
      }
      const newText = editor.value;
      // Clear the flag before the editor leaves the DOM: removing a
      // focused element fires blur, and the blur handler must see
      // that the edit is already done.
      editing = false;
      exitEditMode();
      this._updateTextNode(node.id, newText);
    };

    const cancel = (): void => {
      if (!editing) {
        return;
      }
      editing = false;
      exitEditMode();
    };

    const enterEditMode = (): void => {
      if (editing) {
        return;
      }
      editing = true;
      view.style.display = 'none';

      editorWrap = document.createElement('div');
      editorWrap.className = 'jp-JSONCanvas-texteditor-wrap';
      editor = document.createElement('textarea');
      editor.className = 'jp-JSONCanvas-texteditor';
      editor.value = node.text;
      editor.spellcheck = false;
      editor.setAttribute('aria-label', 'Edit card text');
      editor.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          cancel();
        } else if (
          event.key === 'Enter' &&
          (event.ctrlKey || event.metaKey)
        ) {
          event.preventDefault();
          commit();
        }
      });
      // Clicking away commits; the blur fires before the click that
      // caused it, so a click on another card saves first and selects
      // second. A plain Enter stays a newline — the text is Markdown.
      editor.addEventListener('blur', () => {
        commit();
      });
      editorWrap.appendChild(editor);
      const hint = document.createElement('div');
      hint.className = 'jp-JSONCanvas-texteditor-hint';
      hint.textContent = 'Ctrl/⌘+Enter to save · Esc to cancel';
      editorWrap.appendChild(hint);
      container.appendChild(editorWrap);
      editor.focus();
      editor.setSelectionRange(editor.value.length, editor.value.length);
    };

    // The listener sits on the overlay container (the content's
    // parent) so the first click of the pair still reaches it while
    // the card is unselected and the library's click layer covers the
    // content — the click selects the card, the double-click then
    // opens the editor.
    const overlay = container.parentElement ?? container;
    overlay.addEventListener('dblclick', event => {
      if ((event.target as Element | null)?.closest?.('a')) {
        return;
      }
      enterEditMode();
    });

    // If the overlay is torn down while an edit is open — the JSON
    // pane changed the same node, the file was reloaded, the panel
    // closed — keep the typed text: commit it instead of dropping it.
    // A commit of our own already cleared `editing` before the
    // re-render, so this is a no-op on the normal path.
    args.onBeforeUnmount.subscribe(() => {
      if (editing) {
        commit();
      }
    });
  };

  /**
   * Write one text node's new text back into the shared document
   * model. Only that node's `text` changes; every other node, edge,
   * and the file's own formatting are left alone. A no-op or an
   * unparseable file writes nothing, so a JSON pane mid-edit is never
   * clobbered.
   */
  private _updateTextNode(nodeId: string, newText: string): void {
    if (this._context.isDisposed) {
      return;
    }
    const raw = this._context.model.toString();
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    const root = asRecord(parsed);
    const nodes = root && Array.isArray(root.nodes) ? root.nodes : null;
    if (!nodes) {
      return;
    }
    const node = nodes
      .map(value => asRecord(value))
      .find(record => record?.id === nodeId && record?.type === 'text');
    if (!node || node.text === newText) {
      return;
    }
    node.text = newText;
    try {
      this._context.model.fromString(stringifyCanvas(parsed, raw));
    } catch (error) {
      console.error(
        '[jupyterlab-jsoncanvas] Failed to write the card edit:',
        error
      );
    }
  }

  /**
   * The board's current viewport, read from the library's DataManager
   * through its exported `internal` modules, or — if that ever stops
   * working — parsed out of the overlays layer's own transform, which
   * the library keeps in sync on every redraw. Returns null when
   * neither source is available; the caller then lets the fresh fit
   * stand.
   */
  private _captureView(): ICanvasView | null {
    const viewer = this._viewer;
    if (!viewer) {
      return null;
    }
    try {
      const data = viewer.container.get(internal.DataManager).data;
      const bounds = data.nodeBounds;
      return {
        offsetX: data.offsetX,
        offsetY: data.offsetY,
        scale: data.scale,
        minX: bounds.minX,
        minY: bounds.minY,
        maxX: bounds.maxX,
        maxY: bounds.maxY,
        boundsKnown: true
      };
    } catch {
      // Fall through to the DOM transform below.
    }
    const layer = this._host.querySelector('#overlays');
    if (!layer) {
      return null;
    }
    const match =
      /translate\(\s*(-?[\d.]+)px,\s*(-?[\d.]+)px\)\s*scale\(\s*(-?[\d.]+)\)/.exec(
        (layer as HTMLElement).style.transform
      );
    if (!match) {
      return null;
    }
    return {
      offsetX: Number(match[1]),
      offsetY: Number(match[2]),
      scale: Number(match[3]),
      minX: 0,
      minY: 0,
      maxX: 0,
      maxY: 0,
      boundsKnown: false
    };
  }

  /**
   * Put the viewport back where `_captureView` found it, by writing
   * the pan / zoom straight into the library's DataManager and
   * redrawing — see the header comment for why this does not go
   * through the viewer's (lubricated) pan / zoom commands. The write
   * is synchronous and exact, and repeating it is a no-op, so
   * several restore triggers can never fight each other.
   */
  private _restoreView(view: ICanvasView): void {
    const viewer = this._viewer;
    if (!viewer || this.isDisposed) {
      return;
    }
    try {
      const data = viewer.container.get(internal.DataManager).data;
      data.offsetX = view.offsetX;
      data.offsetY = view.offsetY;
      data.scale = view.scale;
      viewer.refresh();
    } catch (error) {
      console.warn(
        '[jupyterlab-jsoncanvas] Could not restore the view after a re-render:',
        error
      );
    }
  }

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
      // The library re-fits the whole board on every load, which would
      // drop the user back to the fit view after each edit. Save the
      // viewport first and put it back once the new render is in
      // place — two animation frames land after Lumino has processed
      // the update and the viewer's redraw loop has run. If the edit
      // changed the board's geometry, the fresh fit stands instead.
      const previous = this._captureView();
      this._viewer.load({ canvas: data });
      if (previous) {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            if (this.isDisposed || !this._viewer) {
              return;
            }
            const current = this._captureView();
            if (
              current &&
              previous.boundsKnown &&
              current.boundsKnown &&
              (Math.abs(current.minX - previous.minX) > 0.5 ||
                Math.abs(current.minY - previous.minY) > 0.5 ||
                Math.abs(current.maxX - previous.maxX) > 0.5 ||
                Math.abs(current.maxY - previous.maxY) > 0.5)
            ) {
              return;
            }
            // Prefer the last viewport seen while visible: `previous`
            // was captured at render time, which can be while the panel
            // was hidden — i.e. already shifted by the library's
            // resize handling — and restoring it would put the shifted
            // view back over a good one.
            this._restoreView(this._lastVisibleView ?? previous);
          });
        });
      }
      return;
    }

    const viewer = new JSONCanvasViewer(
      {
        container: this._host,
        canvas: data,
        parser,
        theme: currentTheme(),
        nodeComponents: {
          markdown: this._markdownFileNode,
          text: this._textNode
        }
      },
      [Controls, Minimap]
    );
    this._viewer = viewer;
    this._watchTheme();
    // Frame the whole board once the viewer has started.
    viewer.onStart.subscribe(() => {
      viewer.resetView();
    });
    // The library re-centres the board on every container resize,
    // including the trip to 0×0 when this panel is hidden by a tab
    // switch: the offsets shift by half a viewport, and the return
    // trip is a no-op in the library (see the header comment), so the
    // board would come back off-screen — further off with every
    // switch. Both hooks below are the library's own: `onRefresh`
    // fires whenever the viewport changes, `onResize` after each
    // resize, with the new size. While visible, keep the viewport
    // stashed; when a real size returns after a zero size, put the
    // stash back (or fit the board if there is no stash yet, e.g.
    // the panel was opened in a background tab).
    viewer.onRefresh.subscribe(() => {
      if (this.isDisposed) {
        return;
      }
      if (this._host.clientWidth > 0 && this._host.clientHeight > 0) {
        const view = this._captureView();
        if (view) {
          this._lastVisibleView = view;
        }
      }
    });
    viewer.onResize.subscribe((width, height) => {
      const current = this._viewer;
      if (this.isDisposed || !current) {
        return;
      }
      if (width > 0 && height > 0) {
        if (!this._hiddenByResize) {
          return;
        }
        this._hiddenByResize = false;
        if (this._lastVisibleView) {
          this._restoreView(this._lastVisibleView);
        } else {
          current.resetView();
        }
      } else {
        this._hiddenByResize = true;
      }
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
