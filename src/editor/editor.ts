// The source editor: CodeMirror 6. One EditorView shows every document; each
// document keeps its own EditorState (text, selection, undo history) in a
// small LRU, so switching back or renaming keeps them. CodeMirror renders only
// the lines in view, so a 12 MB document opens, scrolls and re-wraps without
// long tasks. Every colour, font and size comes from theme.css: the syntax
// classes below (tok-*) and CodeMirror's own (cm-*) are styled there with the
// theme's tokens, so dark, light and the accent follow live, without a rebuild.

import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentLess, indentMore } from "@codemirror/commands";
import { cssLanguage } from "@codemirror/lang-css";
import { html, htmlLanguage } from "@codemirror/lang-html";
import { javascriptLanguage, jsxLanguage, tsxLanguage, typescriptLanguage } from "@codemirror/lang-javascript";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { bracketMatching, indentUnit, type Language, syntaxHighlighting } from "@codemirror/language";
import { search, searchKeymap } from "@codemirror/search";
import { ChangeSet, Compartment, countColumn, EditorSelection, EditorState, type Extension, type Range, type StateCommand, type StateEffect, StateField, type Text } from "@codemirror/state";
import { Decoration, type DecorationSet, drawSelection, dropCursor, EditorView, highlightSpecialChars, keymap, rectangularSelection, WidgetType } from "@codemirror/view";
import { styleTags, Tag, tagHighlighter, tags } from "@lezer/highlight";

export type DocumentLanguage = "markdown" | "html" | "plaintext";

/**
 * From this length a document is plain text in the editor (no parsing or
 * highlighting); its typography stays its language's.
 */
export const LARGE_DOCUMENT_CHARS = 2 * 1024 * 1024;
/**
 * A document with a line this long (image data not counted) is not soft
 * wrapped: CodeMirror lays out such a line in full the first time it wraps
 * it (about 0.1 s per 1M characters, 1.3 s for a 12 MB one-line page).
 */
export const LONG_LINE_CHARS = 512 * 1024;
/** Documents whose state (undo history, selection, scroll) is kept besides the open one. */
const MAX_STATES = 10;
/** Kept states beyond this many characters in all are dropped first (the open one never). */
const MAX_STATE_CHARS = 24 * 1024 * 1024;
const READ_ONLY_MESSAGE = "Restore this document to edit it.";
/** How long a refused keystroke's read-only note stays. */
const NOTE_MS = 3000;
/** The scrollbar strip at the right edge of the editor, never taken as a margin click. */
const SCROLLBAR_SLACK_PX = 16;

/** Soft wrap (VS Code's Alt+Z): one setting for every document, on until toggled, for this session. */
let softWrap = true;

/**
 * The editor language for a document name: .html and .htm files are HTML,
 * .txt files are plain text, and everything else (including names without
 * an extension) stays Markdown, the vault's default.
 */
export function languageForFile(name: string): DocumentLanguage {
  if (/\.html?$/i.test(name)) return "html";
  if (/\.txt$/i.test(name)) return "plaintext";
  return "markdown";
}

/** Whether soft wrap is on. */
export function softWrapEnabled(): boolean {
  return softWrap;
}

// Syntax colours ------------------------------------------------------------
// Obsidian's source mode: heading text bold, and the "#", list markers, task
// boxes and other Markdown marks faint. Two Markdown tags of our own let
// theme.css colour list markers and code blocks apart from other marks and
// inline code; other highlighters still see them as their parents.
const listMark = Tag.define(tags.processingInstruction);
const codeBlock = Tag.define(tags.monospace);

