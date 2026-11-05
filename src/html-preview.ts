// HTML documents render as static pages in one sandboxed frame per preview
// pane, reused for every render (DECISIONS.md, "Product behavior").
// - The frame loads the static same-origin public/preview.html, which the
//   navigation guard allows, so `#id` links scroll natively inside the page.
//   Its deny-by-default policy <meta> is in force before any page markup is
//   inserted, and stays in force when a whole-page swap removes the <meta>.
// - The sandbox has no allow-scripts: nothing in the page runs, and WebKit
//   never calls listeners the parent adds to the frame's document. Web and
//   mail links therefore point at `preview.html?open=<url>`: the click reloads
//   the frame (the app CSP blocks any other frame destination), and the
//   parent's `load` listener repaints and asks the app to confirm the link.
// - Every frame `load` repaints, so a frame navigated anywhere heals itself.
// - Unchanged text is a no-op; edits keep the scroll position and replace only
//   the changed top-level body children; another document starts at the top.
// - Scrollbars. The frame does not load theme.css, and WebKit draws a frame
//   whose page has no scrollbar styles with the <iframe> element's, that is
//   the app theme's: in dark mode a white thumb on the white page, so no
//   scrollbar could be seen. Every paint puts the app's scrollbar style, built
//   from the theme.css tokens, first in the page's <head> (the page's own
//   scrollbar styles still win): the track on the page's background, the
//   thumb in an ink that contrasts with it. A whole-page swap keeps the
//   frame's <html>, <head> and <body> elements: WebKit ties a frame's styled
//   scrollbar to the element that styled it, and once that element was
//   replaced it drew no scrollbar at all.
// - Zoom (preview-zoom.ts) is CSS `zoom` on the page's root, in the same
//   style element: the text stays crisp and re-flows, and changing it rewrites
//   one rule, never the page.
// - Removed scripts are counted for the status bar (`onScripts`), not shown
//   in the pane.

import { externalUrl, MAX_LINK_LENGTH } from "./navigation";
import { parseCssColor } from "./theme";

export const SAFE_IMAGE_SRC = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
const FRAME_URL = "preview.html";
const OPEN = "open";
// Active or request-bearing elements. SVG and MathML stay: they are static in a
// script-less frame. SMIL elements go because they can rewrite href at run time.
const STRIP =
  "script, iframe, frame, frameset, object, embed, applet, portal, base, link, meta, template, foreignObject, set, animate, animateMotion, animateTransform, discard";
const URL_ATTRIBUTES = new Set([
  "action", "background", "cite", "codebase", "data", "formaction", "href", "longdesc",
  "manifest", "ping", "poster", "src", "srcset", "usemap", "xlink:href",
]);
const FRAGMENT = /^#[A-Za-z0-9_.:-]*$/;
const JS_TYPE = /^(?:module|(?:text|application)\/(?:x-)?(?:java|ecma)script)$/i;

const linkHref = (url: string): string => `${FRAME_URL}?${OPEN}=${encodeURIComponent(url)}`;

/**
 * Parses `source` without running anything and removes everything that could
 * run, load or navigate. Kept: inline CSS, `data:` raster images, SVG, MathML,
 * `#id` links, and web or mail links (rewritten, see the header comment).
 * `scripts` counts the executable scripts that were removed.
 */
function sanitizeHtmlPage(source: string): { page: Document; scripts: number } {
  const page = new DOMParser().parseFromString(source, "text/html");
  let scripts = 0;
  for (const script of page.getElementsByTagName("script")) {
    const type = script.getAttribute("type")?.trim() ?? "";
    if (!type || JS_TYPE.test(type)) scripts++;
  }
  page.querySelectorAll(STRIP).forEach((element) => element.remove());
  for (const element of page.querySelectorAll("*")) {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith("on") || name === "autofocus" || name === "download" || name === "target") {
        element.removeAttribute(attribute.name);
        continue;
      }
      if (!URL_ATTRIBUTES.has(name)) continue;
      const value = attribute.value.trim();
      const href = name === "href" || name === "xlink:href";
      if (href && FRAGMENT.test(value)) continue;
      if (element.localName === "img" && name === "src" && SAFE_IMAGE_SRC.test(value)) continue;
      if (element.localName === "image" && href && SAFE_IMAGE_SRC.test(value)) continue;
      const link = element.localName === "a" && href && value.length <= MAX_LINK_LENGTH ? externalUrl(value) : null;
      if (!link) {
        element.removeAttribute(attribute.name);
        continue;
      }
      attribute.value = linkHref(link);
      if (!element.hasAttribute("title")) element.setAttribute("title", link);
    }
  }
  return { page, scripts };
}

