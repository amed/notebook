// One unlocked workspace: its decrypted listing, the tree built from it and
// the few writes the web version makes (save, new document, new folder).
// The rules are the desktop's (src-tauri/src/notebook.rs and
// deleted_items.rs): the listing decodes like `decode_listing` (a listing in
// which nothing decrypts but something does not is a wrong phrase), the tree
// like `build_nodes` (Notebook's `_deleted` bin, earlier trash namespaces and
// `.notebook_dir` markers stay hidden), names like `validate_name` and
// `unique_name`, conflict copies like `conflict_path`. No DOM, so tests/web
// runs it against an in-memory S3.

import type { TreeNode } from "../../src/ipc.ts";
import { parseVaultFilePath } from "../../src/file-path.ts";
import { nameProblem, uniqueName } from "../../src/folder-import.ts";
import { ROOT_ID, TreeModel } from "../../src/tree-model.ts";
import { DIRECTORY_MARKER, type NotebookV1Codec } from "./codec.ts";
import type { ListedObject, ObjectBody, PutCondition, S3Location } from "./s3.ts";
import { listPrefix, storedKey } from "./s3.ts";

export const MAX_EDIT_BYTES = 16 * 1024 * 1024;
/** Notebook's bin and the trash namespaces of earlier builds: never shown, created or written. */
const RESERVED_ROOTS = new Set(["_deleted", "_delete", ".secure-vault-trash"]);

export interface RemoteStore {
  list(prefix: string): Promise<ListedObject[]>;
  get(key: string): Promise<ObjectBody>;
  put(key: string, body: Uint8Array, condition: PutCondition): Promise<string>;
}

export interface StoredObject {
  key: string;
  etag: string;
}

export class VaultError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "VaultError";
    this.code = code;
  }
}