/** Syntax tag -> class; theme.css (section 9) colours the classes with --md-* and --code-* tokens. */
export const highlighter = tagHighlighter([
  // Markdown. Order matters only in theme.css, where marks come after the text they mark.
  { tag: tags.heading, class: "tok-heading" },
  { tag: tags.strong, class: "tok-strong" },
  { tag: tags.emphasis, class: "tok-emphasis" },
  { tag: tags.strikethrough, class: "tok-strikethrough" },
  { tag: tags.link, class: "tok-link" },
  { tag: tags.url, class: "tok-url" },
  { tag: codeBlock, class: "tok-code-block" },
  { tag: tags.monospace, class: "tok-code" },
  { tag: tags.quote, class: "tok-quote" },
  { tag: listMark, class: "tok-list-mark" },
  { tag: [tags.processingInstruction, tags.contentSeparator], class: "tok-mark" },
  { tag: tags.labelName, class: "tok-label" },
  { tag: tags.escape, class: "tok-escape" },
  // Code: HTML, and CSS and JavaScript in it or in fenced blocks.
  { tag: tags.comment, class: "tok-comment" },
  { tag: tags.tagName, class: "tok-tag" },
  { tag: [tags.attributeName, tags.propertyName], class: "tok-property" },
  { tag: [tags.string, tags.attributeValue], class: "tok-string" },
  { tag: [tags.number, tags.bool, tags.null, tags.atom, tags.unit, tags.color, tags.character], class: "tok-value" },
  { tag: [tags.keyword, tags.documentMeta], class: "tok-keyword" },
  { tag: [tags.typeName, tags.className, tags.namespace, tags.macroName, tags.annotation, tags.function(tags.variableName), tags.function(tags.propertyName)], class: "tok-function" },
  { tag: [tags.regexp, tags.special(tags.string)], class: "tok-important" },
  { tag: tags.operator, class: "tok-operator" },
  { tag: tags.punctuation, class: "tok-punctuation" },
  { tag: tags.invalid, class: "tok-invalid" },
]);

/** Fenced code in Markdown: the languages HTML pages already bring along (no extra code). */
function fenceLanguage(info: string): Language | null {
  const name = info.toLowerCase();
  if (/^(html?|xhtml|svg)$/.test(name)) return htmlLanguage;
  if (name === "css") return cssLanguage;
  if (/^(js|javascript|mjs|cjs|json)$/.test(name)) return javascriptLanguage;
  if (name === "jsx") return jsxLanguage;
  if (/^(ts|typescript|mts|cts)$/.test(name)) return typescriptLanguage;
  if (name === "tsx") return tsxLanguage;
  return null;
}

const markdownSupport = markdown({
  base: markdownLanguage,
  codeLanguages: fenceLanguage,
  completeHTMLTags: false,
  extensions: {
    props: [styleTags({ ListMark: listMark, TaskMarker: listMark, "FencedCode/CodeText CodeBlock/CodeText": codeBlock })],
  },
});
const htmlSupport = html();

const languageSlot = new Compartment();
const wrapSlot = new Compartment();
const readOnlySlot = new Compartment();
const NO_WRAP: Extension = [];
const READ_ONLY = EditorState.readOnly.of(true);
const WRITABLE: Extension = [];
const languageExtensions = new Map<string, Extension>();

/**
 * The language slot of a state: the parser (none for large documents and
 * plain text) and the class theme.css picks the typography by (the text
 * font for Markdown and plain text, the monospace code font for HTML).
 * One object per combination, so a state's slot is compared by identity.
 */
export function languageExtension(language: DocumentLanguage, large: boolean): Extension {
  const key = `${language}|${large}`;
  let extension = languageExtensions.get(key);
  if (!extension) {
    const attributes = EditorView.editorAttributes.of({ class: `cm-lang-${language}` });
    if (large || language === "plaintext") extension = attributes;
    // Markdown pairs brackets, but not quotes or "<" in prose.
    else if (language === "markdown") extension = [markdownSupport, markdownSupport.language.data.of({ closeBrackets: { brackets: ["(", "[", "{"] } }), attributes];
    else extension = [htmlSupport, attributes];
    languageExtensions.set(key, extension);
  }
  return extension;
}

/**
 * Tab without a selection inserts the document's indentation at each
 * caret: a tab, or spaces to the next indent stop; with
 * a selection it indents the selected lines.
 */
export const insertSoftTab: StateCommand = ({ state, dispatch }) => {
  if (state.readOnly) return false;
  if (state.selection.ranges.some((range) => !range.empty)) return indentMore({ state, dispatch });
  const unit = state.facet(indentUnit);
  const width = unit === "\t" ? 0 : unit.length;
  dispatch(state.update(state.changeByRange((range) => {
    const line = state.doc.lineAt(range.head);
    const insert = width ? " ".repeat(width - (countColumn(line.text, state.tabSize, range.head - line.from) % width)) : "\t";
    return { changes: { from: range.head, insert }, range: EditorSelection.cursor(range.head + insert.length) };
  }), { scrollIntoView: true, userEvent: "input.indent" }));
  return true;
};

