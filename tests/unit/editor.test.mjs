// The editor's pure parts (src/editor/editor.ts): languages, syntax classes,
// soft tab and the change that keeps a replaced document's caret. The view
// itself needs a DOM and is covered in the app.
import assert from "node:assert/strict";
import { test } from "node:test";
import { EditorSelection, EditorState } from "@codemirror/state";
import { ensureSyntaxTree, indentUnit, syntaxTree } from "@codemirror/language";
import { deleteMarkupBackward, insertNewlineContinueMarkup } from "@codemirror/lang-markdown";
import { highlightTree } from "@lezer/highlight";
import { EXTRA_SPECIAL_CHARS, FOLD_MIN_CHARS, LARGE_DOCUMENT_CHARS, LONG_LINE_CHARS, dataSize, detectIndentUnit, hasLongLine, highlighter, holds, imageData, insertSoftTab, languageExtension, languageForFile, payloadFolds, readOnlyGuard, textChange } from "../../src/editor/editor.ts";

/** "text=classes" for every highlighted run of `doc`. */
function classes(doc, language = "markdown") {
  const state = EditorState.create({ doc, extensions: languageExtension(language, false) });
  const runs = [];
  highlightTree(ensureSyntaxTree(state, doc.length, 5000), highlighter, (from, to, cls) => runs.push(`${doc.slice(from, to)}=${cls}`));
  return runs;
}

test("file names pick the language: HTML, plain text, else Markdown", () => {
  assert.equal(languageForFile("Page.HTML"), "html");
  assert.equal(languageForFile("page.htm"), "html");
  assert.equal(languageForFile("notes.txt"), "plaintext");
  assert.equal(languageForFile("Welcome.md"), "markdown");
  assert.equal(languageForFile("no extension"), "markdown");
});

test("Markdown marks are faint and apart from the text they mark (Obsidian's source mode)", () => {
  const runs = classes("# Title *em*\n\n- [ ] task\n1. one\n\n> quote\n\n**b** `c` [l](http://x.y) \\*\n\n---\n");
  for (const run of [
    "#=tok-heading tok-mark",
    " Title =tok-heading",
    "*=tok-heading tok-emphasis tok-mark",
    "-=tok-list-mark",
    "[ ]=tok-list-mark",
    "1.=tok-list-mark",
    ">=tok-quote tok-mark",
    "**=tok-strong tok-mark",
    "b=tok-strong",
    "c=tok-code",
    "[=tok-link tok-mark",
    "l=tok-link",
    "http://x.y=tok-link tok-url",
    "\\*=tok-escape",
    "---=tok-mark",
  ]) assert.ok(runs.includes(run), `${run} in ${runs.join("  ")}`);
});

test("code blocks: known fences get their language, others the block colour", () => {
  const runs = classes("```js\nconst x = 1; // c\n```\n\n    indented\n\n<b class=\"a\">x</b>\n");
  for (const run of ["```=tok-mark", "js=tok-label", "const=tok-keyword", "1=tok-value", "// c=tok-comment", "indented=tok-code-block", "b=tok-tag", "class=tok-property", "\"a\"=tok-string"]) {
    assert.ok(runs.includes(run), `${run} in ${runs.join("  ")}`);
  }
});

test("HTML pages highlight tags, attributes and their CSS and JavaScript", () => {
  const runs = classes("<!doctype html>\n<p id=x>&amp;</p><style>a { color: red }</style><script>let a = /x/g; f(\"s\")</script>", "html");
  for (const run of ["<!doctype html>=tok-keyword", "p=tok-tag", "id=tok-property", "x=tok-string", "&amp;=tok-value", "color=tok-property", "red=tok-value", "let=tok-keyword", "/x/g=tok-important", "f=tok-function", "\"s\"=tok-string"]) {
    assert.ok(runs.includes(run), `${run} in ${runs.join("  ")}`);
  }
});

test("large documents and plain text are not parsed; the typography class stays the language's", () => {
  for (const [language, large] of [["markdown", true], ["html", true], ["plaintext", false]]) {
    const state = EditorState.create({ doc: "# Heading\n<p>x</p>", extensions: languageExtension(language, large) });
    assert.equal(syntaxTree(state).length, 0, `${language} large=${large}`);
  }
  assert.equal(languageExtension("html", true), languageExtension("html", true), "one object per combination (compared by identity)");
  assert.notEqual(languageExtension("html", true), languageExtension("html", false));
  assert.equal(LARGE_DOCUMENT_CHARS, 2 * 1024 * 1024);
});

test("line breaks become LF (CodeMirror's default separator handling)", () => {
  assert.equal(EditorState.create({ doc: "a\r\nb\rc\n" }).doc.toString(), "a\nb\nc\n");
});

