import * as monaco from "../../node_modules/monaco-editor/esm/vs/editor/editor.api.js";
// @ts-expect-error The Monarch definition ships without type declarations; it is re-registered below with Obsidian-style heading and list tokens.
import { conf as markdownConf, language as markdownLanguage } from "../../node_modules/monaco-editor/esm/vs/languages/definitions/markdown/markdown.js";
// Basic Monarch tokenizers only (no language services, no extra workers).
// CSS and JavaScript highlight <style> and <script> blocks inside HTML files
// and fenced code in Markdown.
import "../../node_modules/monaco-editor/esm/vs/languages/definitions/html/register.js";
import "../../node_modules/monaco-editor/esm/vs/languages/definitions/css/register.js";
import "../../node_modules/monaco-editor/esm/vs/languages/definitions/javascript/register.js";
import EditorWorker from "../../node_modules/monaco-editor/esm/vs/editor/editor.worker.js?worker";
import {
  applyDocumentTheme,
  cssColor,
  cssPixels,
  cssValue,
  onSystemThemeChange,
  resolveTheme,
  type ThemeMode,
  type ThemePreference,
} from "../theme";

(self as typeof self & { MonacoEnvironment: { getWorker(): Worker } }).MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
};

export type DocumentLanguage = "markdown" | "html" | "plaintext";
export const LARGE_DOCUMENT_CHARS = 2 * 1024 * 1024;
/**
 * From this length soft wrap counts characters ("simple") instead of
 * measuring every line in the DOM ("advanced"). One advanced re-wrap took
 * 131-173 ms at 123 KB, 213-291 ms at 0.2 MB and 0.5-0.75 s at 0.5 MB in
 * WebKit; simple, under 50 ms at 1.9 MB.
 */
const SIMPLE_WRAP_CHARS = 64 * 1024;
/**
 * Below this length a pane width change re-wraps at once (a few ms); from it,
 * the wrap column follows once the width has settled (LARGE_REWRAP_DELAY_MS).
 */
const DEFERRED_REWRAP_CHARS = 16 * 1024;

const models = new Map<string, monaco.editor.ITextModel>();
/** Soft wrap (VS Code's Alt+Z): one setting for every document, on until toggled, for this session. */
let softWrap = true;
const recent: string[] = [];
const MAX_MODELS = 10;
/**
 * Documents wrap at a fixed column (see sizeOptions). Re-wrapping one of
 * DEFERRED_REWRAP_CHARS or more costs tens of milliseconds (about 100 ms for
 * 12 MB), so after the pane width changes the column follows once, this long
 * after the last change, instead of on every frame of a drag or resize.
 */
const LARGE_REWRAP_DELAY_MS = 250;
const pendingRewrap = new WeakMap<monaco.editor.ICodeEditor, number>();
const TRANSPARENT = "#00000000";
// Used only if theme.css could not be read; keep in the same order as --font-default.
const FALLBACK_TEXT_FONT = 'ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Inter Variable", "Inter", sans-serif';
const FALLBACK_MONO_FONT = 'ui-monospace, SFMono-Regular, "Cascadia Mono", "Roboto Mono", Menlo, Consolas, monospace';
const reducedMotion = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;

registerMarkdown();

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

