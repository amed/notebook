// The WebView must never leave the app: links are opened only after the user
// confirms them, new windows are never created and dropped files never load.
// In the Markdown preview, `#heading` links scroll the preview and links to
// vault documents (`nb-doc:` / `nb-wiki:`, preview.rs) go to main.ts, which
// checks them against the tree; neither ever changes the WebView's URL.
import { DOC_LINK_SCHEME, fragmentIds, WIKI_LINK_SCHEME } from "./vault-links";

export const MAX_LINK_LENGTH = 2048;
const EXTERNAL_SCHEMES = new Set(["https:", "http:", "mailto:"]);
/** Room above a heading scrolled to the preview's top. */
const HEADING_MARGIN_PX = 16;

type ExternalLinkHandler = (url: string) => void;
type InternalLinkHandler = (href: string) => void;

let externalLinkHandler: ExternalLinkHandler | null = null;
let internalLinkHandler: InternalLinkHandler | null = null;
let installed = false;
let browserOpen: typeof window.open | null = null;

export function setExternalLinkHandler(handler: ExternalLinkHandler | null): void {
  externalLinkHandler = handler;
}

/** main.ts: follows `nb-doc:` / `nb-wiki:` links of the Markdown preview. */
export function setInternalLinkHandler(handler: InternalLinkHandler | null): void {
  internalLinkHandler = handler;
}

/** The normalized absolute URL when it uses an allowed external scheme, otherwise null. */
export function externalUrl(href: string): string | null {
  let url: URL;
  try {
    url = new URL(href.trim());
  } catch {
    return null;
  }
  return EXTERNAL_SCHEMES.has(url.protocol) ? url.href : null;
}

function linkFrom(event: Event): Element | null {
  for (const target of event.composedPath()) {
    if (target instanceof Element && target.matches("a[href], area[href]")) return target;
  }
  return null;
}

/**
 * The element of the preview `scope` a `#fragment` names: a generated
 * heading or footnote id, or the heading whose text it is (fragmentIds).
 * Only the preview is searched, so a fragment never reaches app elements.
 */
export function previewTarget(scope: Element, fragment: string): HTMLElement | null {
  const wanted = fragmentIds(fragment);
  if (!wanted.length) return null;
  const found = new Map<string, HTMLElement>();
  for (const element of scope.querySelectorAll<HTMLElement>("[id]")) {
    if (wanted.includes(element.id) && !found.has(element.id)) found.set(element.id, element);
  }
  for (const id of wanted) {
    const element = found.get(id);
    if (element) return element;
  }
  return null;
}

/**
 * Scrolls `pane` (and nothing around it) so `target` is at its top, with
 * a little room. At once: an animated scroll repaints a large preview for
 * every frame of the way (240 ms and 7 to 13 frames for a 500 KB document).
 */
export function scrollPaneTo(pane: HTMLElement, target: Element): void {
  const top = pane.scrollTop + target.getBoundingClientRect().top - pane.getBoundingClientRect().top - HEADING_MARGIN_PX;
  pane.scrollTop = Math.max(0, top);
}

/**
 * Like a native fragment link, lets the next Tab go on from `target` (the
 * link's default action, which would do that, is prevented): it takes the
 * focus, without scrolling, when the focus was in `pane` or nowhere — never
 * from the editor or the outline. Its tabindex lasts until it loses focus.
 */
export function focusPaneTarget(pane: HTMLElement, target: HTMLElement): void {
  const active = document.activeElement;
  if (active && active !== document.body && !pane.contains(active)) return;
  if (!target.hasAttribute("tabindex")) {
    target.setAttribute("tabindex", "-1");
    target.addEventListener("blur", () => target.removeAttribute("tabindex"), { once: true });
  }
  target.focus({ preventScroll: true });
}

function scrollToFragment(link: Element, href: string): void {
  const scope = link.closest<HTMLElement>(".preview");
  const target = scope ? previewTarget(scope, href.slice(1)) : null;
  if (!scope || !target) return;
  focusPaneTarget(scope, target);
  scrollPaneTo(scope, target);
}

function isInternalHref(href: string): boolean {
  return href.startsWith(DOC_LINK_SCHEME) || href.startsWith(WIKI_LINK_SCHEME);
}

function onLinkActivation(event: Event): void {
  if (event instanceof KeyboardEvent && event.key !== "Enter") return;
  const link = linkFrom(event);
  if (!link) return;
  event.preventDefault();
  // The native link menu offers "open in new window" and "download linked file".
  if (event.type === "contextmenu") return;
  if (event instanceof KeyboardEvent && event.repeat) return;
  if (event.type === "auxclick" && (event as MouseEvent).button !== 1) return;
  const href = link.getAttribute("href") ?? "";
  if (href.startsWith("#")) {
    scrollToFragment(link, href);
    return;
  }
  // Only the Markdown preview writes vault links; never external.
  if (isInternalHref(href)) {
    if (link.closest(".preview")) internalLinkHandler?.(href);
    return;
  }
  const url = externalUrl(href);
  if (url) externalLinkHandler?.(url);
}

/** Plain-browser preview only; the desktop app opens links through Rust. */
export function openInBrowserTab(url: string): void {
  browserOpen?.(url, "_blank", "noopener,noreferrer");
}

/** Plain-browser preview only: a document window of this app (the desktop app asks Rust). */
export function openAppWindow(url: string): void {
  browserOpen?.(url, "_blank", "popup,width=860,height=900,noopener");
}

export function installNavigationGuards(): void {
  if (installed) return;
  installed = true;
  for (const type of ["click", "auxclick", "keydown", "contextmenu"]) {
    document.addEventListener(type, onLinkActivation, { capture: true });
  }

  if (!("__TAURI_INTERNALS__" in window)) browserOpen = window.open.bind(window);
  const blockedOpen = (): null => null;
  try {
    Object.defineProperty(window, "open", { value: blockedOpen, writable: false, configurable: false });
  } catch {
    window.open = blockedOpen;
  }

  // In-page targets can import supported files or move tree rows. Anything
  // they do not accept is refused so the WebView itself never loads a drop.
  window.addEventListener("dragover", (event) => {
    if (event.defaultPrevented) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "none";
  });
  // Text dropped on the editor's text is the editor's to insert or move (it
  // refuses the rest itself, editor/editor.ts); it never loads a page.
  window.addEventListener("drop", (event) => {
    const editorText = event.target instanceof Element && event.target.closest(".cm-content") !== null;
    if (!editorText || event.dataTransfer?.types.includes("Files")) event.preventDefault();
  }, { capture: true });
}