function sameAttributes(a: Element, b: Element): boolean {
  if (a.attributes.length !== b.attributes.length) return false;
  for (const { name, value } of a.attributes) if (b.getAttribute(name) !== value) return false;
  return true;
}

function sameNode(a: Node, b: Node): boolean {
  if (a.nodeType !== b.nodeType) return false;
  return a.nodeType === Node.ELEMENT_NODE ? (a as Element).outerHTML === (b as Element).outerHTML : a.nodeValue === b.nodeValue;
}

/**
 * Replaces only the changed run of top-level body children, keeping the
 * common prefix and suffix. Returns false when the whole document must be
 * swapped instead: the head or the `<html>`/`<body>` attributes changed.
 */
function patchBody(doc: Document, page: Document, lastHead: string | null): boolean {
  if (lastHead !== page.head.innerHTML || !sameAttributes(doc.body, page.body) || !sameAttributes(doc.documentElement, page.documentElement)) {
    return false;
  }
  const old = [...doc.body.childNodes];
  const next = [...page.body.childNodes];
  let start = 0;
  while (start < old.length && start < next.length && sameNode(old[start]!, next[start]!)) start++;
  let endOld = old.length;
  let endNext = next.length;
  while (endOld > start && endNext > start && sameNode(old[endOld - 1]!, next[endNext - 1]!)) {
    endOld--;
    endNext--;
  }
  const anchor = old[endOld] ?? null;
  for (let i = start; i < endOld; i++) old[i]!.remove();
  for (let i = start; i < endNext; i++) doc.body.insertBefore(doc.importNode(next[i]!, true), anchor);
  return true;
}

/** Gives `target` exactly the attributes of `source` (none when it is missing). */
function copyAttributes(target: Element, source: Element | null): void {
  for (const { name } of [...target.attributes]) if (!source?.hasAttribute(name)) target.removeAttribute(name);
  for (const { name, value } of source?.attributes ?? []) if (target.getAttribute(name) !== value) target.setAttribute(name, value);
}

/** Shows all of `page` in `doc`, keeping the frame's <html>, <head> and <body> (see the header). */
function swapPage(doc: Document, page: Document): void {
  const html = doc.documentElement;
  const head = doc.head ?? html.insertBefore(doc.createElement("head"), html.firstChild);
  const body = doc.body ?? html.appendChild(doc.createElement("body"));
  for (const child of [...html.childNodes]) if (child !== head && child !== body) child.remove();
  copyAttributes(html, page.documentElement);
  copyAttributes(head, page.head);
  copyAttributes(body, page.body);
  head.replaceChildren(...[...(page.head?.childNodes ?? [])].map((node) => doc.importNode(node, true)));
  body.replaceChildren(...[...(page.body?.childNodes ?? [])].map((node) => doc.importNode(node, true)));
}

/**
 * The page's own background colour (its <html>, else its <body>), or null
 * when it paints none and the frame's canvas shows.
 */
function pageBackground(doc: Document): { css: string; dark: boolean } | null {
  const view = doc.defaultView;
  for (const element of [doc.documentElement, doc.body]) {
    if (!element || !view) continue;
    const css = view.getComputedStyle(element).backgroundColor;
    const color = parseCssColor(css);
    if (!color || color.alpha < 0.5) continue;
    const [red, green, blue] = color.rgb;
    return { css, dark: 0.299 * red + 0.587 * green + 0.114 * blue < 128 };
  }
  return null;
}