export function createEditor(host: HTMLElement): monaco.editor.IStandaloneCodeEditor {
  const typography = typographyFor("markdown");
  const editor = monaco.editor.create(host, {
    language: "markdown",
    automaticLayout: true,
    ...typography,
    // Text is centred at the readable line width: fitReadableWidth() sets a
    // left gutter (lineDecorationsWidth) and a wrap column for the text width.
    ...sizeOptions(0),
    wordWrapColumn: 80,
    wrappingIndent: "same",
    lineNumbers: "off",
    lineDecorationsWidth: cssPixels("--file-margins", 32, host),
    glyphMargin: false,
    folding: false,
    minimap: { enabled: false },
    quickSuggestions: false,
    suggestOnTriggerCharacters: false,
    wordBasedSuggestions: "off",
    parameterHints: { enabled: false },
    hover: { enabled: "off" },
    codeLens: false,
    links: false,
    occurrencesHighlight: "off",
    selectionHighlight: false,
    dropIntoEditor: { enabled: false },
    pasteAs: { enabled: false },
    dragAndDrop: true,
    accessibilitySupport: "auto",
    unicodeHighlight: { invisibleCharacters: true, ambiguousCharacters: true },
    padding: { top: cssPixels("--file-margins", 32, host), bottom: cssPixels("--size-4-16", 64) },
    scrollBeyondLastLine: false,
    // Monaco animates scrolling in JavaScript, which the CSS reduced-motion
    // rule cannot reach, so the OS setting is applied here and followed live.
    smoothScrolling: !reducedMotion?.matches,
    renderLineHighlight: "none",
    renderWhitespace: "none",
    guides: { indentation: false },
    bracketPairColorization: { enabled: false },
    overviewRulerLanes: 0,
    overviewRulerBorder: false,
    hideCursorInOverviewRuler: true,
    roundedSelection: true,
    cursorWidth: 2,
    scrollbar: { verticalScrollbarSize: 12, horizontalScrollbarSize: 12, useShadows: false },
  });

  const followMotionSetting = (): void => editor.updateOptions({ smoothScrolling: !reducedMotion?.matches });
  reducedMotion?.addEventListener("change", followMotionSetting);
  editor.onDidDispose(() => reducedMotion?.removeEventListener("change", followMotionSetting));

  editor.onDidLayoutChange(() => fitReadableWidth(editor));
  editor.onDidDispose(() => clearTimeout(pendingRewrap.get(editor)));
  editor.onDidChangeConfiguration((event) => {
    if (event.hasChanged(monaco.editor.EditorOption.fontInfo)) fitReadableWidth(editor);
  });
  // A click in the left gutter puts the caret at the start of that line, as
  // clicking the margin of a document does in Obsidian.
  editor.onMouseDown((event) => {
    if (event.target.type !== monaco.editor.MouseTargetType.GUTTER_LINE_DECORATIONS || !event.target.position) return;
    editor.setPosition({ lineNumber: event.target.position.lineNumber, column: 1 });
    editor.focus();
  });
  fitReadableWidth(editor);
  remeasureWhenFontsLoad();
  return editor;
}

export function openModel(
  editor: monaco.editor.IStandaloneCodeEditor,
  id: string,
  text: string,
  readOnly = false,
  language: DocumentLanguage = "markdown",
): monaco.editor.ITextModel {
  let model = models.get(id);
  const large = text.length >= LARGE_DOCUMENT_CHARS;
  const cheapWrap = text.length >= SIMPLE_WRAP_CHARS;
  const modelLanguage = large ? "plaintext" : language;
  if (!model) {
    model = monaco.editor.createModel(
      text,
      modelLanguage,
      monaco.Uri.parse(`secure-vault://document/${id}`),
    );
    model.setEOL(monaco.editor.EndOfLineSequence.LF);
    // Bracket colours are a model option; the editor option alone does not turn them off.
    model.updateOptions({ bracketColorizationOptions: { enabled: false, independentColorPoolPerBracketType: false } });
    models.set(id, model);
  } else {
    if (model.getLanguageId() !== modelLanguage) monaco.editor.setModelLanguage(model, modelLanguage);
    if (model.getValue() !== text.replace(/\r\n?/g, "\n")) {
      model.setValue(text);
      model.setEOL(monaco.editor.EndOfLineSequence.LF);
    }
  }
  const options: monaco.editor.IEditorOptions = {
    ...typographyFor(language),
    ...sizeOptions(text.length),
    readOnly,
    readOnlyMessage: { value: "Restore this document to edit it." },
  };
  // Advanced wrapping measures every line in the DOM. A large model attached
  // while it is on froze the app for 20 s (12 MB page), so a document that
  // wraps cheaply gets its options first; a small one is attached first, so
  // the options never re-wrap the previous, possibly large, model.
  if (cheapWrap) {
    editor.updateOptions(options);
    editor.setModel(model);
  } else {
    editor.setModel(model);
    editor.updateOptions(options);
  }
  touch(id);
  evict(editor.getModel()?.uri.toString());
  return model;
}

