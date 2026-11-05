// The view's keyboard rules: focus mode (F9), reading / writing
// (Cmd+Shift+V on macOS, Ctrl+Shift+V elsewhere) and Open in new window
// (Cmd+Shift+O / Ctrl+Shift+O; Cmd+Shift+N is New folder). Pure, so
// tests/unit can run it; main.ts applies the result.

/** Edit (editor), Split (editor and preview) or Preview (reading). */
export type PreviewMode = "edit" | "split" | "preview";
export type WritingMode = Exclude<PreviewMode, "preview">;
type ViewKey = "focus" | "read-write" | "new-window" | "escape";

interface ViewKeyEvent {
  key: string;
  keyCode: number;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/**
 * F9 toggles focus mode and Esc leaves it (both without modifiers);
 * Cmd+Shift+V (Ctrl+Shift+V off macOS) toggles reading and writing, and
 * Cmd+Shift+O (Ctrl+Shift+O) opens the document in a new window.
 * keyCode, like Alt+Z: it follows the layout, so V is the key printed V,
 * also on layouts whose `key` is not a Latin letter.
 */
export function viewKey(event: ViewKeyEvent, mac: boolean): ViewKey | null {
  const modified = event.metaKey || event.ctrlKey || event.altKey || event.shiftKey;
  if (event.key === "F9" && !modified) return "focus";
  if (event.key === "Escape" && !modified) return "escape";
  const command = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!command || !event.shiftKey || event.altKey) return null;
  if (event.keyCode === 86) return "read-write";
  if (event.keyCode === 79) return "new-window";
  return null;
}

/**
 * Cmd+Shift+V: Edit and Split go to Preview; Preview goes back to the last
 * writing mode. In focus mode writing is the editor alone (no Split).
 */
export function toggledMode(mode: PreviewMode, writing: WritingMode, focus: boolean): PreviewMode {
  if (mode !== "preview") return "preview";
  return focus ? "edit" : writing;
}

/**
 * Leaving focus mode gives back the mode from before it. Only a reader who
 * ends focus mode writing, after entering it from Preview, gets the last
 * writing mode instead, so the editor they typed in stays.
 */
export function modeAfterFocus(before: PreviewMode, inFocus: PreviewMode, writing: WritingMode): PreviewMode {
  if (inFocus === "preview" || before !== "preview") return before;
  return writing;
}

// Reading position across the editor and the preview (Cmd+Shift+V, F9).
// The editor scrolls by source line, the preview by pixels; headings found
// in both are the fixed points between them, linear in between, and the
// document's start (line 1, offset 0) and end (after the last line, the
// preview's full height) close the ends. Without matching headings (HTML,
// plain text, or a renderer that saw other headings) the mapping is
// proportional. `top(i)` reads heading i's preview offset (a layout read),
// so only the two headings around the position are read: O(log n).

/** The source lines of the headings (ascending) and how to read their preview offsets. */
export interface HeadingTrack {
  lines: readonly number[];
  top(index: number): number;
  /** The source's last line number. */
  lastLine: number;
  /** The preview's full content height. */
  height: number;
}

/** The last index whose value is at most `target` (-1 when none is), for ascending values. */
export function lastAtOrBefore(count: number, valueAt: (index: number) => number, target: number): number {
  let low = 0;
  let high = count - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (valueAt(middle) <= target) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found;
}

/** The anchors around index `before` (-1: the document's start). */
function around(track: HeadingTrack, before: number): { line: [number, number]; top: [number, number] } {
  const count = track.lines.length;
  const fromLine = before < 0 ? 1 : track.lines[before]!;
  const fromTop = before < 0 ? 0 : track.top(before);
  const toLine = before + 1 < count ? track.lines[before + 1]! : track.lastLine + 1;
  const toTop = before + 1 < count ? track.top(before + 1) : track.height;
  return { line: [fromLine, toLine], top: [fromTop, Math.max(fromTop, toTop)] };
}

function between(value: number, [from, to]: [number, number], [start, end]: [number, number]): number {
  const span = to - from;
  const share = span > 0 ? Math.min(1, Math.max(0, (value - from) / span)) : 0;
  return start + (end - start) * share;
}

/** The preview offset showing source line `line` (fractional, 1-based). */
export function previewOffsetForLine(track: HeadingTrack, line: number): number {
  const before = lastAtOrBefore(track.lines.length, (index) => track.lines[index]!, line);
  const anchors = around(track, before);
  return between(line, anchors.line, anchors.top);
}

/** The source line (fractional, 1-based) shown at preview offset `offset`. */
export function lineForPreviewOffset(track: HeadingTrack, offset: number): number {
  const before = lastAtOrBefore(track.lines.length, (index) => track.top(index), offset);
  const anchors = around(track, before);
  return between(offset, anchors.top, anchors.line);
}