/**
 * Refuses every change of a read-only document, whatever made it:
 * lang-markdown's Enter and Backspace commands and its URL
 * paste never check the readOnly facet. `refused` runs for each one.
 */
export function readOnlyGuard(refused: () => void): Extension {
  return EditorState.changeFilter.of((tr) => {
    if (!tr.docChanged || !tr.startState.readOnly) return true;
    refused();
    return false;
  });
}

/**
 * Invisible characters CodeMirror's own list lacks (LRE, RLE, PDF, FSI and
 * the word joiner), so every bidi control ("Trojan Source") shows.
 */
export const EXTRA_SPECIAL_CHARS = /[\u202a-\u202c\u2068\u2060]/;

/** Lines looked at to detect the indentation. */
const INDENT_SAMPLE_LINES = 10_000;

/**
 * The indentation `text` already uses: a tab
 * when more lines start with a tab than with spaces, else two spaces when
 * the indents step by two more often than by four, else four spaces.
 */
export function detectIndentUnit(text: string): string {
  let tabs = 0;
  let spaced = 0;
  let twos = 0;
  let fours = 0;
  let previous = 0;
  for (let start = 0, lines = 0; start <= text.length && lines < INDENT_SAMPLE_LINES; lines++) {
    let end = text.indexOf("\n", start);
    if (end < 0) end = text.length;
    let spaces = 0;
    while (text.charCodeAt(start + spaces) === 32) spaces++;
    const first = text.charCodeAt(start + spaces);
    // Blank lines change nothing.
    if (start + spaces < end && first !== 13) {
      if (first === 9 && spaces === 0) tabs++;
      else if (first !== 9) {
        if (spaces) spaced++;
        const step = Math.abs(spaces - previous);
        if (step === 2) twos++;
        else if (step === 4) fours++;
        previous = spaces;
      }
    }
    start = end + 1;
  }
  if (tabs > spaced) return "\t";
  return twos > fours ? "  " : "    ";
}

// Image data ------------------------------------------------------------------
// Pasted and dropped images are inlined as data URLs, so one line can hold
// megabytes of base64 (an 8 MiB image is an 11 MB line). The payload shows as
// one compact mark instead: the editor never lays out that text (a 12 MB
// line took 1.6 s to open wrapped), and the prose around it stays readable.
// The text itself is unchanged: copy, save, search and the preview see it all.

/** Base64 payloads at least this long (about 3 KB of data) are folded; small icons stay visible. */
export const FOLD_MIN_CHARS = 4096;
const BASE64 = ";base64,";

class PayloadMark extends WidgetType {
  readonly chars: number;
  constructor(chars: number) {
    super();
    this.chars = chars;
  }
  eq(other: PayloadMark): boolean {
    return other.chars === this.chars;
  }
  toDOM(): HTMLElement {
    const mark = document.createElement("span");
    mark.className = "cm-data-fold";
    mark.textContent = `\u22ef ${dataSize(this.chars)}`;
    mark.title = "Image data (base64), not shown";
    return mark;
  }
}

/** The decoded size of `chars` base64 characters, for example "2.4 MB". */
export function dataSize(chars: number): string {
  const bytes = Math.floor((chars * 3) / 4);
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * Calls `found` with each line of at least `min` characters and its start,
 * until it returns true. CodeMirror keeps whole lines in small leaves, so a
 * leaf or branch shorter than `min` is skipped without reading its text: a
 * 12 MB document of ordinary lines costs a walk over the tree, no copies.
 */
function someLongLine(node: Text, from: number, min: number, found: (line: string, from: number) => boolean): boolean {
  if (node.length < min) return false;
  if (node.children) {
    let pos = from;
    for (const child of node.children) {
      if (someLongLine(child, pos, min, found)) return true;
      pos += child.length + 1;
    }
    return false;
  }
  let pos = from;
  for (const lines = node.iterLines(); !lines.next().done; pos += lines.value.length + 1) {
    if (lines.value.length >= min && found(lines.value, pos)) return true;
  }
  return false;
}

/** The folds for the base64 payloads in `text`, which starts at `from`. */
function foldsInText(text: string, from: number, folds: Range<Decoration>[]): void {
  // A scan, not a regular expression: matching megabytes with one overflowed V8's backtracking stack.
  for (let marker = text.indexOf(BASE64); marker >= 0; marker = text.indexOf(BASE64, marker + 1)) {
    const start = marker + BASE64.length;
    let end = start;
    while (end < text.length && isBase64(text.charCodeAt(end))) end++;
    if (end - start >= FOLD_MIN_CHARS) {
      folds.push(Decoration.replace({ widget: new PayloadMark(end - start) }).range(from + start, from + end));
      marker = end - 1;
    }
  }
}

/** The folds for the base64 payloads in `doc` between `from` and `to` (whole lines); the whole document by default. */
export function payloadFolds(doc: Text, from = 0, to = doc.length): Range<Decoration>[] {
  const folds: Range<Decoration>[] = [];
  if (from === 0 && to === doc.length) someLongLine(doc, 0, FOLD_MIN_CHARS, (line, start) => { foldsInText(line, start, folds); return false; });
  else foldsInText(doc.sliceString(from, to), from, folds);
  return folds;
}

/** A–Z, a–z, 0–9, "+", "/" and the "=" padding. */
function isBase64(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 47 && code <= 57) || code === 43 || code === 61;
}