/**
 * Makes the editor read-only while the open document is saved before the
 * workspace closes (lock, switch, move, delete), so nothing typed meanwhile
 * is dropped. The returned function gives the document its own setting back.
 */
export function freezeEditor(editor: monaco.editor.IStandaloneCodeEditor): () => void {
  const readOnly = editor.getOption(monaco.editor.EditorOption.readOnly);
  const readOnlyMessage = editor.getOption(monaco.editor.EditorOption.readOnlyMessage);
  editor.updateOptions({ readOnly: true, readOnlyMessage: { value: "Saving before the workspace closes…" } });
  return () => {
    if (editor.getModel()) editor.updateOptions({ readOnly, readOnlyMessage });
  };
}

/**
 * Changes syntax highlighting and editor typography after a document is
 * renamed without replacing its model, so its selection and undo history are
 * preserved.
 */
export function setEditorLanguage(
  editor: monaco.editor.IStandaloneCodeEditor,
  language: DocumentLanguage,
): void {
  syncEditorSizeMode(editor, language);
  editor.updateOptions(typographyFor(language));
  fitReadableWidth(editor);
}

/** Large documents stay fully editable, with tokenization paused and only the cheap wrapping (see sizeOptions). */
export function syncEditorSizeMode(editor: monaco.editor.IStandaloneCodeEditor, language: DocumentLanguage): void {
  const model = editor.getModel();
  if (!model) return;
  const large = model.getValueLength() >= LARGE_DOCUMENT_CHARS;
  const modelLanguage = large ? "plaintext" : language;
  if (model.getLanguageId() !== modelLanguage) monaco.editor.setModelLanguage(model, modelLanguage);
  const wanted = sizeOptions(model.getValueLength());
  if (editor.getOption(monaco.editor.EditorOption.wordWrap) !== wanted.wordWrap
    || editor.getOption(monaco.editor.EditorOption.wrappingStrategy) !== wanted.wrappingStrategy) {
    editor.updateOptions(wanted);
  }
}

/** Whether soft wrap is on. */
export function softWrapEnabled(): boolean {
  return softWrap;
}

/**
 * Turns soft wrap on or off for the open document and every one opened
 * later. A document of SIMPLE_WRAP_CHARS or more wraps with the "simple"
 * strategy (character counts, no DOM measuring), so turning it on never
 * freezes the app.
 */
export function setSoftWrap(editor: monaco.editor.IStandaloneCodeEditor, on: boolean): void {
  softWrap = on;
  const model = editor.getModel();
  if (model) editor.updateOptions(sizeOptions(model.getValueLength()));
}

/**
 * Wrapping and rendering limits for a document of `length` characters. Soft
 * wrap wraps at the readable width, at a fixed column that
 * fitReadableWidth() keeps inside the pane, rather than "bounded" by the
 * viewport: bounded wrapping re-wraps the whole document on every layout
 * change, including every frame of a pane drag (a 1.9 MB note dragged at
 * 1-2 fps with 2-6 s freezes) and Preview mode, where the hidden editor lays
 * out 5 px wide (12 MB wrapped at column 1 in 250 ms). From SIMPLE_WRAP_CHARS the
 * wrapping counts characters ("simple"; advanced measures every line in the
 * DOM); large documents also render shorter lines. With wrapping on, no
 * extra columns to scroll past the wrapped text (Monaco's 4 would give a
 * wrapped line wider than the right margin a horizontal scrollbar).
 */
