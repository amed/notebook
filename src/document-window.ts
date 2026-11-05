// Document windows (spec D, window.rs): "Open in new window" shows one
// document in a window of its own, in focus mode, which writes it while the
// main window shows it read-only. Pure, so tests/unit can run it; main.ts
// applies the result.

/** Ids are path-derived hashes ("n-" and 64 hex digits); anything far longer is not one. */
const MAX_ID_LENGTH = 256;

/**
 * `index.html?window=document&id=…` (window.rs builds it URL-encoded): the
 * page is a document window. The id only says what to show while the page
 * starts; Rust answers by the window's label (`document_window_info`), and
 * that answer is what the window shows and writes. Null in the main window;
 * an unusable id is "".
 */
export function documentWindowRequest(search: string): { id: string } | null {
  const params = new URLSearchParams(search);
  if (params.get("window") !== "document") return null;
  const id = params.get("id") ?? "";
  return { id: id.length <= MAX_ID_LENGTH ? id : "" };
}

/** Browser mode only: the URL of a document window (the app's come from Rust). */
export function documentWindowUrl(id: string): string {
  return `index.html?${new URLSearchParams({ window: "document", id })}`;
}

/** What a document window says, with a Close button, when it has nothing to show. */
export function documentWindowProblem(code: string | null): { title: string; detail: string } {
  switch (code) {
    case "LOCKED":
    case "WINDOW_STALE":
      return {
        title: "Workspace locked",
        detail: "This window belonged to a workspace session that has ended. Unlock the workspace and open the document again.",
      };
    case "INVALID_INPUT":
      return {
        title: "Document not found",
        detail: "This document no longer exists here. It may have been renamed, moved or deleted.",
      };
    default:
      return {
        title: "Document not opened",
        detail: "This window could not open its document. Close it and open the document again from the main window.",
      };
  }
}

/** The note the main window shows on a document another window writes. */
export const EDITING_ELSEWHERE = "Editing in another window";
/** The editor's note when someone types into that read-only document. */
export const EDITING_ELSEWHERE_HINT = "This document is being edited in another window. Close that window to edit it here.";
