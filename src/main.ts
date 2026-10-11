import { type DocumentData, DocumentSession, SAVE_TIMING, type SyncState, within } from "./documents";
import type { EventCallback, UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { type DocumentLink, errorCode, type HeldMove, ipc, isIpcFailure, type RestoreResult, type ThemePreference, type TreeDelta, type TreeNode, type WorkspaceList, type WorkspaceSummary, kindName, safeErrorMessage } from "./ipc";
import { EDITING_ELSEWHERE, EDITING_ELSEWHERE_HINT, documentWindowProblem, documentWindowRequest, documentWindowUrl } from "./document-window";
import { type DocumentLanguage, Editor, languageForFile, softWrapEnabled } from "./editor/editor";
import { patchChildren } from "./dom-patch";
import { parseVaultFilePath } from "./file-path";
import { type DroppedEntry, IMPORT_PARALLEL, type Skip, foldersByLevel, importProgress, importStopped, importSummary, limitMessage, planImport, readImportText, runPool, scanDrop, uniqueName as uniqueAmong } from "./folder-import";
import { HtmlPreview, SAFE_IMAGE_SRC } from "./html-preview";
import { focusPaneTarget, MAX_LINK_LENGTH, openAppWindow, openInBrowserTab, previewTarget, scrollPaneTo, setExternalLinkHandler, setInternalLinkHandler } from "./navigation";
import { headingText, parseMarkdownOutline, type OutlineItem } from "./outline";
import { DEFAULT_LAYOUT, type PanelLayout, layoutToWire } from "./panel-layout";
import { PanelResizers } from "./panel-resizer";
import { ZOOM, type ZoomKey, zoomed, zoomKey } from "./preview-zoom";
import { ROOT_ID as ROOT, TRASH_ID as TRASH, TreeModel } from "./tree-model";
import { TreeView } from "./tree-view";
import { type HeadingTrack, type PreviewMode, type WritingMode, lastAtOrBefore, lineForPreviewOffset, modeAfterFocus, previewOffsetForLine, toggledMode, viewKey } from "./view-mode";
import { type ContextAction, ContextMenu, icon } from "./ui/primitives";
import { countText } from "./word-count";
import { HeadingIds, type InternalLink, type VaultEntry, VaultIndex, fragmentIds, parseInternalHref, pathIndex, previewHref, resolveInternalLink, wikiHref } from "./vault-links";
import { ACCENTS, type Accent, DEFAULT_ACCENT, applyAccent, setTheme } from "./theme";
import {
  MemoryWorkspaces,
  type WorkspaceFormValues,
  type WorkspaceStore,
  activeWorkspace,
  checkWorkspaceForm,
  defaultWorkspaceName,
  isStartupProblem,
  launchStep,
  locationChanged,
  locationLabel,
  rememberByDefault,
  unlockFailureStep,
  workspaceErrorMessage,
  workspaceInitial,
  workspaceInput,
} from "./workspaces";

/** What the window shows; screens other than "main" hold no decrypted data. */
type Screen = "starting" | "blocked" | "connect" | "opening" | "unlock" | "main";

/** The preview's top block and how far into it the top is; an HTML page's scroll share. */
type PreviewPlace = { element: Element; fraction: number; offset: number } | { ratio: number };

/** Where the reader is, taken before a view or focus mode change (readingPlace). */
type ReadingPlace = {
  /** The editor's top line, when it was shown. */
  editorLine: number | null;
  /** The preview's top block, when it was shown. */
  previewBlock: PreviewPlace | null;
  /** The source line at the preview's top, when only the preview was shown. */
  previewLine: number | null;
};

const isTauri = "__TAURI_INTERNALS__" in window;
const isMac = navigator.platform.includes("Mac");
/** A document window (window.rs, document-window.ts): one document, nothing else. */
const DOCUMENT_WINDOW = documentWindowRequest(location.search);
/** Shortcut hints in tooltips and menus. */
const READ_WRITE_KEYS = isMac ? "⌘⇧V" : "Ctrl+Shift+V";
const NEW_WINDOW_KEYS = isMac ? "⌘⇧O" : "Ctrl+Shift+O";
/** The content zoom is saved this long after its last change (one IPC per burst of zoom keys). */
const ZOOM_SAVE_DELAY_MS = 500;
/** How long the zoom level shows after a zoom key before it fades out (zoomContent). */
const ZOOM_NOTE_MS = 1000;
const APP_TITLE = "Notebook";
/**
 * A document window stays read-only while Rust renames, moves or trashes its
 * document (flushForRename until document-window-resume); after this long it
 * writes again whatever happens, and Rust still refuses an early edit (BUSY).
 */
const MOVE_FREEZE_MAX_MS = 120_000;
const PREVIEW_DELAY_MS = 300;
/**
 * Outline rows drawn at a time; the next ones follow as the outline scrolls
 * (a 12 MB document has 36k headings, and a DOM of them all froze WebKit
 * for seconds).
 */
const OUTLINE_CHUNK = 400;
/** How often a focused HTML page frame is checked for a selection (syncFrameWatch). */
const FRAME_FOCUS_POLL_MS = 250;
/** One arrow key's scroll of an HTML page from its preview (scrollFrame), as WebKit scrolls a page. */
const FRAME_LINE_PX = 40;
/** Above this, the preview renders only when asked (the Render button). */
const LARGE_PREVIEW_CHARS = 512 * 1024;
/** The preview's top-level headings: the source's headings, in the same order. */
const PREVIEW_HEADINGS = ":scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > h5, :scope > h6";
const ALL_HEADINGS = "h1, h2, h3, h4, h5, h6";
const MAX_PREVIEW_BYTES = 16 * 1024 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const IMAGE_TYPE = /^image\/(png|jpeg|gif|webp)$/i;
const HTML_STARTER = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Untitled page</title>
  <style>
    body { max-width: 760px; margin: 64px auto; padding: 0 24px; font: 16px/1.6 system-ui, sans-serif; color: #1f2937; }
    h1 { letter-spacing: -0.04em; }
  </style>
</head>
<body>
  <main>
    <h1>Untitled page</h1>
    <p>This HTML is encrypted before it is stored in S3.</p>
  </main>
</body>
</html>
`;

const sampleNodes: TreeNode[] = [
  { id: ROOT, parent: null, name: "Vault", kind: "Root" },
  { id: TRASH, parent: null, name: "Trash", kind: "Trash" },
  { id: "f1", parent: ROOT, name: "Project Pipeline", kind: "Folder" },
  { id: "f2", parent: ROOT, name: "Personal", kind: "Folder" },
  { id: "d1", parent: ROOT, name: "Welcome.md", kind: "Document" },
  { id: "d2", parent: "f1", name: "games.md", kind: "Document" },
  { id: "d3", parent: "f1", name: "Roadmap.md", kind: "Document" },
  { id: "d4", parent: "f2", name: "Reading list.md", kind: "Document" },
  { id: "d5", parent: ROOT, name: "Page.html", kind: "Document" },
];

/** Browser mode: a fresh copy each time the sample workspace opens (lock clears it). */
const sampleDocs = (): Map<string, DocumentData> => new Map<string, DocumentData>([
  ["d1", { readOnly: false, text: `# Notebook\n\nYour notes are encrypted **before** they reach S3. Names, folder structure, and contents use the same client-side encryption format as \`amed/notebook\`.\n\n## What is protected\n\n- Document and folder names\n- Markdown contents\n- Images and deleted items\n- The encryption phrase stays on this device\n\n> Open **Project Pipeline / games.md** to continue where the existing Notebook workspace left off.\n\n## Links\n\nJump to [what is protected](#what-is-protected), read the [storage format](Project%20Pipeline/games.md#storage-format), see [[Roadmap#Later|what comes later]] or the [[Reading list]]. A link to a [missing note](Nowhere.md) says so.\n` }],
  ["d2", { readOnly: false, text: `# Games pipeline\n\nA focused workspace for the current game research pipeline.\n\n## Next up\n\n- [x] Define the collection model\n- [x] Encrypt filenames and content before upload\n- [ ] Add cover-image paste and drag support\n- [ ] Review the release checklist\n\n## Storage format\n\nEach path segment is encrypted with **AES-256-GCM-SIV** and encoded as base64url. Document bodies use a fresh 12-byte nonce followed by authenticated ciphertext.\n\nThis means the same bucket can be opened by both Notebook and this app.\n\nBack to [the welcome page](../Welcome.md#links), up to [the project folder](./), or on to [[Roadmap]].\n` }],
  ["d3", { readOnly: false, text: `# Roadmap\n\n## Now\n\n1. Legacy bucket compatibility\n2. Fast editing\n3. Reliable background saves\n\n\`\`\`sh\n# Not a heading: fenced code\n\`\`\`\n\n## Later\n\n- Cross-device conflict UI\n- Encrypted image cache\n- Release signing\n` }],
  ["d4", { readOnly: false, text: `# Reading list\n\n- Cryptographic Engineering\n- Designing Data-Intensive Applications\n- The Rustonomicon (carefully)\n` }],
  ["d5", { readOnly: false, text: `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Notebook page</title>
  <style>
    :root { font: 16px/1.55 system-ui, sans-serif; color: #18212f; background: #eef2ff; }
    body { max-width: 760px; margin: 0 auto; padding: 64px 28px; }
    main { padding: 42px; border: 1px solid #d6dcf0; border-radius: 22px; background: white; box-shadow: 0 18px 55px #3341551f; }
    .eyebrow { color: #6d5dd3; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
    h1 { margin: .25em 0; font-size: clamp(2.3rem, 8vw, 4.8rem); line-height: .95; letter-spacing: -.06em; }
    p { color: #556070; }
    a { color: #5b4cc4; }
  </style>
</head>
<body>
  <main>
    <div class="eyebrow">Encrypted HTML</div>
    <h1>A real page, kept private.</h1>
    <p>Edit this source, choose <strong>Split</strong>, and watch the page update. Scripts, forms, navigation, and network requests stay blocked inside the preview.</p>
    <a href="#details">Jump to details</a>
    <h2 id="details">Stored like every other note</h2>
    <p>The filename and the complete HTML document use the same Notebook-compatible encryption before S3 sees them.</p>
  </main>
</body>
</html>
` }],
]);

declare global {
  interface Window {
    /** Called by Rust when the window closes while unlocked (window.rs). */
    __notebookBeforeClose?: () => Promise<void>;
    /** Document windows: called by Rust before a rename, move or Trash of their document (window.rs). */
    __notebookFlush?: (request: number) => Promise<void>;
  }
}


/**
 * Rust sends its events to one window (`emit_to`). The global `listen`
 * would also receive those meant for other windows, so each window listens
 * on itself only (Rust's `emit` to all still arrives).
 */
function listenHere<T>(event: string, handler: EventCallback<T>): Promise<UnlistenFn> {
  return getCurrentWebviewWindow().listen<T>(event, handler);
}

let linkChannel: BroadcastChannel | null = null;
/** Browser mode: document windows hand vault links to the main window here (the app goes through Rust). */
function documentLinks(): BroadcastChannel | null {
  if (isTauri || typeof BroadcastChannel === "undefined") return null;
  linkChannel ??= new BroadcastChannel("notebook-document-links");
  return linkChannel;
}
class App {
  private root = document.querySelector<HTMLElement>("#app")!;
  /** The vault's tree; changes arrive as deltas, Refresh lists S3 again. */
  private tree = treeOf(sampleNodes);
  private treeView: TreeView | null = null;
  private resyncTimer: number | null = null;
  /** A draw of the tree waiting for the next frame (drawSoon). */
  private drawFrame: number | null = null;
  /** A drop is being imported; another waits for it. */
  private importing = false;
  /** Browser mode: what each Trash entry holds, for Restore. */
  private localTrash = new Map<string, TreeNode[]>();
  private docs = sampleDocs();
  private selected = "d2";
  private expanded = new Set([ROOT, "f1"]);
  private previewMode: PreviewMode = "split";
  /** The writing mode Cmd+Shift+V goes back to from Preview (Edit or Split). */
  private writingMode: WritingMode = "split";
  /** F9: the document alone, without sidebar, header, status bar or outline; the window title is its name. */
  private focusMode = false;
  /** The view mode focus mode started from; leaving it gives it back (modeAfterFocus). */
  private modeBeforeFocus: PreviewMode = "split";
  /** The OS window title last set: "Notebook", or the file name in focus mode. */
  private windowTitle = APP_TITLE;
  /** Focus mode on an HTML page: takes the keys back from the page's frame (syncFrameWatch). */
  private frameWatch: number | null = null;
  /**
   * A document window (spec D): one document in focus mode, no sidebar,
   * header, status bar or workspace; Rust says which document it holds.
   */
  private readonly docWindow = DOCUMENT_WINDOW !== null;
  /** Main window: another window writes the open document, so it is read-only here (spec E). */
  private openElsewhere = false;
  /** Document window: renames, moves or Trash of its document under way (flushForRename). */
  private moveFreezes = 0;
  private moveThaw: (() => void) | null = null;
  private moveTimer: number | null = null;
  /** Main window: a lock, switch or quit is closing the workspace; document windows closing then change nothing here. */
  private exiting = false;
  private editor: Editor | null = null;
  // Edits go to the encrypted local outbox within a second and to S3 on
  // Cmd/Ctrl+S, switch, blur, close, lock, 30 s idle or 120 s of typing.
  private documents = new DocumentSession({
    open: async (id) => {
      if (!isTauri) return this.docs.get(id) ?? { text: "", readOnly: false };
      // Opened or saved before: Rust answers from its cache, without S3,
      // and leaves out a text the editor still holds (a switch back).
      let opened = await ipc.docOpen(id, this.editor?.revOf(id) ?? null);
      // The editor let its copy go meanwhile.
      if (opened.text === null && this.editor?.revOf(id) !== opened.rev) opened = await ipc.docOpen(id);
      return { text: opened.text, readOnly: opened.read_only, dirty: opened.dirty, rev: opened.rev };
    },
    stage: async (id, text) => {
      if (isTauri) {
        const staged = await ipc.docStage(id, text);
        this.editor?.staged(id, text, staged.rev);
        return staged.status;
      }
      this.docs.set(id, { text, readOnly: false });
      return "Staged";
    },
    commit: async (id) => {
      if (!isTauri) return { status: "Saved" };
      const result = await ipc.docCommit(id);
      // A conflict copy joins the tree (a document window has none).
      this.applyTree(result.tree);
      return result;
    },
  }, {
    state: (state) => this.setSync(state),
    conflict: (from, to) => void this.afterConflictCopy(from, to),
  });
  private applyingModel = false;
  private locking = false;
  // Preview and outline render only while visible, and only when their key
  // (document, text version, language) changed since the last render.
  /** Bumped by every edit and every model switch. */
  private textVersion = 0;
  private previewKey: string | null = null;
  /** The document whose Markdown blocks the preview shows; patched in place. */
  private previewDoc: string | null = null;
  /** A document switch: the next full preview render starts at the top. */
  private previewFromTop = false;
  /** A source line the preview scrolls to once its render (in flight) is in (showPreviewLine). */
  private previewLineWanted: number | null = null;
  /** The render awaiting Rust's preview_render, if any. */
  private previewInFlight: number | null = null;
  /** A link's #heading, shown once the preview shows the current text of document `id` (revealFragment). */
  private pendingFragment: { id: string; fragment: string } | null = null;
  /** Document window, browser mode: its document's vault path (the app asks Rust at each link). */
  private docWindowPath = "";
  /** The source lines of the open Markdown document's headings, for the reading position. */
  private headingLineCache: { key: string; lines: readonly number[] } | null = null;
  private outlineKey: string | null = null;
  /** The document and headings the outline shows; the same again draws nothing. */
  private outlineSignature: string | null = null;
  /** The outline's rows in order, collapsed branches left out; the first `outlineDrawn` are in the DOM. */
  private outlineRows: OutlineItem[] = [];
  private outlineDrawn = 0;
  /** Draws the next rows once the end of the drawn ones nears the view. */
  private outlineObserver: IntersectionObserver | null = null;
  /** Typing debounce: one timer, re-armed only when it fires early. */
  private renderTimer: number | null = null;
  private renderDueAt = 0;
  private renderFrame: number | null = null;
  private previewSeq = 0;
  private pausedNote: HTMLElement | null = null;
  private wordCount: { panel: HTMLElement; close: () => void } | null = null;
  private htmlPreview = new HtmlPreview((url) => void this.openExternalLink(url), () => this.showPreviewChrome());
  /** Content zoom in percent (preview-zoom.ts): the editor's and the preview's text, global; saved 500 ms after the last change. */
  private contentZoom: number = ZOOM.default;
  private savedZoom: number = ZOOM.default;
  private zoomSaveTimer: number | null = null;
  /** Each shown pane's reading position before a burst of zoom steps, given back in the next frame (zoomContent). */
  private zoomPlace: { editorLine: number | null; preview: PreviewPlace | null } | null = null;
  private zoomFrame: number | null = null;
  private zoomNoteTimer: number | null = null;
  /** Rust in the app; browser mode (`npm run dev`) keeps sample workspaces in memory. */
  private workspaces: WorkspaceStore = isTauri ? tauriWorkspaces() : browserWorkspaces();
  private workspaceList: WorkspaceList = { workspaces: [], active: null };
  private screen: Screen = "starting";
  private switching = false;
  /**
   * Bumped by every switch, lock, delete and leave: an unlock started before
   * that renders nothing when it answers (its workspace is no longer shown).
   */
  private authGeneration = 0;
  /** What had focus when each open dialog appeared; it gets focus back when the dialog closes. */
  private modalOpeners = new WeakMap<HTMLElement, HTMLElement | null>();
  private modalObserver: MutationObserver | null = null;
  /** When the workspace menu last closed: a click on its own button then closes it, not reopens it. */
  private workspaceMenuClosedAt = 0;
  private linkPromptOpen = false;
  private search = "";
  private contextMenu = new ContextMenu();
  private autoLockMinutes = 15;
  private theme: ThemePreference = "System";
  private accent: Accent = DEFAULT_ACCENT;
  private idleTimer: number | null = null;
  private lastActivityPing = 0;
  private outlineVisible = false;
  private collapsedOutline = new Set<string>();
  /** The user's pane sizes: config.json in the app, memory only in browser mode. */
  private panelLayout: PanelLayout = { ...DEFAULT_LAYOUT };
  private resizers: PanelResizers | null = null;

  async start(): Promise<void> {
    setTheme("System");
    setExternalLinkHandler((url) => void this.openExternalLink(url));
    setInternalLinkHandler((href) => this.followVaultLink(href));
    window.__notebookBeforeClose = () => this.beforeClose();
    this.watchModals();
    if (DOCUMENT_WINDOW) {
      await this.startDocumentWindow(DOCUMENT_WINDOW.id);
      return;
    }
    if (isTauri) {
      await listenHere<boolean>("auto-lock", (event) => {
        if (event.payload) this.forcedLock();
        else void this.lock(true);
      });
      // Document windows (window.rs): their commits and closes change what this window may write.
      await listenHere<{ id: string; tree?: TreeDelta | null }>("document-committed", (event) => {
        if (this.screen === "main") this.applyTree(event.payload.tree);
        void this.writerChanged(event.payload.id);
      });
      await listenHere<string>("document-window-closed", (event) => void this.writerChanged(event.payload));
      await listenHere<string[]>("document-windows-gone", (event) => {
        const names = event.payload.map((name) => `“${name}”`).join(", ");
        void this.message("Window closed", `${names} moved to the Trash, so ${event.payload.length === 1 ? "its window was" : "their windows were"} closed. Your edits were saved first.`);
      });
      // Typing in a document window keeps the workspace open.
      await listenHere("window-activity", () => this.armIdleLock());
      // A document window's link to another document (window.rs document_link_open).
      await listenHere<DocumentLink>("document-link", (event) => this.openLinkFromWindow(event.payload));
      try {
        const config = await ipc.configGet();
        this.autoLockMinutes = config.auto_lock_minutes;
        this.theme = config.theme;
        this.accent = config.accent;
        this.panelLayout = config.layout;
        this.contentZoom = this.savedZoom = config.preview_zoom;
        applyAccent(config.accent);
        setTheme(config.theme);
      } catch {
        /* The defaults stay; the workspace list below decides what to show. */
      }
    }
    // Browser mode: document windows hand their links over here.
    documentLinks()?.addEventListener("message", (event: MessageEvent<DocumentLink>) => this.openLinkFromWindow(event.data));
    try {
      this.workspaceList = await this.workspaces.list();
    } catch (caught) {
      if (isStartupProblem(errorCode(caught))) this.renderBlocked(caught);
      else this.renderConnect(null, authErrorMessage(caught, ""));
      return;
    }
    await this.enterActive();
  }

  /**
   * Another Notebook process holds this profile, or its files could not be
   * read: nothing can be shown or changed safely, so the window says why.
   */
  private renderBlocked(caught: unknown): void {
    this.screen = "blocked";
    const screen = this.authScreen();
    const inUse = errorCode(caught) === "PROFILE_IN_USE";
    screen.innerHTML = `<section class="auth-card" role="alert"><div class="auth-logo"></div><h1></h1><p></p></section>`;
    screen.querySelector(".auth-logo")!.append(icon(inUse ? "lock" : "warning"));
    setText(screen.querySelector("h1"), inUse ? "Notebook is already open" : "Notebook could not start");
    setText(screen.querySelector("p"), authErrorMessage(caught, "Quit Notebook and open it again."));
  }

  /**
   * A document window (spec D): Rust says which document this window holds
   * (by its label, for the session it was opened in), and the page shows
   * only that document, in focus mode and in Preview. Cmd/Ctrl+Shift+V
   * switches to writing, Cmd/Ctrl+S uploads, and closing saves first (the
   * close guard). F9 and Esc do nothing: there is no chrome to bring back.
   * The URL's id is only what the page asked for; it never decides anything.
   */
  private async startDocumentWindow(requested: string): Promise<void> {
    let held: { id: string; name: string };
    if (isTauri) {
      window.__notebookFlush = (request) => this.flushForRename(request);
      await listenHere<HeldMove>("document-window-moved", (event) => this.heldMoved(event.payload));
      await listenHere("document-window-resume", () => this.resumeAfterMove());
      try {
        const info = await ipc.documentWindowInfo();
        this.theme = info.theme;
        this.accent = info.accent;
        applyAccent(info.accent);
        setTheme(info.theme);
        this.contentZoom = this.savedZoom = info.preview_zoom;
        held = info;
        this.docWindowPath = info.path;
      } catch (caught) {
        this.renderWindowProblem(errorCode(caught));
        return;
      }
    } else {
      // Browser mode: the sample documents stand in for Rust.
      const node = sampleNodes.find((item) => item.id === requested && kindName(item) === "Document");
      if (!node) {
        this.renderWindowProblem("INVALID_INPUT");
        return;
      }
      held = node;
      this.docWindowPath = treeOf(sampleNodes).pathOf(node.id);
    }
    this.tree = treeOf([
      { id: ROOT, parent: null, name: "Vault", kind: "Root" },
      { id: held.id, parent: ROOT, name: held.name, kind: "Document" },
    ]);
    this.selected = held.id;
    this.expanded = new Set([ROOT]);
    this.focusMode = true;
    this.previewMode = "preview";
    this.renderMain();
    this.showWindowTitle(held.name);
    // Arrow, page and space keys read the document at once.
    this.focusPane();
  }

  /** A document window with nothing to show: why, and a way to close it. */
  private renderWindowProblem(code: string | null): void {
    this.screen = "blocked";
    const problem = documentWindowProblem(code);
    const screen = this.authScreen();
    screen.innerHTML = `<section class="auth-card" role="alert"><div class="auth-logo"></div><h1></h1><p></p><div class="auth-actions"><span class="auth-spacer"></span><button class="button button-primary" type="button">Close window</button></div></section>`;
    screen.querySelector(".auth-logo")!.append(icon(code === "INVALID_INPUT" ? "document" : "lock"));
    setText(screen.querySelector("h1"), problem.title);
    setText(screen.querySelector("p"), problem.detail);
    const close = screen.querySelector<HTMLButtonElement>("button")!;
    close.addEventListener("click", () => {
      if (isTauri) void ipc.documentWindowClose().catch(() => { /* The window's own close button still works. */ });
      else window.close();
    });
    close.focus();
    document.title = problem.title;
  }