/** The folds of a document: found once, then only on the lines an edit touches. */
export const imageData = StateField.define<DecorationSet>({
  create: (state) => Decoration.set(payloadFolds(state.doc)),
  update(folds, tr) {
    if (!tr.docChanged) return folds;
    let next = folds.map(tr.changes);
    const { doc } = tr.state;
    tr.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
      const from = doc.lineAt(fromB).from;
      const to = doc.lineAt(toB).to;
      next = next.update({ filter: (start, end) => end < from || start > to, filterFrom: from, filterTo: to, add: payloadFolds(doc, from, to) });
    });
    return next;
  },
  // A fold is one step for the caret and for Backspace / Delete.
  provide: (field) => [EditorView.decorations.from(field), EditorView.atomicRanges.of((view) => view.state.field(field, false) ?? Decoration.none)],
});

/** Whether `state` has a line of LONG_LINE_CHARS or more outside folded image data. */
export function hasLongLine(state: EditorState): boolean {
  const folds = state.field(imageData, false) ?? Decoration.none;
  return someLongLine(state.doc, 0, LONG_LINE_CHARS, (line, from) => {
    let shown = line.length;
    folds.between(from, from + line.length, (start, end) => { shown -= end - start; });
    return shown >= LONG_LINE_CHARS;
  });
}

/** Whether `doc` holds `text` (LF line breaks): compared piece by piece, without copying the document. */
export function holds(doc: Text, text: string): boolean {
  if (doc.length !== text.length) return false;
  let pos = 0;
  for (const iter = doc.iter(); !iter.next().done;) {
    if (iter.lineBreak ? text.charCodeAt(pos) !== 10 : !text.startsWith(iter.value, pos)) return false;
    pos += iter.value.length;
  }
  return true;
}

/**
 * The change that turns `from` into `to`: the part between their common
 * start and end (a linear scan, about 10 ms for 12 MB), so a document whose
 * text was replaced keeps its caret and scroll place around the change.
 */
export function textChange(from: string, to: string): ChangeSet {
  const end = Math.min(from.length, to.length);
  let start = 0;
  while (start < end && from.charCodeAt(start) === to.charCodeAt(start)) start++;
  let tail = 0;
  while (tail < end - start && from.charCodeAt(from.length - 1 - tail) === to.charCodeAt(to.length - 1 - tail)) tail++;
  return ChangeSet.of({ from: start, to: from.length - tail, insert: to.slice(start, to.length - tail) }, from.length);
}

type Entry = {
  id: string;
  state: EditorState;
  language: DocumentLanguage;
  large: boolean;
  /** Has a line too long to wrap (LONG_LINE_CHARS): shown unwrapped whatever the setting. */
  longLines: boolean;
  /** Where it was scrolled to, mapped through later edits. */
  scroll: StateEffect<unknown> | null;
  /** Reads its newest text, also once another document is shown. */
  read: () => string;
  /** doc_open's rev of the text it was opened with; null once edited. */
  rev: string | null;
};

export class Editor {
  readonly view: EditorView;
  private readonly onChange: () => void;
  private readonly extensions: Extension;
  private readonly entries = new Map<string, Entry>();
  private readonly selectionListeners = new Set<() => void>();
  private current: Entry | null = null;
  private readOnly = false;
  private message = READ_ONLY_MESSAGE;
  private note: HTMLElement | null = null;
  private noteTimer: number | undefined;