/**
 * The app's scrollbar (section 10 of theme.css) for the page in the frame.
 * WebKit leaves the page background out from under a frame's scrollbar, so
 * the track takes the page's background, and the thumb's ink contrasts with it.
 * WebKit and Chromium scale the page's scrollbar with the root's zoom: the
 * sizes are divided by `zoom`, so the bar keeps the app's size.
 */
function scrollbarCss(background: { css: string; dark: boolean } | null, zoom: number): string {
  const root = getComputedStyle(document.documentElement);
  const token = (name: string, fallback: string): string => root.getPropertyValue(name).trim() || fallback;
  const length = (name: string, fallback: string): string => {
    const value = token(name, fallback);
    return zoom === 1 || !/^[\d.]+px$/.test(value) ? value : `${+(parseFloat(value) / zoom).toFixed(2)}px`;
  };
  const ink = background?.dark ? token("--html-preview-scrollbar-ink-dark-page", "255, 255, 255") : token("--html-preview-scrollbar-ink", "0, 0, 0");
  const size = length("--scrollbar-size", "12px");
  const thumb = `rgba(${ink}, ${token("--scrollbar-thumb-alpha", "0.1")})`;
  const active = `rgba(${ink}, ${token("--scrollbar-active-thumb-alpha", "0.2")})`;
  return `::-webkit-scrollbar{width:${size};height:${size};background:${background?.css ?? "transparent"}}`
    + "::-webkit-scrollbar-corner,::-webkit-scrollbar-track{background:transparent}"
    + `::-webkit-scrollbar-thumb{min-height:${length("--scrollbar-thumb-min-length", "40px")};border:${length("--scrollbar-thumb-inset", "3px")} solid transparent;`
    + `border-radius:${length("--scrollbar-thumb-radius", "12px")};background-color:${thumb};background-clip:padding-box}`
    + `::-webkit-scrollbar-thumb:hover,::-webkit-scrollbar-thumb:active{background-color:${active}}`
    + `@supports not selector(::-webkit-scrollbar){:root{scrollbar-color:${thumb} transparent;scrollbar-width:thin}}`;
}

export class HtmlPreview {
  private frame: HTMLIFrameElement | null = null;
  private loaded = false;
  private key: string | null = null;
  private source: string | null = null;
  /** The frame document last painted. */
  private doc: Document | null = null;
  /** The sanitized `<head>` last painted. */
  private head: string | null = null;
  /** Set by a document switch: the next paint swaps the whole page. */
  private switched = false;
  /** The scroll position last painted; a reloaded frame returns to it. */
  private scroll: [number, number] = [0, 0];
  private scripts = 0;
  /** Set while reloading our page after a foreign document, to try only once. */
  private healing = false;
  /** The scrollbar and zoom style this preview put in the painted page (not part of the page text). */
  private scrollbars: HTMLStyleElement | null = null;
  /** The page background found by the last paint (the scrollbar track's colour). */
  private background: { css: string; dark: boolean } | null = null;
  /** Percent; 100 adds no rule. */
  private zoom = 100;

  /** `onScripts` hears the count of scripts not run whenever it changes (0 after a reset). */
  constructor(
    private readonly openLink: (url: string) => void,
    private readonly onScripts: (count: number) => void = () => {},
  ) {}

  /** Scripts removed from the shown page (0 while no page is shown). */
  get scriptsOff(): number {
    return this.frame?.isConnected ? this.scripts : 0;
  }

  /** Zooms the page to `percent`: one rule in the frame, no repaint of the page. */
  setZoom(percent: number): void {
    if (percent === this.zoom) return;
    this.zoom = percent;
    const doc = this.loaded ? this.frame?.contentDocument : null;
    if (doc && doc === this.doc) this.writeStyle();
  }

  /** Shows `source` in `host`. `key` names the document; a new key starts at the top. */
  render(host: HTMLElement, key: string, source: string): void {
    if (this.frame?.parentElement !== host) this.mount(host);
    else if (key === this.key && source === this.source) return;
    if (key !== this.key) {
      this.key = key;
      this.switched = true;
      this.scroll = [0, 0];
    }
    this.source = source;
    this.paint();
  }

  /** The painted page's scrolling element (reading position), or null before it has loaded. */
  scroller(): Element | null {
    return this.loaded && this.doc ? this.frame?.contentDocument?.scrollingElement ?? null : null;
  }