  /**
   * Document window: Rust renames, moves or trashes this document next. The
   * pending edit goes to the outbox first (it is uploaded before the move),
   * and the editor stays read-only until Rust says the change is over
   * (resumeAfterMove): an edit typed meanwhile would go to a key that is
   * about to disappear, and a trashed document's window closes.
   */
  private async flushForRename(request: number): Promise<void> {
    if (this.editor && this.moveFreezes++ === 0) {
      this.moveThaw = this.editor.freeze("Wait a moment: this document is being renamed or moved…");
      this.documents.hold();
    }
    if (this.moveTimer !== null) clearTimeout(this.moveTimer);
    this.moveTimer = window.setTimeout(() => this.resumeAfterMove(true), MOVE_FREEZE_MAX_MS);
    await this.documents.persist();
    try { await ipc.documentWindowFlushed(request); } catch { /* Rust stops waiting after 2 s. */ }
  }

  /**
   * Document window: the rename, move or Trash is over (or failed). The
   * editor writes again, and an edit Rust refused meanwhile (BUSY) is
   * written and uploaded under the document's id, new or not.
   */
  private resumeAfterMove(all = false): void {
    if (this.moveFreezes === 0) return;
    this.moveFreezes = all ? 0 : this.moveFreezes - 1;
    if (this.moveFreezes > 0) return;
    if (this.moveTimer !== null) clearTimeout(this.moveTimer);
    this.moveTimer = null;
    this.moveThaw?.();
    this.moveThaw = null;
    this.documents.release();
    void this.documents.persist().then(() => this.documents.retryNow());
  }

  /**
   * Document window: a rename or move gave this document a new id and name
   * (Rust retitled the window), or the edit became a conflict copy that
   * this window writes now. The editor keeps its model and undo history.
   */
  private heldMoved(change: HeldMove): void {
    const node = this.tree.get(change.from) ?? this.tree.get(change.to);
    if (!node || !this.editor) return;
    if (change.from !== change.to && this.tree.has(change.from)) {
      this.tree.change([{ ...node, id: change.to, name: change.name }], [change.from]);
      this.selected = change.to;
      if (this.documents.openId === change.from) this.documents.retarget(change.from, change.to);
      this.retargetOpen(change.from, change.to);
    } else {
      this.tree.change([{ ...node, name: change.name }]);
    }
    const shown = this.tree.get(change.to);
    if (!shown) return;
    this.showDocumentName(shown);
    this.showWindowTitle(shown.name);
    this.applyPreviewMode();
  }

  /** Starts a new auth step; unlocks started before it are dropped when they answer. */
  private nextAuth(): number {
    return ++this.authGeneration;
  }

  private activeWorkspace(): WorkspaceSummary | null {
    return activeWorkspace(this.workspaceList);
  }

  /** Reads the list again (no S3 request); a failure keeps the last one. */
  private async reloadWorkspaces(): Promise<void> {
    try {
      this.workspaceList = await this.workspaces.list();
    } catch {
      /* The next change or launch reads it again. */
    }
    this.updateWorkspacePicker();
  }

  /**
   * Shows the active workspace: the first-run screen when there is none, the
   * connect screen when its credentials are missing, the workspace itself when
   * its phrase is remembered, and the unlock screen otherwise.
   */
  private async enterActive(message = ""): Promise<void> {
    const step = launchStep(this.workspaceList);
    switch (step.kind) {
      case "setup":
        this.renderConnect(null, message);
        return;
      case "select":
        try {
          await this.workspaces.select(step.workspace.id);
          await this.reloadWorkspaces();
        } catch (caught) {
          this.renderUnlock(step.workspace, authErrorMessage(caught, ""));
          return;
        }
        if (this.activeWorkspace()) await this.enterActive(message);
        else this.renderUnlock(step.workspace, message);
        return;
      case "connect":
        this.renderConnect(step.workspace, message || authErrorMessage({ code: "NO_CREDENTIALS" }, ""));
        return;
      case "open":
        await this.openRemembered(step.workspace);
        return;
      case "unlock":
        this.renderUnlock(step.workspace, message);
        return;
    }
  }

  /** Opens a workspace with its remembered phrase; any failure asks instead and keeps every stored secret. */
  private async openRemembered(workspace: WorkspaceSummary): Promise<void> {
    this.renderOpening(workspace);
    const generation = this.authGeneration;
    try {
      if (!(await this.unlockActive(null, undefined, generation))) return;
    } catch (caught) {
      if (generation !== this.authGeneration) return;
      await this.afterUnlockFailure(
        workspace,
        caught,
        errorCode(caught) === "WRONG_PHRASE"
          ? "The remembered encryption phrase did not open this workspace. Enter the current phrase."
          : authErrorMessage(caught, "Could not open this workspace. Check the connection and try again."),
      );
      return;
    }
    this.renderMain();
  }

  /**
   * Unlocks the active workspace and loads its tree (browser mode: the
   * sample). False when a switch, lock or delete started meanwhile
   * (`generation` is stale): then nothing was loaded and nothing is shown.
   */
  private async unlockActive(phrase: string | null, remember: boolean | undefined, generation: number): Promise<boolean> {
    const snapshot = await this.workspaces.unlock(phrase, remember);
    if (generation !== this.authGeneration) return false;
    if (snapshot) {
      this.tree.replace(snapshot);
      this.selected = this.tree.firstDocument() ?? "";
    } else {
      this.docs = sampleDocs();
      this.tree.replace({ nodes: sampleNodes });
      this.expanded = new Set([ROOT, "f1"]);
      this.selected = "d2";
    }
    // Remember may have stored or forgotten the phrase.
    await this.reloadWorkspaces();
    return generation === this.authGeneration;
  }

  /** Routes a failed unlock: missing credentials to the connect screen, the rest to the unlock screen. */
  private async afterUnlockFailure(workspace: WorkspaceSummary, caught: unknown, message: string): Promise<void> {
    const code = errorCode(caught);
    if (code === "NO_STORED_PHRASE" || code === "WORKSPACE_CHANGED" || code === "NO_WORKSPACE") await this.reloadWorkspaces();
    const current = this.activeWorkspace() ?? workspace;
    switch (unlockFailureStep(code)) {
      case "connect":
        this.renderConnect(current, message);
        return;
      case "setup":
        await this.enterActive(message);
        return;
      case "unlock":
        this.renderUnlock(current, message);
        return;
    }
  }

  private authScreen(): HTMLElement {
    this.root.innerHTML = "";
    const screen = document.createElement("main");
    screen.className = "auth-screen";
    this.root.append(screen);
    return screen;
  }

