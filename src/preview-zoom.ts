// Content zoom: the text size of what is shown, the editor and the preview
// (Markdown, plain text and HTML pages) together, in every mode and window.
// One global level kept with the pane sizes (config.json
// "layout".preview_zoom, src-tauri/src/notebook/layout.rs; the range
// matches). Cmd/Ctrl+= (or +), Cmd/Ctrl+- and Cmd/Ctrl+0; the level shows
// for a moment. Pure, so tests/unit can run it; main.ts and html-preview.ts
// apply the level.

/** Percent. Zooming in or out moves to the next step. */
export const ZOOM_STEPS = [50, 67, 80, 90, 100, 110, 125, 150, 175, 200] as const;
export const ZOOM = { min: 50, max: 200, default: 100 } as const;
export type ZoomKey = "in" | "out" | "reset";

interface ZoomKeyEvent {
  key: string;
  keyCode: number;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
}

/**
 * Cmd (Ctrl off macOS) with =, + or the keypad's +; with - or the keypad's
 * -; with 0 or the keypad's 0. keyCode 48 and 96 keep Cmd+0 on layouts
 * whose unshifted key there is not a digit (AZERTY's "à").
 */
export function zoomKey(event: ZoomKeyEvent, mac: boolean): ZoomKey | null {
  const command = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!command || event.altKey) return null;
  if (event.key === "=" || event.key === "+" || event.keyCode === 107) return "in";
  if (event.key === "-" || event.keyCode === 109) return "out";
  if (event.key === "0" || event.keyCode === 48 || event.keyCode === 96) return "reset";
  return null;
}

/** The level after `key`: the next step up or down (from a level between steps too), or 100%. */
export function zoomed(level: number, key: ZoomKey): number {
  if (key === "reset") return ZOOM.default;
  if (key === "in") return ZOOM_STEPS.find((step) => step > level) ?? ZOOM.max;
  return [...ZOOM_STEPS].reverse().find((step) => step < level) ?? ZOOM.min;
}

/** `config_get`'s `layout.preview_zoom`; a missing, mistyped or out-of-range value is 100%. */
export function zoomFromWire(layout: unknown): number {
  const value = layout && typeof layout === "object" ? (layout as { preview_zoom?: unknown }).preview_zoom : undefined;
  return typeof value === "number" && Number.isInteger(value) && value >= ZOOM.min && value <= ZOOM.max ? value : ZOOM.default;
}