test("Tab inserts spaces to the next tab stop; with a selection it indents the lines", () => {
  const run = (doc, selection) => {
    let state = EditorState.create({ doc, selection, extensions: [EditorState.tabSize.of(4), indentUnit.of("    "), EditorState.allowMultipleSelections.of(true)] });
    assert.equal(insertSoftTab({ state, dispatch: (tr) => { state = tr.state; } }), true);
    return state;
  };
  assert.equal(run("ab", EditorSelection.cursor(2)).doc.toString(), "ab  ");
  assert.equal(run("abcd", EditorSelection.cursor(4)).doc.toString(), "abcd    ");
  const two = run("x\ny", EditorSelection.create([EditorSelection.cursor(1), EditorSelection.cursor(2)]));
  assert.equal(two.doc.toString(), "x   \n    y");
  assert.deepEqual(two.selection.ranges.map((range) => range.head), [4, 9]);
  assert.equal(run("one\ntwo", EditorSelection.range(0, 7)).doc.toString(), "    one\n    two");
  const readOnly = EditorState.create({ doc: "a", extensions: EditorState.readOnly.of(true) });
  assert.equal(insertSoftTab({ state: readOnly, dispatch: () => assert.fail("no edit") }), false);
  let tabbed = EditorState.create({ doc: "\tab", selection: EditorSelection.cursor(1), extensions: indentUnit.of("\t") });
  insertSoftTab({ state: tabbed, dispatch: (tr) => { tabbed = tr.state; } });
  assert.equal(tabbed.doc.toString(), "\t\tab", "a tab-indented document gets a tab");
});

test("the indentation follows the document's", () => {
  assert.equal(detectIndentUnit("- a\n\t- b\n\t\t- c\n\t- d\n"), "\t", "tabs (Obsidian's default)");
  assert.equal(detectIndentUnit("<ul>\n  <li>\n    <a>x</a>\n  </li>\n</ul>\n"), "  ", "two spaces");
  assert.equal(detectIndentUnit("def f():\n    return 1\n\n    \nclass A:\n    pass\n"), "    ", "four spaces, blank lines ignored");
  assert.equal(detectIndentUnit("no indentation\r\nat all"), "    ", "the default");
  assert.equal(detectIndentUnit(""), "    ");
});

test("a read-only document refuses every change, also lang-markdown's own commands", () => {
  let refusals = 0;
  let state = EditorState.create({
    doc: "- a",
    selection: EditorSelection.cursor(3),
    extensions: [languageExtension("markdown", false), EditorState.readOnly.of(true), readOnlyGuard(() => refusals++)],
  });
  const dispatch = (tr) => { state = tr.state; };
  insertNewlineContinueMarkup({ state, dispatch });
  assert.equal(state.doc.toString(), "- a", "Enter in a list");
  state = state.update({ selection: EditorSelection.cursor(2) }).state;
  deleteMarkupBackward({ state, dispatch });
  assert.equal(state.doc.toString(), "- a", "Backspace after list marks");
  state = state.update({ changes: { from: 0, insert: "[x](https://example.com)" } }).state;
  assert.equal(state.doc.toString(), "- a", "any other change (a pasted link)");
  assert.ok(refusals >= 2);
  const writable = EditorState.create({ doc: "- a", selection: EditorSelection.cursor(3), extensions: [languageExtension("markdown", false), readOnlyGuard(() => assert.fail("not read-only"))] });
  assert.equal(writable.update({ changes: { from: 3, insert: "b" } }).state.doc.toString(), "- ab");
});

test("every bidi control and the word joiner show as special characters", () => {
  // CodeMirror's own list has U+202D, U+202E, U+2066, U+2067 and U+2069.
  for (const char of ["\u202a", "\u202b", "\u202c", "\u2068", "\u2060"]) assert.ok(EXTRA_SPECIAL_CHARS.test(char), char.codePointAt(0).toString(16));
  assert.equal(EXTRA_SPECIAL_CHARS.test("a \u00e9"), false);
});

test("a replaced text keeps positions outside the change", () => {
  const change = textChange("intro\nold line\noutro", "intro\nnew longer line\noutro");
  assert.equal(change.apply(EditorState.create({ doc: "intro\nold line\noutro" }).doc).toString(), "intro\nnew longer line\noutro");
  assert.equal(change.mapPos(3), 3, "before the change");
  assert.equal(change.mapPos(17), 17 + "new longer line".length - "old line".length, "after the change");
  assert.equal(textChange("same", "same").empty, true);
  assert.equal(textChange("", "added").apply(EditorState.create().doc).toString(), "added");
  assert.equal(textChange("aaa", "aa").length, 3, "a repeated character is not counted twice");
  assert.equal(textChange("aaa", "aa").apply(EditorState.create({ doc: "aaa" }).doc).toString(), "aa");
});

