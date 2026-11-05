// Node 22.18+ strips the TypeScript types from the imported source file.
import assert from "node:assert/strict";
import { test } from "node:test";
import { lastAtOrBefore, lineForPreviewOffset, modeAfterFocus, previewOffsetForLine, toggledMode, viewKey } from "../../src/view-mode.ts";

const key = (key, keyCode, modifiers = {}) => ({ key, keyCode, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...modifiers });

test("F9 and Esc only without modifiers", () => {
  assert.equal(viewKey(key("F9", 120), true), "focus");
  assert.equal(viewKey(key("F9", 120), false), "focus");
  assert.equal(viewKey(key("F9", 120, { shiftKey: true }), true), null);
  assert.equal(viewKey(key("F9", 120, { metaKey: true }), true), null);
  assert.equal(viewKey(key("Escape", 27), true), "escape");
  assert.equal(viewKey(key("Escape", 27, { altKey: true }), true), null);
});

test("Cmd+Shift+V on macOS, Ctrl+Shift+V elsewhere", () => {
  assert.equal(viewKey(key("V", 86, { metaKey: true, shiftKey: true }), true), "read-write");
  assert.equal(viewKey(key("V", 86, { ctrlKey: true, shiftKey: true }), true), null, "Ctrl on macOS is not Cmd");
  assert.equal(viewKey(key("V", 86, { ctrlKey: true, shiftKey: true }), false), "read-write");
  assert.equal(viewKey(key("V", 86, { metaKey: true, shiftKey: true }), false), null);
  assert.equal(viewKey(key("v", 86, { metaKey: true }), true), null, "Cmd+V stays paste");
  assert.equal(viewKey(key("◊", 86, { metaKey: true, shiftKey: true, altKey: true }), true), null, "Option+Shift+Cmd+V stays Paste and Match Style");
  assert.equal(viewKey(key("М", 86, { metaKey: true, shiftKey: true }), true), "read-write", "the key printed V on a Cyrillic layout");
});

test("Open in new window: Cmd+Shift+O on macOS, Ctrl+Shift+O elsewhere", () => {
  assert.equal(viewKey(key("O", 79, { metaKey: true, shiftKey: true }), true), "new-window");
  assert.equal(viewKey(key("O", 79, { ctrlKey: true, shiftKey: true }), false), "new-window");
  assert.equal(viewKey(key("O", 79, { ctrlKey: true, shiftKey: true }), true), null);
  assert.equal(viewKey(key("o", 79, { metaKey: true }), true), null, "Cmd+O alone is not taken");
  assert.equal(viewKey(key("N", 78, { metaKey: true, shiftKey: true }), true), null, "Cmd+Shift+N stays New folder");
  assert.equal(viewKey(key("Ø", 79, { metaKey: true, shiftKey: true, altKey: true }), true), null);
});

test("reading and writing: Preview goes back to the last writing mode", () => {
  assert.equal(toggledMode("edit", "edit", false), "preview");
  assert.equal(toggledMode("split", "split", false), "preview");
  assert.equal(toggledMode("preview", "split", false), "split");
  assert.equal(toggledMode("preview", "edit", false), "edit");
});

test("in focus mode writing is the editor alone", () => {
  assert.equal(toggledMode("preview", "split", true), "edit");
  assert.equal(toggledMode("edit", "split", true), "preview");
});

test("leaving focus mode gives back the mode from before it", () => {
  assert.equal(modeAfterFocus("split", "preview", "split"), "split");
  assert.equal(modeAfterFocus("edit", "preview", "edit"), "edit");
  assert.equal(modeAfterFocus("split", "edit", "split"), "split", "writing in focus mode: Split again");
  assert.equal(modeAfterFocus("preview", "preview", "split"), "preview");
  assert.equal(modeAfterFocus("preview", "edit", "split"), "split", "entered reading, left writing: the last writing mode");
  assert.equal(modeAfterFocus("preview", "edit", "edit"), "edit");
});

test("reading position: headings are fixed points, linear in between", () => {
  // Headings at lines 1, 11 and 31 of 40 lines; in the preview at 0, 500 and 900 of 1200 px.
  const tops = [0, 500, 900];
  const track = { lines: [1, 11, 31], top: (index) => tops[index], lastLine: 40, height: 1200 };
  assert.equal(previewOffsetForLine(track, 11), 500);
  assert.equal(previewOffsetForLine(track, 21), 700, "halfway between two headings");
  assert.equal(previewOffsetForLine(track, 36), 900 + 300 * (5 / 10), "the last heading to the end");
  assert.equal(lineForPreviewOffset(track, 500), 11);
  assert.equal(lineForPreviewOffset(track, 700), 21);
  assert.equal(lineForPreviewOffset(track, 1200), 41, "the end is after the last line");
  // Round trip anywhere.
  for (const line of [1, 4.5, 11, 17.25, 30, 39]) assert.ok(Math.abs(lineForPreviewOffset(track, previewOffsetForLine(track, line)) - line) < 1e-9);
});

test("reading position: proportional without headings, and only O(log n) layout reads", () => {
  const plain = { lines: [], top: () => assert.fail("no headings to read"), lastLine: 99, height: 2000 };
  assert.equal(previewOffsetForLine(plain, 1), 0);
  assert.equal(previewOffsetForLine(plain, 50.5), 1000);
  assert.equal(lineForPreviewOffset(plain, 1000), 50.5);
  assert.equal(lineForPreviewOffset(plain, -20), 1, "clamped to the start");
  // 50,000 headings: a mapping reads about log2(n) + 2 offsets, not all of them.
  let reads = 0;
  const many = { lines: Array.from({ length: 50_000 }, (_, index) => index * 4 + 1), top: (index) => { reads++; return index * 60; }, lastLine: 200_000, height: 3_000_000 };
  assert.equal(previewOffsetForLine(many, 4 * 30_000 + 3), 30_000 * 60 + 30);
  assert.equal(lineForPreviewOffset(many, 30_000 * 60 + 30), 4 * 30_000 + 3);
  assert.ok(reads < 40, `${reads} reads`);
  assert.equal(lastAtOrBefore(0, () => 0, 5), -1);
  assert.equal(lastAtOrBefore(3, (index) => [2, 4, 6][index], 1), -1);
  assert.equal(lastAtOrBefore(3, (index) => [2, 4, 6][index], 4), 1);
  assert.equal(lastAtOrBefore(3, (index) => [2, 4, 6][index], 9), 2);
});