function sizeOptions(length: number): Pick<monaco.editor.IEditorOptions, "wordWrap" | "wrappingStrategy" | "stopRenderingLineAfter" | "scrollBeyondLastColumn"> {
  const wordWrap = softWrap ? "wordWrapColumn" : "off";
  const scrollBeyondLastColumn = softWrap ? 0 : 4;
  if (length >= LARGE_DOCUMENT_CHARS) return { wordWrap, wrappingStrategy: "simple", stopRenderingLineAfter: 2000, scrollBeyondLastColumn };
  return { wordWrap, wrappingStrategy: length >= SIMPLE_WRAP_CHARS ? "simple" : "advanced", stopRenderingLineAfter: 10000, scrollBeyondLastColumn };
}

export function disposeModels(editor?: monaco.editor.IStandaloneCodeEditor): void {
  editor?.setModel(null);
  for (const model of models.values()) model.dispose();
  models.clear();
  recent.length = 0;
}

let themePreference: ThemePreference = "System";
let followingSystem = false;

/**
 * Applies the app theme: sets <html data-theme="dark|light">, which selects
 * the token set in theme.css, then rebuilds the Monaco theme from those
 * tokens. "System" follows OS changes while it is selected.
 */
export function setTheme(theme: ThemePreference): void {
  themePreference = theme;
  if (theme === "System" && !followingSystem) {
    followingSystem = true;
    onSystemThemeChange(() => {
      if (themePreference === "System") applyTheme();
    });
  }
  applyTheme();
}

function applyTheme(): void {
  const mode = resolveTheme(themePreference);
  applyDocumentTheme(mode);
  const name = `vault-${mode}`;
  monaco.editor.defineTheme(name, buildEditorTheme(mode));
  monaco.editor.setTheme(name);
}

// Markdown is shown in the text font; HTML in the monospace code font.
function typographyFor(language: DocumentLanguage): monaco.editor.IEditorOptions {
  const code = language === "html";
  const fontSize = code ? cssPixels("--font-code-editor-size", 14) : cssPixels("--font-text-size", 16);
  return {
    fontFamily: (code ? cssValue("--font-monospace") : cssValue("--font-text")) || (code ? FALLBACK_MONO_FONT : FALLBACK_TEXT_FONT),
    fontSize,
    lineHeight: Math.round(fontSize * cssPixels("--line-height-normal", 1.5)),
    letterSpacing: 0,
    disableMonospaceOptimizations: !code,
  };
}

// Centres the text column at --file-line-width (Obsidian's "readable line
// length") and keeps at least --file-margins on both sides. A hidden editor
// (Preview mode) keeps the layout it had.
function fitReadableWidth(editor: monaco.editor.IStandaloneCodeEditor, settled = false): void {
  const layout = editor.getLayoutInfo();
  const available = layout.width - layout.verticalScrollbarWidth;
  if (available <= 0 || editor.getContainerDomNode().getClientRects().length === 0) return;
  // Narrow windows set smaller margins on the editor's own element (theme.css, section 11).
  const margin = cssPixels("--file-margins", 32, editor.getContainerDomNode());
  const lineWidth = cssPixels("--file-line-width", 700);
  const charWidth = editor.getOption(monaco.editor.EditorOption.fontInfo).typicalHalfwidthCharacterWidth || 8;
  const textWidth = Math.max(0, Math.min(lineWidth, available - margin * 2));
  const left = Math.min(1000, Math.max(margin, Math.floor((available - textWidth) / 2)));
  const column = Math.max(20, Math.floor(textWidth / charWidth));
  const sameLeft = editor.getOption(monaco.editor.EditorOption.lineDecorationsWidth) === left;
  const sameColumn = editor.getOption(monaco.editor.EditorOption.wordWrapColumn) === column;
  if (sameLeft && sameColumn) return;
  if (!sameColumn && !settled && editor.getOption(monaco.editor.EditorOption.wordWrap) === "wordWrapColumn"
    && (editor.getModel()?.getValueLength() ?? 0) >= DEFERRED_REWRAP_CHARS) {
    if (!sameLeft) editor.updateOptions({ lineDecorationsWidth: left });
    clearTimeout(pendingRewrap.get(editor));
    pendingRewrap.set(editor, window.setTimeout(() => {
      pendingRewrap.delete(editor);
      fitReadableWidth(editor, true);
    }, LARGE_REWRAP_DELAY_MS));
    return;
  }
  editor.updateOptions({ lineDecorationsWidth: left, wordWrapColumn: column });
}

