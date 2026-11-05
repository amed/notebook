// Node 22.18+ strips the TypeScript types from the imported source file.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_LAYOUT,
  MIN_CONTENT,
  MIN_PANE,
  OUTLINE_WIDTH,
  SIDEBAR_WIDTH,
  SPLIT_RATIO,
  layoutFromWire,
  layoutToWire,
  resolveLayout,
} from "../../src/panel-layout.ts";

const wide = { viewport: 1280, outline: false, split: true };

test("a roomy window shows the saved sizes unchanged", () => {
  const layout = { sidebarWidth: 333, outlineWidth: 201, splitRatio: 0.62 };
  const resolved = resolveLayout(layout, { ...wide, outline: true });
  assert.equal(resolved.sidebar, 333);
  assert.equal(resolved.outline, 201);
  assert.equal(resolved.ratio, 0.62);
  assert.equal(resolved.panes, 1280 - 333 - 201);
});

test("sizes stay inside their ranges", () => {
  const huge = resolveLayout({ sidebarWidth: 9999, outlineWidth: 9999, splitRatio: 5 }, { ...wide, viewport: 4000, outline: true });
  assert.equal(huge.sidebar, SIDEBAR_WIDTH.max);
  assert.equal(huge.outline, OUTLINE_WIDTH.max);
  assert.equal(huge.ratio, SPLIT_RATIO.max);
  const tiny = resolveLayout({ sidebarWidth: 0, outlineWidth: 0, splitRatio: 0 }, { ...wide, viewport: 4000, outline: true });
  assert.equal(tiny.sidebar, SIDEBAR_WIDTH.min);
  assert.equal(tiny.outline, OUTLINE_WIDTH.min);
  assert.equal(tiny.ratio, SPLIT_RATIO.min);
});

test("each Split pane keeps 240 px: the ratio range narrows with the room", () => {
  const resolved = resolveLayout({ ...DEFAULT_LAYOUT, splitRatio: 0.8 }, { ...wide, viewport: 1000 });
  // 1000 - 280 = 720 px for both panes: the editor may take at most 480.
  assert.equal(resolved.panes, 720);
  assert.equal(resolved.limits.ratio.max, 1 - MIN_PANE / 720);
  assert.ok(Math.round(resolved.panes * (1 - resolved.ratio)) >= MIN_PANE);
});

test("a shrinking window squeezes the outline first, then the sidebar, never the panes", () => {
  const layout = { sidebarWidth: 420, outlineWidth: 400, splitRatio: 0.5 };
  // 1100: the sidebar keeps 420, the outline gives way.
  let resolved = resolveLayout(layout, { ...wide, viewport: 1100, outline: true });
  assert.equal(resolved.sidebar, 420);
  assert.equal(resolved.outline, 1100 - 420 - (MIN_PANE * 2 + 1));
  // 900: the outline is at its minimum and the sidebar gives way.
  resolved = resolveLayout(layout, { ...wide, viewport: 900, outline: true });
  assert.equal(resolved.outline, OUTLINE_WIDTH.min);
  assert.equal(resolved.sidebar, 900 - OUTLINE_WIDTH.min - (MIN_PANE * 2 + 1));
  assert.ok(resolved.panes >= MIN_PANE * 2);
  for (let viewport = 851; viewport <= 2000; viewport += 7) {
    for (const outline of [false, true]) {
      for (const split of [false, true]) {
        const fit = resolveLayout({ sidebarWidth: 480, outlineWidth: 420, splitRatio: 0.8 }, { viewport, outline, split });
        const content = viewport - fit.sidebar;
        assert.ok(content >= MIN_CONTENT, `${viewport}: content ${content}`);
        const panes = content - (outline ? fit.outline : 0);
        assert.equal(fit.panes, panes);
        if (split) {
          assert.ok(panes * fit.ratio >= MIN_PANE - 0.5 && panes * (1 - fit.ratio) >= MIN_PANE - 0.5, `${viewport}: ${fit.ratio} of ${panes}`);
        } else {
          assert.ok(panes >= MIN_PANE, `${viewport}: ${panes}`);
        }
      }
    }
  }
});

