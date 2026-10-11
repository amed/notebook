// Links in the Markdown preview (README "Links"). preview.rs gives every
// heading an id ("h-" and a GitHub-style slug) and writes links to other
// vault documents as `nb-doc:<relative path>#<id>` or
// `nb-wiki:<target>#<id>`; navigation.ts catches the clicks and main.ts
// resolves them here, against the tree, before it opens anything. No DOM
// and no runtime imports, so tests/unit can run it.

export const HEADING_ID_PREFIX = "h-";
export const DOC_LINK_SCHEME = "nb-doc:";
export const WIKI_LINK_SCHEME = "nb-wiki:";
/** As preview.rs: slugs are cut here (in code points), paths and targets longer are no links. */
const MAX_SLUG = 200;
const MAX_TARGET = 1024;
const SLUG_CHAR = /^[\p{Alphabetic}\p{N}\p{M}_-]$/u;
const WHITE_SPACE = /^\p{White_Space}$/u;
const CONTROL = /\p{Cc}/u;
const FOOTNOTE_ID = /^footnote-\d+$/;
const MARKDOWN_NAME = /\.(?:md|markdown)$/;

/**
 * GitHub's heading slug, exactly as preview.rs `slug`: NFC, the whole text
 * lowercased (so a final Σ becomes ς, as github-slugger and Rust's
 * str::to_lowercase do), letters, numbers, marks, `-` and `_` kept, each
 * white space a `-`, the rest dropped.
 */
export function slugify(text: string): string {
  let slug = "";
  let length = 0;
  for (const lower of text.normalize("NFC").toLowerCase()) {
    if (length === MAX_SLUG) return slug;
    if (WHITE_SPACE.test(lower)) slug += "-";
    else if (SLUG_CHAR.test(lower)) slug += lower;
    else continue;
    length++;
  }
  return slug;
}

/** Heading ids in document order; a repeated slug gets -1, -2, … (preview.rs HeadingIds). */
export class HeadingIds {
  private seen = new Map<string, number>();

  next(text: string): string {
    const base = slugify(text);
    let id = base;
    while (this.seen.has(id)) {
      const count = (this.seen.get(base) ?? 0) + 1;
      this.seen.set(base, count);
      id = `${base}-${count}`;
    }
    this.seen.set(id, 0);
    return `${HEADING_ID_PREFIX}${id}`;
  }
}

/**
 * The element ids a `#fragment` may mean, best first: the fragment itself
 * when it is a generated id (preview.rs writes those), then the heading id
 * of its text, so `#My%20Heading` and `#my-heading` work too.
 */
export function fragmentIds(fragment: string): string[] {
  let decoded = fragment;
  try {
    decoded = decodeURIComponent(fragment);
  } catch {
    /* Not percent-encoded: the text as it is. */
  }
  const ids: string[] = [];
  if (decoded.startsWith(HEADING_ID_PREFIX) || FOOTNOTE_ID.test(decoded)) ids.push(decoded);
  const slug = slugify(decoded);
  const heading = `${HEADING_ID_PREFIX}${slug}`;
  if (slug && !ids.includes(heading)) ids.push(heading);
  return ids;
}