const base64 = (length) => "QUJD".repeat(Math.ceil(length / 4)).slice(0, length);
/** [from, to] of each folded payload in `state`. */
const folded = (state) => {
  const out = [];
  state.field(imageData).between(0, state.doc.length, (from, to) => { out.push([from, to]); });
  return out;
};

test("long base64 payloads of data URLs are folded; short ones and other text are not", () => {
  const payload = base64(FOLD_MIN_CHARS + 10);
  const doc = `# Note\n\n![shot](data:image/png;base64,${payload})\n![icon](data:image/png;base64,${base64(100)})\nplain ${base64(FOLD_MIN_CHARS * 2)}\n`;
  const state = EditorState.create({ doc, extensions: imageData });
  const start = doc.indexOf(";base64,") + ";base64,".length;
  assert.deepEqual(folded(state), [[start, start + payload.length]]);
  assert.deepEqual(payloadFolds(state.doc, 0, doc.length).length, 1);
  assert.equal(dataSize(4 * 1024 * 1024), "3.0 MB");
  assert.equal(dataSize(5000), "4 KB");
});

test("folds follow edits: kept elsewhere, found again on the edited line, gone when the data is", () => {
  const payload = base64(FOLD_MIN_CHARS);
  let state = EditorState.create({ doc: `intro\n![a](data:image/png;base64,${payload})\n`, extensions: imageData });
  const [[from, to]] = folded(state);
  state = state.update({ changes: { from: 0, insert: "more " } }).state;
  assert.deepEqual(folded(state), [[from + 5, to + 5]], "an edit on another line maps the fold");
  state = state.update({ changes: { from: state.doc.line(2).from + 2, insert: "alt" } }).state;
  assert.deepEqual(folded(state), [[from + 8, to + 8]], "an edit on its line finds it again");
  state = state.update({ changes: { from: from + 8 + 10, to: to + 8 } }).state;
  assert.deepEqual(folded(state), [], "too short to fold once cut");
  state = state.update({ changes: { from: state.doc.length, insert: `![b](data:image/gif;base64,${payload})` } }).state;
  assert.equal(folded(state).length, 1, "pasted image data folds");
});

test("a line too long to wrap is found, image data not counted", () => {
  const long = "x".repeat(LONG_LINE_CHARS);
  assert.equal(hasLongLine(EditorState.create({ doc: `a\n${long}\nb`, extensions: imageData })), true);
  assert.equal(hasLongLine(EditorState.create({ doc: `${"y".repeat(LONG_LINE_CHARS - 1)}\n${"z".repeat(LONG_LINE_CHARS - 1)}`, extensions: imageData })), false);
  const image = `![p](data:image/png;base64,${base64(LONG_LINE_CHARS + 10)})`;
  assert.equal(hasLongLine(EditorState.create({ doc: `text\n${image}\nmore`, extensions: imageData })), false, "folded data is not laid out");
  assert.equal(hasLongLine(EditorState.create({ doc: long, extensions: imageData })), true, "a single line");
});

test("folds and long lines are found at the right place in a document of many leaves", () => {
  const lines = Array.from({ length: 5000 }, (_, i) => `line ${i} with some ordinary text`);
  const payload = base64(FOLD_MIN_CHARS * 3);
  lines.splice(2500, 0, `![x](data:image/png;base64,${payload})`);
  lines.splice(4000, 0, "y".repeat(LONG_LINE_CHARS));
  const doc = lines.join("\n");
  const state = EditorState.create({ doc, extensions: imageData });
  assert.ok(state.doc.children, "a branch, not one leaf");
  const start = doc.indexOf(";base64,") + ";base64,".length;
  assert.deepEqual(folded(state), [[start, start + payload.length]]);
  assert.equal(hasLongLine(state), true);
  assert.equal(hasLongLine(EditorState.create({ doc: lines.filter((line) => line.length < LONG_LINE_CHARS).join("\n"), extensions: imageData })), false);
});

test("a kept document is compared with the opened text without copying it", () => {
  const text = Array.from({ length: 3000 }, (_, i) => `line ${i}`).join("\n");
  const doc = EditorState.create({ doc: text }).doc;
  assert.equal(holds(doc, text), true);
  assert.equal(holds(doc, `${text}x`), false, "longer");
  assert.equal(holds(doc, text.replace("line 2999", "line 2998")), false, "same length, other text");
  assert.equal(holds(doc, text.replace("\n", " ")), false, "a line break replaced");
  assert.equal(holds(EditorState.create().doc, ""), true);
});