export function parentPath(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

export function fileName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export function joinPath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

/** Bin storage is top-level only, like Notebook's `is_deleted_path`. */
export function isHiddenPath(path: string): boolean {
  return RESERVED_ROOTS.has(path.split("/")[0]!);
}

export function isMarkerPath(path: string): boolean {
  return fileName(path) === DIRECTORY_MARKER;
}

/** src/editor/editor.ts `languageForFile`, here so reading a note never loads the editor. */
export function documentLanguage(name: string): "markdown" | "html" | "plaintext" {
  if (/\.html?$/i.test(name)) return "html";
  if (/\.txt$/i.test(name)) return "plaintext";
  return "markdown";
}

export const folderId = (path: string): string => `folder:${path}`;
export const documentId = (path: string): string => `doc:${path}`;

/** "stem (conflict 1712000000123).ext", then "-1", "-2"… (desktop `conflict_path`). */
export function conflictPath(original: string, timestamp: number, sequence: number): string {
  const name = fileName(original);
  const dot = name.lastIndexOf(".");
  const split = dot > 0 ? dot : name.length;
  const suffix = sequence === 0 ? ` (conflict ${timestamp})` : ` (conflict ${timestamp}-${sequence})`;
  return joinPath(parentPath(original), `${name.slice(0, split)}${suffix}${name.slice(split)}`);
}

/** Logical paths of every listed object that decrypts (desktop `decode_listing`). */
export async function decodeListing(
  codec: NotebookV1Codec,
  location: Pick<S3Location, "prefix">,
  listed: readonly ListedObject[],
): Promise<Map<string, StoredObject>> {
  const prefix = listPrefix(location);
  const objects = new Map<string, StoredObject>();
  let undecodable = 0;
  for (const object of listed) {
    let relative: string;
    if (prefix) {
      if (!object.key.startsWith(prefix)) continue;
      relative = object.key.slice(prefix.length);
    } else {
      relative = object.key.replace(/^\/+|\/+$/g, "");
    }
    if (!relative) continue;
    try {
      const path = await codec.decodePath(relative);
      objects.set(path, { key: object.key, etag: object.etag });
    } catch {
      undecodable++;
    }
  }
  if (objects.size === 0 && undecodable > 0) {
    throw new VaultError("WRONG_PHRASE", "The encryption phrase does not match this workspace.");
  }
  return objects;
}

/** The folders and documents of the tree (desktop `build_nodes`). */
export function buildNodes(paths: Iterable<string>): TreeNode[] {
  const folders = new Set<string>();
  const documents: string[] = [];
  for (const path of paths) {
    if (isHiddenPath(path)) continue;
    const marker = isMarkerPath(path);
    const visible = marker ? parentPath(path) : path;
    let parent = parentPath(visible);
    while (parent && !folders.has(parent)) {
      folders.add(parent);
      parent = parentPath(parent);
    }
    if (marker && visible) folders.add(visible);
    else if (!marker) documents.push(path);
  }
  const node = (kind: "Folder" | "Document", path: string): TreeNode => {
    const parent = parentPath(path);
    return {
      id: kind === "Folder" ? folderId(path) : documentId(path),
      parent: parent ? folderId(parent) : ROOT_ID,
      name: fileName(path),
      kind,
    };
  };
  return [...[...folders].sort().map((path) => node("Folder", path)), ...documents.sort().map((path) => node("Document", path))];
}

/** The desktop's `validate_name`, plus the web new-file rules (src/folder-import.ts). */
export function checkedName(name: string): string {
  const value = name.trim();
  const problem = nameProblem(value);
  if (problem) throw new VaultError("INVALID_NAME", `This name cannot be used: ${problem}.`);
  return value;
}

export interface OpenedDocument {
  path: string;
  text: string;
  etag: string;
}

export type SaveOutcome =
  | { status: "saved"; path: string; etag: string }
  | { status: "conflict"; path: string; etag: string; original: string };

export class Vault {
  readonly location: S3Location;
  readonly tree = new TreeModel();
  private readonly codec: NotebookV1Codec;
  private readonly remote: RemoteStore;
  private objects = new Map<string, StoredObject>();
  private version = 0;
  private readonly clock: () => number;

  constructor(location: S3Location, codec: NotebookV1Codec, remote: RemoteStore, clock: () => number = Date.now) {
    this.location = location;
    this.codec = codec;
    this.remote = remote;
    this.clock = clock;
  }

  /** Lists and decrypts the workspace; WRONG_PHRASE when nothing decrypts. */
  async load(): Promise<void> {
    const listed = await this.remote.list(listPrefix(this.location));
    this.objects = await decodeListing(this.codec, this.location, listed);
    this.rebuild();
  }

  /** Every decrypted object path, markers and bin included. */
  paths(): string[] {
    return [...this.objects.keys()].sort();
  }

  isEmpty(): boolean {
    return this.tree.children(ROOT_ID).length === 0;
  }

  private rebuild(): void {
    this.tree.replace({
      nodes: [{ id: ROOT_ID, parent: null, name: "Vault", kind: "Root" }, ...buildNodes(this.objects.keys())],
      version: ++this.version,
    });
  }

  /** The S3 key (ciphertext) of a stored path, to remember a note without its name. */
  storedKey(path: string): string | undefined {
    return this.objects.get(path)?.key;
  }

  /** The logical path stored under an S3 key, if it is still in the listing. */
  pathOfKey(key: string): string | undefined {
    for (const [path, object] of this.objects) if (object.key === key) return path;
    return undefined;
  }

  /** The logical path of a node id ("folder:a/b" or "doc:a/b.md"); "" for the root. */
  pathOf(id: string): string {
    return this.tree.pathOf(id).slice(1);
  }

  private async key(path: string): Promise<string> {
    return storedKey(this.location, await this.codec.encodePath(path));
  }

  async open(path: string): Promise<OpenedDocument> {
    const object = this.objects.get(path);
    if (!object) throw new VaultError("NOT_FOUND", "This document no longer exists. Refresh the list.");
    const body = await this.remote.get(object.key);
    let text: string;
    try {
      text = this.codec.decodeContent(body.bytes);
    } catch {
      throw new VaultError("DECRYPT", "This document could not be decrypted with the workspace's phrase.");
    }
    // Without an exposed ETag header the listing's (older or equal) one is the base: a stale base only
    // ever turns a save into a conflict copy, never into an overwrite.
    const etag = body.etag ?? object.etag;
    this.objects.set(path, { key: object.key, etag });
    return { path, text, etag };
  }

  /**
   * Writes `text` over the version `base` with If-Match. When S3 holds
   * another version (or none), the text is kept as a conflict copy next to
   * it, created with If-None-Match, and the original is left alone.
   */
  async save(path: string, base: string, text: string): Promise<SaveOutcome> {
    if (new TextEncoder().encode(text).length > MAX_EDIT_BYTES) {
      throw new VaultError("DOCUMENT_TOO_LARGE", "Documents are limited to 16 MiB.");
    }
    const object = this.objects.get(path);
    const key = object?.key ?? (await this.key(path));
    const body = this.codec.encodeContent(text);
    try {
      const etag = await this.remote.put(key, body, { ifMatch: base });
      this.objects.set(path, { key, etag });
      return { status: "saved", path, etag };
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== "CONFLICT" && code !== "NOT_FOUND") throw error;
    }
    // A save whose reply was lost may have succeeded: the same text in S3 is ours.
    try {
      const current = await this.remote.get(key);
      if (current.etag && this.codec.decodeContent(current.bytes) === text) {
        this.objects.set(path, { key, etag: current.etag });
        return { status: "saved", path, etag: current.etag };
      }
    } catch {
      /* Gone or unreadable: the conflict copy keeps the text. */
    }
    const timestamp = this.clock();
    for (let sequence = 0; sequence < 100; sequence++) {
      const copy = conflictPath(path, timestamp, sequence);
      if (this.objects.has(copy)) continue;
      const copyKey = await this.key(copy);
      try {
        const etag = await this.remote.put(copyKey, body, { ifNoneMatch: true });
        this.objects.set(copy, { key: copyKey, etag });
        this.rebuild();
        return { status: "conflict", path: copy, etag, original: path };
      } catch (error) {
        if ((error as { code?: string }).code !== "CONFLICT") throw error;
      }
    }
    throw new VaultError("CONFLICT", "A unique conflict-copy name could not be created.");
  }

  private siblings(parent: string): TreeNode[] {
    return [...this.tree.children(parent ? folderId(parent) : ROOT_ID)];
  }

  /** The child folder of `parent` named `name` without case (desktop `child_named`). */
  private childNamed(parent: string, name: string): TreeNode | undefined {
    const wanted = name.toLowerCase();
    return this.siblings(parent).find((node) => node.name.toLowerCase() === wanted);
  }

  private async putMarker(folder: string): Promise<void> {
    const path = joinPath(folder, DIRECTORY_MARKER);
    const key = await this.key(path);
    try {
      const etag = await this.remote.put(key, this.codec.encodeContent(""), { ifNoneMatch: true });
      this.objects.set(path, { key, etag });
    } catch (error) {
      // An existing marker is the folder this one would be.
      if ((error as { code?: string }).code !== "CONFLICT") throw error;
      this.objects.set(path, { key, etag: "" });
    }
  }

  /**
   * A new empty document at `input`, a path from the workspace root
   * ("Folder/Note"; a missing extension becomes ".md"). Existing folders
   * are matched without case; missing ones get Notebook folder markers.
   * Returns its logical path.
   */
  async createDocument(input: string, text = ""): Promise<string> {
    let requested: { directories: string[]; name: string };
    try {
      requested = parseVaultFilePath(input);
    } catch (error) {
      throw new VaultError("INVALID_NAME", (error as Error).message);
    }
    const directories = requested.directories.map(checkedName);
    const base = checkedName(requested.name);
    let parent = "";
    const created: string[] = [];
    for (const folder of directories) {
      const existing = created.length ? undefined : this.childNamed(parent, folder);
      if (existing && existing.kind !== "Folder") throw new VaultError("INVALID_NAME", "A file has the name of a folder in this path.");
      parent = existing ? this.pathOf(existing.id) : joinPath(parent, folder);
      if (!existing) created.push(parent);
    }
    for (const folder of created) await this.putMarker(folder);
    if (created.length) this.rebuild();
    const body = this.codec.encodeContent(text);
    for (let attempt = 0; attempt < 100; attempt++) {
      const taken = new Set(this.siblings(parent).map((node) => node.name.toLowerCase()));
      const path = joinPath(parent, uniqueName(taken, base));
      const key = await this.key(path);
      try {
        const etag = await this.remote.put(key, body, { ifNoneMatch: true });
        this.objects.set(path, { key, etag });
        this.rebuild();
        return path;
      } catch (error) {
        if ((error as { code?: string }).code !== "CONFLICT") throw error;
        // Taken by an item this session did not know: list it and try the next name.
        this.objects.set(path, { key, etag: "" });
        this.rebuild();
      }
    }
    throw new VaultError("CONFLICT", "A unique name could not be reserved in S3.");
  }

  /**
   * A new folder at `input`, a path from the workspace root ("Projects/Ideas"):
   * existing folders on the way are matched without case, missing ones get
   * markers, and the last name gets a number when it is taken.
   */
  async createFolderAt(input: string): Promise<string> {
    const names = input.split("/").map((part) => part.trim()).filter(Boolean).map(checkedName);
    const last = names.pop();
    if (!last) throw new VaultError("INVALID_NAME", "Enter a folder name.");
    let parent = "";
    const created: string[] = [];
    for (const folder of names) {
      const existing = created.length ? undefined : this.childNamed(parent, folder);
      if (existing && existing.kind !== "Folder") throw new VaultError("INVALID_NAME", "A file has the name of a folder in this path.");
      parent = existing ? this.pathOf(existing.id) : joinPath(parent, folder);
      if (!existing) created.push(parent);
    }
    for (const folder of created) await this.putMarker(folder);
    if (created.length) this.rebuild();
    return this.createFolder(parent, last);
  }

  /** A new folder (its Notebook marker) in `parent`; returns its logical path. */
  async createFolder(parent: string, name: string): Promise<string> {
    const base = checkedName(name);
    for (let attempt = 0; attempt < 100; attempt++) {
      const taken = new Set(this.siblings(parent).map((node) => node.name.toLowerCase()));
      const path = joinPath(parent, uniqueName(taken, base));
      const marker = joinPath(path, DIRECTORY_MARKER);
      const key = await this.key(marker);
      try {
        const etag = await this.remote.put(key, this.codec.encodeContent(""), { ifNoneMatch: true });
        this.objects.set(marker, { key, etag });
        this.rebuild();
        return path;
      } catch (error) {
        if ((error as { code?: string }).code !== "CONFLICT") throw error;
        this.objects.set(marker, { key, etag: "" });
        this.rebuild();
      }
    }
    throw new VaultError("CONFLICT", "A unique name could not be reserved in S3.");
  }

  /** Forgets the keys; the vault is unusable afterwards. */
  close(): void {
    this.codec.wipe();
    this.objects.clear();
  }
}