test("narrow windows (820 wide) stack Split, keep the header's room and a visible editor beside the drawer", () => {
  const fit = resolveLayout({ sidebarWidth: 480, outlineWidth: 420, splitRatio: 0.8 }, { viewport: 820, outline: true, split: true });
  // The content keeps what Split and the outline need side by side: the sidebar gives way to its minimum.
  assert.equal(fit.sidebar, SIDEBAR_WIDTH.min);
  // The drawer does not take a column: the stacked panes keep the whole content width,
  assert.equal(fit.panes, 820 - SIDEBAR_WIDTH.min);
  // and the drawer over them leaves MIN_PANE of the editor visible.
  assert.equal(fit.outline, 820 - SIDEBAR_WIDTH.min - MIN_PANE);
  // Stacked, the ratio shares no width: the saved one is kept for the next wide window.
  assert.equal(fit.ratio, 0.8);
  assert.deepEqual(fit.limits.ratio, { min: SPLIT_RATIO.min, max: SPLIT_RATIO.max });
  // Edit with the drawer: the sidebar leaves the outline's minimum plus one pane.
  const edit = resolveLayout({ sidebarWidth: 480, outlineWidth: 420, splitRatio: 0.8 }, { viewport: 820, outline: true, split: false });
  assert.equal(edit.sidebar, 820 - (OUTLINE_WIDTH.min + MIN_PANE));
  assert.equal(edit.outline, OUTLINE_WIDTH.min);
  assert.ok(edit.panes - edit.outline >= MIN_PANE);
  const plain = resolveLayout({ sidebarWidth: 480, outlineWidth: 420, splitRatio: 0.8 }, { viewport: 820, outline: false, split: false });
  assert.equal(plain.sidebar, 820 - MIN_CONTENT);
});

test("crossing the narrow breakpoint moves no pane by more than the window did", () => {
  const saved = { sidebarWidth: 480, outlineWidth: 420, splitRatio: 0.8 };
  for (const outline of [false, true]) {
    for (const split of [false, true]) {
      let previous = null;
      for (let viewport = 820; viewport <= 900; viewport++) {
        const fit = resolveLayout(saved, { viewport, outline, split });
        if (previous) {
          assert.ok(Math.abs(fit.sidebar - previous.sidebar) <= 1, `${viewport} ${outline} ${split}: sidebar ${previous.sidebar} -> ${fit.sidebar}`);
        }
        // Whatever the width, a drawer or a column, the editor keeps MIN_PANE visible.
        const content = viewport - fit.sidebar;
        if (outline) assert.ok(content - fit.outline >= MIN_PANE, `${viewport} ${split}: ${content} - ${fit.outline}`);
        previous = fit;
      }
    }
  }
});

test("config_get's layout is read leniently and layout_set gets clean values", () => {
  assert.deepEqual(layoutFromWire(undefined), DEFAULT_LAYOUT);
  assert.deepEqual(layoutFromWire({ sidebar_width: 300 }), { ...DEFAULT_LAYOUT, sidebarWidth: 300 });
  assert.deepEqual(layoutFromWire({ sidebar_width: 99, outline_width: "x", split_ratio: 0.9 }), DEFAULT_LAYOUT);
  assert.deepEqual(layoutFromWire({ sidebar_width: 300.5, outline_width: 200, split_ratio: 0.25 }), { sidebarWidth: 280, outlineWidth: 200, splitRatio: 0.25 });
  assert.deepEqual(layoutToWire({ sidebarWidth: 300.4, outlineWidth: 1000, splitRatio: 0.123456 }), {
    sidebar_width: 300,
    outline_width: OUTLINE_WIDTH.max,
    split_ratio: SPLIT_RATIO.min,
  });
  assert.deepEqual(layoutToWire({ sidebarWidth: 280, outlineWidth: 240, splitRatio: 0.612345 }), { sidebar_width: 280, outline_width: 240, split_ratio: 0.6123 });
});