  /** `onChange` runs after every edit of the open document (typing, undo, an inserted image), never for an open. */
  constructor(host: HTMLElement, onChange: () => void) {
    this.onChange = onChange;
    this.extensions = [
      history(),
      drawSelection(),
      dropCursor(),
      // Control, zero-width and bidi characters show as a marked placeholder.
      highlightSpecialChars({ addSpecialChars: EXTRA_SPECIAL_CHARS }),
      readOnlyGuard(() => queueMicrotask(() => this.noteReadOnly())),
      imageData,
      EditorState.allowMultipleSelections.of(true),
      // Alt+click adds a caret and Alt+Shift+drag selects a column.
      EditorView.clickAddsSelectionRange.of((event) => event.altKey),
      rectangularSelection({ eventFilter: (event) => event.altKey && event.shiftKey }),
      EditorState.tabSize.of(4),
      closeBrackets(),
      bracketMatching(),
      syntaxHighlighting(highlighter),
      search({ top: true }),
      keymap.of([
        ...closeBracketsKeymap,
        ...searchKeymap,
        ...historyKeymap,
        { key: "Tab", run: insertSoftTab, shift: indentLess },
        ...defaultKeymap,
      ]),
      EditorView.contentAttributes.of({ "aria-label": "Document text" }),
      EditorView.domEventHandlers({
        beforeinput: (event, view) => {
          // A composition cannot be cancelled; CodeMirror drops it when read-only.
          if (!view.state.readOnly || event.inputType === "insertCompositionText" || !/^(insert|delete|history|format)/.test(event.inputType)) return false;
          this.noteReadOnly();
          return true;
        },
        paste: (_event, view) => this.refused(view),
        cut: (_event, view) => this.refused(view),
        // Text dragged within the editor (or into it) moves or copies there;
        // images are main.ts's, everything else is refused (navigation.ts).
        dragover: (event, view) => {
          const types = event.dataTransfer?.types ?? [];
          if (types.includes("text/plain") && !types.includes("Files") && !view.state.readOnly) event.preventDefault();
          return false;
        },
        drop: (event, view) => {
          if (!event.dataTransfer?.types.includes("text/plain")) return true;
          if (!view.state.readOnly) return false;
          this.noteReadOnly();
          return true;
        },
      }),
      EditorView.updateListener.of((update) => {
        const entry = this.current;
        if (!entry) return;
        entry.state = update.state;
        if (update.docChanged) {
          entry.rev = null;
          if (entry.scroll) entry.scroll = entry.scroll.map(update.changes) ?? null;
          this.onChange();
        }
        if (update.selectionSet || update.docChanged) for (const listener of this.selectionListeners) listener();
        if (this.note && !this.note.hidden && (update.selectionSet || update.focusChanged)) this.note.hidden = true;
      }),
    ];
    this.view = new EditorView({ state: emptyState(), parent: host });
    this.view.scrollDOM.addEventListener("mousedown", this.onMarginDown);
    // Remembered here because a hidden editor (Preview mode) reads as scrolled to the top.
    this.view.scrollDOM.addEventListener("scroll", () => {
      if (this.current) this.current.scroll = this.view.scrollSnapshot();
    }, { passive: true });
  }

  /** Whether a document is open. */
  get hasDocument(): boolean {
    return this.current !== null;
  }

  /** Whether the open document refuses edits (read-only or frozen). */
  get isReadOnly(): boolean {
    return this.view.state.readOnly;
  }

  /** Whether the open document has a line too long to soft wrap, so it is shown unwrapped. */
  get longLines(): boolean {
    return this.current?.longLines ?? false;
  }

  /** The open document's text ("" without one). */
  text(): string {
    return this.current ? this.view.state.doc.toString() : "";
  }

  /** The open document's length in characters. */
  get length(): number {
    return this.current ? this.view.state.doc.length : 0;
  }

  get lineCount(): number {
    return this.current ? this.view.state.doc.lines : 0;
  }

  /** Reads the open document's newest text when called, even once another document is shown. */
  reader(): () => string {
    return this.current?.read ?? (() => "");
  }

  /** doc_open's rev of the text kept for `id`, while unedited; null otherwise. */
  revOf(id: string): string | null {
    return this.entries.get(id)?.rev ?? null;
  }