// Monaco measures glyphs when it starts. The bundled Inter is only used
// where the system fonts earlier in the stack are missing (for example on
// Linux), and it loads lazily the first time text needs it, so measure
// again whenever a font finishes loading.
let fontsHooked = false;
function remeasureWhenFontsLoad(): void {
  if (fontsHooked || !("fonts" in document)) return;
  fontsHooked = true;
  document.fonts.addEventListener("loadingdone", () => monaco.editor.remeasureFonts());
  document.fonts.ready
    .then(() => monaco.editor.remeasureFonts())
    .catch(() => { /* The metrics measured at start stay in use. */ });
}

// The Monaco theme is built from theme.css tokens, so editor and app always match.
function buildEditorTheme(mode: ThemeMode): monaco.editor.IStandaloneThemeData {
  const dark = mode === "dark";
  // `color` returns #rrggbb or #rrggbbaa. Token rules take rrggbb without "#" or alpha.
  const color = (name: string, fallback: string): string => cssColor(name, fallback);
  const fg = (name: string, fallback: string): string => color(name, fallback).slice(1, 7);
  // The fallbacks below apply only if a token is missing from theme.css.
  const text = color("--editor-text", dark ? "#dadada" : "#222222");
  const background = color("--editor-background", dark ? "#1e1e1e" : "#ffffff");
  const faint = color("--text-faint", dark ? "#666666" : "#ababab");
  const muted = color("--text-muted", dark ? "#b3b3b3" : "#5c5c5c");
  const accent = color("--text-accent", dark ? "#a68af9" : "#7c49f3");
  const thumb = color("--scrollbar-thumb-bg", dark ? "#ffffff1a" : "#0000001a");
  const thumbActive = color("--scrollbar-active-thumb-bg", dark ? "#ffffff33" : "#00000033");
  const widget = color("--editor-widget-background", dark ? "#262626" : "#f6f6f6");
  const widgetBorder = color("--editor-widget-border", dark ? "#3f3f3f" : "#d4d4d4");
  const findMatch = color("--editor-find-match", "#ffd00066");

  return {
    // No inherited token rules: Monaco's built-in themes have specific rules
    // (for example metatag.html) that would override the generic ones below.
    // Workbench colours not listed here fall back to Monaco's defaults for the base type.
    base: dark ? "vs-dark" : "vs",
    inherit: false,
    rules: [
      { token: "", foreground: text.slice(1, 7), background: background.slice(1, 7) },
      // Markdown source mode
      { token: "keyword.heading.md", foreground: fg("--md-heading", text), fontStyle: "bold" },
      { token: "keyword.heading.marker.md", foreground: fg("--md-marker", faint), fontStyle: "bold" },
      { token: "keyword.list.md", foreground: fg("--md-list-marker", faint) },
      { token: "keyword.table.header.md", foreground: fg("--md-heading", text), fontStyle: "bold" },
      { token: "keyword.table", foreground: fg("--md-marker", faint) },
      { token: "keyword.md", foreground: fg("--md-marker", faint) },
      { token: "meta.separator.md", foreground: fg("--md-marker", faint) },
      { token: "strong.md", foreground: fg("--md-strong", text), fontStyle: "bold" },
      { token: "emphasis.md", foreground: fg("--md-emphasis", text), fontStyle: "italic" },
      { token: "string.link.md", foreground: fg("--md-link", accent) },
      { token: "string.target.md", foreground: fg("--md-link-target", faint) },
      { token: "string.escape.md", foreground: faint.slice(1, 7) },
      { token: "escape.md", foreground: faint.slice(1, 7) },
      { token: "variable.md", foreground: fg("--md-code", "#e9973f") },
      { token: "variable.source.md", foreground: fg("--md-code-block", muted) },
      { token: "string.md", foreground: fg("--md-code-block", muted) },
      { token: "comment.md", foreground: fg("--md-quote", accent) },
      { token: "comment.content.md", foreground: fg("--code-comment", faint) },
      // Code: HTML, CSS, JavaScript and fenced blocks
      { token: "comment", foreground: fg("--code-comment", faint), fontStyle: "italic" },
      { token: "tag", foreground: fg("--code-tag", "#fb464c") },
      { token: "metatag", foreground: fg("--code-keyword", "#fa99cd") },
      { token: "metatag.content", foreground: fg("--code-value", "#a882ff") },
      { token: "attribute.name", foreground: fg("--code-property", "#53dfdd") },
      { token: "attribute.value", foreground: fg("--code-string", "#44cf6e") },
      { token: "attribute.value.number", foreground: fg("--code-value", "#a882ff") },
      { token: "attribute.value.unit", foreground: fg("--code-value", "#a882ff") },
      { token: "string", foreground: fg("--code-string", "#44cf6e") },
      { token: "string.html", foreground: fg("--code-string", "#44cf6e") },
      { token: "number", foreground: fg("--code-value", "#a882ff") },
      { token: "keyword", foreground: fg("--code-keyword", "#fa99cd") },
      { token: "type", foreground: fg("--code-function", "#e0de71") },
      { token: "type.identifier", foreground: fg("--code-function", "#e0de71") },
      { token: "regexp", foreground: fg("--code-important", "#e9973f") },
      { token: "delimiter", foreground: fg("--code-punctuation", muted) },
      { token: "operator", foreground: fg("--code-operator", "#fb464c") },
      { token: "identifier", foreground: text.slice(1, 7) },
      { token: "variable", foreground: text.slice(1, 7) },
      { token: "constant", foreground: fg("--code-value", "#a882ff") },
      { token: "predefined", foreground: fg("--code-function", "#e0de71") },
      { token: "annotation", foreground: fg("--code-function", "#e0de71") },
      { token: "key", foreground: fg("--code-property", "#53dfdd") },
      { token: "string.escape", foreground: fg("--code-important", "#e9973f") },
      { token: "emphasis", fontStyle: "italic" },
      { token: "strong", fontStyle: "bold" },
      { token: "invalid", foreground: fg("--text-error", "#fb464c") },
    ],
    colors: {
      "editor.background": background,
      "editor.foreground": text,
      "editorCursor.foreground": color("--editor-caret", text),
      "editor.selectionBackground": color("--editor-selection", "#8a5cf555"),
      "editor.inactiveSelectionBackground": color("--editor-selection-inactive", "#8a5cf52e"),
      "editor.selectionHighlightBackground": TRANSPARENT,
      "editor.wordHighlightBackground": TRANSPARENT,
      "editor.wordHighlightStrongBackground": TRANSPARENT,
      "editor.lineHighlightBackground": TRANSPARENT,
      "editor.lineHighlightBorder": TRANSPARENT,
      "editor.findMatchBackground": findMatch,
      "editor.findMatchHighlightBackground": findMatch,
      "editor.placeholder.foreground": faint,
      "editorGutter.background": background,
      "editorWhitespace.foreground": faint,
      "editorIndentGuide.background1": color("--nav-indentation-guide-color", TRANSPARENT),
      "editorIndentGuide.activeBackground1": color("--nav-indentation-guide-color", TRANSPARENT),
      "editorLink.activeForeground": accent,
      "editorBracketMatch.background": color("--background-modifier-hover", TRANSPARENT),
      "editorBracketMatch.border": color("--background-modifier-border-focus", TRANSPARENT),
      "editorUnicodeHighlight.border": color("--text-warning", "#e9973f"),
      "editorUnicodeHighlight.background": TRANSPARENT,
      "editorError.foreground": color("--text-error", "#fb464c"),
      "editorWarning.foreground": color("--text-warning", "#e9973f"),
      "editorOverviewRuler.border": TRANSPARENT,
      "editorWidget.background": widget,
      "editorWidget.foreground": text,
      "editorWidget.border": widgetBorder,
      "editorHoverWidget.background": widget,
      "editorHoverWidget.border": widgetBorder,
      "widget.shadow": color("--background-modifier-cover", TRANSPARENT),
      "input.background": color("--background-modifier-form-field", widget),
      "input.border": color("--background-modifier-border", widgetBorder),
      "input.foreground": text,
      "focusBorder": color("--focus-ring-color", accent),
      "scrollbar.shadow": TRANSPARENT,
      "scrollbarSlider.background": thumb,
      "scrollbarSlider.hoverBackground": thumbActive,
      "scrollbarSlider.activeBackground": thumbActive,
    },
  };
}