  /**
   * The first-run screen (`workspace` null) creates the first workspace and
   * opens it. For a workspace whose credentials are missing it fills them in
   * again; stored secrets are kept where a field is left blank.
   */
  private renderConnect(workspace: WorkspaceSummary | null, message = ""): void {
    this.screen = "connect";
    const screen = this.authScreen();
    const title = workspace ? `Reconnect “${workspace.name}”` : "Connect your encrypted workspace";
    const intro = workspace
      ? "Enter this workspace's S3 credentials again. Fields you leave blank keep what is stored on this device."
      : "Use the same bucket, prefix, credentials, and encryption phrase as Notebook. You can add more workspaces later and switch between them.";
    screen.innerHTML = `
      <section class="auth-card auth-card-wide">
        <div class="auth-logo"></div>
        <h1>${escapeHtml(title)}</h1>
        <p>${escapeHtml(intro)}</p>
        <form class="form-grid" id="setup-form" novalidate>
          ${workspaceFields(workspace, { create: !workspace, connect: true })}
          <p class="error" id="setup-error" role="alert"></p>
          <div class="auth-actions">
            ${workspace ? '<button class="button button-ghost" type="button" id="switch-workspace" aria-haspopup="menu" aria-expanded="false">Switch workspace</button><span class="auth-spacer"></span>' : ""}
            <button class="button button-primary" type="submit">${workspace ? "Save and unlock" : "Connect workspace"}</button>
          </div>
        </form>
        <div class="secure-note" id="secure-note"><span></span><span>Paths and contents are encrypted locally with the Notebook-compatible AES-256-GCM-SIV format before upload. Credentials and a remembered phrase are sealed on this device; only their key is in the OS keychain.</span></div>
      </section>`;
    screen.querySelector(".auth-logo")!.append(icon("lock"));
    screen.querySelector("#secure-note span")!.append(icon("shield"));
    const form = screen.querySelector<HTMLFormElement>("#setup-form")!;
    bindWorkspaceFields(form);
    form.querySelector<HTMLElement>("#setup-error")!.textContent = message;
    const switcher = screen.querySelector<HTMLButtonElement>("#switch-workspace");
    switcher?.addEventListener("click", () => this.toggleWorkspaceMenu(switcher));
    // The first save creates the workspace; a retry after a wrong phrase updates it.
    let target = workspace;
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.submitConnect(form, target).then((saved) => { if (saved) target = saved; });
    });
    if (!dialogOpen()) (form.elements.namedItem(workspace ? "accessKeyId" : "bucket") as HTMLInputElement | null)?.focus();
  }

  /** Saves the connect form, then unlocks with the typed (or remembered) phrase. Returns the saved workspace. */
  private async submitConnect(form: HTMLFormElement, target: WorkspaceSummary | null): Promise<WorkspaceSummary | null> {
    const error = form.querySelector<HTMLElement>("#setup-error")!;
    const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    const label = submit.textContent ?? "";
    const values = readWorkspaceForm(form);
    const problem = checkWorkspaceForm(values, { existing: target, others: this.workspaceList.workspaces, requirePhrase: true });
    showFormProblem(form, error, problem);
    if (problem) return null;
    const switcher = this.root.querySelector<HTMLButtonElement>("#switch-workspace");
    const busy = (on: boolean): void => {
      submit.disabled = on;
      submit.textContent = on ? "Connecting…" : label;
      if (switcher) switcher.disabled = on;
    };
    busy(true);
    const generation = this.nextAuth();
    let saved: WorkspaceSummary | null = null;
    try {
      saved = await this.workspaces.save(workspaceInput(values, target, { withPhrase: false }));
      if (generation !== this.authGeneration) return saved;
      if (this.workspaceList.active !== saved.id) await this.workspaces.select(saved.id);
      await this.reloadWorkspaces();
      if (!(await this.unlockActive(values.phrase || null, values.remember, generation))) return saved;
      form.reset();
      this.renderMain();
    } catch (caught) {
      if (generation !== this.authGeneration) return saved;
      const code = errorCode(caught);
      if (code === "NO_STORED_PHRASE") await this.reloadWorkspaces();
      error.textContent = authErrorMessage(caught, "Could not open this workspace. Check the connection details and encryption phrase.");
      busy(false);
    }
    return saved;
  }

  /** The brief state while a remembered phrase opens the workspace. */
  private renderOpening(workspace: WorkspaceSummary): void {
    this.screen = "opening";
    const screen = this.authScreen();
    screen.innerHTML = `<section class="auth-card auth-opening" role="status" aria-live="polite"><span class="workspace-avatar workspace-avatar-large"></span><h1></h1><p></p><div class="auth-progress" aria-hidden="true"></div></section>`;
    setText(screen.querySelector(".workspace-avatar"), workspaceInitial(workspace.name));
    setText(screen.querySelector("h1"), `Opening ${workspace.name}…`);
    setText(screen.querySelector("p"), locationLabel(workspace));
  }

  private renderUnlock(workspace: WorkspaceSummary, message = ""): void {
    this.screen = "unlock";
    const screen = this.authScreen();
    const remembered = workspace.phrase_stored;
    screen.innerHTML = `<section class="auth-card">
      <div class="auth-logo"></div>
      <h1></h1>
      <p class="auth-location"></p>
      <form class="form-grid" id="unlock-form">
        <label class="field">Encryption phrase<input name="phrase" type="password" ${remembered ? 'placeholder="Remembered — leave blank to use it"' : "required"} autocomplete="off" spellcheck="false"></label>
        ${rememberField(rememberByDefault(workspace))}
        <p class="error" role="alert"></p>
        <div class="auth-actions">
          <button class="button button-ghost" type="button" id="switch-workspace" aria-haspopup="menu" aria-expanded="false">Switch workspace</button>
          <button class="button button-ghost" type="button" id="edit-workspace">Edit workspace</button>
          <span class="auth-spacer"></span>
          <button class="button button-primary" type="submit">Unlock</button>
        </div>
      </form>
      <div class="secure-note"><span></span><span>${remembered
        ? "The phrase is remembered on this device, sealed with a key from the OS keychain. It is never uploaded."
        : "The phrase never leaves this device."}</span></div>
    </section>`;
    setText(screen.querySelector("h1"), `Unlock ${workspace.name}`);
    setText(screen.querySelector(".auth-location"), `${locationLabel(workspace)} · Notebook-compatible encryption`);
    screen.querySelector(".auth-logo")!.append(icon("lock"));
    screen.querySelector(".secure-note span")!.append(icon("shield"));
    const switcher = screen.querySelector<HTMLButtonElement>("#switch-workspace")!;
    switcher.addEventListener("click", () => this.toggleWorkspaceMenu(switcher));
    screen.querySelector("#edit-workspace")!.addEventListener("click", () => void this.openWorkspaceForm(workspace));
    const form = screen.querySelector<HTMLFormElement>("#unlock-form")!;
    form.querySelector<HTMLElement>(".error")!.textContent = message;
    form.addEventListener("submit", (event) => void this.submitUnlock(event, workspace));
    if (!dialogOpen()) form.querySelector<HTMLInputElement>('input[name="phrase"]')!.focus();
  }

  private async submitUnlock(event: SubmitEvent, workspace: WorkspaceSummary): Promise<void> {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const input = form.elements.namedItem("phrase") as HTMLInputElement;
    const remember = (form.elements.namedItem("remember") as HTMLInputElement).checked;
    const button = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    const error = form.querySelector<HTMLElement>(".error")!;
    // Switching or editing while S3 answers would show this workspace's result for another one.
    const others = [...this.root.querySelectorAll<HTMLButtonElement>("#switch-workspace, #edit-workspace")];
    const busy = (on: boolean): void => {
      button.disabled = on;
      button.textContent = on ? "Unlocking…" : "Unlock";
      for (const other of others) other.disabled = on;
    };
    busy(true);
    const generation = this.nextAuth();
    try {
      // A blank field uses the remembered phrase; unchecking Remember forgets it.
      if (!(await this.unlockActive(input.value || null, remember, generation))) return;
      input.value = "";
      this.renderMain();
    } catch (caught) {
      if (generation !== this.authGeneration) return;
      input.value = "";
      const code = errorCode(caught);
      if (unlockFailureStep(code) !== "unlock" || code === "NO_STORED_PHRASE" || code === "WORKSPACE_CHANGED") {
        await this.afterUnlockFailure(workspace, caught, authErrorMessage(caught, ""));
        return;
      }
      error.textContent = authErrorMessage(caught, "Could not unlock this workspace. Check the encryption phrase and connection settings.");
      busy(false);
      input.focus();
    }
  }

  private renderMain(): void {
    this.root.innerHTML = `<main class="shell${this.focusMode ? " focus-mode" : ""}${this.docWindow ? " document-window" : ""}">
      <section class="workspace"><aside class="sidebar"><div class="side-heading"><button class="workspace-picker" id="workspace-picker" type="button" aria-haspopup="menu" aria-expanded="false"><span class="workspace-avatar"></span><span class="workspace-picker-name"></span><span class="workspace-picker-chevron"></span></button><div class="side-actions"><button class="icon-button header-action" id="new-file" type="button" title="New file" aria-label="New file"></button><button class="icon-button header-action" id="new-folder" type="button" title="New folder" aria-label="New folder"></button></div></div><div class="search-wrap"><span></span><input class="search" placeholder="Quick open…" aria-label="Search titles" autocomplete="off" spellcheck="false"><button class="icon-button search-clear" id="search-clear" type="button" title="Clear search" aria-label="Clear search" hidden></button></div><div class="tree" role="tree"></div><div class="side-bottom"><button class="trash-button"><span></span><span>Trash</span><span class="trash-count">0</span></button></div><div class="file-drop-hint" aria-hidden="true"><span class="file-drop-icon"></span><strong>Import files</strong><span>Drop Markdown, text, or HTML here</span></div></aside><div class="panel-resizer sidebar-resizer" role="separator" aria-orientation="vertical" aria-label="Resize sidebar" title="Drag to resize, double-click to reset" tabindex="0"></div>
      <section class="content"><header class="document-bar"><div class="doc-breadcrumb"><span class="doc-folders" hidden><bdi dir="ltr"></bdi></span><span class="doc-separator" aria-hidden="true" hidden>/</span><span class="doc-title"></span></div><button class="elsewhere-note" id="elsewhere" type="button" title="Editing in another window: click to show it" aria-label="Editing in another window: show it" hidden></button><div class="header-actions"><button class="icon-button header-action" id="outline-toggle" type="button" aria-expanded="false" title="Outline" aria-label="Outline"></button><div class="segmented" role="group" aria-label="View mode"><button class="icon-button header-action" type="button" data-mode="edit" title="Edit (${READ_WRITE_KEYS} to read)" aria-label="Edit" aria-pressed="false"></button><button class="icon-button header-action" type="button" data-mode="split" title="Split (${READ_WRITE_KEYS} to read)" aria-label="Split" aria-pressed="false"></button><button class="icon-button header-action" type="button" data-mode="preview" title="Preview (${READ_WRITE_KEYS} to write, F9 focus mode)" aria-label="Preview" aria-pressed="false"></button></div><button class="icon-button header-action" id="open-window" type="button" disabled title="Open in new window (${NEW_WINDOW_KEYS})" aria-label="Open in new window"></button><span class="header-divider" aria-hidden="true"></span><button class="icon-button header-action" id="refresh" type="button" title="Refresh" aria-label="Refresh"></button><button class="icon-button header-action" id="settings" type="button" title="Settings" aria-label="Settings"></button><button class="icon-button header-action" id="lock" type="button" title="Lock workspace" aria-label="Lock workspace"></button></div></header><div class="editor-area"><aside class="outline-panel" aria-label="Document outline"><header><strong>Outline</strong><div><button type="button" id="outline-expand" title="Expand all headings">Expand</button><button type="button" id="outline-collapse" title="Collapse all headings">Collapse</button><button class="icon-button outline-close" id="outline-close" type="button" title="Close outline" aria-label="Close outline"></button></div></header><div class="outline-tree" role="tree" aria-label="Markdown headings"></div></aside><div class="panel-resizer outline-resizer" role="separator" aria-orientation="vertical" aria-label="Resize outline" title="Drag to resize, double-click to reset" tabindex="0"></div><div class="editor-host"></div><div class="panel-resizer split-resizer" role="separator" aria-orientation="vertical" aria-label="Resize editor and preview" title="Drag to resize, double-click to reset" tabindex="0"></div><article class="preview" tabindex="-1"></article><div class="zoom-indicator" role="status" aria-live="polite" aria-atomic="true"><span class="zoom-indicator-label">Zoom </span><span class="zoom-indicator-level"></span></div></div></section><div class="resize-overlay" aria-hidden="true" hidden></div></section>
      <footer class="statusbar"><button class="sync clean" type="button" title="Saved" aria-label="Saved"><span class="sync-dot"></span><span class="sync-label"></span></button><span class="encryption-label">End-to-end encrypted</span><span class="status-spacer"></span><span class="scripts-off" id="scripts-off" hidden></span><button class="status-button" id="word-count" type="button" aria-haspopup="dialog" aria-expanded="false">Word count</button><button class="status-button" id="soft-wrap" type="button" aria-pressed="true">Wrap</button><span>UTF-8</span><span class="language-label">Markdown</span></footer>
    </main>`;
    this.screen = "main";
    this.root.querySelector(".workspace-picker-chevron")!.append(icon("chevron"));
    this.root.querySelector("#refresh")!.append(icon("refresh"));
    this.root.querySelector("#settings")!.append(icon("gear"));
    this.root.querySelector("#lock")!.append(icon("lock"));
    this.root.querySelector("#new-file")!.append(icon("document"));
    this.root.querySelector("#new-folder")!.append(icon("folder"));
    this.root.querySelector("#outline-toggle")!.append(icon("list"));
    this.root.querySelector('[data-mode="edit"]')!.append(icon("pencil"));
    this.root.querySelector('[data-mode="split"]')!.append(icon("columns"));
    this.root.querySelector('[data-mode="preview"]')!.append(icon("preview"));
    this.root.querySelector("#open-window")!.append(icon("window"));
    const elsewhere = this.root.querySelector<HTMLElement>("#elsewhere")!;
    const elsewhereLabel = document.createElement("span");
    elsewhereLabel.className = "elsewhere-label";
    elsewhereLabel.textContent = EDITING_ELSEWHERE;
    // A narrow header shows only the icon (theme.css); the name keeps the room.
    elsewhere.append(icon("window"), elsewhereLabel);
    this.showSoftWrap();
    this.root.querySelector(".search-wrap span")!.append(icon("search"));
    this.root.querySelector("#search-clear")!.append(icon("close"));
    this.root.querySelector("#outline-close")!.append(icon("close"));
    this.root.querySelector(".trash-button span")!.append(icon("trash"));
    this.root.querySelector(".file-drop-icon")!.append(icon("archive"));
    const editorHost = this.root.querySelector<HTMLElement>(".editor-host")!;
    this.editor = new Editor(editorHost, () => this.onTextChanged());
    editorHost.addEventListener("paste", (event) => void this.onImagePaste(event), true);
    // Capture phase, ahead of the editor; navigation.ts still refuses every other drop.
    editorHost.addEventListener("dragover", this.onImageDragOver, true);
    editorHost.addEventListener("drop", (event) => void this.onImageDrop(event), true);
    this.treeView = new TreeView(this.root.querySelector<HTMLElement>(".tree")!, this.tree, {
      activate: (id) => this.activateNode(id),
      rename: (id) => { const node = this.tree.get(id); if (node) void this.renameNode(node); },
      menu: (id, x, y) => {
        const node = this.tree.get(id);
        if (!node) return;
        this.selectNode(id);
        this.showNodeMenu(node, x, y);
      },
      key: (id, event) => { const node = this.tree.get(id); if (node) this.onTreeKeyDown(event, node); },
      drop: (moved, folder) => void this.moveNode(moved, folder),
    });
    this.resizers = new PanelResizers({
      containers: [...this.root.querySelectorAll<HTMLElement>(".workspace, .editor-area, .outline-panel, .panel-resizer")],
      overlay: this.root.querySelector<HTMLElement>(".resize-overlay")!,
      handles: {
        sidebar: this.root.querySelector<HTMLElement>(".sidebar-resizer")!,
        outline: this.root.querySelector<HTMLElement>(".outline-resizer")!,
        split: this.root.querySelector<HTMLElement>(".split-resizer")!,
      },
      context: () => ({ outline: this.outlineShown(), split: this.previewMode === "split" }),
      commit: (layout) => this.saveLayout(layout),
    }, this.panelLayout);
    this.bindMainEvents();
    this.updateWorkspacePicker();
    this.renderTree();
    void this.openDocument(this.selected);
  }

  private bindMainEvents(): void {
    const search = this.root.querySelector<HTMLInputElement>(".search")!;
    search.addEventListener("input", () => {
      this.search = search.value;
      this.showSearchClear();
      this.renderTree();
    });
    // Esc clears the query first; a second Esc leaves the field.
    search.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || event.isComposing) return;
      event.preventDefault();
      if (search.value) this.clearSearch();
      else search.blur();
    });
    const clear = this.root.querySelector<HTMLButtonElement>("#search-clear")!;
    // The field keeps the focus (and its caret) through the click.
    clear.addEventListener("mousedown", (event) => event.preventDefault());
    clear.addEventListener("click", () => this.clearSearch());
    this.root.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach((button) => button.addEventListener("click", () => {
      const mode = button.dataset.mode as PreviewMode;
      if (mode === this.previewMode) return;
      const place = this.readingPlace();
      this.previewMode = mode;
      this.applyPreviewMode();
      this.restoreReadingPlace(place);
    }));
    this.root.querySelector("#new-file")!.addEventListener("click", () => void this.createFile());
    this.root.querySelector("#new-folder")!.addEventListener("click", () => void this.createFolder());
    this.root.querySelector("#outline-toggle")!.addEventListener("click", () => this.toggleOutline());
    this.root.querySelector("#outline-close")!.addEventListener("click", () => {
      if (this.outlineVisible) this.toggleOutline();
      this.root.querySelector<HTMLButtonElement>("#outline-toggle")?.focus();
    });
    this.root.querySelector("#outline-expand")!.addEventListener("click", () => {
      this.collapsedOutline.clear();
      this.renderOutline(true);
    });
    this.root.querySelector("#outline-collapse")!.addEventListener("click", () => {
      this.collapsedOutline = new Set(flattenOutline(parseMarkdownOutline(this.editor?.text() ?? "")).filter((item) => item.children.length).map((item) => item.id));
      this.renderOutline(true);
    });
    // One listener for every row (Enter and Space on a row's button click it too).
    this.root.querySelector(".outline-tree")!.addEventListener("click", (event) => {
      const button = event.target instanceof Element ? event.target.closest<HTMLElement>(".outline-disclosure, .outline-heading") : null;
      const index = Number(button?.closest<HTMLElement>(".outline-item")?.dataset.index);
      const item = this.outlineRows[index];
      if (!button || !item) return;
      if (button.classList.contains("outline-heading")) {
        this.revealOutlineItem(item);
        return;
      }
      if (!this.collapsedOutline.delete(item.id)) this.collapsedOutline.add(item.id);
      this.renderOutline(true);
      this.root.querySelector<HTMLElement>(`.outline-item[data-index="${index}"] .outline-disclosure`)?.focus();
    });
    this.root.querySelector("#refresh")!.addEventListener("click", () => void this.refresh().catch(async (caught: unknown) => this.message("Could not refresh", ipcMessage(caught))));
    this.root.querySelector("#settings")!.addEventListener("click", () => void this.openSettings());
    this.root.querySelector("#lock")!.addEventListener("click", () => void this.lock());
    this.root.querySelector("#open-window")!.addEventListener("click", () => void this.openInNewWindow());
    this.root.querySelector("#elsewhere")!.addEventListener("click", () => void this.openInNewWindow());
    const picker = this.root.querySelector<HTMLButtonElement>("#workspace-picker")!;
    picker.addEventListener("click", () => this.toggleWorkspaceMenu(picker));
    this.root.querySelector(".trash-button")!.addEventListener("click", () => this.showTrash());
    this.root.querySelector(".sync")!.addEventListener("click", () => void this.documents.syncNow());
    const wordCount = this.root.querySelector<HTMLButtonElement>("#word-count")!;
    // Keep the focus (and the caret) where it was; the next keystroke closes the panel.
    wordCount.addEventListener("mousedown", (event) => event.preventDefault());
    wordCount.addEventListener("click", () => this.toggleWordCount());
    const softWrap = this.root.querySelector<HTMLButtonElement>("#soft-wrap")!;
    softWrap.addEventListener("mousedown", (event) => event.preventDefault());
    softWrap.addEventListener("click", () => this.toggleSoftWrap());
    this.applyZoom();
    this.bindFileDrop();
    window.addEventListener("keydown", this.onSoftWrapKey, true);
    window.addEventListener("keydown", this.onViewKey, true);
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("pointerdown", this.onActivity);
    window.addEventListener("keydown", this.onActivity);
    window.addEventListener("blur", this.onWindowBlur);
    window.addEventListener("focus", this.onReconnect);
    window.addEventListener("online", this.onReconnect);
    document.addEventListener("visibilitychange", this.onVisibilityChange);
    this.armIdleLock();
    this.applyPreviewMode();
  }

  /** Shows the tree and the Trash count; only rows that changed are touched (tree-view.ts). */
  private renderTree(): void {
    if (this.drawFrame !== null) { cancelAnimationFrame(this.drawFrame); this.drawFrame = null; }
    this.treeView?.render({ selected: this.selected, expanded: this.expanded, query: this.search });
    setText(this.root.querySelector(".trash-count"), String(this.tree.trashCount()));
    this.tree.markDrawn();
  }

  /**
   * Moves the selection in the tree: two rows change. After a change that
   * was applied without drawing (Restore opens the restored document, Move
   * to Trash of the open one opens another), the whole tree and the Trash
   * count are drawn instead.
   */
  private selectNode(id: string): void {
    this.selected = id;
    if (this.tree.needsDraw) this.renderTree();
    else this.treeView?.select(id);
  }

  /**
   * A change applied without drawing, so that its caller draws once after
   * following it, is drawn on the next frame if nothing drew it by then. An
   * import draws on its own timer (at most twice a second).
   */
  private drawSoon(): void {
    if (this.drawFrame !== null) return;
    this.drawFrame = requestAnimationFrame(() => {
      this.drawFrame = null;
      if (this.tree.needsDraw && this.treeView && !this.importing) this.renderTree();
    });
  }

  private activateNode(id: string): void {
    const node = this.tree.get(id);
    if (!node) return;
    if (kindName(node) !== "Folder") {
      void this.openDocument(id);
      return;
    }
    // A folder in the search results: show it in the tree.
    if (this.search.trim()) {
      this.revealInTree(id);
      return;
    }
    this.selected = id;
    this.expanded.has(id) ? this.expanded.delete(id) : this.expanded.add(id);
    this.renderTree();
  }

  /** Empties Quick open and shows the whole tree again; the focus stays in the field. */
  private clearSearch(): void {
    const search = this.root.querySelector<HTMLInputElement>(".search");
    if (!search) return;
    search.value = "";
    this.search = "";
    this.showSearchClear();
    this.renderTree();
    search.focus();
  }

  /** The clear button shows only while Quick open has text. */
  private showSearchClear(): void {
    const clear = this.root.querySelector<HTMLButtonElement>("#search-clear");
    const hidden = this.search.length === 0;
    if (clear && clear.hidden !== hidden) clear.hidden = hidden;
  }

  /** Ends the search and shows the folder `id`, open, with its ancestors. */
  private revealInTree(id: string): void {
    const search = this.root.querySelector<HTMLInputElement>(".search");
    if (search) search.value = "";
    this.search = "";
    this.showSearchClear();
    for (let node = this.tree.get(id); node; node = this.tree.get(node.parent)) {
      if (node.id !== ROOT) this.expanded.add(node.id);
    }
    this.selected = id;
    this.renderTree();
    this.treeView?.element(id)?.scrollIntoView({ block: "nearest" });
  }

  /** Applies a change's tree delta. A delta that comes before the one it follows waits; if that one never comes, the session's tree is fetched (no S3 request). */
  private applyTree(delta: TreeDelta | null | undefined, render = true): void {
    // A document window holds no tree.
    if (!isTauri || !delta || this.docWindow) return;
    const changed = this.tree.apply(delta);
    if (this.tree.behind && this.resyncTimer === null) {
      this.resyncTimer = window.setTimeout(() => {
        this.resyncTimer = null;
        if (this.tree.behind) void this.resyncTree();
      }, 250);
    }
    if (changed && render) this.renderTree();
    else if (changed) this.drawSoon();
  }

  /** Runs a change and applies its delta; after a failure the tree is fetched again (no S3 request), as part of the change may have happened. */
  private async changeTree<T extends { tree?: TreeDelta | null }>(change: Promise<T>): Promise<T> {
    try {
      const result = await change;
      this.applyTree(result.tree);
      return result;
    } catch (error) {
      await this.resyncTree();
      throw error;
    }
  }

  /** The session's own tree, without an S3 request. */
  private async resyncTree(render = true): Promise<void> {
    if (!isTauri || !this.editor || this.docWindow) return;
    try {
      this.tree.replace(await ipc.treeGet(false));
      if (render) this.renderTree();
      else this.drawSoon();
    } catch { /* Locked meanwhile; the next unlock lists S3. */ }
  }

  // The selection and the editor switch only once the document has loaded,
  // and only for the newest request (see documents.ts).
  private async openDocument(id: string): Promise<void> {
    const node = this.tree.get(id);
    if (!node || kindName(node) !== "Document" || !this.editor) return;
    if (id === this.documents.openId) {
      this.selectNode(id);
      return;
    }
    try {
      await this.documents.open(id, (data) => this.showDocument(node, data));
    } catch (caught) {
      this.selectNode(this.documents.openId ?? "");
      await this.message("Could not open document", ipcMessage(caught));
    }
  }

  private showDocument(node: TreeNode, data: DocumentData): void {
    if (!this.editor) return;
    this.selectNode(node.id);
    // Folds are per open: the outline is drawn again even for the same headings.
    this.collapsedOutline.clear();
    this.outlineSignature = null;
    this.closeWordCount();
    this.applyingModel = true;
    try {
      this.editor.open(node.id, data.text, data.readOnly, languageForFile(node.name), EDITING_ELSEWHERE_HINT, data.rev);
    } finally {
      this.applyingModel = false;
    }
    this.showElsewhere(data.readOnly);
    this.showSoftWrap();
    this.textVersion++;
    this.previewFromTop = true;
    this.showDocumentName(node);
    this.applyLayout();
    // Let the editor paint the new document first.
    this.renderAfterPaint();
  }

  private showDocumentName(node: TreeNode): void {
    const folders: string[] = [];
    for (let folder = node.parent ? this.tree.get(node.parent) : undefined; folder && folder.id !== ROOT; folder = folder.parent ? this.tree.get(folder.parent) : undefined) {
      folders.unshift(folder.name);
    }
    this.showBreadcrumb(folders, node.name, this.tree.pathOf(node.id));
    const language = languageForFile(node.name);
    this.editor?.setLanguage(language);
    setText(this.root.querySelector(".language-label"), languageLabel(language));
    this.updateOutlineAvailability();
    if (this.focusMode) this.showWindowTitle(node.name);
  }

  /**
   * The document header's one line: "Folder / Sub / name", Obsidian's
   * breadcrumb. The folders give way first (cut from the left); the full
   * path is the tooltip.
   */
  private showBreadcrumb(folders: string[], name: string, path: string): void {
    const crumb = this.root.querySelector<HTMLElement>(".doc-breadcrumb");
    if (!crumb) return;
    const nested = folders.length > 0;
    for (const part of crumb.querySelectorAll<HTMLElement>(".doc-folders, .doc-separator")) {
      if (part.hidden === nested) part.hidden = !nested;
    }
    setText(crumb.querySelector(".doc-folders bdi"), folders.join(" / "));
    setText(crumb.querySelector(".doc-title"), name);
    setAttribute(crumb, "title", path);
  }

  /**
   * Main window: whether another window writes the open document (doc_open
   * says so), shown as the header's "Editing in another window", which
   * brings that window to the front.
   */
  private showElsewhere(elsewhere: boolean): void {
    this.openElsewhere = elsewhere && !this.docWindow;
    const note = this.root.querySelector<HTMLElement>("#elsewhere");
    if (note && note.hidden === this.openElsewhere) note.hidden = !this.openElsewhere;
  }

  /**
   * "Open in new window" (header button, tree menu, Cmd/Ctrl+Shift+O): the
   * document moves to a window of its own, in focus mode, which writes it
   * from now on; here it stays read-only until that window closes. What was
   * typed here reaches the outbox first, and the new window opens it from
   * there. A document already in a window brings that window to the front.
   */
  private async openInNewWindow(id: string | null = this.documents.openId): Promise<void> {
    const node = this.tree.get(id);
    if (!node || kindName(node) !== "Document" || !this.editor || this.docWindow) return;
    if (!isTauri) {
      openAppWindow(documentWindowUrl(node.id));
      return;
    }
    const open = this.documents.openId === node.id;
    // Nothing typed during the hand-over is left behind: the editor is
    // read-only from before the outbox write until the window has it.
    const thaw = open && !this.openElsewhere ? this.editor.freeze("Opening in a new window…") : null;
    let handedOver = false;
    try {
      // Every edit, also one of a document no longer open whose outbox
      // write failed, is written first: handOff forgets what is not.
      if (!(await this.documents.persist())) {
        await this.message("Window not opened", "An edit could not be saved on this device. Retry, then open the document in a new window.");
        return;
      }
      await ipc.openDocumentWindow(node.id);
      handedOver = true;
    } catch (caught) {
      await this.message("Window not opened", ipcMessage(caught));
      return;
    } finally {
      if (!handedOver) thaw?.();
    }
    // That window uploads the edits written here; nothing of it is retried from here.
    this.documents.handOff(node.id);
    if (this.documents.openId === node.id && this.editor) {
      this.editor.setReadOnly(true, EDITING_ELSEWHERE_HINT);
      this.showElsewhere(true);
      await this.writerChanged(node.id);
    }
  }

  /**
   * Main window: a document window committed or closed (or took over) the
   * open document. Its newest text is shown, read-only while another window
   * writes it; Rust answers from its outbox or cache, without S3.
   */
  private async writerChanged(id: string): Promise<void> {
    if (this.docWindow || this.exiting || !this.editor || this.documents.openId !== id || !this.openElsewhere) return;
    const node = this.tree.get(id);
    if (!node) return;
    try {
      await this.documents.open(id, (data) => this.showWriterText(node, data));
    } catch {
      /* The next open of this document shows it. */
    }
  }

  /** The same document with another window's text: the preview keeps its place. */
  private showWriterText(node: TreeNode, data: DocumentData): void {
    if (!this.editor) return;
    this.applyingModel = true;
    try {
      this.editor.open(node.id, data.text, data.readOnly, languageForFile(node.name), EDITING_ELSEWHERE_HINT, data.rev);
    } finally {
      this.applyingModel = false;
    }
    this.showElsewhere(data.readOnly);
    this.showSoftWrap();
    this.textVersion++;
    this.renderAfterPaint();
  }

  /** No document is open, for example after the open one was trashed. */
  private closeDocument(): void {
    // Focus mode shows a document; with none open, the sidebar comes back.
    if (this.focusMode) this.leaveFocusMode();
    this.showElsewhere(false);
    this.documents.close();
    this.closeWordCount();
    this.editor?.close();
    this.showSoftWrap();
    this.textVersion++;
    this.showBreadcrumb([], "", "");
    setText(this.root.querySelector(".language-label"), "");
    this.updateOutlineAvailability();
    this.renderTree();
    this.applyPreviewMode();
  }

  // A keystroke only bumps counters: the word count is computed when asked
  // for, and the preview and outline re-render after a pause, only if shown.
  private onTextChanged(): void {
    if (!this.editor?.hasDocument || !this.documents.openId || this.applyingModel) return;
    // Read only when the edit is written to the outbox, from this document's state.
    this.documents.edited(this.editor.reader(), this.editor.length);
    this.textVersion++;
    if (this.wordCount) this.closeWordCount();
    if (this.previewMode === "edit" && !this.outlineShown()) return;
    this.renderDueAt = performance.now() + PREVIEW_DELAY_MS;
    this.renderTimer ??= window.setTimeout(this.renderWhenDue, PREVIEW_DELAY_MS);
  }

  private renderWhenDue = (): void => {
    const wait = this.renderDueAt - performance.now();
    if (wait > 1) {
      this.renderTimer = window.setTimeout(this.renderWhenDue, wait);
      return;
    }
    this.renderTimer = null;
    this.renderVisible();
  };

  private renderAfterPaint(): void {
    if (this.renderFrame !== null) return;
    this.renderFrame = requestAnimationFrame(() => {
      this.renderFrame = null;
      setTimeout(() => this.renderVisible(), 0);
    });
  }

  /** Renders the outline and preview if shown and out of date; otherwise nothing. */
  private renderVisible(): void {
    this.renderOutline();
    void this.renderPreview();
  }

  /**
   * The Word count button opens a small panel whose numbers are computed once,
   * when it opens. It never updates live: an edit, a selection change, a
   * document switch, Esc, a click elsewhere or leaving the window closes it.
   */
  private toggleWordCount(): void {
    if (this.wordCount) {
      this.closeWordCount();
      return;
    }
    const button = this.root.querySelector<HTMLButtonElement>("#word-count");
    const editor = this.editor;
    if (!button || !editor) return;
    const html = this.currentLanguage() === "html";
    const readable = (text: string): string => (html ? pageText(text) : text);
    const counts = countText(readable(editor.text()));
    const rows: [string, number][] = [["Words", counts.words], ["Characters", counts.characters], ["Lines", editor.lineCount]];
    const selected = editor.selectedTexts();
    if (selected.length) rows.push(["Selected words", countText(readable(selected.join("\n"))).words]);
    const panel = document.createElement("section");
    panel.className = "word-count-panel";
    panel.id = "word-count-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "Word count");
    const list = document.createElement("dl");
    const format = new Intl.NumberFormat();
    for (const [label, value] of rows) {
      const row = document.createElement("div");
      const term = document.createElement("dt");
      term.textContent = label;
      const detail = document.createElement("dd");
      detail.textContent = format.format(value);
      row.append(term, detail);
      list.append(row);
    }
    panel.append(list);
    if (html) {
      const note = document.createElement("p");
      note.textContent = "Words and characters of the page text, without tags.";
      panel.append(note);
    }
    // Above the button, right-aligned with it; the status bar is anchored bottom right.
    const box = button.getBoundingClientRect();
    panel.style.right = `${Math.max(8, innerWidth - box.right)}px`;
    panel.style.bottom = `${innerHeight - box.top + 6}px`;
    document.body.append(panel);
    const outside = (event: Event): void => {
      if (event.target instanceof Node && (panel.contains(event.target) || button.contains(event.target))) return;
      this.closeWordCount();
    };
    const escape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") this.closeWordCount();
    };
    const stopWatching = editor.onSelectionChange(() => this.closeWordCount());
    window.addEventListener("pointerdown", outside, true);
    window.addEventListener("keydown", escape, true);
    window.addEventListener("blur", this.closeWordCount);
    button.setAttribute("aria-expanded", "true");
    button.setAttribute("aria-controls", panel.id);
    this.wordCount = {
      panel,
      close: () => {
        stopWatching();
        window.removeEventListener("pointerdown", outside, true);
        window.removeEventListener("keydown", escape, true);
        window.removeEventListener("blur", this.closeWordCount);
        panel.remove();
        button.setAttribute("aria-expanded", "false");
        button.removeAttribute("aria-controls");
      },
    };
  }

  private closeWordCount = (): void => {
    const open = this.wordCount;
    this.wordCount = null;
    open?.close();
  };

  /** Called only on state changes, never per keystroke. */
  private setSync(state: SyncState): void {
    const sync = this.root.querySelector<HTMLElement>(".sync");
    if (!sync || sync.classList.contains(state)) return;
    const [title, label] = SYNC_TEXT[state];
    sync.className = `sync ${state}`;
    sync.title = title;
    sync.setAttribute("aria-label", title);
    setText(sync.querySelector(".sync-label"), label);
  }

  /**
   * The upload found another device's version: the edit is now the
   * conflict copy `to` (already in the tree), and the editor keeps showing it
   * with its undo history.
   */
  private async afterConflictCopy(from: string, to: string): Promise<void> {
    if (this.documents.openId === to) this.retargetOpen(from, to);
    const node = this.tree.get(this.documents.openId);
    if (node) {
      this.selectNode(node.id);
      this.showDocumentName(node);
    }
    await this.message("Conflict copy created", "The S3 version changed on another device. Your edit was saved beside it as a conflict copy, so neither version was overwritten.");
  }

  /**
   * The open document got a new id (rename, move, conflict copy): its editor
   * model and the preview and outline keys follow it, so nothing re-renders
   * unless the language changed (.md and .html).
   */
  private retargetOpen(from: string, to: string): void {
    this.editor?.retarget(from, to);
    const swap = (key: string | null): string | null => key && key.split("|").map((part) => (part === from ? to : part)).join("|");
    this.previewKey = swap(this.previewKey);
    this.outlineKey = swap(this.outlineKey);
    if (this.previewDoc === from) this.previewDoc = to;
    this.htmlPreview.retarget(from, to);
  }

  private applyPreviewMode(): void {
    this.applyLayout();
    this.renderVisible();
  }

  /** Mode and outline classes; each attribute is written only when it changes. */
  private applyLayout(): void {
    const area = this.root.querySelector<HTMLElement>(".editor-area");
    if (!area) return;
    const outline = this.outlineShown();
    if (!this.focusMode && this.previewMode !== "preview") this.writingMode = this.previewMode;
    // Focus mode keeps an open outline's class: theme.css hides the panel
    // there without dropping its layout, so leaving focus mode does not lay
    // out thousands of headings again (it does not re-render while hidden).
    const outlineOpen = this.outlineVisible && this.currentLanguage() === "markdown";
    const className = `editor-area${this.previewMode === "split" ? " split" : this.previewMode === "preview" ? " preview-only" : ""}${outlineOpen ? " outline-visible" : ""}`;
    if (area.className !== className) area.className = className;
    const toggle = this.root.querySelector<HTMLButtonElement>("#outline-toggle");
    if (toggle) {
      setAttribute(toggle, "aria-expanded", String(outline));
      toggle.classList.toggle("active", outline);
    }
    this.root.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach((button) => {
      const active = button.dataset.mode === this.previewMode;
      button.classList.toggle("active", active);
      setAttribute(button, "aria-pressed", String(active));
    });
    // The outline and Split change how much room each pane can have; focus mode has no handles.
    if (!this.focusMode) this.resizers?.update();
    this.syncFrameWatch();
    this.showPreviewChrome();
  }

  /**
   * Cmd/Ctrl+=, +, - and 0 zoom what is shown, in every mode and window and
   * wherever the focus is (in the editor they never type), but not under a
   * dialog or without a document.
   */
  private zoomKeyApplies(): boolean {
    return this.editor !== null && this.documents.openId !== null && !topModal();
  }

  /**
   * One zoom step (or 100%) for the editor and the preview together, each
   * shown pane keeping its reading position; saved once the keys pause. The
   * level, the editor and a Markdown preview change in the next frame. An
   * HTML page re-flows in the task after that frame is painted: its whole
   * layout (about 0.5 s for a 12 MB page in WebKit) would otherwise hold
   * back the level and the editor too. Steps that queue up behind one
   * re-flow share the next one. The level shows for a moment, also when it
   * is already at the end of the range.
   */
  private zoomContent(key: ZoomKey): void {
    const level = zoomed(this.contentZoom, key);
    this.showZoomLevel(level);
    if (level === this.contentZoom) return;
    this.zoomPlace ??= {
      editorLine: this.previewMode === "preview" ? null : this.editor?.topLine() ?? null,
      preview: this.previewMode === "edit" ? null : this.previewPlace(),
    };
    this.contentZoom = level;
    this.applyZoom(false);
    this.zoomFrame ??= requestAnimationFrame(() => {
      const place = this.zoomPlace;
      this.zoomFrame = null;
      this.zoomPlace = null;
      if (place?.editorLine != null) this.editor?.showLine(place.editorLine, false);
      const preview = place?.preview ?? null;
      if (preview && !("ratio" in preview)) this.restorePreviewPlace(preview);
      window.setTimeout(() => {
        this.htmlPreview.setZoom(this.contentZoom);
        // Reading the page's height re-flows it here, in this task.
        if (preview && "ratio" in preview) this.restorePreviewPlace(preview);
      }, 0);
    });
    if (this.zoomSaveTimer !== null) clearTimeout(this.zoomSaveTimer);
    this.zoomSaveTimer = window.setTimeout(() => {
      this.zoomSaveTimer = null;
      if (this.contentZoom === this.savedZoom) return;
      const wanted = this.contentZoom;
      if (!isTauri) {
        this.savedZoom = wanted;
        return;
      }
      void ipc.layoutSet({ preview_zoom: wanted }).then(
        () => { this.savedZoom = wanted; },
        () => { /* Cosmetic: the level stays for this session and the next change saves again. */ },
      );
    }, ZOOM_SAVE_DELAY_MS);
  }

  /**
   * The zoom is one custom property, --content-zoom, on the two panes (not
   * on a shared parent, so the outline's rows are not restyled): theme.css
   * scales the editor's and the Markdown and plain-text preview's text and
   * readable width with it. The HTML page zooms in its frame (`page`
   * false: zoomContent zooms it after the next paint).
   */
  private applyZoom(page = true): void {
    const level = this.contentZoom;
    const value = level === ZOOM.default ? "" : String(level / 100);
    for (const pane of this.root.querySelectorAll<HTMLElement>(".editor-area > .editor-host, .editor-area > .preview")) {
      if (pane.style.getPropertyValue("--content-zoom") === value) continue;
      if (value) pane.style.setProperty("--content-zoom", value);
      else pane.style.removeProperty("--content-zoom");
    }
    if (page) this.htmlPreview.setZoom(level);
    // The line height changed but the editor's box did not: CodeMirror measures its lines again.
    this.editor?.view.requestMeasure();
  }

  /**
   * The level ("110%") centred near the top of the content for a second,
   * then fading out (theme.css .zoom-indicator); a polite live region, so
   * screen readers say it too.
   */
  private showZoomLevel(level: number): void {
    const note = this.root.querySelector<HTMLElement>(".zoom-indicator");
    const label = note?.querySelector<HTMLElement>(".zoom-indicator-level");
    if (!note || !label) return;
    label.textContent = `${level}%`;
    note.classList.add("shown");
    if (this.zoomNoteTimer !== null) clearTimeout(this.zoomNoteTimer);
    this.zoomNoteTimer = window.setTimeout(() => {
      this.zoomNoteTimer = null;
      note.classList.remove("shown");
    }, ZOOM_NOTE_MS);
  }

  /**
   * Keeps the user's pane sizes: in config.json (one IPC per drag, or per
   * pause in resize keys; no S3 request), in memory in browser mode.
   */
  private saveLayout(layout: PanelLayout): void {
    this.panelLayout = layout;
    // A document window has no panes of its own to size.
    if (isTauri && !this.docWindow) void ipc.layoutSet(layoutToWire(layout)).catch(() => {
      /* Cosmetic: the sizes stay for this session and the next drag saves again. */
    });
  }

  /** Soft wrap for every document this session (Alt+Z, Option+Z on macOS, or the status bar). */
  private toggleSoftWrap(): void {
    if (!this.editor) return;
    this.editor.setSoftWrap(!softWrapEnabled());
    this.showSoftWrap();
  }

  /** The status-bar toggle; a document with a line too long to wrap shows it off and says why. */
  private showSoftWrap(): void {
    const button = this.root.querySelector<HTMLButtonElement>("#soft-wrap");
    if (!button) return;
    const keys = isMac ? "⌥Z" : "Alt+Z";
    const unwrapped = this.editor?.longLines ?? false;
    setAttribute(button, "aria-pressed", String(softWrapEnabled() && !unwrapped));
    setAttribute(button, "title", unwrapped ? `Word wrap is off for this document: a line is too long to wrap (${keys})` : `Word wrap ${softWrapEnabled() ? "on" : "off"} (${keys})`);
  }

  /**
   * Alt+Z (Option+Z on macOS) toggles soft wrap, as in VS Code. It is caught
   * in the capture phase, ahead of the editor, so it never types "Ω";
   * other text fields and dialogs keep the key for their own characters.
   * keyCode, not code, on purpose: it follows the keyboard layout, so the
   * shortcut is the key printed Z (physical Y on QWERTZ), as in VS Code.
   */
  private onSoftWrapKey = (event: KeyboardEvent): void => {
    if (event.keyCode !== 90 || !event.altKey || event.metaKey || event.ctrlKey || event.shiftKey || event.isComposing) return;
    const inEditor = event.target instanceof Element && event.target.closest(".cm-editor") !== null;
    if (!inEditor && isTypingTarget(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat) this.toggleSoftWrap();
  };

  /** Showing or hiding the outline never re-renders the preview; a hidden outline keeps no rows. */
  private toggleOutline(): void {
    if (this.currentLanguage() !== "markdown") return;
    this.outlineVisible = !this.outlineVisible;
    if (!this.outlineVisible) this.clearOutline();
    this.applyLayout();
    this.renderOutline();
  }

  private clearOutline(): void {
    this.outlineObserver?.disconnect();
    const tree = this.root.querySelector(".outline-tree");
    tree?.replaceChildren();
    // Shown again, it starts at the top (its rows are drawn from there).
    if (tree) tree.scrollTop = 0;
    this.outlineKey = this.outlineSignature = null;
    this.outlineRows = [];
    this.outlineDrawn = 0;
  }

  private outlineShown(): boolean {
    return !this.focusMode && this.outlineVisible && this.currentLanguage() === "markdown";
  }

  private updateOutlineAvailability(): void {
    // "Open in new window" needs an open document too.
    const newWindow = this.root.querySelector<HTMLButtonElement>("#open-window");
    if (newWindow && newWindow.disabled === Boolean(this.documents.openId)) newWindow.disabled = !this.documents.openId;
    const toggle = this.root.querySelector<HTMLButtonElement>("#outline-toggle");
    if (!toggle) return;
    const available = this.currentLanguage() === "markdown";
    if (toggle.hidden === available) toggle.hidden = !available;
    if (toggle.disabled === available) toggle.disabled = !available;
    setAttribute(toggle, "aria-expanded", String(available && this.outlineVisible));
  }

  /**
   * Shows the independently collapsible heading tree of Markdown, only while
   * the outline is shown and only when the headings changed (or `force`,
   * after a fold). Rows are drawn OUTLINE_CHUNK at a time as the outline
   * scrolls; a redraw of the same document keeps at least the rows drawn.
   */
  private renderOutline(force = false): void {
    const tree = this.root.querySelector<HTMLElement>(".outline-tree");
    if (!tree || !this.editor || !this.outlineShown()) return;
    const id = this.documents.openId;
    const key = `${id}|${this.textVersion}`;
    if (!force && key === this.outlineKey) return;
    this.outlineKey = key;
    const headings = parseMarkdownOutline(this.editor.text());
    const signature = `${id}\n${flattenOutline(headings).map((item) => `${item.level}\t${item.line}\t${item.text}`).join("\n")}`;
    if (!force && signature === this.outlineSignature && tree.firstChild) return;
    const sameDocument = this.outlineSignature?.startsWith(`${id}\n`) ?? false;
    this.outlineSignature = signature;
    this.outlineObserver?.disconnect();
    if (!headings.length) {
      const empty = document.createElement("p");
      empty.className = "outline-empty";
      empty.textContent = "Add a Markdown heading to build the outline.";
      tree.replaceChildren(empty);
      this.outlineRows = [];
      this.outlineDrawn = 0;
      return;
    }
    const drawn = sameDocument ? this.outlineDrawn : 0;
    this.outlineRows = flattenOutline(headings, this.collapsedOutline);
    this.outlineDrawn = 0;
    tree.replaceChildren();
    this.drawOutlineRows(tree, Math.max(OUTLINE_CHUNK, drawn));
  }

  /** Appends up to `count` more outline rows, and a marker that draws the next ones once it nears the view. */
  private drawOutlineRows(tree: HTMLElement, count = OUTLINE_CHUNK): void {
    tree.querySelector(".outline-more")?.remove();
    const end = Math.min(this.outlineRows.length, this.outlineDrawn + count);
    const fragment = document.createDocumentFragment();
    const chevron = icon("chevron");
    for (let index = this.outlineDrawn; index < end; index++) {
      const item = this.outlineRows[index]!;
      const branch = document.createElement("div");
      branch.className = "outline-item";
      branch.dataset.index = String(index);
      branch.setAttribute("role", "treeitem");
      branch.setAttribute("aria-level", String(item.level));
      const row = document.createElement("div");
      row.className = "outline-row";
      row.style.setProperty("--outline-depth", String(Math.max(0, item.level - 1)));
      if (item.children.length) {
        const collapsed = this.collapsedOutline.has(item.id);
        const disclosure = document.createElement("button");
        disclosure.type = "button";
        disclosure.className = `outline-disclosure${collapsed ? "" : " open"}`;
        disclosure.setAttribute("aria-label", `${collapsed ? "Expand" : "Collapse"} ${item.text}`);
        disclosure.append(chevron.cloneNode(true));
        row.append(disclosure);
        branch.setAttribute("aria-expanded", String(!collapsed));
      } else {
        const spacer = document.createElement("span");
        spacer.className = "outline-disclosure-spacer";
        row.append(spacer);
      }
      const heading = document.createElement("button");
      heading.type = "button";
      heading.className = "outline-heading";
      heading.textContent = item.text;
      heading.title = `${item.text} · line ${item.line}`;
      row.append(heading);
      branch.append(row);
      fragment.append(branch);
    }
    this.outlineDrawn = end;
    if (end < this.outlineRows.length) {
      const more = document.createElement("div");
      more.className = "outline-more";
      more.setAttribute("aria-hidden", "true");
      fragment.append(more);
      // A new one after renderMain, which makes a new outline.
      if (this.outlineObserver?.root !== tree) {
        this.outlineObserver?.disconnect();
        this.outlineObserver = new IntersectionObserver((entries) => {
          if (entries.some((entry) => entry.isIntersecting)) this.drawOutlineRows(tree);
        }, { root: tree, rootMargin: "0px 0px 600px 0px" });
      }
      this.outlineObserver.disconnect();
      this.outlineObserver.observe(more);
    }
    tree.append(fragment);
  }

  /**
   * An outline heading (clicked, or Enter / Space on it) in the panes
   * shown: Edit goes to its line, Preview scrolls the preview to it, Split
   * does both. Preview keeps the focus in the outline, so the keyboard can
   * go on from there; the editor takes it when shown, as before.
   */
  private revealOutlineItem(item: OutlineItem): void {
    if (!this.editor) return;
    if (this.previewMode !== "edit") this.scrollPreviewToHeading(item);
    if (this.previewMode === "preview") return;
    this.showHeadingLine(item.line);
    this.editor.focus();
  }

  private showHeadingLine(line: number): void {
    this.editor?.revealLine(line);
  }

  /** The preview's heading of `item` at the preview's top; without it (HTML, a stale or paused preview) the mapped line. */
  private scrollPreviewToHeading(item: OutlineItem): void {
    const host = this.root.querySelector<HTMLElement>(".preview");
    if (!host) return;
    const heading = host.classList.contains("html-mode") ? null : this.previewHeadingFor(host, item);
    if (heading) scrollPaneTo(host, heading);
    else this.showPreviewLine(item.line);
  }

  /**
   * The preview element of outline item `item`: the heading at the same
   * index when the preview's headings are the outline's (previewHeadings),
   * else the one with the id its text gets (preview.rs numbers repeats the
   * same way).
   */
  private previewHeadingFor(host: HTMLElement, item: OutlineItem): Element | null {
    const headings = this.previewHeadings(host);
    const index = this.headingLines().indexOf(item.line);
    if (headings && index >= 0) return headings[index] ?? null;
    const ids = new HeadingIds();
    for (const other of flattenOutline(parseMarkdownOutline(this.editor?.text() ?? ""))) {
      const id = ids.next(other.text);
      if (other.line === item.line) return previewTarget(host, id);
    }
    return null;
  }

  /** The source line of the preview's heading `target`, when the preview's headings are the outline's. */
  private previewHeadingLine(host: HTMLElement, target: Element): number | null {
    const index = this.previewHeadings(host)?.indexOf(target) ?? -1;
    return index >= 0 ? this.headingLines()[index] ?? null : null;
  }

  /**
   * The preview's headings in source order when they are exactly the
   * outline's (outline.ts skips fenced code, as the renderer does): the
   * top-level ones, else all but those in block quotes, which the outline
   * never counts (it does count a heading in a list item); null when
   * neither count matches.
   */
  private previewHeadings(host: HTMLElement): Element[] | null {
    const count = this.headingLines().length;
    const top = Array.from(host.querySelectorAll(PREVIEW_HEADINGS));
    if (top.length === count) return top;
    const unquoted = Array.from(host.querySelectorAll(ALL_HEADINGS)).filter((heading) => !heading.closest("blockquote"));
    return unquoted.length === count ? unquoted : null;
  }

  /** The source line of the heading `fragment` names, by the ids the outline's headings get. */
  private headingLineFor(fragment: string): number | null {
    const wanted = fragmentIds(fragment);
    const ids = new HeadingIds();
    for (const item of flattenOutline(parseMarkdownOutline(this.editor?.text() ?? ""))) {
      if (wanted.includes(ids.next(item.text))) return item.line;
    }
    return null;
  }

  /**
   * A vault link of the Markdown preview (`nb-doc:` / `nb-wiki:`, through
   * navigation.ts). The main window resolves it from the open document's
   * folder; a document window shows a heading of its own document itself
   * and hands every other link to the main window, which comes to the front.
   */
  private followVaultLink(href: string): void {
    const link = parseInternalHref(href);
    const open = this.documents.openId;
    if (!link || !open || !this.editor) return;
    if (this.docWindow) void this.followFromDocumentWindow(href, link, open);
    else void this.openVaultLink(link, this.tree.pathOf(open));
  }

  private async followFromDocumentWindow(href: string, link: InternalLink, id: string): Promise<void> {
    let path = this.docWindowPath;
    if (isTauri) {
      try {
        // A rename or move changed the folder links start from: Rust knows where it is now.
        path = (await ipc.documentWindowInfo()).path;
      } catch {
        return;
      }
    }
    const own = resolveInternalLink(pathIndex(path, id), path, link);
    if (own.kind === "document" && own.id === id) {
      if (link.fragment) this.revealFragment(link.fragment);
      return;
    }
    if (!isTauri) {
      documentLinks()?.postMessage({ from: path, href } satisfies DocumentLink);
      return;
    }
    try {
      await ipc.documentLinkOpen(href);
    } catch (caught) {
      await this.message("Link not opened", safeErrorMessage(caught, "The main window could not open this link."));
    }
  }

  /** Main window: a document window's link (Rust says which document's folder it starts from). */
  private openLinkFromWindow(payload: DocumentLink | null | undefined): void {
    if (this.docWindow || typeof payload?.from !== "string" || typeof payload.href !== "string") return;
    const link = parseInternalHref(payload.href);
    if (link) void this.openVaultLink(link, payload.from);
  }

  /**
   * What `link` names from the document at `from`, checked against the
   * tree: a document opens (at its heading), a folder is shown in the
   * sidebar, and anything else is said in a short message.
   */
  private async openVaultLink(link: InternalLink, from: string): Promise<void> {
    if (this.screen !== "main" || !this.editor || this.docWindow) return;
    const target = resolveInternalLink(new VaultIndex(ROOT, this.vaultEntries()), from, link);
    const name = link.target.length > 80 ? `${link.target.slice(0, 79)}…` : link.target;
    switch (target.kind) {
      case "missing":
        await this.message("Link not found", `“${name}” is not in this workspace.`);
        return;
      case "ambiguous":
        await this.message("Link is ambiguous", `${target.count} documents are named “${name}”. Add a folder to the link, like [[Folder/${name}]].`);
        return;
      case "folder":
        // The sidebar shows the folder: focus mode hides it.
        if (this.focusMode) this.leaveFocusMode();
        this.revealInTree(target.id);
        return;
      case "document":
        if (target.id !== this.documents.openId) {
          await this.openDocument(target.id);
          if (this.documents.openId !== target.id) return;
        }
        if (link.fragment) this.revealFragment(link.fragment);
    }
  }

  private *vaultEntries(): Iterable<VaultEntry> {
    for (const node of this.tree.nodes()) {
      const kind = kindName(node);
      if (kind === "Folder" || kind === "Document") yield { id: node.id, parent: node.parent, name: node.name, folder: kind === "Folder" };
    }
  }

  /**
   * The heading `fragment` names in the open document, in the panes shown:
   * the preview once it shows the current text (and Split's editor at the
   * heading's line), or Edit's editor at once.
   */
  private revealFragment(fragment: string): void {
    const id = this.documents.openId;
    if (!id || !this.editor) return;
    if (this.previewMode === "edit") {
      const line = this.headingLineFor(fragment);
      if (line !== null) this.showHeadingLine(line);
      return;
    }
    this.pendingFragment = { id, fragment };
    if (this.previewDoc === id && this.previewInFlight === null && this.previewKey === `${id}|${this.textVersion}|${this.currentLanguage()}`) {
      this.applyPendingFragment();
    }
  }

  /** After a render: the pending heading, if the preview shows its document. */
  private applyPendingFragment(): void {
    const pending = this.pendingFragment;
    this.pendingFragment = null;
    const host = this.root.querySelector<HTMLElement>(".preview");
    if (!pending || !host || pending.id !== this.documents.openId || this.previewMode === "edit") return;
    const target = previewTarget(host, pending.fragment);
    if (target) {
      focusPaneTarget(host, target);
      scrollPaneTo(host, target);
    }
    if (this.previewMode !== "split") return;
    const line = (target ? this.previewHeadingLine(host, target) : null) ?? this.headingLineFor(pending.fragment);
    if (line !== null) this.showHeadingLine(line);
  }

  private currentLanguage(): DocumentLanguage {
    const node = this.tree.get(this.documents.openId);
    return node ? languageForFile(node.name) : "plaintext";
  }

  /**
   * Renders the open document into the preview pane, only when the pane is
   * shown and the document, its text or its language changed since the last
   * render. Edit mode keeps the hidden DOM, so switching back is free.
   * Documents over LARGE_PREVIEW_CHARS render once per text in Preview (and
   * so in focus mode and document windows); Split, which re-renders while
   * typing, waits for `force` (the Render button, pausePreview). Responses
   * are applied only if no newer render, document switch or lock happened
   * while Rust was rendering.
   */
  private async renderPreview(force = false): Promise<void> {
    const host = this.root.querySelector<HTMLElement>(".preview");
    if (!host) return;
    const id = this.documents.openId;
    if (!this.editor?.hasDocument || !id) {
      this.clearPreview(host);
      return;
    }
    const language = this.currentLanguage();
    const large = this.editor.length > LARGE_PREVIEW_CHARS;
    if (this.previewMode === "edit") {
      // Large documents do not keep a hidden copy of their preview.
      if (large) this.clearPreview(host);
      return;
    }
    const key = `${id}|${this.textVersion}|${language}`;
    if (large && !force && this.previewMode === "split") {
      this.pausePreview(host, id, language, key);
      return;
    }
    if (!force && key === this.previewKey) return;
    this.previewKey = key;
    const sequence = ++this.previewSeq;
    const fromTop = this.previewFromTop;
    this.previewFromTop = false;
    const text = this.editor.text();
    if (tooLargeToPreview(text)) {
      this.previewDoc = null;
      host.classList.remove("html-mode");
      host.replaceChildren(previewNote("This document is too large to preview."));
      return;
    }
    host.classList.toggle("html-mode", language === "html");
    if (language === "html") {
      this.previewDoc = null;
      this.htmlPreview.render(host, id, text);
      // Rendered: a Render button left above the page from Split goes.
      this.pausedNote?.remove();
      this.showPreviewChrome();
      return;
    }
    if (language === "plaintext") {
      this.previewDoc = null;
      const pre = document.createElement("pre");
      pre.className = "plain-preview";
      pre.textContent = text;
      host.replaceChildren(pre);
      if (fromTop) host.scrollTop = 0;
      this.showPreviewChrome();
      return;
    }
    let blocks: DocumentFragment;
    this.previewInFlight = sequence;
    try {
      blocks = previewFragment(isTauri ? await ipc.previewRender(text) : renderMarkdown(text));
    } catch (caught) {
      blocks = document.createDocumentFragment();
      blocks.append(previewNote(safeErrorMessage(caught, "The preview could not be rendered.")));
    } finally {
      if (this.previewInFlight === sequence) this.previewInFlight = null;
    }
    if (sequence !== this.previewSeq || !host.isConnected) return;
    // Same document: replace only the changed blocks. Otherwise everything.
    if (!large && this.previewDoc === id) patchChildren(host, blocks);
    else {
      host.replaceChildren(blocks);
      if (fromTop) host.scrollTop = 0;
    }
    this.previewDoc = large ? null : id;
    this.showPreviewChrome();
    this.applyPreviewLine();
    if (this.pendingFragment) this.applyPendingFragment();
    // Typed in Split while Rust rendered: this render is already behind.
    if (large && this.previewMode === "split" && key !== `${id}|${this.textVersion}|${language}`) {
      this.pausePreview(host, id, language, `${id}|${this.textVersion}|${language}`);
    }
  }

  /**
   * Split with a large document whose text is not rendered: "Preview paused"
   * and its Render button, above this document's last render (kept, so the
   * reading position stays) or alone. A keystroke costs one comparison.
   */
  private pausePreview(host: HTMLElement, id: string, language: DocumentLanguage, key: string): void {
    if (key === this.previewKey) return;
    const note = this.largePreviewNote();
    const shown = this.previewKey?.startsWith(`${id}|`) && this.previewKey.endsWith(`|${language}`);
    if (!shown) {
      if (host.firstChild === note && host.childNodes.length === 1) return;
      this.previewSeq++;
      this.previewKey = this.previewDoc = null;
      host.classList.remove("html-mode");
      host.replaceChildren(note);
      this.showPreviewChrome();
      return;
    }
    if (host.firstChild !== note) host.prepend(note);
    this.showPreviewChrome();
  }

  private clearPreview(host: HTMLElement): void {
    if (this.previewKey === null && !host.firstChild) return;
    this.previewSeq++;
    this.previewKey = this.previewDoc = null;
    this.htmlPreview.reset();
    host.classList.remove("html-mode");
    host.replaceChildren();
  }

  /**
   * The status bar's "Scripts off (N)" while the HTML page preview shown
   * removed scripts: not in focus mode or a document window, which hide the
   * status bar (the preview pane never carries that note).
   */
  private showPreviewChrome(): void {
    const item = this.root.querySelector<HTMLElement>("#scripts-off");
    if (!item) return;
    const count = this.focusMode || this.previewMode === "edit" ? 0 : this.htmlPreview.scriptsOff;
    if (item.hidden !== (count === 0)) item.hidden = count === 0;
    if (count === 0) return;
    setText(item, `Scripts off (${count})`);
    setAttribute(item, "title", `This page has ${count} ${count === 1 ? "script" : "scripts"}. The preview shows HTML pages without running scripts, so anything a script would build is missing.`);
  }

  /** "Preview paused" with a Render button, above a large document's preview. */
  private largePreviewNote(): HTMLElement {
    if (this.pausedNote) return this.pausedNote;
    const note = document.createElement("div");
    note.className = "preview-paused";
    note.setAttribute("role", "status");
    const text = document.createElement("span");
    text.textContent = "Preview paused for large documents.";
    const render = document.createElement("button");
    render.type = "button";
    render.className = "button";
    render.textContent = "Render";
    render.title = "Render the preview of the current text once";
    render.addEventListener("click", () => void this.renderPreview(true));
    note.append(text, render);
    this.pausedNote = note;
    return note;
  }

  private cancelPreview(): void {
    if (this.renderTimer !== null) { clearTimeout(this.renderTimer); this.renderTimer = null; }
    if (this.renderFrame !== null) { cancelAnimationFrame(this.renderFrame); this.renderFrame = null; }
    this.previewSeq++;
    this.previewKey = this.previewDoc = this.outlineKey = null;
    this.pausedNote = null;
    this.previewLineWanted = this.previewInFlight = null;
    this.pendingFragment = null;
  }

  /**
   * New file at a path from the vault root. Existing folders are matched
   * without case; the missing ones are created with the file, in one round.
   * Opening it next needs no request (Rust keeps its text).
   */
  private async createFile(): Promise<void> {
    const initialFolder = this.selectedFolderId();
    const folder = initialFolder === ROOT ? "" : this.tree.pathOf(initialFolder);
    const requested = await this.filePathPrompt(`${folder}/Untitled`);
    if (!requested) return;
    try {
      const { parent, missing } = this.resolveFolders(requested.directories);
      const text = initialDocumentText(requested.name);
      let id: string;
      if (isTauri) {
        id = (await this.changeTree(ipc.docCreate(parent, requested.name, text, missing))).id;
      } else {
        let folderId = parent;
        for (const name of missing) {
          const created = crypto.randomUUID();
          this.tree.change([{ id: created, parent: folderId, name, kind: "Folder" }]);
          folderId = created;
        }
        id = crypto.randomUUID();
        this.tree.change([{ id, parent: folderId, name: uniqueName(this.tree.children(folderId), requested.name), kind: "Document" }]);
        this.docs.set(id, { text, readOnly: false });
      }
      this.expandTo(id);
      this.renderTree();
      await this.openDocument(id);
    } catch (error) {
      await this.message("Could not create file", ipcMessage(error));
    }
  }

  private async createFolder(): Promise<void> {
    const parent = this.selectedFolderId();
    try {
      let id: string;
      if (isTauri) {
        id = (await this.changeTree(ipc.folderCreate(parent, "New folder"))).id;
      } else {
        id = crypto.randomUUID();
        this.tree.change([{ id, parent, name: uniqueName(this.tree.children(parent), "New folder"), kind: "Folder" }]);
      }
      this.selected = id;
      this.expanded.add(id);
      this.expanded.add(parent);
      this.renderTree();
    } catch (error) {
      await this.message("Could not create folder", ipcMessage(error));
    }
  }

  /** Opens every folder that contains `id`. */
  private expandTo(id: string): void {
    for (let node = this.tree.get(this.tree.get(id)?.parent); node && node.id !== ROOT; node = this.tree.get(node.parent)) {
      this.expanded.add(node.id);
    }
  }

  /**
   * The deepest existing folder of `parts` (matched without case) and the
   * names below it that do not exist yet. A file in the way is refused.
   */
  private resolveFolders(parts: string[]): { parent: string; missing: string[] } {
    let parent = ROOT;
    for (const [index, name] of parts.entries()) {
      const wanted = name.toLocaleLowerCase();
      const existing = this.tree.children(parent).find((node) => node.name.toLocaleLowerCase() === wanted);
      if (!existing) return { parent, missing: parts.slice(index) };
      if (kindName(existing) !== "Folder") throw new Error(`“${name}” is a file, so it cannot contain another file.`);
      parent = existing.id;
    }
    return { parent, missing: [] };
  }

  private filePathPrompt(initial: string): Promise<ReturnType<typeof parseVaultFilePath> | null> {
    return new Promise((resolve) => {
      const overlay = this.modal(
        "New file",
        "Enter a path from the vault root. Missing folders are created; a name without an extension becomes Markdown.",
        () => resolve(null),
      );
      const body = overlay.querySelector<HTMLElement>(".modal-body")!;
      const form = document.createElement("form");
      form.className = "modal-form";
      const label = document.createElement("label");
      label.className = "field";
      label.textContent = "Path from vault root";
      const input = document.createElement("input");
      input.name = "path";
      input.value = initial;
      input.required = true;
      input.autocomplete = "off";
      input.spellcheck = false;
      const hint = document.createElement("span");
      hint.className = "field-hint field-hint-block";
      hint.textContent = "Examples: /notes/Meeting or /site/index.html";
      const error = document.createElement("p");
      error.className = "error";
      error.setAttribute("role", "alert");
      const actions = document.createElement("div");
      actions.className = "modal-actions";
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "button";
      cancel.textContent = "Cancel";
      const submit = document.createElement("button");
      submit.type = "submit";
      submit.className = "button button-primary";
      submit.textContent = "Create file";
      actions.append(cancel, submit);
      label.append(input, hint);
      form.append(label, error, actions);
      body.append(form);
      const done = (answer: ReturnType<typeof parseVaultFilePath> | null): void => {
        overlay.remove();
        resolve(answer);
      };
      cancel.addEventListener("click", () => done(null));
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        try {
          done(parseVaultFilePath(input.value));
        } catch (caught) {
          error.textContent = safeErrorMessage(caught, "Enter a valid vault path.");
          input.focus();
        }
      });
      this.showModal(overlay);
      input.focus();
      const start = initial.lastIndexOf("/") + 1;
      input.setSelectionRange(start, initial.length);
    });
  }

  /** The Refresh button: S3 is listed again, so changes from other devices appear. */
  private async refresh(): Promise<void> {
    if (isTauri) this.tree.replace(await ipc.treeGet(true));
    this.renderTree();
  }

  private async openSettings(): Promise<void> {
    // A previewed accent that is not saved goes back when the dialog closes.
    const overlay = this.modal("Settings", "Preferences for this device, and the workspace that is open.", () => this.showAccent(this.accent));
    const body = overlay.querySelector<HTMLElement>(".modal-body")!;
    body.innerHTML = `<form class="modal-form" id="preferences-form">
      <section class="settings-group" aria-labelledby="settings-workspace">
        <h3 id="settings-workspace">Workspace</h3>
        <div class="settings-workspace"><span class="workspace-avatar workspace-avatar-large"></span><div class="settings-workspace-text"><strong></strong><span></span></div></div>
        <div class="settings-buttons"><button type="button" class="button edit-workspace"><span>Edit workspace…</span></button><button type="button" class="button manage-workspaces"><span>Manage workspaces…</span></button><button type="button" class="button phrase"><span>Change phrase…</span></button></div>
      </section>
      <section class="settings-group" aria-labelledby="settings-appearance">
        <h3 id="settings-appearance">Appearance</h3>
        <label class="field">Theme<select name="theme"><option>System</option><option>Light</option><option>Dark</option></select></label>
        <fieldset class="field"><legend>Accent colour</legend><div class="accent-swatches" role="radiogroup" aria-label="Accent colour">${ACCENTS.map((accent) => `<label class="accent-swatch" data-value="${accent}" title="${accentLabel(accent)}"><input type="radio" name="accent" value="${accent}" aria-label="${accentLabel(accent)}"><span></span></label>`).join("")}</div></fieldset>
      </section>
      <section class="settings-group" aria-labelledby="settings-security">
        <h3 id="settings-security">Security</h3>
        <label class="field">Auto-lock after (minutes)<input name="auto-lock" type="number" min="0" max="1440" step="1" required><span class="field-hint field-hint-block">Use 0 to disable auto-lock.</span><span class="field-hint field-hint-block auto-lock-remembered" hidden></span></label>
      </section>
      <p class="error" role="alert"></p>
      <div class="modal-actions"><button type="button" class="button cancel">Cancel</button><button type="submit" class="button button-primary">Save</button></div>
    </form>`;
    const form = body.querySelector<HTMLFormElement>("#preferences-form")!;
    (form.elements.namedItem("theme") as HTMLSelectElement).value = this.theme;
    (form.elements.namedItem("auto-lock") as HTMLInputElement).value = String(this.autoLockMinutes);
    form.querySelector<HTMLInputElement>(`input[name="accent"][value="${this.accent}"]`)!.checked = true;
    const showWorkspace = (): void => {
      const workspace = this.activeWorkspace();
      setText(body.querySelector(".settings-workspace .workspace-avatar"), workspaceInitial(workspace?.name ?? ""));
      setText(body.querySelector(".settings-workspace strong"), workspace?.name ?? "No workspace");
      setText(body.querySelector(".settings-workspace-text span"), workspace ? locationLabel(workspace) : "");
      const remembered = body.querySelector<HTMLElement>(".auto-lock-remembered")!;
      remembered.hidden = !workspace?.phrase_stored;
      remembered.textContent = workspace?.phrase_stored ? `${workspace.name} stays open: its encryption phrase is remembered on this device.` : "";
    };
    showWorkspace();
    form.addEventListener("change", (event) => {
      const input = event.target;
      if (input instanceof HTMLInputElement && input.name === "accent") this.showAccent(input.value as Accent);
    });
    form.addEventListener("submit", (event) => void this.savePreferences(event, overlay));
    body.querySelector(".cancel")!.addEventListener("click", () => { overlay.remove(); this.showAccent(this.accent); });
    body.querySelector<HTMLElement>(".phrase")!.hidden = !isTauri;
    body.querySelector(".edit-workspace")!.addEventListener("click", () => {
      const workspace = this.activeWorkspace();
      if (workspace) void this.openWorkspaceForm(workspace).then(showWorkspace);
    });
    // Both open on top of Settings, so changes not saved yet are kept.
    body.querySelector(".manage-workspaces")!.addEventListener("click", () => void this.openWorkspaceManager().then(showWorkspace));
    body.querySelector(".phrase")!.addEventListener("click", () => void this.openPassphraseChange());
    this.showModal(overlay);
  }

  /** Shows `accent` everywhere, the editor included (its theme reads the colours from theme.css). */
  private showAccent(accent: Accent): void {
    applyAccent(accent);
    setTheme(this.theme);
  }

  private async savePreferences(event: SubmitEvent, overlay: HTMLElement): Promise<void> {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const error = form.querySelector<HTMLElement>(".error")!;
    const minutes = Number((form.elements.namedItem("auto-lock") as HTMLInputElement).value);
    const theme = (form.elements.namedItem("theme") as HTMLSelectElement).value as ThemePreference;
    const accent = (form.querySelector<HTMLInputElement>('input[name="accent"]:checked')?.value ?? this.accent) as Accent;
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > 1440) {
      error.textContent = "Auto-lock must be a whole number from 0 to 1440.";
      return;
    }
    try {
      if (isTauri) await ipc.settingsSet(minutes, theme, accent);
      this.autoLockMinutes = minutes;
      this.theme = theme;
      this.accent = accent;
      applyAccent(accent);
      setTheme(theme);
      this.armIdleLock();
      overlay.remove();
    } catch (caught) {
      error.textContent = ipcMessage(caught);
    }
  }

  // Workspaces ---------------------------------------------------------------

  /** Updates the sidebar picker; the main view is the only place it exists. */
  private updateWorkspacePicker(): void {
    const picker = this.root.querySelector<HTMLButtonElement>("#workspace-picker");
    if (!picker) return;
    const workspace = this.activeWorkspace();
    const name = workspace?.name ?? "Workspace";
    setText(picker.querySelector(".workspace-avatar"), workspaceInitial(name));
    setText(picker.querySelector(".workspace-picker-name"), name);
    setAttribute(picker, "title", workspace ? `${name} · ${locationLabel(workspace)}. Switch workspace` : "Switch workspace");
    setAttribute(picker, "aria-label", `Workspace: ${name}. Switch workspace`);
  }

  /** The workspace menu under `anchor`: every workspace (the active one checked) and the manager. */
  private toggleWorkspaceMenu(anchor: HTMLButtonElement): void {
    if (anchor.getAttribute("aria-expanded") === "true" || performance.now() - this.workspaceMenuClosedAt < 250) {
      this.contextMenu.close();
      return;
    }
    const actions: ContextAction[] = this.workspaceList.workspaces.map((workspace) => ({
      label: workspace.name,
      detail: locationLabel(workspace),
      checked: workspace.id === this.workspaceList.active,
      run: () => void this.switchTo(workspace.id),
    }));
    // Focus goes back to the anchor first, so it gets focus again when the manager closes.
    actions.push({ label: "Manage workspaces…", icon: "gear", separatorBefore: actions.length > 0, run: () => { anchor.focus(); void this.openWorkspaceManager(); } });
    const rect = anchor.getBoundingClientRect();
    anchor.setAttribute("aria-expanded", "true");
    this.contextMenu.show(rect.left, rect.bottom + 4, actions, {
      className: "workspace-menu",
      // As wide as the sidebar it opens from.
      properties: this.resizers ? { "--sidebar-width": `${this.resizers.current.sidebar}px` } : undefined,
      onClose: () => {
        anchor.setAttribute("aria-expanded", "false");
        this.workspaceMenuClosedAt = performance.now();
      },
    });
  }

  /**
   * Saves the open document (as Lock does), makes `id` active and opens it:
   * with its remembered phrase straight away, otherwise on the unlock screen.
   */
  private async switchTo(id: string): Promise<void> {
    if (this.switching || this.locking) return;
    if (id === this.workspaceList.active && this.screen === "main") return;
    this.switching = true;
    // An unlock still running for the workspace on screen shows nothing now.
    this.nextAuth();
    try {
      const thaw = await this.saveBeforeClosing("Could not switch", "switch again");
      if (!thaw) return;
      try {
        await this.workspaces.select(id);
      } catch (caught) {
        thaw();
        await this.message("Could not switch workspace", authErrorMessage(caught, ipcMessage(caught)));
        if (this.screen !== "main") this.showLocked();
        return;
      }
      // Rust ended the session; queued edits wait in that workspace's outbox.
      if (this.editor) this.leaveWorkspace();
      document.querySelectorAll(".modal-overlay").forEach((overlay) => overlay.remove());
      await this.reloadWorkspaces();
      await this.enterActive();
    } finally {
      this.switching = false;
    }
  }

  /**
   * Saves the open document before its workspace closes (lock, switch, move,
   * delete). The editor is read-only meanwhile, so nothing typed is left
   * out: every edit is in the outbox and S3 got a few seconds. Returns what
   * makes the editor editable again if the workspace stays open after all,
   * or null (after a message) when the outbox could not be written.
   */
  private async saveBeforeClosing(title: string, retry: string): Promise<(() => void) | null> {
    if (!this.editor) return () => {};
    // Document windows save and close first (each as its close button
    // does); one that cannot save keeps the workspace open.
    this.exiting = true;
    if (!(await this.closeDocumentWindows(title))) {
      this.exiting = false;
      return null;
    }
    this.documents.invalidate();
    const frozen = this.editor.freeze();
    const thaw = (): void => {
      frozen();
      this.exiting = false;
      // A document a closed window wrote is writable here again.
      const open = this.documents.openId;
      if (open && this.openElsewhere) void this.writerChanged(open);
    };
    const failed = async (): Promise<null> => {
      thaw();
      await this.message(title, `The open document could not be saved on this device. Retry, then ${retry}.`);
      return null;
    };
    if (!(await this.documents.flushForExit())) return failed();
    if (isTauri) await uploadQueuedEdits();
    // Anything typed before the editor froze reaches the outbox before the session ends.
    if (!(await this.documents.persist())) return failed();
    return thaw;
  }

  /**
   * Main window: every document window saves and closes (lock, switch,
   * phrase change, quit). False, after a message, when one stays open
   * because its edit could not be written even to the outbox.
   */
  private async closeDocumentWindows(title: string): Promise<boolean> {
    if (!isTauri || this.docWindow) return true;
    try {
      await ipc.documentWindowsClose();
      return true;
    } catch (caught) {
      await this.message(title, ipcMessage(caught));
      return false;
    }
  }

  /** Asks whether to go on although edits of `workspace` are not uploaded yet. */
  private confirmLeavePending(workspace: WorkspaceSummary, action: "move" | "delete"): Promise<boolean> {
    const consequence = action === "move"
      ? "If you change its bucket or prefix now, they stay on this device and are uploaded only when a workspace points at the current location again."
      : "If you delete it now, they stay on this device and are uploaded only when a workspace points at this location again.";
    return this.confirm(
      "Edits not uploaded yet",
      `Some edits of “${workspace.name}” are saved on this device but have not reached S3. ${consequence} To upload them first, open the workspace while S3 is reachable.`,
      action === "move" ? "Save anyway" : "Delete anyway",
    );
  }

  /** Locked screens show the active workspace; after a change in the manager they show it again. */
  private refreshLockedScreen(): void {
    if (this.screen !== "unlock" && this.screen !== "connect") return;
    const step = launchStep(this.workspaceList);
    if (step.kind === "setup") {
      document.querySelectorAll(".modal-overlay").forEach((overlay) => overlay.remove());
      this.renderConnect(null);
    } else if (step.kind === "connect") this.renderConnect(step.workspace, authErrorMessage({ code: "NO_CREDENTIALS" }, ""));
    else this.renderUnlock(step.workspace);
  }

  /** Resolves when the manager is closed (Done, Escape or the close button). */
  private openWorkspaceManager(): Promise<void> {
    let closed = (): void => {};
    const done = new Promise<void>((resolve) => { closed = resolve; });
    const overlay = this.modal("Workspaces", "Each workspace is a bucket and prefix with its own S3 credentials and encryption phrase, sealed on this device.", () => closed());
    overlay.querySelector(".modal")!.classList.add("workspace-manager");
    const body = overlay.querySelector<HTMLElement>(".modal-body")!;
    body.innerHTML = `<div class="workspace-list" role="list"></div><p class="error" role="alert"></p><div class="modal-actions"><button type="button" class="button add"><span>Add workspace…</span></button><span class="modal-actions-spacer"></span><button type="button" class="button button-primary done">Done</button></div>`;
    body.querySelector(".add")!.prepend(icon("plus"));
    const list = body.querySelector<HTMLElement>(".workspace-list")!;
    const error = body.querySelector<HTMLElement>(".error")!;
    // After a change the rows are new: focus goes to the changed row (or Done when it is gone).
    const focusRow = (id: string): void => {
      const row = [...list.querySelectorAll<HTMLElement>(".workspace-row")].find((candidate) => candidate.dataset.workspaceId === id);
      (row?.querySelector<HTMLButtonElement>(".workspace-row-actions .icon-button") ?? body.querySelector<HTMLButtonElement>(".done"))?.focus();
    };
    const render = (): void => {
      list.replaceChildren(...this.workspaceList.workspaces.map((workspace) => this.workspaceRow(workspace, {
        edit: () => void this.openWorkspaceForm(workspace).then((saved) => { if (saved && overlay.isConnected) { render(); focusRow(saved.id); } }),
        remove: () => void this.deleteWorkspace(workspace).then((removed) => { if (removed && overlay.isConnected) { render(); focusRow(workspace.id); } }),
        open: () => void this.switchTo(workspace.id),
      })));
      if (this.workspaceList.workspaces.length === 0) {
        const empty = document.createElement("p");
        empty.className = "modal-message";
        empty.textContent = "No workspaces yet.";
        list.append(empty);
      }
      error.textContent = "";
    };
    render();
    body.querySelector(".add")!.addEventListener("click", () => void this.openWorkspaceForm(null).then((saved) => { if (saved && overlay.isConnected) { render(); focusRow(saved.id); } }));
    body.querySelector(".done")!.addEventListener("click", () => { overlay.remove(); closed(); });
    this.showModal(overlay);
    body.querySelector<HTMLButtonElement>(".done")!.focus();
    return done;
  }

  private workspaceRow(workspace: WorkspaceSummary, actions: { edit: () => void; remove: () => void; open: () => void }): HTMLElement {
    const active = workspace.id === this.workspaceList.active;
    const row = document.createElement("div");
    row.className = active ? "workspace-row is-active" : "workspace-row";
    row.dataset.workspaceId = workspace.id;
    row.setAttribute("role", "listitem");
    row.innerHTML = `<span class="workspace-avatar workspace-avatar-large"></span><div class="workspace-row-text"><div class="workspace-row-title"><strong></strong></div><span class="workspace-row-location"></span><div class="chips"></div></div><div class="workspace-row-actions"></div>`;
    setText(row.querySelector(".workspace-avatar"), workspaceInitial(workspace.name));
    setText(row.querySelector("strong"), workspace.name);
    setText(row.querySelector(".workspace-row-location"), locationLabel(workspace));
    const title = row.querySelector(".workspace-row-title")!;
    if (active) title.append(chip("Active", "chip-accent"));
    const chips = row.querySelector(".chips")!;
    const missing = chip("Credentials missing", "chip-warning");
    missing.prepend(icon("warning"));
    chips.append(
      workspace.credentials_stored
        ? chip(workspace.masked_access_key_id ? `Credentials stored · ${workspace.masked_access_key_id}` : "Credentials stored", "chip-success")
        : missing,
      workspace.phrase_stored ? chip("Phrase remembered", "chip-success") : chip("Asks for phrase"),
    );
    const buttons = row.querySelector(".workspace-row-actions")!;
    if (!active || this.screen !== "main") {
      const open = document.createElement("button");
      open.type = "button";
      open.className = "button button-ghost workspace-open";
      open.textContent = active ? "Open" : "Switch";
      const name = `${active ? "Open" : "Switch to"} ${workspace.name}`;
      open.title = name;
      open.setAttribute("aria-label", name);
      open.addEventListener("click", actions.open);
      buttons.append(open);
    }
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "icon-button";
    edit.title = `Edit ${workspace.name}`;
    edit.setAttribute("aria-label", `Edit ${workspace.name}`);
    edit.append(icon("pencil"));
    edit.addEventListener("click", actions.edit);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "icon-button icon-button-danger";
    remove.title = `Delete ${workspace.name}`;
    remove.setAttribute("aria-label", `Delete ${workspace.name}`);
    remove.append(icon("trash"));
    remove.addEventListener("click", actions.remove);
    buttons.append(edit, remove);
    return row;
  }

  /**
   * Adds (`target` null) or edits a workspace. Blank secret fields keep what
   * is stored. Moving the open workspace to another bucket, region, prefix or
   * endpoint saves the open document, saves the change and opens it again.
   */
  private openWorkspaceForm(target: WorkspaceSummary | null): Promise<WorkspaceSummary | null> {
    return new Promise((resolve) => {
      const overlay = this.modal(
        target ? "Edit workspace" : "Add workspace",
        target ? "Secret fields left blank keep what is stored on this device." : "Another bucket or prefix, with its own credentials and encryption phrase.",
        () => resolve(null),
      );
      const body = overlay.querySelector<HTMLElement>(".modal-body")!;
      body.innerHTML = `<form class="modal-form workspace-form" novalidate>${workspaceFields(target, { create: !target, connect: false })}<p class="error" role="alert"></p><div class="modal-actions"><button type="button" class="button cancel">Cancel</button><button type="submit" class="button button-primary">${target ? "Save" : "Add workspace"}</button></div></form>`;
      const form = body.querySelector<HTMLFormElement>("form")!;
      bindWorkspaceFields(form);
      const done = (saved: WorkspaceSummary | null): void => { overlay.remove(); resolve(saved); };
      body.querySelector(".cancel")!.addEventListener("click", () => done(null));
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        void this.submitWorkspaceForm(form, target).then((saved) => { if (saved) done(saved); });
      });
      this.showModal(overlay);
      (form.elements.namedItem(target ? "name" : "bucket") as HTMLInputElement).focus();
    });
  }

  private async submitWorkspaceForm(form: HTMLFormElement, target: WorkspaceSummary | null): Promise<WorkspaceSummary | null> {
    const error = form.querySelector<HTMLElement>(".error")!;
    const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    const label = submit.textContent ?? "";
    const values = readWorkspaceForm(form);
    const problem = checkWorkspaceForm(values, { existing: target, others: this.workspaceList.workspaces });
    showFormProblem(form, error, problem);
    if (problem) return null;
    const open = !!target && target.id === this.workspaceList.active && this.screen === "main";
    const moving = open && locationChanged(target, values);
    let thaw: () => void = () => {};
    if (moving) {
      const proceed = await this.confirm(
        "Reopen at the new location?",
        "Changing the bucket, region, prefix or endpoint locks this workspace. The open document is saved first; the workspace then opens at the new location.",
        "Save and reopen",
        { danger: false },
      );
      if (!proceed) return null;
      const saved = await this.saveBeforeClosing("Workspace not changed", "save the workspace again");
      if (!saved) return null;
      thaw = saved;
    }
    submit.disabled = true;
    submit.textContent = "Saving…";
    const input = workspaceInput(values, target, { withPhrase: true });
    let saved: WorkspaceSummary;
    try {
      try {
        saved = await this.workspaces.save(input);
      } catch (caught) {
        // Queued edits would stay behind at the old location: only with the user's word.
        if (errorCode(caught) !== "OUTBOX_PENDING" || !target || !(await this.confirmLeavePending(target, "move"))) throw caught;
        saved = await this.workspaces.save({ ...input, leave_pending: true });
      }
    } catch (caught) {
      thaw();
      error.textContent = authErrorMessage(caught, ipcMessage(caught));
      submit.disabled = false;
      submit.textContent = label;
      return null;
    }
    await this.reloadWorkspaces();
    if (moving) {
      // Rust ended the session that read the old location.
      this.leaveWorkspace();
      await this.enterActive();
    } else if (this.screen === "main") {
      this.armIdleLock();
    } else {
      this.refreshLockedScreen();
    }
    return saved;
  }

  /** Deletes a workspace after a confirmation; the open one is locked first. Never touches S3 or queued edits. */
  private async deleteWorkspace(target: WorkspaceSummary): Promise<boolean> {
    const open = target.id === this.workspaceList.active && this.screen === "main";
    const confirmed = await this.confirm(
      `Delete “${target.name}”?`,
      open
        ? "This workspace is open: it is locked first and the open document saved. Its stored credentials and remembered phrase are removed from this device. Documents in the bucket are not touched."
        : "Its stored credentials and remembered phrase are removed from this device. Documents in the bucket are not touched.",
      "Delete workspace",
    );
    if (!confirmed) return false;
    // An unlock still running for this workspace shows nothing now.
    if (target.id === this.workspaceList.active) this.nextAuth();
    if (open) {
      const thaw = await this.saveBeforeClosing("Workspace not deleted", "delete again");
      if (!thaw) return false;
      try {
        await this.workspaces.lock();
      } catch (caught) {
        thaw();
        await this.message("Workspace not deleted", ipcMessage(caught));
        return false;
      }
      this.leaveWorkspace();
    }
    try {
      try {
        this.workspaceList = await this.workspaces.remove(target.id);
      } catch (caught) {
        if (errorCode(caught) !== "OUTBOX_PENDING") throw caught;
        if (!(await this.confirmLeavePending(target, "delete"))) {
          if (open) await this.enterActive();
          return false;
        }
        this.workspaceList = await this.workspaces.remove(target.id, true);
      }
    } catch (caught) {
      await this.message("Workspace not deleted", authErrorMessage(caught, ipcMessage(caught)));
      if (open) await this.enterActive();
      return false;
    }
    this.updateWorkspacePicker();
    if (open) await this.enterActive();
    else this.refreshLockedScreen();
    return true;
  }

  private async openPassphraseChange(): Promise<void> {
    const overlay = this.modal("Change encryption phrase", "Close Notebook on other devices first. Every encrypted object is copied and verified before old-key objects are removed.");
    const body = overlay.querySelector<HTMLElement>(".modal-body")!;
    body.innerHTML = `<form class="modal-form">
      <label class="field">Current phrase<input name="old" type="password" required autocomplete="off"></label>
      <label class="field">New phrase<input name="next" type="password" minlength="12" required autocomplete="new-password"></label>
      <label class="field">Confirm new phrase<input name="confirm" type="password" minlength="12" required autocomplete="new-password"></label>
      <p class="error" role="alert"></p>
      <div class="modal-actions"><button type="button" class="button cancel">Cancel</button><button type="submit" class="button button-primary">Change phrase</button></div>
    </form>`;
    const form = body.querySelector<HTMLFormElement>("form")!;
    body.querySelector(".cancel")!.addEventListener("click", () => overlay.remove());
    form.addEventListener("submit", (event) => void this.changePassphrase(event, overlay));
    this.showModal(overlay);
  }

  private async changePassphrase(event: SubmitEvent, overlay: HTMLElement): Promise<void> {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const error = form.querySelector<HTMLElement>(".error")!;
    const oldPhrase = (form.elements.namedItem("old") as HTMLInputElement).value;
    const newPhrase = (form.elements.namedItem("next") as HTMLInputElement).value;
    const confirmation = (form.elements.namedItem("confirm") as HTMLInputElement).value;
    if (newPhrase !== confirmation) { error.textContent = "The new phrases do not match."; return; }
    if (newPhrase.trim().length < 12) { error.textContent = "Use at least 12 non-whitespace characters."; return; }
    const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    submit.disabled = true;
    submit.textContent = "Migrating…";
    try {
      if (!(await this.documents.save())) throw new Error("Save the open document before changing the phrase.");
      // Every key changes: document windows save and close first.
      if (isTauri) await ipc.documentWindowsClose();
      const result = await ipc.passphraseChange(oldPhrase, newPhrase);
      form.reset();
      overlay.remove();
      // The backend migrated every object; its new tree needs no listing.
      await this.resyncTree();
      await this.message(
        "Phrase changed",
        result.cleanup_pending
          ? "The new phrase is active. Some old encrypted objects could not yet be removed; Notebook will retry cleanup on the next unlock."
          : "The workspace now uses the new phrase on this device and in S3.",
      );
    } catch (caught) {
      error.textContent = safeErrorMessage(caught, "The phrase could not be changed. No only-copy of a document was deleted.");
      submit.disabled = false;
      submit.textContent = "Change phrase";
    }
  }

  // ContextMenu closes on a pointerdown outside the menu only, so a click on
  // an item reaches it (the old menu closed on any pointerdown, before the click).
  private showNodeMenu(node: TreeNode, x: number, y: number): void {
    const actions: ContextAction[] = [];
    if (kindName(node) === "Folder") {
      actions.push(
        { label: "New file…", run: () => void this.createFile() },
        { label: "New folder", run: () => void this.createFolder() },
      );
    }
    if (kindName(node) === "Document") {
      actions.push({ label: "Open in new window", shortcut: NEW_WINDOW_KEYS, run: () => void this.openInNewWindow(node.id) });
    }
    actions.push(
      { label: "Rename…", run: () => void this.renameNode(node), separatorBefore: kindName(node) === "Document" },
      { label: "Move to Trash", danger: true, run: () => void this.trashNode(node) },
    );
    this.contextMenu.show(x, y, actions);
  }

  private async renameNode(node: TreeNode): Promise<void> {
    const name = await this.prompt("Rename item", "Name", node.name);
    if (!name || name.trim() === node.name) return;
    await this.relocate(node, "Rename failed", async () => {
      if (isTauri) return ipc.nodeRename(node.id, name);
      const parent = node.parent ?? ROOT;
      const siblings = this.tree.children(parent).filter((item) => item.id !== node.id);
      this.tree.change([{ ...node, name: uniqueName(siblings, name.trim()) }]);
      return { id: node.id };
    });
  }

  private async moveNode(id: string, parentId: string): Promise<void> {
    const node = this.tree.get(id);
    if (!node) return;
    await this.relocate(node, "Move failed", async () => {
      this.expanded.add(parentId);
      if (isTauri) return ipc.nodeMove(id, parentId);
      this.tree.change([{ ...node, parent: parentId }]);
      return { id };
    });
  }

  private async trashNode(node: TreeNode): Promise<void> {
    if (!(await this.confirm("Move to Trash?", `“${node.name}” will stay encrypted and can be restored later.`, "Move to Trash"))) return;
    await this.relocate(node, "Could not move item", async () => {
      if (isTauri) return { id: null, tree: (await ipc.nodeTrash(node.id)).tree };
      this.trashLocally(node);
      return { id: null };
    });
  }

  /** Browser mode: Move to Trash keeps the nodes for Restore and lists a Trash entry, as Rust does. */
  private trashLocally(node: TreeNode): void {
    const gone: TreeNode[] = [];
    const collect = (item: TreeNode): void => {
      gone.push(item);
      for (const child of this.tree.children(item.id)) collect(child);
    };
    collect(node);
    const key = `local:${crypto.randomUUID()}`;
    const isFolder = kindName(node) === "Folder";
    const documents = gone.filter((item) => kindName(item) === "Document").length;
    const path = this.tree.pathOf(node.id).slice(1);
    const entry: TreeNode = {
      id: `trash-${key}`, parent: TRASH, name: node.name, kind: "TrashEntry", trash_entry_id: key,
      origin: {
        name: node.name, original_path: path, location: path.split("/").slice(0, -1).join("/"), deleted_at: Date.now(),
        item_kind: isFolder ? "Folder" : "Document", item_count: gone.length - 1, doc_count: documents,
        folder_count: gone.length - documents - (isFolder ? 1 : 0), image_count: 0, legacy: false,
      },
    };
    this.localTrash.set(key, gone);
    this.tree.change([entry], gone.map((item) => item.id));
  }

  private affectsOpenDocument(node: TreeNode): boolean {
    const openId = this.documents.openId;
    if (!openId) return false;
    if (node.id === openId) return true;
    return kindName(node) === "Folder" && this.tree.has(openId) && this.tree.pathOf(openId).startsWith(`${this.tree.pathOf(node.id)}/`);
  }

  /**
   * Runs a rename, move or trash of `node` and applies its tree delta (one
   * IPC call, no listing). Ids follow paths, so afterwards the open document,
   * the selection and expanded folders are looked up again by path: `action`
   * returns the item's new id, or null when it left the tree.
   */
  private async relocate(node: TreeNode, failure: string, action: () => Promise<{ id: string | null; tree?: TreeDelta | null }>): Promise<void> {
    if (!(await this.documents.save()) && this.affectsOpenDocument(node)) {
      await this.message(failure, "The open document could not be uploaded to S3, so nothing was changed.");
      return;
    }
    // The paths, before the change, of everything that has to follow it.
    const tracked = new Map<string, { kind: "Folder" | "Document"; path: string }>();
    for (const id of [...this.expanded, this.selected, this.documents.openId]) {
      const item = this.tree.get(id);
      const kind = item && kindName(item);
      if (item && (kind === "Folder" || kind === "Document")) tracked.set(item.id, { kind, path: this.tree.pathOf(item.id) });
    }
    const source = this.tree.pathOf(node.id);
    let destination: string | null = source;
    let error: unknown;
    let failed = false;
    this.documents.hold();
    try {
      const result = await action();
      this.applyTree(result.tree, false);
      if (this.tree.behind) await this.resyncTree(false);
      destination = result.id === null ? null : this.tree.has(result.id) ? this.tree.pathOf(result.id) : source;
    } catch (caught) {
      failed = true;
      error = caught;
      await this.resyncTree(false);
    } finally {
      this.documents.release();
    }
    // Locked meanwhile: the page no longer holds a tree to update.
    if (!this.editor) return;
    await this.followRelocation(tracked, source, destination);
    if (failed) await this.message(failure, ipcMessage(error));
  }

  /**
   * A renamed or moved open document stays in the editor (with its model,
   * undo history and preview) under its new id; a trashed one is replaced by
   * the first document. The tree renders once.
   */
  private async followRelocation(
    tracked: Map<string, { kind: "Folder" | "Document"; path: string }>,
    source: string,
    destination: string | null,
  ): Promise<void> {
    const follow = (id: string | null): string | null => {
      if (!id) return null;
      const before = tracked.get(id);
      if (!before) return this.tree.has(id) ? id : null;
      const inside = before.path === source || before.path.startsWith(`${source}/`);
      if (inside && destination === null) return null;
      const path = inside ? `${destination}${before.path.slice(source.length)}` : before.path;
      return this.tree.find(before.kind, path)?.id ?? null;
    };
    this.expanded = new Set([...this.expanded].map(follow).filter((id): id is string => id !== null));
    const open = this.documents.openId;
    const followed = follow(open);
    this.selected = follow(this.selected) ?? followed ?? "";
    if (open && followed !== open) {
      this.documents.retarget(open, followed);
      if (followed) this.retargetOpen(open, followed);
    }
    const shown = this.tree.get(followed);
    if (!open || shown) {
      this.renderTree();
      if (shown) {
        this.showDocumentName(shown);
        this.applyPreviewMode();
      }
      return;
    }
    const first = this.tree.firstDocument();
    if (first) await this.openDocument(first);
    else this.closeDocument();
  }

  private async lock(automatic = false): Promise<void> {
    if (this.locking) return;
    this.locking = true;
    this.nextAuth();
    try {
      // Only a failed outbox write keeps the workspace open; an edit that S3
      // did not take within 3 s is uploaded by the next unlock.
      const thaw = await this.saveBeforeClosing(automatic ? "Auto-lock paused" : "Could not lock", "lock again");
      if (!thaw) {
        this.armIdleLock();
        return;
      }
      try {
        await this.workspaces.lock();
      } catch (caught) {
        thaw();
        await this.message("Could not lock", ipcMessage(caught));
        return;
      }
      this.leaveWorkspace();
      this.showLocked();
    } finally {
      this.locking = false;
    }
  }

  /** The unlock screen of the active workspace (or what stands in for it). */
  private showLocked(): void {
    const workspace = this.activeWorkspace();
    if (workspace) this.renderUnlock(workspace);
    else void this.enterActive();
  }

  private forcedLock(): void {
    if (!this.editor) return;
    this.leaveWorkspace();
    this.showLocked();
    void this.message("Workspace locked", "The backend locked the workspace after the idle grace period.");
  }

  /**
   * Drops the editor, its models and every decrypted name and text the page
   * holds. The WebView is not reloaded; strings already created are left to
   * garbage collection.
   */
  private leaveWorkspace(): void {
    this.nextAuth();
    this.exiting = false;
    this.openElsewhere = false;
    // No file name stays in the window title once the workspace is locked.
    this.endFocusState();
    this.cancelPreview();
    this.htmlPreview.reset();
    this.documents.reset();
    this.editor?.destroy();
    this.editor = null;
    this.selected = "";
    this.search = "";
    this.tree.replace({ nodes: [] });
    this.treeView = null;
    if (this.resyncTimer !== null) window.clearTimeout(this.resyncTimer);
    this.resyncTimer = null;
    if (this.drawFrame !== null) cancelAnimationFrame(this.drawFrame);
    this.drawFrame = null;
    this.docs.clear();
    this.localTrash.clear();
    this.contextMenu.close();
    this.closeWordCount();
    this.resizers?.dispose();
    this.resizers = null;
    document.querySelectorAll(".modal-overlay").forEach((overlay) => overlay.remove());
    window.removeEventListener("keydown", this.onSoftWrapKey, true);
    window.removeEventListener("keydown", this.onViewKey, true);
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("pointerdown", this.onActivity);
    window.removeEventListener("keydown", this.onActivity);
    window.removeEventListener("blur", this.onWindowBlur);
    window.removeEventListener("focus", this.onReconnect);
    window.removeEventListener("online", this.onReconnect);
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
  }

  // Focus moving into the HTML preview frame also blurs the window; that is
  // not leaving the app, so only a real blur uploads.
  private onWindowBlur = (): void => {
    setTimeout(() => { if (!document.hasFocus()) this.documents.background(); }, 0);
  };

  private onVisibilityChange = (): void => {
    if (document.visibilityState === "hidden") this.documents.background();
  };

  /** Back online or back in the window: retry failed uploads now. */
  private onReconnect = (): void => void this.documents.retryNow();

  /**
   * Answers within about 3.1 s: the edit is written to the outbox, then S3
   * gets 3 s. Only a failed outbox write keeps the window open.
   */
  private async beforeClose(): Promise<void> {
    // A pane size changed by keys in the last 500 ms is saved too.
    this.resizers?.flush();
    // Quitting closes the document windows too, each saving first.
    if (isTauri && !this.docWindow) {
      this.exiting = true;
      try {
        await ipc.documentWindowsClose();
      } catch (caught) {
        this.exiting = false;
        try { await ipc.cancelClose(); } catch { /* A later close can retry. */ }
        await this.message("Window kept open", ipcMessage(caught));
        return;
      }
    }
    if (await this.documents.flushForExit()) {
      try { await ipc.closeAfterFlush(); } catch { /* Rust closes the window after a timeout. */ }
      return;
    }
    try { await ipc.cancelClose(); } catch { /* A later close can retry. */ }
    await this.message("Window kept open", "The document could not be saved on this device. Your edit is still in the editor; retry before closing.");
  }

  // Items deleted here or in Notebook share Notebook's "_deleted" bin.
  private showTrash(): void {
    const entries = this.tree.trash();
    const overlay = this.modal("Trash", entries.length ? "Items deleted here or in Notebook. They stay encrypted in S3 until you delete them permanently." : "Trash is empty.");
    const body = overlay.querySelector<HTMLElement>(".modal-body")!;
    if (entries.length) {
      const list = document.createElement("div"); list.className = "trash-list";
      for (const entry of entries) {
        const row = document.createElement("div"); row.className = "trash-row";
        const text = document.createElement("div");
        const name = document.createElement("strong"); name.textContent = entry.name;
        const origin = document.createElement("span"); origin.textContent = trashAnnotation(entry);
        const when = document.createElement("span"); when.textContent = trashDeletedAt(entry);
        text.title = trashHover(entry);
        text.append(name, origin, when);
        const restore = document.createElement("button"); restore.className = "button"; restore.textContent = "Restore";
        restore.addEventListener("click", () => void this.restoreTrash(entry, overlay));
        const purge = document.createElement("button"); purge.className = "button button-danger"; purge.textContent = "Delete permanently";
        purge.addEventListener("click", () => void this.purgeTrash(entry, overlay));
        row.append(text, restore, purge); list.append(row);
      }
      body.append(list);
      const empty = document.createElement("button"); empty.className = "button button-danger modal-empty"; empty.textContent = "Empty Trash";
      empty.addEventListener("click", () => void this.emptyTrash(overlay)); body.append(empty);
    }
    this.showModal(overlay);
  }

  // Like Notebook, an occupied original path is never overwritten or renamed
  // silently: the user picks another folder or name instead.
  private async restoreTrash(entry: TreeNode, overlay: HTMLElement): Promise<void> {
    if (!isTauri) {
      overlay.remove();
      await this.afterRestore(entry, this.restoreLocally(entry));
      return;
    }
    try {
      const result = await ipc.trashRestore(trashEntryId(entry), "Original");
      overlay.remove();
      await this.afterRestore(entry, result);
    } catch (error) {
      // A failed restore may have copied or deleted part of the entry: take the session's tree again.
      if (errorCode(error) !== "RESTORE_CONFLICT") { await this.resyncTree(); await this.message("Restore failed", ipcMessage(error)); return; }
      const elsewhere = await this.confirm("Original location is taken", safeErrorMessage(error, "Something already exists at the original location."), "Restore to…", { danger: false });
      if (!elsewhere) return;
      overlay.remove();
      await this.restoreTrashTo(entry);
    }
  }

  private async restoreTrashTo(entry: TreeNode): Promise<void> {
    const folders = [{ id: ROOT, path: "/" }, ...[...this.tree.nodes()].filter((node) => kindName(node) === "Folder").map((node) => ({ id: node.id, path: this.tree.pathOf(node.id) }))]
      .sort((a, b) => a.path.localeCompare(b.path));
    const location = `/${entry.origin?.location ?? ""}`;
    const choice = await this.restoreToPrompt(entry.name, folders, folders.find((folder) => folder.path === location)?.id ?? ROOT);
    if (!choice) return;
    try {
      await this.afterRestore(entry, await ipc.trashRestore(trashEntryId(entry), { To: choice.folder }, choice.name));
    } catch (error) {
      if (errorCode(error) !== "RESTORE_CONFLICT") await this.resyncTree();
      await this.message("Restore failed", ipcMessage(error));
    }
  }

  private restoreToPrompt(name: string, folders: { id: string; path: string }[], selected: string): Promise<{ folder: string; name: string } | null> {
    return new Promise((resolve) => {
      const overlay = this.modal("Restore to…", "Choose a folder and a name that is not taken there.", () => resolve(null));
      const body = overlay.querySelector<HTMLElement>(".modal-body")!;
      const form = document.createElement("form"); form.className = "modal-form";
      const folderLabel = document.createElement("label"); folderLabel.textContent = "Folder";
      const select = document.createElement("select");
      for (const folder of folders) {
        const option = document.createElement("option"); option.value = folder.id; option.textContent = folder.path;
        option.selected = folder.id === selected; select.append(option);
      }
      folderLabel.append(select);
      const nameLabel = document.createElement("label"); nameLabel.textContent = "Name";
      const input = document.createElement("input");
      Object.assign(input, { value: name, maxLength: 255, required: true, autocomplete: "off", spellcheck: false });
      nameLabel.append(input);
      const actions = document.createElement("div"); actions.className = "modal-actions";
      const cancel = document.createElement("button"); cancel.type = "button"; cancel.className = "button cancel"; cancel.textContent = "Cancel";
      const submit = document.createElement("button"); submit.type = "submit"; submit.className = "button button-primary"; submit.textContent = "Restore";
      actions.append(cancel, submit);
      form.append(folderLabel, nameLabel, actions);
      body.append(form);
      const done = (answer: { folder: string; name: string } | null): void => { overlay.remove(); resolve(answer); };
      cancel.addEventListener("click", () => done(null));
      form.addEventListener("submit", (event) => { event.preventDefault(); done({ folder: select.value, name: input.value }); });
      this.showModal(overlay); input.focus(); input.select();
    });
  }

  /** Browser mode: the item goes back to its folder (the root if that is gone), under a free name. */
  private restoreLocally(entry: TreeNode): RestoreResult {
    const key = trashEntryId(entry);
    const [item, ...inside] = this.localTrash.get(key) ?? [];
    this.localTrash.delete(key);
    if (!item) {
      this.tree.change([], [entry.id]);
      return { restored_id: "", final_name: entry.name, final_path: entry.name };
    }
    const parent = item.parent && this.tree.has(item.parent) ? item.parent : ROOT;
    const restored = { ...item, parent, name: uniqueName(this.tree.children(parent), item.name) };
    this.tree.change([restored, ...inside], [entry.id]);
    return { restored_id: restored.id, final_name: restored.name, final_path: this.tree.pathOf(restored.id).slice(1) };
  }

  private async afterRestore(entry: TreeNode, result: RestoreResult): Promise<void> {
    this.applyTree(result.tree, false);
    const restored = this.tree.get(result.restored_id);
    for (let parent = restored?.parent; parent && parent !== ROOT; parent = this.tree.get(parent)?.parent) this.expanded.add(parent);
    if (restored && kindName(restored) === "Document") await this.openDocument(restored.id);
    else this.renderTree();
    const path = `/${result.final_path ?? entry.name}`;
    if (path !== `/${entry.origin?.original_path ?? ""}`) await this.message("Restored", `“${entry.name}” was restored to ${path}.`);
  }

  private async purgeTrash(entry: TreeNode, overlay: HTMLElement): Promise<void> {
    if (!(await this.confirm("Delete permanently?", `“${entry.name}” will be removed from S3 for this app and Notebook. This cannot be undone.`, "Delete permanently"))) return;
    await this.deleteFromTrash(overlay, "Delete failed", () => isTauri ? ipc.trashPurge([trashEntryId(entry)]) : this.purgeLocally([entry]), true);
  }

  private async emptyTrash(overlay: HTMLElement): Promise<void> {
    if (!(await this.confirm("Empty Trash?", "Every item in Trash, including items deleted in Notebook, will be permanently removed from S3.", "Empty Trash"))) return;
    await this.deleteFromTrash(overlay, "Empty Trash failed", () => isTauri ? ipc.trashEmpty() : this.purgeLocally(this.tree.trash()), false);
  }

  /** Browser mode: Delete permanently and Empty Trash. */
  private async purgeLocally(entries: TreeNode[]): Promise<{ tree?: TreeDelta | null }> {
    for (const entry of entries) this.localTrash.delete(trashEntryId(entry));
    this.tree.change([], entries.map((entry) => entry.id));
    return {};
  }

  /**
   * Runs a purge. A failed one may have deleted part of what it was given
   * (its delta is lost): changeTree takes the session's tree again, and the
   * open Trash dialog is drawn from it, so it lists what is really left.
   */
  private async deleteFromTrash(overlay: HTMLElement, failure: string, purge: () => Promise<{ tree?: TreeDelta | null }>, reopen: boolean): Promise<void> {
    const generation = this.authGeneration;
    let failed: unknown = null;
    try {
      await this.changeTree(purge());
    } catch (error) { failed = error; }
    if (generation !== this.authGeneration) return;
    if (this.tree.behind) await this.resyncTree(false);
    overlay.remove(); this.renderTree();
    if (reopen || failed) this.showTrash();
    if (failed) await this.message(failure, ipcMessage(failed));
  }

  private modal(title: string, description = "", onDismiss?: () => void): HTMLElement {
    const overlay = document.createElement("div"); overlay.className = "modal-overlay";
    overlay.innerHTML = `<section class="modal" role="dialog" aria-modal="true"><header><div><h2>${escapeHtml(title)}</h2>${description ? `<p>${escapeHtml(description)}</p>` : ""}</div><button class="modal-close" aria-label="Close">×</button></header><div class="modal-body"></div></section>`;
    const dismiss = (): void => { overlay.remove(); onDismiss?.(); };
    overlay.querySelector(".modal-close")!.addEventListener("click", dismiss);
    overlay.addEventListener("pointerdown", (event) => { if (event.target === overlay) dismiss(); });
    overlay.addEventListener("keydown", (event) => { if (event.key === "Escape") { event.preventDefault(); dismiss(); } });
    return overlay;
  }

  private showModal(overlay: HTMLElement): void {
    // The menu layer sits above modals; a dialog (F2, Delete) replaces both popups.
    this.contextMenu.close();
    this.closeWordCount();
    const opener = document.activeElement;
    this.modalOpeners.set(overlay, opener instanceof HTMLElement && opener !== document.body ? opener : null);
    this.watchModals();
    document.body.append(overlay);
    this.layerModals();
  }

  /**
   * Only the top dialog takes input: the page and lower dialogs are inert, so
   * Tab stays in it. When a dialog closes, focus returns to what opened it,
   * or into the dialog now on top.
   */
  private watchModals(): void {
    if (this.modalObserver) return;
    this.modalObserver = new MutationObserver((records) => {
      const removed = records
        .flatMap((record) => [...record.removedNodes])
        .filter((node): node is HTMLElement => node instanceof HTMLElement && node.classList.contains("modal-overlay"));
      const added = records.some((record) => [...record.addedNodes].some((node) => node instanceof HTMLElement && node.classList.contains("modal-overlay")));
      if (removed.length === 0 && !added) return;
      this.layerModals();
      // After the code that closed the dialog ran (it may re-enable its opener or render a new screen).
      if (removed.length > 0) window.setTimeout(() => this.restoreModalFocus(removed.reverse()), 0);
    });
    this.modalObserver.observe(document.body, { childList: true });
  }

  private restoreModalFocus(closed: HTMLElement[]): void {
    // A new screen or dialog may already have taken focus.
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && focused !== document.body && focused.isConnected) return;
    for (const overlay of closed) {
      const opener = this.modalOpeners.get(overlay);
      if (opener?.isConnected && !opener.closest("[inert]")) {
        opener.focus();
        if (document.activeElement === opener) return;
      }
    }
    topModal()?.querySelector<HTMLElement>(".done, .modal-close")?.focus();
  }

  private layerModals(): void {
    const overlays = [...document.querySelectorAll<HTMLElement>(".modal-overlay")];
    this.root.inert = overlays.length > 0;
    overlays.forEach((overlay, index) => { overlay.inert = index < overlays.length - 1; });
  }

  private prompt(title: string, label: string, value: string): Promise<string | null> {
    return new Promise((resolve) => {
      const overlay = this.modal(title, "", () => resolve(null));
      const body = overlay.querySelector<HTMLElement>(".modal-body")!;
      body.innerHTML = `<form class="modal-form"><label class="field">${escapeHtml(label)}<input value="${escapeHtml(value)}" maxlength="255" required autocomplete="off" spellcheck="false"></label><div class="modal-actions"><button type="button" class="button cancel">Cancel</button><button type="submit" class="button button-primary">Save</button></div></form>`;
      const done = (answer: string | null): void => { overlay.remove(); resolve(answer); };
      body.querySelector(".cancel")!.addEventListener("click", () => done(null));
      body.querySelector("form")!.addEventListener("submit", (event) => { event.preventDefault(); done(body.querySelector<HTMLInputElement>("input")!.value); });
      this.showModal(overlay); const input = body.querySelector<HTMLInputElement>("input")!; input.focus(); input.select();
    });
  }

  private confirm(title: string, description: string, action: string, options: { detail?: string; danger?: boolean } = {}): Promise<boolean> {
    return new Promise((resolve) => {
      const overlay = this.modal(title, description, () => resolve(false)); const body = overlay.querySelector<HTMLElement>(".modal-body")!;
      body.innerHTML = `<div class="modal-actions"><button class="button cancel">Cancel</button><button class="button ${options.danger === false ? "button-primary" : "button-danger"} confirm">${escapeHtml(action)}</button></div>`;
      if (options.detail !== undefined) {
        const detail = document.createElement("p"); detail.className = "modal-detail"; detail.textContent = options.detail;
        body.prepend(detail);
      }
      const done = (answer: boolean): void => { overlay.remove(); resolve(answer); };
      body.querySelector(".cancel")!.addEventListener("click", () => done(false)); body.querySelector(".confirm")!.addEventListener("click", () => done(true));
      this.showModal(overlay);
      body.querySelector<HTMLButtonElement>(".cancel")!.focus();
    });
  }

  private message(title: string, description: string): Promise<void> {
    return new Promise((resolve) => {
      const overlay = this.modal(title, description, resolve); const body = overlay.querySelector<HTMLElement>(".modal-body")!;
      body.innerHTML = `<div class="modal-actions"><button class="button button-primary">OK</button></div>`;
      body.querySelector("button")!.addEventListener("click", () => { overlay.remove(); resolve(); }); this.showModal(overlay);
      // As confirm() does: Enter and Escape reach the dialog also when what opened it lost focus to the inert page.
      body.querySelector<HTMLButtonElement>("button")!.focus();
    });
  }

  private async openExternalLink(url: string): Promise<void> {
    if (this.linkPromptOpen) return;
    this.linkPromptOpen = true;
    try {
      if (url.length > MAX_LINK_LENGTH) {
        await this.message("Link not opened", `Links longer than ${MAX_LINK_LENGTH} characters are not opened.`);
        return;
      }
      const mail = url.startsWith("mailto:");
      const confirmed = await this.confirm(
        mail ? "Open in your mail app?" : "Open in your browser?",
        mail ? "This link starts a message in your default mail app." : "This link leaves Notebook and opens in your default browser.",
        "Open link",
        { detail: url, danger: false },
      );
      if (!confirmed) return;
      if (isTauri) await ipc.linkOpen(url);
      else openInBrowserTab(url);
    } catch (caught) {
      await this.message("Link not opened", safeErrorMessage(caught, "The link could not be opened."));
    } finally {
      this.linkPromptOpen = false;
    }
  }

  private onKeyDown = (event: KeyboardEvent): void => {
    // A document window has no sidebar, workspace or lock: only Cmd/Ctrl+S.
    if (this.docWindow) {
      if ((isMac ? event.metaKey : event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void this.documents.save();
      }
      return;
    }
    // F2 and Delete act on the sidebar's selection, which focus mode hides.
    if (this.focusMode && ["F2", "Backspace", "Delete"].includes(event.key)) return;
    if (event.key === "F2" && !isTypingTarget(event.target)) {
      const node = this.tree.get(this.selected);
      if (node && ["Folder", "Document"].includes(kindName(node))) {
        event.preventDefault();
        void this.renameNode(node);
      }
      return;
    }
    if (event.key === "Backspace" || event.key === "Delete") {
      if (isTypingTarget(event.target)) return;
      const node = this.tree.get(this.selected);
      if (node) { event.preventDefault(); void this.trashNode(node); }
      return;
    }
    const mod = isMac ? event.metaKey : event.ctrlKey;
    if (!mod) return;
    // Quick open, New file and New folder use the sidebar: focus mode ends first.
    if (this.focusMode && ["n", "p"].includes(event.key.toLowerCase())) this.leaveFocusMode();
    if (event.key.toLowerCase() === "s") {
      event.preventDefault();
      // A document without unsynced edits sends nothing. While Rust renames
      // or moves a document window's document, it uploads the edit itself.
      if (this.moveFreezes === 0) void this.documents.save();
    } else if (event.key.toLowerCase() === "n" && !event.shiftKey) {
      event.preventDefault(); void this.createFile();
    } else if (event.key.toLowerCase() === "n" && event.shiftKey) {
      event.preventDefault(); void this.createFolder();
    } else if (event.key.toLowerCase() === "l") {
      event.preventDefault(); void this.lock();
    } else if (event.key.toLowerCase() === "p") {
      event.preventDefault();
      this.root.querySelector<HTMLInputElement>(".search")?.focus();
    }
  };

  /**
   * F9 (focus mode), Esc (leaves it), Cmd+Shift+V (Ctrl+Shift+V off
   * macOS; reading and writing), Cmd/Ctrl+Shift+O (Open in new window) and
   * the zoom keys (zoomKeyApplies), caught in the capture phase
   * ahead of the editor, so it never pastes on Cmd+Shift+V. Text fields outside
   * the editor and dialogs keep Cmd+Shift+V and Esc; no shortcut works under
   * a dialog.
   */
  private onViewKey = (event: KeyboardEvent): void => {
    if (event.isComposing) return;
    if (this.scrollFrame(event)) {
      event.preventDefault();
      return;
    }
    const zoom = zoomKey(event, isMac);
    if (zoom && this.zoomKeyApplies()) {
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) this.zoomContent(zoom);
      return;
    }
    const command = viewKey(event, isMac);
    if (!command || !this.editor || topModal()) return;
    const inEditor = event.target instanceof Element && event.target.closest(".cm-editor") !== null;
    if (command === "escape") {
      // Menus and the word count close on Esc themselves; the editor keeps Esc.
      if (!this.focusMode || this.docWindow || isTypingTarget(event.target) || document.querySelector(".context-menu, .word-count-panel")) return;
      event.preventDefault();
      this.leaveFocusMode();
      return;
    }
    if (command === "read-write" && !inEditor && isTypingTarget(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.repeat) return;
    if (command === "read-write") this.toggleReadWrite();
    // A document window has no chrome to bring back and opens no other window.
    else if (this.docWindow) return;
    else if (command === "focus") this.toggleFocusMode();
    else void this.openInNewWindow();
  };

  /** F9. Nothing happens without an open document. */
  private toggleFocusMode(): void {
    if (this.focusMode) this.leaveFocusMode();
    else this.enterFocusMode();
  }

  /**
   * Hides the sidebar, header, status bar and outline (one class on the
   * shell, one relayout; the document, its editor state and the preview's
   * DOM stay) and shows the document in Preview. The window title becomes
   * the file name.
   */
  private enterFocusMode(): void {
    const node = this.tree.get(this.documents.openId);
    const shell = this.root.querySelector<HTMLElement>(".shell");
    if (this.focusMode || !node || !shell || !this.editor) return;
    this.contextMenu.close();
    this.closeWordCount();
    // WebKit keeps no scroll anchor when the text column widens: the
    // reading position is taken before and given back after the relayout.
    const place = this.readingPlace();
    this.focusMode = true;
    this.modeBeforeFocus = this.previewMode;
    this.previewMode = "preview";
    shell.classList.add("focus-mode");
    this.applyPreviewMode();
    this.restoreReadingPlace(place);
    this.showWindowTitle(node.name);
    this.focusPane();
  }

  /** F9 or Esc: the sidebar and header come back with the view mode from before (modeAfterFocus). */
  private leaveFocusMode(): void {
    // A document window is focus mode: there is nothing to bring back.
    if (!this.focusMode || this.docWindow) return;
    const place = this.readingPlace();
    this.previewMode = modeAfterFocus(this.modeBeforeFocus, this.previewMode, this.writingMode);
    this.endFocusState();
    this.applyPreviewMode();
    this.restoreReadingPlace(place);
    // The pane shown takes the keys (the preview had them, and may be hidden
    // now); the editor keeps its caret and selection on focus.
    this.focusPane();
  }

  /** Focus mode off without a relayout (also when the workspace is left). */
  private endFocusState(): void {
    this.focusMode = false;
    this.root.querySelector(".shell")?.classList.remove("focus-mode");
    this.stopFrameWatch();
    this.showWindowTitle(null);
  }

  /**
   * Cmd+Shift+V: Preview and the last writing mode (Edit or Split); in
   * focus mode Preview and the editor alone. The Edit / Split / Preview
   * control follows, and the focus moves to what is now shown.
   */
  private toggleReadWrite(): void {
    if (!this.documents.openId) return;
    const place = this.readingPlace();
    this.previewMode = toggledMode(this.previewMode, this.writingMode, this.focusMode);
    this.applyPreviewMode();
    this.restoreReadingPlace(place);
    this.focusPane();
  }

  /**
   * Where the reader is, before the view mode or focus mode changes: the
   * editor's top line and the preview's top block, of the panes shown.
   * A few layout reads (binary searches), so a 12 MB document costs the same.
   */
  private readingPlace(): ReadingPlace {
    const editorShown = this.previewMode !== "preview";
    const previewShown = this.previewMode !== "edit";
    return {
      editorLine: editorShown && this.editor ? this.editor.topLine() : null,
      previewBlock: previewShown ? this.previewPlace() : null,
      previewLine: previewShown && !editorShown ? this.previewTopLine() : null,
    };
  }

  /**
   * After the change (and its relayout): a pane that stays keeps its place,
   * also when its column changed width; a pane shown now opens where the
   * other one was, so Cmd+Shift+V writes what was being read and reads
   * what was being written.
   */
  private restoreReadingPlace(place: ReadingPlace): void {
    if (this.previewMode !== "preview" && this.editor) {
      const line = place.editorLine ?? place.previewLine;
      if (line !== null) this.editor.showLine(line, place.editorLine === null);
    }
    if (this.previewMode !== "edit") {
      if (place.previewBlock) this.restorePreviewPlace(place.previewBlock);
      else if (place.editorLine !== null) this.showPreviewLine(place.editorLine);
    }
  }

  /** The block at the preview's top (binary search over its blocks), or the page's scroll share. */
  private previewPlace(): PreviewPlace | null {
    const host = this.root.querySelector<HTMLElement>(".preview");
    if (!host) return null;
    if (host.classList.contains("html-mode")) {
      const page = this.htmlPreview.scroller();
      return page ? { ratio: page.scrollTop / Math.max(1, page.scrollHeight - page.clientHeight) } : null;
    }
    const top = host.getBoundingClientRect().top;
    const blocks = host.children;
    const element = blocks[lastAtOrBefore(blocks.length, (index) => blocks[index]!.getBoundingClientRect().bottom, top) + 1];
    if (!element) return null;
    const box = element.getBoundingClientRect();
    return {
      element,
      fraction: box.height > 0 ? Math.min(1, Math.max(0, (top - box.top) / box.height)) : 0,
      offset: Math.max(0, box.top - top),
    };
  }

  private restorePreviewPlace(place: PreviewPlace): void {
    const host = this.root.querySelector<HTMLElement>(".preview");
    if (!host) return;
    if ("ratio" in place) {
      const page = this.htmlPreview.scroller();
      if (page) page.scrollTop = place.ratio * Math.max(0, page.scrollHeight - page.clientHeight);
      return;
    }
    if (place.element.parentElement !== host) return;
    const box = place.element.getBoundingClientRect();
    host.scrollTop += box.top + place.fraction * box.height - place.offset - host.getBoundingClientRect().top;
  }

  /**
   * The source line at the preview's top. Null when the preview has nothing
   * to scroll (a short page, or "Preview paused" for a large document): it
   * then says nothing about where the reader is, and the editor keeps its place.
   */
  private previewTopLine(): number | null {
    const preview = this.previewTrack();
    if (!preview || preview.track.height - preview.viewport < 1) return null;
    return lineForPreviewOffset(preview.track, preview.offset);
  }

  /** Scrolls the preview to source line `line`, now or once the render in flight is in. */
  private showPreviewLine(line: number): void {
    this.previewLineWanted = line;
    if (this.previewInFlight === null) this.applyPreviewLine();
  }

  private applyPreviewLine(): void {
    const line = this.previewLineWanted;
    this.previewLineWanted = null;
    if (line === null || this.previewMode === "edit") return;
    const preview = this.previewTrack();
    preview?.scrollTo(previewOffsetForLine(preview.track, line));
  }

  /**
   * The preview's scroll and the headings that tie it to source lines:
   * Markdown headings, when the preview has exactly the ones the source has
   * (else proportional, as for HTML pages, plain text and large documents).
   */
  private previewTrack(): { track: HeadingTrack; offset: number; viewport: number; scrollTo(top: number): void } | null {
    const host = this.root.querySelector<HTMLElement>(".preview");
    const editor = this.editor;
    if (!host || !editor?.hasDocument) return null;
    const lastLine = editor.lineCount;
    if (host.classList.contains("html-mode")) {
      const page = this.htmlPreview.scroller();
      if (!page) return null;
      return {
        track: { lines: [], top: () => 0, lastLine, height: page.scrollHeight },
        offset: page.scrollTop,
        viewport: page.clientHeight,
        scrollTo: (top) => { page.scrollTop = top; },
      };
    }
    const markdown = this.currentLanguage() === "markdown" && editor.length <= LARGE_PREVIEW_CHARS;
    const headings = markdown ? host.querySelectorAll(PREVIEW_HEADINGS) : null;
    const lines = headings ? this.headingLines() : [];
    const origin = host.getBoundingClientRect().top - host.scrollTop;
    return {
      track: {
        lines: headings && headings.length === lines.length ? lines : [],
        top: (index) => headings![index]!.getBoundingClientRect().top - origin,
        lastLine,
        height: host.scrollHeight,
      },
      offset: host.scrollTop,
      viewport: host.clientHeight,
      scrollTo: (top) => { host.scrollTop = top; },
    };
  }

  /** The source lines of the open document's headings, parsed once per text version. */
  private headingLines(): readonly number[] {
    const key = `${this.documents.openId}|${this.textVersion}`;
    if (this.headingLineCache?.key !== key) {
      const text = this.editor?.text() ?? "";
      this.headingLineCache = { key, lines: flattenOutline(parseMarkdownOutline(text)).map((item) => item.line) };
    }
    return this.headingLineCache.lines;
  }

  /** The editor when writing, else the preview, so arrow and page keys scroll what is shown. */
  private focusPane(): void {
    if (this.previewMode !== "preview") {
      this.editor?.focus();
      return;
    }
    this.root.querySelector<HTMLElement>(".preview")?.focus({ preventScroll: true });
  }

  /**
   * The OS window title: the file name in focus mode, otherwise "Notebook".
   * Written only when it changes (one IPC call).
   */
  private showWindowTitle(name: string | null): void {
    const title = name || APP_TITLE;
    if (title === this.windowTitle) return;
    this.windowTitle = title;
    document.title = title;
    // Rust titles a document window (window.rs).
    if (isTauri && !this.docWindow) void getCurrentWindow().setTitle(title).catch(() => { /* Cosmetic: the next change retries. */ });
  }

  /**
   * An HTML page's frame keeps every key once clicked (WebKit runs no
   * listener in it). While a page is shown (Split, Preview, focus mode, a
   * document window), the keys come back to the preview after a click in
   * it once no text is selected there, so F9, Esc, Cmd+S and the zoom keys
   * work again; Copy still works while text is selected. Arrow, page and
   * space keys then scroll the page (scrollFrame). A poll, because a click
   * that activates the window right in the page sends the parent no event.
   */
  private syncFrameWatch(): void {
    const wanted = this.previewMode !== "edit" && this.currentLanguage() === "html";
    if (!wanted) { this.stopFrameWatch(); return; }
    this.frameWatch ??= window.setInterval(() => {
      const frame = document.activeElement;
      if (!(frame instanceof HTMLIFrameElement) || !frame.closest(".preview")) return;
      // The mouse button is still down in the page (WebKit marks the frame
      // element :active): a drag that has not moved yet selects nothing.
      if (frame.matches(":active")) return;
      let selected = false;
      try { selected = !(frame.contentWindow?.getSelection()?.isCollapsed ?? true); } catch { /* Not our page: take the keys back. */ }
      if (!selected) this.root.querySelector<HTMLElement>(".preview")?.focus({ preventScroll: true });
    }, FRAME_FOCUS_POLL_MS);
  }

  /** Arrow, page, space, Home and End keys on the preview of an HTML page scroll the page in its frame. */
  private scrollFrame(event: KeyboardEvent): boolean {
    const host = event.target;
    if (!(host instanceof HTMLElement) || !host.matches(".preview.html-mode") || event.metaKey || event.ctrlKey || event.altKey) return false;
    if (event.shiftKey && event.key !== " ") return false;
    const scroller = host.querySelector<HTMLIFrameElement>(".html-preview")?.contentDocument?.scrollingElement;
    if (!scroller) return false;
    const page = Math.max(FRAME_LINE_PX, scroller.clientHeight - FRAME_LINE_PX);
    const steps: Record<string, number> = {
      ArrowDown: FRAME_LINE_PX, ArrowUp: -FRAME_LINE_PX, PageDown: page, PageUp: -page,
      " ": event.shiftKey ? -page : page, Home: -scroller.scrollHeight, End: scroller.scrollHeight,
    };
    const step = steps[event.key];
    if (step === undefined) return false;
    scroller.scrollBy(0, step);
    return true;
  }

  private stopFrameWatch(): void {
    if (this.frameWatch !== null) window.clearInterval(this.frameWatch);
    this.frameWatch = null;
  }

  private onTreeKeyDown(event: KeyboardEvent, node: TreeNode): void {
    const rows = [...this.root.querySelectorAll<HTMLElement>('.tree-row[data-node-id]')];
    const index = rows.indexOf(event.currentTarget as HTMLElement);
    const focus = (row: HTMLElement | undefined): void => {
      const id = row?.dataset.nodeId;
      if (!id) return;
      this.selected = id;
      this.renderTree();
      this.root.querySelector<HTMLElement>(`.tree-row[data-node-id="${CSS.escape(id)}"]`)?.focus();
    };
    if (event.key === "ArrowDown") { event.preventDefault(); focus(rows[index + 1]); return; }
    if (event.key === "ArrowUp") { event.preventDefault(); focus(rows[index - 1]); return; }
    if (event.key === "Home") { event.preventDefault(); focus(rows[0]); return; }
    if (event.key === "End") { event.preventDefault(); focus(rows.at(-1)); return; }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (kindName(node) === "Folder") {
        this.expanded.has(node.id) ? this.expanded.delete(node.id) : this.expanded.add(node.id);
        this.renderTree();
      } else void this.openDocument(node.id);
      return;
    }
    if (event.key === "ArrowRight" && kindName(node) === "Folder") {
      event.preventDefault();
      if (!this.expanded.has(node.id)) { this.expanded.add(node.id); this.renderTree(); }
      else focus(rows[index + 1]);
      return;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      if (kindName(node) === "Folder" && this.expanded.has(node.id)) {
        this.expanded.delete(node.id); this.renderTree();
      } else if (node.parent && node.parent !== ROOT) {
        focus(rows.find((row) => row.dataset.nodeId === node.parent));
      }
    }
  }

  private onActivity = (): void => {
    const timestamp = Date.now();
    if (isTauri && timestamp - this.lastActivityPing >= 30_000) {
      this.lastActivityPing = timestamp;
      void ipc.activityPing();
    }
    this.armIdleLock();
  };

  /** A workspace whose phrase is remembered is not locked on idle: it would reopen without the user (Rust skips it too). */
  private armIdleLock(): void {
    // The main window runs the idle lock; a document window's typing reaches it through activity_ping.
    if (!isTauri || this.docWindow) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.autoLockMinutes === 0 || this.activeWorkspace()?.phrase_stored) { this.idleTimer = null; return; }
    this.idleTimer = window.setTimeout(() => void this.lock(), this.autoLockMinutes * 60_000);
  }

  private bindFileDrop(): void {
    const sidebar = this.root.querySelector<HTMLElement>(".sidebar")!;
    const workspace = this.root.querySelector<HTMLElement>(".workspace")!;
    const hasFiles = (event: DragEvent): boolean => event.dataTransfer?.types.includes("Files") ?? false;
    const clear = (): void => {
      sidebar.classList.remove("file-drop-target");
      this.root.querySelectorAll(".tree-row.file-drop-folder").forEach((row) => row.classList.remove("file-drop-folder"));
    };
    const folderAt = (target: EventTarget | null): string => {
      const row = target instanceof Element ? target.closest<HTMLElement>(".tree-row[data-node-id]") : null;
      const node = row ? this.tree.get(row.dataset.nodeId) : undefined;
      return node && kindName(node) === "Folder" ? node.id : this.selectedFolderId();
    };
    sidebar.addEventListener("dragover", (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
      clear();
      sidebar.classList.add("file-drop-target");
      const row = event.target instanceof Element ? event.target.closest<HTMLElement>(".tree-row[data-node-id]") : null;
      const node = row ? this.tree.get(row.dataset.nodeId) : undefined;
      if (node && kindName(node) === "Folder") row?.classList.add("file-drop-folder");
    });
    sidebar.addEventListener("dragleave", (event) => {
      if (event.relatedTarget instanceof Node && sidebar.contains(event.relatedTarget)) return;
      clear();
    });
    sidebar.addEventListener("drop", (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      event.stopPropagation();
      const parent = folderAt(event.target);
      // The entries must be taken while the event lasts.
      const roots = droppedRoots(event.dataTransfer);
      clear();
      void this.importDrop(roots, parent);
    });
    workspace.addEventListener("dragover", (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    });
    workspace.addEventListener("drop", (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      void this.importDrop(droppedRoots(event.dataTransfer), this.selectedFolderId());
    });
  }

  /**
   * Imports dropped files and folders below `parent`: the folders first,
   * level by level, then the documents, 8 requests at a time. The tree
   * follows the returned deltas (no listing) and is drawn at most twice a
   * second. Problems are reported in one dialog at the end.
   */
  private async importDrop(roots: Array<DroppedEntry | File>, parent: string): Promise<void> {
    if (!roots.length) return;
    if (this.importing) {
      await this.message("Import in progress", "Wait until the current import has finished, then drop again.");
      return;
    }
    this.importing = true;
    // The sidebar shows the import's progress.
    if (this.focusMode) this.leaveFocusMode();
    // Locking or switching workspaces ends the import: no item may land in another workspace.
    const generation = this.authGeneration;
    let stopped = false;
    const stale = (): boolean => (stopped ||= generation !== this.authGeneration);
    const sidebar = this.root.querySelector<HTMLElement>(".sidebar");
    const hintTitle = sidebar?.querySelector<HTMLElement>(".file-drop-hint strong");
    sidebar?.classList.add("file-importing");
    sidebar?.setAttribute("aria-busy", "true");
    if (hintTitle) hintTitle.textContent = "Reading dropped items…";
    let drawTimer: number | null = null;
    let changed = false;
    let resync = false;
    const failed: Skip[] = [];
    let skipped: Skip[] = [];
    let hidden = 0;
    let files = 0;
    let folders = 0;
    let lastLoose: string | null = null;
    let refusal: string | null = null;
    const topFolders: string[] = [];
    // Bulk changes apply their deltas without drawing; a timer draws.
    const apply = <T extends { id: string; tree?: TreeDelta | null }>(created: T): string => {
      // A delta answered after a lock or switch belongs to the old session.
      if (!stale()) this.applyTree(created.tree, false);
      changed = true;
      return created.id;
    };
    const createFolder = async (folderParent: string, name: string): Promise<string> => {
      if (isTauri) return apply(await ipc.folderCreate(folderParent, name));
      const id = crypto.randomUUID();
      this.tree.change([{ id, parent: folderParent, name: uniqueName(this.tree.children(folderParent), name), kind: "Folder" }]);
      changed = true;
      return id;
    };
    const createDocument = async (folder: string, name: string, text: string): Promise<string> => {
      if (isTauri) return apply(await ipc.docCreate(folder, name, text));
      const id = crypto.randomUUID();
      this.tree.change([{ id, parent: folder, name: uniqueName(this.tree.children(folder), name), kind: "Document" }]);
      this.docs.set(id, { text, readOnly: false });
      changed = true;
      return id;
    };
    try {
      const scan = await scanDrop(roots);
      if (scan.over) {
        refusal = limitMessage(scan.over);
        return;
      }
      hidden = scan.hidden;
      const plan = planImport(scan, this.tree.children(parent).map((node) => node.name));
      skipped = plan.skipped;
      const total = plan.folders.length + plan.files.length;
      let done = 0;
      const step = (): void => {
        done++;
        if (hintTitle) hintTitle.textContent = importProgress(done, total);
      };
      if (hintTitle && total) hintTitle.textContent = importProgress(0, total);
      drawTimer = window.setInterval(() => {
        if (changed) { changed = false; this.renderTree(); }
      }, 500);
      const folderIds = new Map<number, string>();
      for (const level of foldersByLevel(plan.folders)) {
        await runPool(level, IMPORT_PARALLEL, async (folder) => {
          if (stale()) return;
          const inside = folder.parent === null ? parent : folderIds.get(folder.parent);
          try {
            if (inside === undefined) throw new Error("its folder could not be created");
            const id = await createFolder(inside, folder.name);
            folderIds.set(folder.index, id);
            folders++;
            if (folder.parent === null) topFolders.push(id);
          } catch (caught) {
            resync = true;
            failed.push({ path: folder.path, reason: safeErrorMessage(caught, "could not be created") });
          }
          step();
        });
      }
      await runPool(plan.files, IMPORT_PARALLEL, async (file) => {
        if (stale()) return;
        const inside = file.folder === null ? parent : folderIds.get(file.folder);
        try {
          if (inside === undefined) throw new Error("its folder could not be created");
          const text = await readImportText(file.file);
          // A lock or switch can happen while a slow file (iCloud, network) is
          // read: check again with no await before the request.
          if (stale()) return;
          const id = await createDocument(inside, file.name, text);
          files++;
          if (file.folder === null) lastLoose = id;
        } catch (caught) {
          if (isIpcFailure(caught)) resync = true;
          failed.push({ path: file.path, reason: safeErrorMessage(caught, "could not be imported") });
        }
        step();
      });
    } catch (caught) {
      failed.push({ path: "Import", reason: safeErrorMessage(caught, "the drop could not be read") });
    } finally {
      if (drawTimer !== null) clearInterval(drawTimer);
      // Ids are paths: after a lock or switch they would name items of another workspace.
      if (!stale()) {
        // A failed change may have happened in part: take the session's tree (no S3 request).
        if (resync) await this.resyncTree(false);
        this.expanded.add(parent);
        for (const id of topFolders) this.expanded.add(id);
        if (!lastLoose && topFolders.length === 1) this.selected = topFolders[0]!;
        this.renderTree();
      }
      sidebar?.classList.remove("file-importing");
      sidebar?.removeAttribute("aria-busy");
      if (hintTitle) hintTitle.textContent = "Import files";
      this.importing = false;
      // Shown once the sidebar is idle again; nothing was created.
      if (refusal && !stale()) void this.message("Too many items to import", refusal);
    }
    if (stale()) {
      // No names: the summary would otherwise show over the lock screen.
      if (this.screen === "main") await this.message("Import stopped", importStopped(files, folders));
      return;
    }
    if (lastLoose) await this.openDocument(lastLoose);
    const summary = importSummary({ files, folders, skipped, failed, hidden });
    if (summary) await this.message(summary.title, summary.text);
  }

  // A paste or drop in the find panel (inside .editor-host) is its input's,
  // never an image for the document.
  private async onImagePaste(event: ClipboardEvent): Promise<void> {
    if (inFindPanel(event)) return;
    const files = imageFiles(event.clipboardData?.files);
    if (!this.editor || !this.documents.openId || !files.length) return;
    event.preventDefault();
    // Read-only: nothing is encrypted for an edit that would be refused.
    if (this.editor.isReadOnly) { this.editor.noteReadOnly(); return; }
    await this.insertImages(files);
  }

  private onImageDragOver = (event: DragEvent): void => {
    if (inFindPanel(event)) return;
    if (!this.editor || !this.documents.openId || !event.dataTransfer?.types.includes("Files")) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "copy";
  };

  private async onImageDrop(event: DragEvent): Promise<void> {
    // Refused by navigation.ts's drop listener, so the WebView never loads it.
    if (inFindPanel(event)) return;
    const files = imageFiles(event.dataTransfer?.files);
    if (!this.editor || !this.documents.openId || !files.length) return;
    event.preventDefault();
    event.stopPropagation();
    this.editor.placeCaretAt(event.clientX, event.clientY);
    this.editor.focus();
    if (this.editor.isReadOnly) { this.editor.noteReadOnly(); return; }
    await this.insertImages(files);
  }

  /** Pasted and dropped images are inlined as data URLs, as Notebook stores them. */
  private async insertImages(files: File[]): Promise<void> {
    const id = this.documents.openId;
    for (const file of files) {
      if (!this.editor || this.documents.openId !== id) return;
      if (file.size > MAX_IMAGE_BYTES) { await this.message("Image is too large", "Images are limited to 8 MiB."); continue; }
      let dataUrl: string;
      try {
        dataUrl = isTauri
          ? await ipc.imageAdd(new Uint8Array(await file.arrayBuffer()), file.name)
          : await readDataUrl(file);
      } catch (caught) {
        await this.message("Image not added", safeErrorMessage(caught, "The image could not be added."));
        continue;
      }
      if (!this.editor || this.documents.openId !== id) return;
      const label = file.name.replace(/[\[\]()]/g, "_") || "image";
      this.editor.insertText(`![${label}](${dataUrl})`);
    }
  }

  private selectedFolderId(): string {
    const selected = this.tree.get(this.selected);
    if (selected && kindName(selected) === "Folder") return selected.id;
    const parent = this.tree.get(selected?.parent);
    return parent && kindName(parent) === "Folder" ? parent.id : ROOT;
  }

}

