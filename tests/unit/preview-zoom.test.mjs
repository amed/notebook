// Node 22.18+ strips the TypeScript types from the imported source file.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ZOOM, ZOOM_STEPS, zoomed, zoomFromWire, zoomKey } from "../../src/preview-zoom.ts";

const key = (key, keyCode, modifiers = {}) => ({ key, keyCode, metaKey: false, ctrlKey: false, altKey: false, ...modifiers });
const cmd = { metaKey: true };
const ctrl = { ctrlKey: true };

test("Cmd on macOS and Ctrl elsewhere zoom with =, +, - and 0", () => {
  assert.equal(zoomKey(key("=", 187, cmd), true), "in");
  assert.equal(zoomKey(key("+", 187, cmd), true), "in", "Cmd+Shift+= and layouts with a + key");
  assert.equal(zoomKey(key("+", 107, cmd), true), "in", "keypad +");
  assert.equal(zoomKey(key("-", 189, cmd), true), "out");
  assert.equal(zoomKey(key("-", 109, cmd), true), "out", "keypad -");
  assert.equal(zoomKey(key("0", 48, cmd), true), "reset");
  assert.equal(zoomKey(key("à", 48, cmd), true), "reset", "AZERTY's 0 key");
  assert.equal(zoomKey(key("0", 96, cmd), true), "reset", "keypad 0");
  assert.equal(zoomKey(key("=", 187, ctrl), false), "in");
  assert.equal(zoomKey(key("-", 189, ctrl), false), "out");
  assert.equal(zoomKey(key("0", 48, ctrl), false), "reset");
});

test("other modifiers and plain keys are not zoom keys", () => {
  assert.equal(zoomKey(key("=", 187), true), null, "typing = in a field");
  assert.equal(zoomKey(key("=", 187, ctrl), true), null, "Ctrl on macOS is not Cmd");
  assert.equal(zoomKey(key("=", 187, cmd), false), null, "Meta off macOS is not Ctrl");
  assert.equal(zoomKey(key("=", 187, { metaKey: true, ctrlKey: true }), true), null);
  assert.equal(zoomKey(key("≠", 187, { metaKey: true, altKey: true }), true), null);
  assert.equal(zoomKey(key("_", 189, { metaKey: true }), true), null, "Cmd+Shift+- is not zoom out");
  assert.equal(zoomKey(key("s", 83, cmd), true), null);
});

test("zoom steps from 50% to 200%, also from a level between steps", () => {
  assert.deepEqual([...ZOOM_STEPS], [50, 67, 80, 90, 100, 110, 125, 150, 175, 200]);
  assert.equal(zoomed(100, "in"), 110);
  assert.equal(zoomed(100, "out"), 90);
  assert.equal(zoomed(175, "in"), 200);
  assert.equal(zoomed(200, "in"), 200);
  assert.equal(zoomed(67, "out"), 50);
  assert.equal(zoomed(50, "out"), 50);
  assert.equal(zoomed(120, "in"), 125);
  assert.equal(zoomed(120, "out"), 110);
  assert.equal(zoomed(175, "reset"), 100);
  let level = ZOOM.default;
  const seen = [];
  for (let i = 0; i < 12; i++) seen.push((level = zoomed(level, "in")));
  assert.deepEqual(seen.slice(0, 6), [110, 125, 150, 175, 200, 200]);
});

test("config_get's preview_zoom is read leniently", () => {
  assert.equal(zoomFromWire(undefined), 100);
  assert.equal(zoomFromWire({}), 100);
  assert.equal(zoomFromWire({ preview_zoom: 150 }), 150);
  assert.equal(zoomFromWire({ preview_zoom: 120 }), 120, "a level between steps stays");
  assert.equal(zoomFromWire({ preview_zoom: 49 }), 100);
  assert.equal(zoomFromWire({ preview_zoom: 201 }), 100);
  assert.equal(zoomFromWire({ preview_zoom: 1.5 }), 100);
  assert.equal(zoomFromWire({ preview_zoom: "150" }), 100);
  assert.equal(zoomFromWire("wide"), 100);
});

test("one content zoom scales the editor and the preview alike (theme.css)", () => {
  const css = readFileSync(new URL("../../src/theme.css", import.meta.url), "utf8");
  const rule = (selector) => css.match(new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{([^}]*)\\}`))?.[1] ?? "";
  // The editor's text and readable column, in both typographies.
  assert.match(rule(".editor-host .cm-editor"), /font-size: calc\(var\(--font-text-size\) \* var\(--content-zoom, 1\)\)/);
  assert.match(css, /\.cm-lang-html \{[^}]*font-size: calc\(var\(--font-code-editor-size\) \* var\(--content-zoom, 1\)\)/);
  assert.match(rule(".editor-host .cm-editor .cm-content"), /var\(--file-line-width\) \* var\(--content-zoom, 1\)/);
  // The Markdown preview's text and column, and the plain-text preview.
  assert.match(rule(".preview"), /font-size: calc\(var\(--font-text-size\) \* var\(--content-zoom, 1\)\)/);
  assert.match(rule(".preview"), /var\(--file-line-width\) \* var\(--content-zoom, 1\)/);
  assert.match(rule(".preview > .plain-preview"), /var\(--content-zoom, 1\)/);
  // No second level and no permanent control; the level shows briefly and never takes the pointer.
  assert.doesNotMatch(css, /--preview-zoom|\.preview-zoom/);
  assert.match(rule(".zoom-indicator"), /pointer-events: none/);
  assert.match(rule(".zoom-indicator"), /opacity: 0/);
});