  /**
   * Rust staged `text` of `id` as `rev`: a kept state that still holds
   * exactly that text takes the rev, so the next open of `id` needs no text.
   */
  staged(id: string, text: string, rev: string): void {
    const entry = this.entries.get(id);
    if (entry && entry.rev !== rev && holds(entry.state.doc, text)) entry.rev = rev;
  }

  /**
   * Shows document `id` with `text`. Its kept state (undo history,
   * selection, scroll) is reused when it still holds this text; other text
   * (another window's) starts a new history with the caret kept in range.
   * Null `text` keeps the kept state as it is: doc_open left the text out
   * because it is still the one of `rev` (revOf). `readOnlyMessage` is
   * what a refused keystroke shows.
   */
  open(id: string, text: string | null, readOnly = false, language: DocumentLanguage = "markdown", readOnlyMessage = READ_ONLY_MESSAGE, rev: string | null = null): void {
    let entry = this.entries.get(id);
    if (text === null && !entry) throw new Error("The document's text is no longer in the editor.");
    this.readOnly = readOnly;
    this.message = readOnlyMessage;
    const large = (text ?? entry?.state.doc ?? "").length >= LARGE_DOCUMENT_CHARS;
    const leaving = this.current;
    if (leaving && this.visible()) leaving.scroll = this.view.scrollSnapshot();
    if (text !== null && entry) {
      const wanted = text.includes("\r") ? text.replace(/\r\n?/g, "\n") : text;
      if (!holds(entry.state.doc, wanted)) {
        // Another window's (or the saved) text: a new undo history;
        // caret and scroll place follow the change.
        const change = textChange(entry.state.doc.toString(), wanted);
        entry.state = this.createState(wanted, language, large, entry.state.selection.map(change));
        entry.longLines = hasLongLine(entry.state);
        entry.scroll = entry.scroll?.map(change) ?? null;
      }
    } else if (text !== null) {
      const state = this.createState(text, language, large);
      const created: Entry = { id, state, language, large, longLines: hasLongLine(state), scroll: null, read: () => created.state.doc.toString(), rev: null };
      entry = created;
    }
    if (!entry) return;
    entry.rev = rev;
    entry.language = language;
    entry.large = large;
    entry.state = this.settle(entry.state, entry);
    this.entries.delete(id);
    this.entries.set(id, entry);
    if (entry !== leaving || entry.state !== this.view.state) {
      this.current = entry;
      this.view.setState(entry.state);
      if (entry.scroll) this.view.dispatch({ effects: entry.scroll });
      else this.view.scrollDOM.scrollTop = 0;
    }
    this.evict();
  }

  /** No document: an empty editor that takes no input. */
  close(): void {
    if (this.current && this.visible()) this.current.scroll = this.view.scrollSnapshot();
    this.current = null;
    this.hideNote();
    this.view.setState(emptyState());
  }

  /** A renamed, moved or conflict-copied document keeps its state (and undo history) under its new id. */
  retarget(from: string, to: string): void {
    const entry = this.entries.get(from);
    if (!entry || from === to) return;
    this.entries.delete(from);
    entry.id = to;
    this.entries.set(to, entry);
  }

  /** After a rename: the open document's highlighting and typography for `language`; nothing else changes. */
  setLanguage(language: DocumentLanguage): void {
    const entry = this.current;
    if (!entry) return;
    const large = this.view.state.doc.length >= LARGE_DOCUMENT_CHARS;
    if (entry.language === language && entry.large === large) return;
    entry.language = language;
    entry.large = large;
    this.reconfigure();
  }

  /** Read-only or writable, with what a refused keystroke shows meanwhile. */
  setReadOnly(readOnly: boolean, message = this.message): void {
    this.readOnly = readOnly;
    this.message = message;
    this.reconfigure();
  }

  /**
   * Read-only while the open document is saved before something closes it
   * (lock, switch, move, a new window). `message` is what a keystroke shows
   * meanwhile. The returned function gives back the setting from before.
   */
  freeze(message = "Saving before the workspace closes…"): () => void {
    const { readOnly, message: before } = this;
    this.setReadOnly(true, message);
    return () => {
      if (this.current) this.setReadOnly(readOnly, before);
    };
  }

  /** Soft wrap on or off for the open document and every one shown later. */
  setSoftWrap(on: boolean): void {
    softWrap = on;
    this.reconfigure();
  }

  focus(): void {
    this.view.focus();
  }