/** The status-bar dot's tooltip, and the text shown beside it (offline or failed only). */
const SYNC_TEXT: Record<SyncState, [title: string, label: string]> = {
  clean: ["Saved", ""],
  dirty: ["Unsynced changes · saved on this device", ""],
  busy: ["Uploading to S3…", ""],
  offline: ["Offline — saved on this device. Click to retry.", "Offline — saved on this device"],
  failed: ["Save failed. Click to retry.", "Save failed"],
};

/** Lock and settings: queued edits get 3 s; the rest waits in the outbox. */
function uploadQueuedEdits(): Promise<void> {
  const flushed = ipc.flushAll().catch(() => { /* Exact ciphertext stays in the encrypted outbox. */ });
  return within(flushed, SAVE_TIMING.exitBudgetMs);
}

/** Whether `event` happened in the editor's find panel. */
function inFindPanel(event: Event): boolean {
  return event.target instanceof Element && event.target.closest(".cm-panels") !== null;
}

function imageFiles(files: FileList | null | undefined): File[] {
  return Array.from(files ?? []).filter((file) => IMAGE_TYPE.test(file.type));
}

/**
 * The dropped items as entries (folders included) where the webview offers
 * them, else as Files. Must run while the drop event lasts.
 */
function droppedRoots(transfer: DataTransfer | null): Array<DroppedEntry | File> {
  if (!transfer) return [];
  const items = Array.from(transfer.items ?? []).filter((item) => item.kind === "file");
  if (!items.length) return Array.from(transfer.files);
  return items.flatMap((item): Array<DroppedEntry | File> => {
    const entry = typeof item.webkitGetAsEntry === "function" ? item.webkitGetAsEntry() : null;
    if (entry) return [entry];
    const file = item.getAsFile();
    return file ? [file] : [];
  });
}