// Registers Markdown with Monaco's Monarch grammar, changed so that headings,
// list markers and task boxes get their own tokens. Obsidian's source mode
// shows the heading text bold, and faints the "#", the list markers and the
// "[ ]" / "[x]" of a task (the stock grammar colours those like links).
function registerMarkdown(): void {
  monaco.languages.register({
    id: "markdown",
    extensions: [".md", ".markdown", ".mdown", ".mkdn", ".mkd", ".mdwn", ".mdtxt", ".mdtext"],
    aliases: ["Markdown", "markdown"],
  });
  monaco.languages.setLanguageConfiguration("markdown", markdownConf as monaco.languages.LanguageConfiguration);
  monaco.languages.setMonarchTokensProvider("markdown", obsidianMarkdown(markdownLanguage as monaco.languages.IMonarchLanguage));
}

type MonarchRule = monaco.languages.IMonarchLanguageRule;

function obsidianMarkdown(base: monaco.languages.IMonarchLanguage): monaco.languages.IMonarchLanguage {
  // Declared here, not at module level: registerMarkdown() runs while the module is still initialising.
  const taskItem: MonarchRule = [/^(\s*)([*\-+]|\d+\.)(\s+)(\[[ xX]\])(?=\s|$)/, ["white", "keyword.list", "white", "keyword.list"]];
  const root = (base.tokenizer.root ?? []).flatMap((rule: MonarchRule): MonarchRule[] => {
    if (!Array.isArray(rule) || !(rule[0] instanceof RegExp)) return [rule];
    const source = rule[0].source;
    if (source.startsWith("^(\\s{0,3})(#+)")) {
      return [[rule[0], ["white", "keyword.heading.marker", "keyword.heading", "keyword.heading.marker"]]];
    }
    if (source === "^\\s*(=+|\\-+)\\s*$") return [[rule[0], "keyword.heading.marker"]];
    // Task items first, so "- [ ]" is one faint marker run, then plain list items.
    if (source === "^\\s*([\\*\\-+:]|\\d+\\.)\\s") return [taskItem, [rule[0], "keyword.list"]];
    return [rule];
  });
  return { ...base, tokenizer: { ...base.tokenizer, root } };
}

/** A renamed, moved or conflict-copied document keeps its model (and undo history) under its new id. */
export function retargetModel(from: string, to: string): void {
  const model = models.get(from);
  if (!model || from === to) return;
  models.delete(from);
  models.set(to, model);
  const index = recent.indexOf(from);
  if (index >= 0) recent[index] = to;
}

function touch(id: string): void {
  const index = recent.indexOf(id);
  if (index >= 0) recent.splice(index, 1);
  recent.push(id);
}

function evict(activeUri?: string): void {
  while (recent.length > MAX_MODELS) {
    const id = recent.shift();
    if (!id) return;
    const model = models.get(id);
    if (model && model.uri.toString() !== activeUri) {
      model.dispose();
      models.delete(id);
    }
  }
}

export { monaco };
