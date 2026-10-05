// The WebView must never leave the app: links are opened only after the user
// confirms them, new windows are never created and dropped files never load.

export const MAX_LINK_LENGTH = 2048;
const EXTERNAL_SCHEMES = new Set(["https:", "http:", "mailto:"]);

type ExternalLinkHandler = (url: string) => void;

let externalLinkHandler: ExternalLinkHandler | null = null;
let installed = false;
let browserOpen: typeof window.open | null = null;

export function setExternalLinkHandler(handler: ExternalLinkHandler | null): void {
  externalLinkHandler = handler;
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

function scrollToFragment(link: Element, href: string): void {
  let id: string;
  try {
    id = decodeURIComponent(href.slice(1));
  } catch {
    return;
  }
  const scope = link.closest(".preview");
  const target = id ? document.getElementById(id) : null;
  if (scope && target && scope.contains(target)) target.scrollIntoView({ block: "start" });
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
  const url = externalUrl(href);
  if (url) externalLinkHandler?.(url);
}

/** Plain-browser preview only; the desktop app opens links through Rust. */
export function openInBrowserTab(url: string): void {
  browserOpen?.(url, "_blank", "noopener,noreferrer");
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
  window.addEventListener("drop", (event) => event.preventDefault(), { capture: true });
}