function initialDocumentText(name: string): string {
  if (!/\.html?$/i.test(name)) return "";
  const title = name.replace(/\.html?$/i, "") || "Untitled page";
  const escaped = escapeHtml(title);
  return HTML_STARTER
    .replace("<title>Untitled page</title>", `<title>${escaped}</title>`)
    .replace("<h1>Untitled page</h1>", `<h1>${escaped}</h1>`);
}

function accentLabel(accent: Accent): string {
  return accent === DEFAULT_ACCENT ? "Orange (app icon)" : accent[0]!.toUpperCase() + accent.slice(1);
}

/** Browser mode: the sample workspace as a tree. */
function treeOf(nodes: TreeNode[]): TreeModel {
  const tree = new TreeModel();
  tree.replace({ nodes });
  return tree;
}

/** `wanted`, or `wanted 2`… when a sibling has that name (without case, as the backend compares). */
function uniqueName(siblings: readonly TreeNode[], wanted: string): string {
  return uniqueAmong(new Set(siblings.map((node) => node.name.toLowerCase())), wanted);
}

function trashEntryId(entry: TreeNode): string {
  return entry.trash_entry_id ?? entry.id.replace(/^trash-/, "");
}

function rootedPath(path: string): string {
  const trimmed = path.replace(/^\/+|\/+$/g, "");
  return trimmed ? `/${trimmed}` : "/";
}

