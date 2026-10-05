/**
 * Pane sizes: the sidebar and outline widths (CSS pixels) and the editor's
 * share of Split. The ranges match src-tauri/src/notebook/layout.rs, which
 * keeps the user's values in config.json; resolveLayout() fits them into the
 * current window, so a narrower window shrinks panes without changing what
 * was saved. Pure: it reads no layout and touches no DOM.
 */

export interface PanelLayout {
  sidebarWidth: number;
  outlineWidth: number;
  /** The editor's fraction of the editor and preview in Split. */
  splitRatio: number;
}

/** `config_get`'s `layout` and `layout_set`'s arguments. */
export interface PanelLayoutWire {
  sidebar_width: number;
  outline_width: number;
  split_ratio: number;
}

export interface Range {
  min: number;
  max: number;
}

export const SIDEBAR_WIDTH = { min: 180, max: 480, default: 280 } as const;
/** 180: the outline's header still fits Expand, Collapse and its close button. */
export const OUTLINE_WIDTH = { min: 180, max: 420, default: 240 } as const;
export const SPLIT_RATIO = { min: 0.2, max: 0.8, default: 0.5 } as const;
export const DEFAULT_LAYOUT: Readonly<PanelLayout> = Object.freeze({
  sidebarWidth: SIDEBAR_WIDTH.default,
  outlineWidth: OUTLINE_WIDTH.default,
  splitRatio: SPLIT_RATIO.default,
});

/** The least width of the editor and of the preview in Split. */
export const MIN_PANE = 240;
/** The least width of the content column: the header's breadcrumb and buttons. */
export const MIN_CONTENT = 400;
/**
 * At or below this window width Split stacks and the outline is a drawer
 * (theme.css, `@media (max-width: 850px)`). Compared with window.innerWidth,
 * not read from matchMedia: WebKit answers a resize event with the previous
 * size's matches.
 */
export const NARROW_MAX_WIDTH = 850;
const DIVIDER = 1;
/** Arrow keys move a handle this far; with Shift, BIG_STEP. */
export const STEP = 16;
export const BIG_STEP = 64;

export interface LayoutContext {
  /** window.innerWidth; at NARROW_MAX_WIDTH or less Split stacks and the outline is a drawer over the editor. */
  viewport: number;
  outline: boolean;
  split: boolean;
}

export interface ResolvedLayout {
  sidebar: number;
  outline: number;
  ratio: number;
  /** The editor plus the preview in Split, in pixels: ratio steps are pixels over this. */
  panes: number;
  limits: { sidebar: Range; outline: Range; ratio: Range };
}

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/**
 * The widths the window can show. Priority, when room runs out: the editor
 * and preview keep MIN_PANE each, then the outline gives way down to its
 * minimum, then the sidebar down to its minimum.
 */
export function resolveLayout(layout: PanelLayout, context: LayoutContext): ResolvedLayout {
  const narrow = context.viewport <= NARROW_MAX_WIDTH;
  const sideBySide = context.split && !narrow;
  const outlineTrack = context.outline && !narrow;
  // The content's least width does not depend on the narrow breakpoint, so
  // the sidebar never jumps when the window crosses it: what Split and the
  // outline need side by side, they keep when stacked and as a drawer.
  const panesMin = context.split ? MIN_PANE * 2 + DIVIDER : MIN_PANE;
  const contentMin = Math.max(MIN_CONTENT, (context.outline ? OUTLINE_WIDTH.min : 0) + panesMin);
  const sidebarLimit = { min: SIDEBAR_WIDTH.min, max: clamp(Math.floor(context.viewport - contentMin), SIDEBAR_WIDTH.min, SIDEBAR_WIDTH.max) };
  const sidebar = Math.round(clamp(layout.sidebarWidth, sidebarLimit.min, sidebarLimit.max));
  const content = Math.max(0, context.viewport - sidebar);
  // The drawer (narrow) covers the editor but leaves MIN_PANE of it visible.
  const outlineRoom = Math.floor(content - (narrow ? MIN_PANE : panesMin));
  const outlineLimit = { min: OUTLINE_WIDTH.min, max: clamp(outlineRoom, OUTLINE_WIDTH.min, OUTLINE_WIDTH.max) };
  const outline = Math.round(clamp(layout.outlineWidth, outlineLimit.min, outlineLimit.max));
  const panes = Math.max(1, content - (outlineTrack ? outline : 0));
  // Only side by side does the ratio share a width; stacked or hidden it keeps its range.
  let ratioMin = sideBySide ? Math.max(SPLIT_RATIO.min, MIN_PANE / panes) : SPLIT_RATIO.min;
  let ratioMax = sideBySide ? Math.min(SPLIT_RATIO.max, 1 - MIN_PANE / panes) : SPLIT_RATIO.max;
  if (ratioMin > ratioMax) ratioMin = ratioMax = clamp(0.5, SPLIT_RATIO.min, SPLIT_RATIO.max);
  const ratio = roundRatio(clamp(layout.splitRatio, ratioMin, ratioMax));
  return {
    sidebar,
    outline,
    ratio,
    panes,
    limits: { sidebar: sidebarLimit, outline: outlineLimit, ratio: { min: ratioMin, max: ratioMax } },
  };
}

/** `config_get`'s layout; a missing, mistyped or out-of-range value is the default. */
export function layoutFromWire(raw: unknown): PanelLayout {
  const record = raw && typeof raw === "object" ? (raw as Partial<Record<keyof PanelLayoutWire, unknown>>) : {};
  const pick = (value: unknown, range: { min: number; max: number; default: number }, integer: boolean): number =>
    typeof value === "number" && Number.isFinite(value) && (!integer || Number.isInteger(value)) && value >= range.min && value <= range.max
      ? value
      : range.default;
  return {
    sidebarWidth: pick(record.sidebar_width, SIDEBAR_WIDTH, true),
    outlineWidth: pick(record.outline_width, OUTLINE_WIDTH, true),
    splitRatio: pick(record.split_ratio, SPLIT_RATIO, false),
  };
}

/** `layout_set`'s arguments: whole pixels and a ratio of four decimals, inside the ranges Rust accepts. */
export function layoutToWire(layout: PanelLayout): PanelLayoutWire {
  return {
    sidebar_width: Math.round(clamp(layout.sidebarWidth, SIDEBAR_WIDTH.min, SIDEBAR_WIDTH.max)),
    outline_width: Math.round(clamp(layout.outlineWidth, OUTLINE_WIDTH.min, OUTLINE_WIDTH.max)),
    split_ratio: roundRatio(clamp(layout.splitRatio, SPLIT_RATIO.min, SPLIT_RATIO.max)),
  };
}

export function sameLayout(left: PanelLayout, right: PanelLayout): boolean {
  return left.sidebarWidth === right.sidebarWidth && left.outlineWidth === right.outlineWidth && left.splitRatio === right.splitRatio;
}

function roundRatio(ratio: number): number {
  return Math.round(ratio * 10_000) / 10_000;
}