  /** The shown document now has another id (renamed, moved or copied): keep the page and its scroll. */
  retarget(from: string, to: string): void {
    if (this.key === from) this.key = to;
  }

  /** Forgets the page text and drops the frame, for example on lock. */
  reset(): void {
    this.frame?.remove();
    this.frame = this.doc = this.scrollbars = this.background = null;
    this.key = this.source = this.head = null;
    this.loaded = this.switched = this.healing = false;
    this.scroll = [0, 0];
    this.setScripts(0);
  }

  private mount(host: HTMLElement): void {
    const frame = document.createElement("iframe");
    frame.className = "html-preview";
    frame.title = "HTML page preview";
    frame.setAttribute("sandbox", "allow-same-origin"); // no allow-scripts: nothing in the page runs
    frame.setAttribute("referrerpolicy", "no-referrer");
    frame.addEventListener("load", () => this.onLoad(frame));
    frame.src = FRAME_URL;
    this.frame = frame;
    this.doc = null;
    this.loaded = this.healing = false;
    host.replaceChildren(frame);
    this.setScripts(0);
  }

  private onLoad(frame: HTMLIFrameElement): void {
    if (frame !== this.frame) return;
    const doc = frame.contentDocument;
    // Anything but our page (an error page, say) is replaced by ours, once.
    if (!doc || new URL(doc.URL).pathname !== new URL(FRAME_URL, document.baseURI).pathname) {
      if (!this.healing) frame.src = FRAME_URL;
      this.healing = true;
      return;
    }
    this.healing = false;
    this.loaded = true;
    const requested = new URL(doc.URL).searchParams.get(OPEN);
    this.paint();
    if (requested === null) return;
    // Forget the link in the frame URL, so a later reload does not ask again.
    try {
      frame.contentWindow?.history.replaceState(null, "", FRAME_URL);
    } catch { /* The next link click replaces it anyway. */ }
    const url = externalUrl(requested);
    if (!url) return;
    const href = linkHref(url);
    const clicked = [...doc.querySelectorAll("a")].find((link) => (link.getAttribute("href") ?? link.getAttribute("xlink:href")) === href);
    const box = clicked?.getBoundingClientRect();
    if (clicked && box && (box.bottom < 0 || box.top > frame.clientHeight)) clicked.scrollIntoView({ block: "center" });
    this.openLink(url);
  }

  private paint(): void {
    const doc = this.loaded ? this.frame?.contentDocument : null;
    if (!doc?.documentElement || this.source === null) return;
    const { page, scripts } = sanitizeHtmlPage(this.source);
    const head = page.head.innerHTML;
    const sameDocument = doc === this.doc && !this.switched;
    const scroller = doc.scrollingElement;
    if (sameDocument && scroller) this.scroll = [scroller.scrollLeft, scroller.scrollTop];
    if (!sameDocument || !patchBody(doc, page, this.head)) {
      swapPage(doc, page);
      this.doc = doc;
    }
    this.switched = false;
    this.head = head;
    this.styleScrollbars(doc);
    doc.scrollingElement?.scrollTo(...this.scroll);
    this.setScripts(scripts);
  }

  private setScripts(count: number): void {
    if (count === this.scripts) return;
    this.scripts = count;
    this.onScripts(count);
  }

  /** Puts the app's scrollbar style first in the page's head; rewritten only when it changes. */
  private styleScrollbars(doc: Document): void {
    if (!doc.head) return;
    let style = this.scrollbars;
    if (style?.ownerDocument !== doc) {
      style = doc.createElement("style");
      style.dataset.notebook = "scrollbars";
      this.scrollbars = style;
    }
    if (doc.head.firstChild !== style) doc.head.prepend(style);
    this.background = pageBackground(doc);
    this.writeStyle();
  }

  private writeStyle(): void {
    const style = this.scrollbars;
    if (!style) return;
    const zoom = this.zoom / 100;
    const css = scrollbarCss(this.background, zoom) + (zoom === 1 ? "" : `:root{zoom:${zoom}}`);
    if (style.textContent !== css) style.textContent = css;
  }
}