function itemCount(count: number): string {
  return count === 1 ? "1 item" : `${count} items`;
}

/** Notebook's list annotation: original location, plus the item count of a folder. */
function trashAnnotation(entry: TreeNode): string {
  const origin = entry.origin;
  if (!origin) return "/";
  const location = rootedPath(origin.location);
  return origin.item_kind === "Folder" ? `${location} | ${itemCount(origin.item_count)}` : location;
}

function trashHover(entry: TreeNode): string {
  const origin = entry.origin;
  const path = rootedPath(origin?.original_path ?? entry.name);
  return origin?.item_kind === "Folder" ? `Deleted from ${path} (${itemCount(origin.item_count)})` : `Deleted from ${path}`;
}

function trashDeletedAt(entry: TreeNode): string {
  const deletedAt = entry.origin?.deleted_at;
  if (typeof deletedAt === "number") {
    return `Deleted ${new Date(deletedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`;
  }
  return entry.origin?.legacy ? "Deleted by an earlier version of this app" : "Deletion time unknown";
}

function isTypingTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest("input, textarea, select, [contenteditable], .cm-editor, .modal-overlay") !== null;
}

function keychainUnavailableMessage(): string {
  return /Linux/i.test(navigator.userAgent)
    ? "No OS keychain is available, so the workspace secrets cannot be stored. Install and unlock GNOME Keyring or KWallet (with its Secret Service interface enabled), then connect again."
    : "The OS keychain is not available, so the workspace secrets cannot be stored or read. Unlock the keychain, then connect again.";
}