/** Percent-encodes all but ASCII letters, digits, `-._~` (and `/`), as preview.rs does. */
export function encodeTarget(value: string, keepSlash: boolean): string {
  let encoded = "";
  for (const byte of new TextEncoder().encode(value)) {
    const char = String.fromCharCode(byte);
    if (/[A-Za-z0-9\-._~]/.test(char) || (keepSlash && char === "/")) encoded += char;
    else encoded += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return encoded;
}

/** A link to another vault document: a relative path or a wikilink target, and a heading. */
export type InternalLink = { kind: "doc" | "wiki"; target: string; fragment: string | null };

function isTarget(value: string): boolean {
  return value.length > 0 && Array.from(value).length <= MAX_TARGET && !CONTROL.test(value);
}

/** The internal link an `nb-doc:` / `nb-wiki:` href names, or null for anything else. */
export function parseInternalHref(href: string): InternalLink | null {
  const kind = href.startsWith(DOC_LINK_SCHEME) ? "doc" : href.startsWith(WIKI_LINK_SCHEME) ? "wiki" : null;
  if (!kind) return null;
  const rest = href.slice(kind === "doc" ? DOC_LINK_SCHEME.length : WIKI_LINK_SCHEME.length);
  const hash = rest.indexOf("#");
  let target: string;
  let fragment: string | null = null;
  try {
    target = decodeURIComponent(hash < 0 ? rest : rest.slice(0, hash));
    if (hash >= 0) fragment = decodeURIComponent(rest.slice(hash + 1)) || null;
  } catch {
    return null;
  }
  return isTarget(target) ? { kind, target, fragment } : null;
}

/** The key two names are compared by: NFC, lowercase per code point, NFC. */
export function nameKey(name: string): string {
  return Array.from(name.normalize("NFC"), (char) => char.toLowerCase()).join("").normalize("NFC");
}

/** A folder or document of the tree. */
export interface VaultEntry {
  id: string;
  parent: string | null;
  name: string;
  folder: boolean;
}

/** What a link names, checked against the tree. */
type LinkTarget =
  | { kind: "document"; id: string }
  | { kind: "folder"; id: string }
  | { kind: "missing" }
  | { kind: "ambiguous"; count: number };

type Indexed = VaultEntry & { key: string };

/** The tree, by folder, with name keys; built for one link. */
export class VaultIndex {
  readonly root: string;
  private children = new Map<string, Indexed[]>();
  private byId = new Map<string, Indexed>();

  constructor(root: string, entries: Iterable<VaultEntry>) {
    this.root = root;
    for (const entry of entries) {
      if (entry.id === root || entry.parent === null) continue;
      const indexed = { ...entry, key: nameKey(entry.name) };
      this.byId.set(entry.id, indexed);
      const siblings = this.children.get(entry.parent);
      if (siblings) siblings.push(indexed);
      else this.children.set(entry.parent, [indexed]);
    }
  }

  childrenOf(parent: string): readonly Indexed[] {
    return this.children.get(parent) ?? [];
  }

  documents(): Indexed[] {
    return [...this.byId.values()].filter((entry) => !entry.folder);
  }

  /** The name keys of the folders from the root down to `id`'s parent; null outside the tree. */
  folderKeys(id: string): string[] | null {
    const keys: string[] = [];
    let entry = this.byId.get(id);
    for (let depth = 0; entry && depth < 4096; depth++) {
      if (entry.parent === this.root) return keys;
      entry = entry.parent ? this.byId.get(entry.parent) : undefined;
      if (entry) keys.unshift(entry.key);
    }
    return null;
  }
}

/**
 * The tree of a document window, which holds only its document: the
 * folders of `path` and the document `id`. Enough to tell a link to the
 * window's own document from one the main window opens.
 */
export function pathIndex(path: string, id: string): VaultIndex {
  const parts = path.split("/").filter(Boolean);
  const root = "path:root";
  const entries: VaultEntry[] = parts.map((name, index) => ({
    id: index === parts.length - 1 ? id : `path:${index}`,
    parent: index === 0 ? root : `path:${index - 1}`,
    name,
    folder: index < parts.length - 1,
  }));
  return new VaultIndex(root, entries);
}

/**
 * The vault path `target` names from the document at `from` ("/a/b.md" or
 * "a/b.md"): relative to its folder, or to the vault's root when it starts
 * with "/". Null when ".." climbs above the root.
 */
export function joinVaultPath(from: string, target: string): string[] | null {
  const parts = target.startsWith("/") ? [] : from.split("/").filter(Boolean).slice(0, -1);
  for (const part of target.split("/")) {
    if (!part || part === ".") continue;
    if (part !== "..") parts.push(part);
    else if (!parts.pop()) return null;
  }
  return parts;
}

/**
 * A relative link (`notes/a.md`, `../b.md`, `Folder/`): each name is
 * matched without case, as Notebook names are. A last name without an
 * extension also finds its ".md" document, as in Obsidian; a trailing "/"
 * wants a folder.
 */
export function resolveDocLink(index: VaultIndex, from: string, target: string): LinkTarget {
  const parts = joinVaultPath(from, target);
  if (!parts?.length) return { kind: "missing" };
  const wantsFolder = /(?:^|\/)(?:\.\.?)?$/.test(target);
  let parent = index.root;
  for (const [position, part] of parts.entries()) {
    const last = position === parts.length - 1;
    const key = nameKey(part);
    const children = index.childrenOf(parent);
    let found = children.find((entry) => entry.key === key && (last ? !wantsFolder || entry.folder : entry.folder));
    if (!found && last && !wantsFolder && !part.includes(".")) {
      found = children.find((entry) => !entry.folder && entry.key === `${key}.md`);
    }
    if (!found) return { kind: "missing" };
    if (last) return { kind: found.folder ? "folder" : "document", id: found.id };
    parent = found.id;
  }
  return { kind: "missing" };
}

function stem(key: string): string {
  const dot = key.lastIndexOf(".");
  return dot > 0 ? key.slice(0, dot) : key;
}

function distance(from: readonly string[], to: readonly string[]): number {
  let shared = 0;
  while (shared < from.length && shared < to.length && from[shared] === to[shared]) shared++;
  return from.length - shared + (to.length - shared);
}

/**
 * `[[Note]]`, `[[Folder/Note]]`, `[[Note.html]]`: the document named so
 * (with its extension, else without; Markdown first), whose folders end
 * with the given ones. Several: the one nearest the linking document's
 * folder; several as near are ambiguous.
 */
export function resolveWikiLink(index: VaultIndex, from: string, target: string): LinkTarget {
  const segments = target.trim().split("/").map((part) => part.trim()).filter(Boolean);
  const name = segments.pop();
  if (!name) return { kind: "missing" };
  const key = nameKey(name);
  const folders = segments.map(nameKey);
  const documents = index.documents();
  const exact = documents.filter((entry) => entry.key === key);
  let pool = exact;
  if (!exact.length) {
    const stems = documents.filter((entry) => stem(entry.key) === key);
    const markdown = stems.filter((entry) => MARKDOWN_NAME.test(entry.key));
    pool = markdown.length ? markdown : stems;
  }
  const placed = pool
    .map((entry) => ({ entry, folders: index.folderKeys(entry.id) }))
    .filter((item): item is { entry: Indexed; folders: string[] } =>
      item.folders !== null
      && item.folders.length >= folders.length
      && folders.every((folder, at) => item.folders![item.folders!.length - folders.length + at] === folder));
  if (!placed.length) return { kind: "missing" };
  if (placed.length === 1) return { kind: "document", id: placed[0]!.entry.id };
  const source = from.split("/").filter(Boolean).slice(0, -1).map(nameKey);
  const distances = placed.map((item) => distance(source, item.folders));
  const nearest = Math.min(...distances);
  const best = placed.filter((_, at) => distances[at] === nearest);
  return best.length === 1 ? { kind: "document", id: best[0]!.entry.id } : { kind: "ambiguous", count: best.length };
}

/** What `link` names from the document at `from`. */
export function resolveInternalLink(index: VaultIndex, from: string, link: InternalLink): LinkTarget {
  return link.kind === "doc" ? resolveDocLink(index, from, link.target) : resolveWikiLink(index, from, link.target);
}

function fragmentId(fragment: string): string | null {
  if (FOOTNOTE_ID.test(fragment)) return fragment;
  let decoded = fragment;
  try {
    decoded = decodeURIComponent(fragment);
  } catch {
    /* Kept as written. */
  }
  const slug = slugify(decoded);
  return slug ? `${HEADING_ID_PREFIX}${slug}` : null;
}

function internalHref(scheme: string, target: string, fragment: string | null): string {
  const id = fragment === null ? null : fragmentId(fragment);
  return `${scheme}${encodeTarget(target, true)}${id ? `#${encodeTarget(id, false)}` : ""}`;
}

/**
 * Browser mode's stand-in renderer (main.ts) writes the hrefs preview.rs
 * writes: `#Heading` targets its id, web and mail links stay, relative
 * paths become `nb-doc:` links; null is a link without a target.
 */
export function previewHref(dest: string): string | null {
  if (dest.startsWith("#")) {
    const id = fragmentId(dest.slice(1));
    return id ? `#${encodeTarget(id, false)}` : null;
  }
  if (/^(?:https?|mailto):/i.test(dest)) return dest;
  if (/^[a-z][a-z0-9+.-]*:/i.test(dest) || /^(?:\/\/|\\|\/\\)/.test(dest)) return null;
  const hash = dest.indexOf("#");
  const path = (hash < 0 ? dest : dest.slice(0, hash)).split("?")[0]!;
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    decoded = path;
  }
  return isTarget(decoded) ? internalHref(DOC_LINK_SCHEME, decoded, hash < 0 ? null : dest.slice(hash + 1)) : null;
}

/** `[[Note#Heading]]`'s href, as preview.rs writes it (`[[#Heading]]`: this document). */
export function wikiHref(dest: string): string | null {
  const hash = dest.indexOf("#");
  const target = (hash < 0 ? dest : dest.slice(0, hash)).trim();
  const heading = hash < 0 ? null : dest.slice(hash + 1).split("#").at(-1)!.trim();
  if (!target) {
    const id = heading === null ? null : fragmentId(heading);
    return id ? `#${encodeTarget(id, false)}` : null;
  }
  return isTarget(target) ? internalHref(WIKI_LINK_SCHEME, target, heading) : null;
}
