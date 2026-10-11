// Markdown preview for the web version: marked (GFM tables, strikethrough,
// task lists) renders, DOMPurify sanitizes with the desktop's allowlist
// (src-tauri/src/preview.rs, spec section 9), and the result is a DOM
// fragment, never an HTML string assigned with innerHTML.
// Kept from preview.rs: raw HTML is shown as text; links keep only
// https/http/mailto, "#heading" (as the heading's generated "h-<slug>" id)
// and vault links (relative paths become nb-doc:, [[wikilinks]] nb-wiki:,
// written by src/vault-links.ts); images only as inline
// data:image/(png|jpeg|gif|webp) (others become "Image blocked"); no
// attributes beyond the allowlist; links get rel="noopener noreferrer".
// Not ported: footnotes (shown as typed) and pulldown-cmark's exact
// parsing corner cases (marked also links bare URLs).

import DOMPurify from "dompurify";
import { Marked, type Tokens } from "marked";
import { SAFE_IMAGE_SRC } from "../../src/html-preview.ts";
import { DOC_LINK_SCHEME, encodeTarget, HeadingIds, previewHref, WIKI_LINK_SCHEME, wikiHref } from "../../src/vault-links.ts";

export const MAX_PREVIEW_BYTES = 16 * 1024 * 1024;
const BLOCKED_IMAGE = '<span class="blocked-image">Image blocked</span>';
const SLUG_CHAR = /^[\p{Alphabetic}\p{N}\p{M}_-]$/u;
const CONTROL = /\p{Cc}/u;
const FOOTNOTE_ID = /^footnote-\d+$/;

const ALLOWED_TAGS = [
  "p", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "blockquote", "pre", "code", "em", "strong", "del",
  "a", "img", "table", "thead", "tbody", "tr", "th", "td", "hr", "br", "sup", "section", "input", "span",
];
const ALLOWED_CLASSES: Record<string, readonly string[]> = {
  span: ["blocked-image"],
  sup: ["footnote-reference", "footnote-definition-label"],
  section: ["footnote-definition"],
};

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** preview.rs `percent_decode`: %XX escapes; a lone "%" stays; null when not UTF-8. */
function percentDecode(value: string): string | null {
  const bytes: number[] = [];
  const source = new TextEncoder().encode(value);
  for (let index = 0; index < source.length; index++) {
    const hex = source[index] === 0x25 ? String.fromCharCode(source[index + 1] ?? 0, source[index + 2] ?? 0) : "";
    if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
      bytes.push(Number.parseInt(hex, 16));
      index += 2;
    } else {
      bytes.push(source[index]!);
    }
  }
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(new Uint8Array(bytes));
  } catch {
    return null;
  }
}

function isHeadingId(value: string): boolean {
  return value.startsWith("h-") && Array.from(value.slice(2)).every((char) => SLUG_CHAR.test(char));
}

/** preview.rs `is_fragment_href`: an in-page "#…" exactly as the renderer writes it. */
function isFragmentHref(value: string): boolean {
  if (FOOTNOTE_ID.test(value)) return true;
  const id = percentDecode(value);
  return id !== null && isHeadingId(id) && encodeTarget(id, false) === value;
}

/** preview.rs `is_internal_href`: an nb-doc: / nb-wiki: href exactly as written. */
function isInternalHref(value: string): boolean {
  const scheme = value.startsWith(DOC_LINK_SCHEME) ? DOC_LINK_SCHEME : value.startsWith(WIKI_LINK_SCHEME) ? WIKI_LINK_SCHEME : null;
  if (!scheme) return false;
  const rest = value.slice(scheme.length);
  const hash = rest.indexOf("#");
  const target = hash < 0 ? rest : rest.slice(0, hash);
  const fragment = hash < 0 ? null : rest.slice(hash + 1);
  const decoded = percentDecode(target);
  return decoded !== null
    && decoded.length > 0
    && Array.from(decoded).length <= 1024
    && !CONTROL.test(decoded)
    && encodeTarget(decoded, true) === target
    && (fragment === null || (fragment.length > 0 && isFragmentHref(fragment)));
}