function authErrorMessage(error: unknown, fallback: string): string {
  const code = errorCode(error);
  switch (code) {
    case "NO_CREDENTIALS":
      return "No S3 credentials are stored on this device for this workspace. Enter them again to connect.";
    case "NO_WORKSPACE":
    case "WORKSPACE_CHANGED":
    case "WORKSPACE_UNLOCKED":
    case "NO_STORED_PHRASE":
    case "OUTBOX_PENDING":
    case "PROFILE_IN_USE":
    case "CONFIG_UNREADABLE":
    case "SECRETS_UNREADABLE":
      return workspaceErrorMessage(code) ?? safeErrorMessage(error, fallback);
    case "KEYCHAIN_UNAVAILABLE":
      return keychainUnavailableMessage();
    case "KEYCHAIN_TOO_LONG":
      return "These credentials are too long for the OS credential store. Try an access key without a session token.";
    default:
      return safeErrorMessage(error, fallback);
  }
}

function ipcMessage(error: unknown): string {
  return safeErrorMessage(error, "The operation could not be completed. Your existing S3 objects were not intentionally overwritten.");
}

function tauriWorkspaces(): WorkspaceStore {
  return {
    list: ipc.workspacesList,
    save: ipc.workspaceSave,
    remove: ipc.workspaceDelete,
    select: ipc.workspaceSelect,
    unlock: (phrase, remember) => ipc.vaultUnlock(phrase, remember),
    lock: ipc.vaultLock,
  };
}