  /** The non-empty selections' texts, for the word count. */
  selectedTexts(): string[] {
    if (!this.current) return [];
    const { state } = this.view;
    return state.selection.ranges.filter((range) => !range.empty).map((range) => state.sliceDoc(range.from, range.to));
  }

  /** Runs `listener` whenever the selection or the text changes; returns what stops it. */
  onSelectionChange(listener: () => void): () => void {
    this.selectionListeners.add(listener);
    return () => this.selectionListeners.delete(listener);
  }

  /**
   * The source line at the top of the viewport, fractional inside a line
   * (a wrapped paragraph): a binary search over the line heights, no
   * rendering. Null without a document.
   */
  topLine(): number | null {
    if (!this.current) return null;
    const view = this.view;
    const y = view.scrollDOM.scrollTop - view.documentPadding.top;
    if (y <= 0) return 1;
    const block = view.lineBlockAtHeight(y);
    const line = view.state.doc.lineAt(block.from).number;
    return line + (block.height > 0 ? Math.min(1, Math.max(0, (y - block.top) / block.height)) : 0);
  }

  /**
   * Scrolls `line` (fractional) to the top of the viewport; CodeMirror
   * places it after measuring, so a pane that was just shown or changed
   * width is right. With `moveCaret`, a caret then out of view moves to the
   * first whole line shown, so typing lands where the reader was; a caret
   * in view keeps its place and selection.
   */
  showLine(line: number, moveCaret: boolean): void {
    if (!this.current) return;
    const view = this.view;
    const { doc, selection } = view.state;
    const whole = Math.min(doc.lines, Math.max(1, Math.floor(line)));
    const fraction = Math.min(1, Math.max(0, line - whole));
    const target = doc.line(whole);
    const pos = target.from + Math.round(target.length * fraction);
    let caret: number | undefined;
    if (moveCaret) {
      const block = view.lineBlockAt(target.from);
      const top = block.top + block.height * fraction;
      const head = selection.main.head;
      const at = view.lineBlockAt(head);
      const caretTop = at.top + at.height * ((head - at.from) / Math.max(1, at.length));
      const inView = caretTop >= top && caretTop + view.defaultLineHeight <= top + view.scrollDOM.clientHeight;
      if (!inView) caret = doc.line(Math.min(doc.lines, fraction > 0 ? whole + 1 : whole)).from;
    }
    view.dispatch({
      selection: caret === undefined ? undefined : { anchor: caret },
      effects: EditorView.scrollIntoView(pos, { y: "start", yMargin: 0 }),
    });
  }

  /** Puts the caret at the start of `line` and centres it (an outline or link jump). */
  revealLine(line: number): void {
    if (!this.current) return;
    const { doc } = this.view.state;
    const target = doc.line(Math.min(doc.lines, Math.max(1, Math.floor(line))));
    this.view.dispatch({ selection: { anchor: target.from }, effects: EditorView.scrollIntoView(target.from, { y: "center" }) });
  }

  /** Puts the caret at the text nearest the window point (`clientX`, `clientY`), for a drop. */
  placeCaretAt(clientX: number, clientY: number): void {
    if (!this.current) return;
    const pos = this.view.posAtCoords({ x: clientX, y: clientY }, false);
    this.view.dispatch({ selection: { anchor: pos } });
  }