/** preview.rs `is_allowed_href`. */
export function isAllowedHref(value: string): boolean {
  if (value.startsWith("#")) return isFragmentHref(value.slice(1));
  if (isInternalHref(value)) return true;
  try {
    return ["https:", "http:", "mailto:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

function anchor(href: string | null, inner: string): string {
  return href === null ? `<a>${inner}</a>` : `<a href="${escapeHtml(href)}">${inner}</a>`;
}

const wikilink = {
  name: "wikilink",
  level: "inline" as const,
  start(source: string): number | undefined {
    const index = source.indexOf("[[");
    return index < 0 ? undefined : index;
  },
  tokenizer(source: string): Tokens.Generic | undefined {
    const match = /^\[\[([^[\]\n|]+)(?:\|([^[\]\n]+))?\]\]/.exec(source);
    if (!match) return undefined;
    return { type: "wikilink", raw: match[0], target: match[1]!, alias: match[2] ?? null };
  },
  renderer(token: Tokens.Generic): string {
    const target = token.target as string;
    return anchor(wikiHref(target), escapeHtml((token.alias as string | null) ?? target));
  },
};

const marked = new Marked({
  gfm: true,
  breaks: false,
  async: false,
  extensions: [wikilink],
  renderer: {
    // Raw HTML is text, as in preview.rs; an HTML block becomes a paragraph.
    html(token: Tokens.HTML | Tokens.Tag): string {
      const text = escapeHtml(token.text);
      return "block" in token && token.block ? `<p>${text}</p>\n` : text;
    },
    link(token: Tokens.Link): string {
      return anchor(previewHref(token.href), this.parser.parseInline(token.tokens));
    },
    image(token: Tokens.Image): string {
      if (!SAFE_IMAGE_SRC.test(token.href)) return BLOCKED_IMAGE;
      const title = token.title ? ` title="${escapeHtml(token.title)}"` : "";
      return `<img src="${escapeHtml(token.href)}" alt="${escapeHtml(token.text)}"${title}>`;
    },
  },
});

type Purifier = ReturnType<typeof DOMPurify>;
let purifier: Purifier | null = null;

function keepAttribute(tag: string, name: string, value: string): boolean {
  switch (name) {
    case "href":
      return tag === "a" && isAllowedHref(value);
    case "src":
      return tag === "img" && SAFE_IMAGE_SRC.test(value);
    case "alt":
    case "title":
      return tag === "img";
    case "checked":
    case "disabled":
      return tag === "input";
    case "type":
      return tag === "input" && value === "checkbox";
    case "align":
      return (tag === "th" || tag === "td") && ["left", "center", "right"].includes(value);
    case "class":
      return value.split(/\s+/).every((part) => ALLOWED_CLASSES[tag]?.includes(part) ?? false);
    default:
      return false; // ids are generated after sanitizing; nothing else is allowed.
  }
}

function getPurifier(): Purifier {
  if (purifier) return purifier;
  const instance = DOMPurify(window);
  instance.addHook("uponSanitizeAttribute", (node, data) => {
    if (!keepAttribute(node.nodeName.toLowerCase(), data.attrName, data.attrValue)) data.keepAttr = false;
  });
  instance.addHook("afterSanitizeAttributes", (node) => {
    const tag = node.nodeName.toLowerCase();
    if (tag === "a" && node.hasAttribute("href")) node.setAttribute("rel", "noopener noreferrer");
    if (tag === "input") {
      node.setAttribute("type", "checkbox");
      node.setAttribute("disabled", "");
    }
  });
  purifier = instance;
  return instance;
}

const PURIFY_CONFIG = {
  ALLOWED_TAGS,
  ALLOWED_ATTR: ["href", "src", "alt", "title", "checked", "disabled", "type", "align", "class"],
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
  ALLOW_UNKNOWN_PROTOCOLS: false,
  // Every attribute not marked URI-safe must pass this pattern, hrefs and srcs included (the hook then
  // checks them exactly); align and type hold plain words.
  ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|nb-doc|nb-wiki):|#)/i,
  ADD_URI_SAFE_ATTR: ["align", "type"],
  RETURN_DOM_FRAGMENT: true as const,
};

/** The heading's id text: its visible text without blocked images or footnote marks (preview.rs `heading`). */
function headingText(heading: Element): string {
  const copy = heading.cloneNode(true) as Element;
  for (const skip of copy.querySelectorAll(".blocked-image, sup.footnote-reference")) skip.remove();
  return copy.textContent ?? "";
}

/** The sanitized preview of `source`, with "h-<slug>" ids on its headings. */
export function renderMarkdown(source: string): DocumentFragment {
  if (new TextEncoder().encode(source).length > MAX_PREVIEW_BYTES) {
    const fragment = document.createDocumentFragment();
    const note = document.createElement("p");
    note.className = "preview-note";
    note.textContent = "This document is too large to preview. Use Edit to read it.";
    fragment.append(note);
    return fragment;
  }
  const html = marked.parse(source) as string;
  const fragment = getPurifier().sanitize(html, PURIFY_CONFIG);
  const ids = new HeadingIds();
  for (const heading of fragment.querySelectorAll("h1, h2, h3, h4, h5, h6")) heading.id = ids.next(headingText(heading));
  return fragment;
}