/** Browser mode: sample workspaces in memory ("Work" has edits waiting to upload); `?first-run` starts without any. */
function browserWorkspaces(): WorkspaceStore {
  if (new URLSearchParams(location.search).has("first-run")) return new MemoryWorkspaces([], { latencyMs: 700 });
  return new MemoryWorkspaces([
    { name: "Personal", bucket: "notes-archive", region: "eu-central-1", prefix: "notebook", accessKeyId: "AKIAEXAMPLEPERSONAL", phrase: "sample phrase" },
    { name: "Work", bucket: "team-docs", region: "us-east-1", prefix: "handbook", accessKeyId: "AKIAEXAMPLEWORK", queued: true },
    { name: "Lab (MinIO)", bucket: "lab", region: "us-east-1", prefix: "", endpoint: "https://minio.lab.example:9000" },
  ], { latencyMs: 700 });
}

/** A dialog is open over the screen: a re-rendered screen must not take its focus. */
function dialogOpen(): boolean {
  return document.querySelector(".modal-overlay") !== null;
}

function topModal(): HTMLElement | null {
  const overlays = document.querySelectorAll<HTMLElement>(".modal-overlay");
  return overlays[overlays.length - 1] ?? null;
}

function chip(text: string, tone = ""): HTMLSpanElement {
  const element = document.createElement("span");
  element.className = tone ? `chip ${tone}` : "chip";
  element.textContent = text;
  return element;
}

function rememberField(checked: boolean): string {
  return `<label class="check-field"><input type="checkbox" name="remember"${checked ? " checked" : ""}><span><span class="check-field-label">Remember encryption phrase on this device</span><span class="field-hint field-hint-block">Opens this workspace without asking and keeps it open while idle. The phrase is sealed with a key from the OS keychain.</span></span></label>`;
}

/**
 * The workspace form fields, shared by the connect screen and the Add/Edit
 * dialog. Stored secrets are never sent to the page: their fields stay empty
 * and say that leaving them blank keeps what is stored.
 */
function workspaceFields(workspace: WorkspaceSummary | null, options: { create: boolean; connect: boolean }): string {
  const value = (text: string | null | undefined): string => (text ? ` value="${escapeHtml(text)}"` : "");
  const credentials = !!workspace?.credentials_stored;
  const masked = workspace?.masked_access_key_id ? ` (${workspace.masked_access_key_id})` : "";
  const phraseStored = !!workspace?.phrase_stored;
  const phrasePlaceholder = phraseStored
    ? options.connect ? "Remembered — leave blank to use it" : "Stored — leave blank to keep"
    : options.connect ? "" : "Optional — asked when the workspace opens";
  // New workspaces remember the phrase unless unchecked; otherwise the user's last choice.
  const remember = options.create || (options.connect ? rememberByDefault(workspace) : phraseStored);
  return `
    <label class="field">Workspace name<input name="name"${value(workspace?.name)} maxlength="64" autocomplete="off" spellcheck="false"${options.create ? ' data-follow-bucket="true" placeholder="Named after the bucket"' : ""}></label>
    <label class="field">Bucket<input name="bucket"${value(workspace?.bucket)} autocomplete="off" spellcheck="false"></label>
    <div class="form-grid two">
      <label class="field">Region<input name="region"${value(workspace?.region ?? "eu-central-1")} autocomplete="off" spellcheck="false"></label>
      <label class="field">Prefix <span class="field-hint">optional</span><input name="prefix"${value(workspace?.prefix)} autocomplete="off" spellcheck="false"></label>
    </div>
    <label class="field">Custom S3 endpoint <span class="field-hint">optional</span><input name="endpoint" type="url"${value(workspace?.endpoint)} placeholder="https://s3.example.com" autocomplete="off" spellcheck="false"></label>
    <div class="form-section"><span>S3 credentials</span>${credentials ? '<span class="chip chip-success">Stored</span>' : ""}</div>
    <label class="field">Access key ID<input name="accessKeyId" autocomplete="off" spellcheck="false"${credentials ? ` placeholder="Stored${escapeHtml(masked)} — leave blank to keep"` : ""}></label>
    <label class="field">Secret access key<input name="secretAccessKey" type="password" autocomplete="off" spellcheck="false"${credentials ? ' placeholder="Stored — leave blank to keep"' : ""}></label>
    <label class="field">Session token <span class="field-hint">optional</span><input name="sessionToken" type="password" autocomplete="off" spellcheck="false"${credentials ? ' placeholder="Leave blank to keep the stored credentials"' : ""}></label>
    <div class="form-section"><span>Encryption</span>${phraseStored ? '<span class="chip chip-success">Remembered</span>' : ""}</div>
    <label class="field">Encryption phrase<input name="phrase" type="password" autocomplete="off" spellcheck="false"${phrasePlaceholder ? ` placeholder="${phrasePlaceholder}"` : ""}></label>
    ${rememberField(remember)}`;
}

/** The name follows the bucket until it is edited; the phrase field follows Remember outside the connect screen. */
function bindWorkspaceFields(form: HTMLFormElement): void {
  const name = form.elements.namedItem("name") as HTMLInputElement;
  const bucket = form.elements.namedItem("bucket") as HTMLInputElement;
  bucket.addEventListener("input", () => {
    if (name.dataset.followBucket === "true") name.value = bucket.value.trim() ? defaultWorkspaceName(bucket.value) : "";
  });
  name.addEventListener("input", () => { name.dataset.followBucket = "false"; });
  // Editing the field a problem named clears that problem.
  form.addEventListener("input", (event) => {
    if (event.target instanceof HTMLInputElement && event.target.hasAttribute("aria-invalid")) clearFieldProblem(event.target);
  });
  if (form.id === "setup-form") return;
  // Outside the connect screen a typed phrase is only stored when remembered:
  // typing one checks Remember, and unchecking it clears the field.
  const remember = form.elements.namedItem("remember") as HTMLInputElement;
  const phrase = form.elements.namedItem("phrase") as HTMLInputElement;
  phrase.addEventListener("input", () => { if (phrase.value) remember.checked = true; });
  remember.addEventListener("change", () => { if (!remember.checked) phrase.value = ""; });
}

function clearFieldProblem(input: HTMLInputElement): void {
  input.removeAttribute("aria-invalid");
  const note = input.getAttribute("aria-describedby");
  input.removeAttribute("aria-describedby");
  if (note) document.getElementById(note)?.remove();
}

function readWorkspaceForm(form: HTMLFormElement): WorkspaceFormValues {
  const text = (name: string): string => (form.elements.namedItem(name) as HTMLInputElement | null)?.value ?? "";
  // A new workspace left unnamed is named after its bucket; an edit keeps the check.
  const follows = (form.elements.namedItem("name") as HTMLInputElement | null)?.dataset.followBucket !== undefined;
  const name = text("name").trim() || !follows ? text("name") : defaultWorkspaceName(text("bucket"));
  return {
    name,
    bucket: text("bucket"),
    region: text("region"),
    prefix: text("prefix"),
    endpoint: text("endpoint"),
    accessKeyId: text("accessKeyId"),
    secretAccessKey: text("secretAccessKey"),
    sessionToken: text("sessionToken"),
    phrase: text("phrase"),
    remember: (form.elements.namedItem("remember") as HTMLInputElement | null)?.checked ?? false,
  };
}

/**
 * Shows a form problem under the field it names (the bottom line is for
 * answers from the backend, next to the button just pressed) and brings
 * that field, label and message included, into view.
 */
function showFormProblem(form: HTMLFormElement, error: HTMLElement, problem: { field: string; message: string } | null): void {
  form.querySelectorAll<HTMLInputElement>("input[aria-invalid]").forEach(clearFieldProblem);
  error.textContent = "";
  if (!problem) return;
  const input = form.elements.namedItem(problem.field);
  if (!(input instanceof HTMLInputElement)) {
    error.textContent = problem.message;
    return;
  }
  const note = document.createElement("span");
  note.className = "field-error";
  note.id = `${form.id || "workspace-form"}-${problem.field}-error`;
  note.textContent = problem.message;
  input.after(note);
  input.setAttribute("aria-invalid", "true");
  input.setAttribute("aria-describedby", note.id);
  input.focus({ preventScroll: true });
  (input.closest(".field") ?? input).scrollIntoView({ block: "nearest" });
}

function readDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("Invalid image"));
    reader.onerror = () => reject(reader.error ?? new Error("Could not read image"));
    reader.readAsDataURL(file);
  });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

/** Writes `value` only when it differs, so an unchanged label costs no DOM work. */
function setText(element: Element | null, value: string): void {
  if (element && element.textContent !== value) element.textContent = value;
}

function setAttribute(element: Element, name: string, value: string): void {
  if (element.getAttribute(name) !== value) element.setAttribute(name, value);
}

const BLOCK_ELEMENTS = "address, article, aside, blockquote, br, dd, details, div, dl, dt, figcaption, figure, footer, h1, h2, h3, h4, h5, h6, header, hr, li, main, nav, ol, p, pre, section, summary, table, td, th, tr, ul";

/**
 * The text a reader sees in an HTML page, for the word count: no tags,
 * scripts or styles, and block boundaries separate words. DOMParser runs no
 * script and loads nothing.
 */
function pageText(html: string): string {
  const body = new DOMParser().parseFromString(html, "text/html").body;
  body.querySelectorAll("script, style, template").forEach((element) => element.remove());
  for (const element of body.querySelectorAll(BLOCK_ELEMENTS)) {
    element.before(" ");
    element.after(" ");
  }
  return (body.textContent ?? "").replace(/\s+/g, " ").trim();
}

function tooLargeToPreview(text: string): boolean {
  if (text.length > MAX_PREVIEW_BYTES) return true;
  return text.length * 3 > MAX_PREVIEW_BYTES && new TextEncoder().encode(text).length > MAX_PREVIEW_BYTES;
}

function languageLabel(language: DocumentLanguage): string {
  if (language === "html") return "HTML";
  if (language === "plaintext") return "Plain text";
  return "Markdown";
}

/** Every item in document order; the children of those in `collapsed` left out. */
function flattenOutline(items: OutlineItem[], collapsed?: ReadonlySet<string>): OutlineItem[] {
  const flattened: OutlineItem[] = [];
  const visit = (children: OutlineItem[]): void => {
    for (const item of children) {
      flattened.push(item);
      if (!collapsed?.has(item.id)) visit(item.children);
    }
  };
  visit(items);
  return flattened;
}

function blockedImage(): HTMLSpanElement {
  const span = document.createElement("span");
  span.className = "blocked-image";
  span.textContent = "Image blocked";
  return span;
}

function previewNote(text: string): HTMLParagraphElement {
  const note = document.createElement("p");
  note.className = "preview-error";
  note.setAttribute("role", "status");
  note.textContent = text;
  return note;
}

// The HTML is already sanitized; parsing it in an inert template and
// re-checking images and links costs little and loads nothing.
function previewFragment(html: string): DocumentFragment {
  const template = document.createElement("template");
  template.innerHTML = html;
  for (const image of template.content.querySelectorAll("img")) {
    if (!SAFE_IMAGE_SRC.test(image.getAttribute("src") ?? "")) image.replaceWith(blockedImage());
  }
  for (const link of template.content.querySelectorAll("a[href]")) link.setAttribute("rel", "noopener noreferrer");
  return template.content;
}

function renderMarkdown(source: string): string {
  const escaped = escapeHtml(source);
  const lines = escaped.split(/\r?\n/);
  const html: string[] = [];
  const ids = new HeadingIds();
  let inList = false;
  let inCode = false;
  for (const raw of lines) {
    if (raw.startsWith("```")) {
      if (inCode) html.push("</code></pre>"); else html.push("<pre><code>");
      inCode = !inCode; continue;
    }
    if (inCode) { html.push(`${raw}\n`); continue; }
    if (/^[-*] /.test(raw)) {
      if (!inList) { html.push("<ul>"); inList = true; }
      const task = /^\[([ xX])\] (.*)$/.exec(raw.slice(2));
      if (task) html.push(`<li><input type="checkbox" disabled${task[1] === " " ? "" : " checked"}> ${inline(task[2]!)}</li>`);
      else html.push(`<li>${inline(raw.slice(2))}</li>`);
      continue;
    }
    if (inList) { html.push("</ul>"); inList = false; }
    const heading = /^(#{1,6})\s+(.*)$/.exec(raw);
    if (heading) { const level = heading[1]!.length; html.push(`<h${level} id="${escapeHtml(ids.next(plainHeading(heading[2]!)))}">${inline(heading[2]!)}</h${level}>`); }
    else if (raw.startsWith("> ")) html.push(`<blockquote>${inline(raw.slice(2))}</blockquote>`);
    else if (raw.trim()) html.push(`<p>${inline(raw)}</p>`);
  }
  if (inList) html.push("</ul>");
  if (inCode) html.push("</code></pre>");
  return html.join("");
}

function inline(value: string): string {
  return value
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/!\[([^\]]*)\]\(([^\s)]*)\)/g, (_, alt: string, src: string) =>
      SAFE_IMAGE_SRC.test(src) ? `<img src="${src}" alt="${alt}" loading="lazy">` : '<span class="blocked-image">Image blocked</span>')
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target: string, alias: string | undefined) =>
      anchor(wikiHref(unescapeHtml(target)), alias ?? target))
    .replace(/\[([^\]]+)\]\(([^\s)]+)\)/g, (_, text: string, dest: string) => anchor(previewHref(unescapeHtml(dest)), text));
}

/** A link of the stand-in renderer; `text` is escaped already. */
function anchor(href: string | null, text: string): string {
  return href === null ? `<a>${text}</a>` : `<a href="${escapeHtml(href)}" rel="noopener noreferrer">${text}</a>`;
}

function unescapeHtml(value: string): string {
  return value.replace(/&(amp|lt|gt|quot|#39);/g, (_, name: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" })[name]!);
}

/** A heading's text without inline Markdown, for its id (the stand-in renderer). */
/** The text a heading's id comes from: wikilinks give their shown text, the rest as the outline's labels (outline.ts). */
function plainHeading(escaped: string): string {
  return headingText(unescapeHtml(escaped.replace(/!?\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, text: string, alias?: string) => alias ?? text)));
}

export const started = new App().start();