  /** Replaces the main selection with `text`, the caret after it, as one undo step; false when read-only. */
  insertText(text: string): boolean {
    const { state } = this.view;
    if (!this.current || state.readOnly) return false;
    const { from, to } = state.selection.main;
    const insert = state.toText(text);
    this.view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length }, scrollIntoView: true, userEvent: "input.paste" });
    return true;
  }

  /** Shows the read-only note at the caret, as a refused keystroke does. */
  noteReadOnly(): void {
    const view = this.view;
    if (!this.note) {
      this.note = document.createElement("div");
      this.note.className = "cm-readonly-note";
      this.note.setAttribute("role", "status");
      view.dom.append(this.note);
    }
    const note = this.note;
    note.textContent = this.message;
    const caret = view.coordsAtPos(view.state.selection.main.head);
    const box = view.dom.getBoundingClientRect();
    note.style.left = `${Math.max(0, Math.round((caret?.left ?? box.left) - box.left))}px`;
    note.style.top = `${Math.max(0, Math.round((caret?.bottom ?? box.top) - box.top + 4))}px`;
    note.hidden = false;
    clearTimeout(this.noteTimer);
    this.noteTimer = window.setTimeout(() => this.hideNote(), NOTE_MS);
  }

  /** Drops every kept document state and the view; the editor is unusable afterwards. */
  destroy(): void {
    clearTimeout(this.noteTimer);
    this.entries.clear();
    this.selectionListeners.clear();
    this.current = null;
    this.view.destroy();
  }

  private refused(view: EditorView): boolean {
    if (view.state.readOnly && this.current) this.noteReadOnly();
    return false;
  }

  private hideNote(): void {
    if (this.note) this.note.hidden = true;
  }

  private visible(): boolean {
    return this.view.dom.getClientRects().length > 0;
  }

  private createState(text: string, language: DocumentLanguage, large: boolean, selection?: EditorSelection): EditorState {
    return EditorState.create({
      doc: text,
      selection,
      extensions: [
        this.extensions,
        languageSlot.of(languageExtension(language, large)),
        wrapSlot.of(softWrap ? EditorView.lineWrapping : NO_WRAP),
        readOnlySlot.of(this.readOnly ? READ_ONLY : WRITABLE),
        indentUnit.of(detectIndentUnit(text)),
      ],
    });
  }

  /** The reconfiguration `state` needs for its language and the editor's wrap and read-only settings, if any. */
  private effectsFor(state: EditorState, entry: Entry): StateEffect<unknown>[] {
    const effects: StateEffect<unknown>[] = [];
    const language = languageExtension(entry.language, entry.large);
    if (languageSlot.get(state) !== language) effects.push(languageSlot.reconfigure(language));
    const wrap = softWrap && !entry.longLines ? EditorView.lineWrapping : NO_WRAP;
    if (wrapSlot.get(state) !== wrap) effects.push(wrapSlot.reconfigure(wrap));
    const readOnly = this.readOnly ? READ_ONLY : WRITABLE;
    if (readOnlySlot.get(state) !== readOnly) effects.push(readOnlySlot.reconfigure(readOnly));
    return effects;
  }

  private settle(state: EditorState, entry: Entry): EditorState {
    const effects = this.effectsFor(state, entry);
    if (!effects.length) return state;
    if (entry === this.current && state === this.view.state) {
      this.view.dispatch({ effects });
      return this.view.state;
    }
    return state.update({ effects }).state;
  }

  private reconfigure(): void {
    const entry = this.current;
    if (!entry) return;
    const effects = this.effectsFor(this.view.state, entry);
    if (effects.length) this.view.dispatch({ effects });
  }

  /** Least recently shown first, past MAX_STATES documents or MAX_STATE_CHARS characters. */
  private evict(): void {
    let chars = 0;
    for (const entry of this.entries.values()) chars += entry.state.doc.length;
    for (const [id, entry] of this.entries) {
      if (this.entries.size <= MAX_STATES && chars <= MAX_STATE_CHARS) return;
      if (entry === this.current) continue;
      this.entries.delete(id);
      chars -= entry.state.doc.length;
    }
  }

  /**
   * A click in the margin beside the text column puts the caret there: at
   * the start of that line on the left (as clicking the margin of a
   * document does in Obsidian), at the nearest text on the right.
   */
  private onMarginDown = (event: MouseEvent): void => {
    const view = this.view;
    if (event.button !== 0 || event.target !== view.scrollDOM || !this.current) return;
    const scroller = view.scrollDOM.getBoundingClientRect();
    if (event.clientX >= scroller.left + view.scrollDOM.clientWidth - SCROLLBAR_SLACK_PX || event.clientY >= scroller.top + view.scrollDOM.clientHeight) return;
    const content = view.contentDOM.getBoundingClientRect();
    // Below the text CodeMirror places the caret itself.
    if (event.clientY < content.top || event.clientY > content.bottom) return;
    const pos = view.posAtCoords({ x: Math.min(Math.max(event.clientX, content.left), content.right - 1), y: event.clientY }, false);
    const head = event.clientX < content.left ? view.state.doc.lineAt(pos).from : pos;
    event.preventDefault();
    const anchor = event.shiftKey ? view.state.selection.main.anchor : head;
    view.dispatch({ selection: EditorSelection.single(anchor, head), userEvent: "select.pointer" });
    view.focus();
  };
}

/** The state shown without a document: empty, not focusable, no caret. */
function emptyState(): EditorState {
  return EditorState.create({ extensions: [EditorView.editable.of(false), READ_ONLY] });
}
