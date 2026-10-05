// The sidebar tree as data: nodes by id, sorted children, paths and search.
// Indexes are rebuilt only when the nodes change (a snapshot or a delta), and
// deltas apply in version order. No DOM, so tests/unit can run it.
import { kindName, type TreeDelta, type TreeNode, type TreeSnapshot } from "./ipc";

export const ROOT_ID = "00000000-0000-0000-0000-000000000001";
export const TRASH_ID = "00000000-0000-0000-0000-000000000002";

/** A row of the sidebar: a folder or document and its indentation. */
export type TreeItem = { node: TreeNode; depth: number };

const collator = new Intl.Collator();

/** Folders first, then by name, as the sidebar always sorted. */
function compare(a: TreeNode, b: TreeNode): number {
  return Number(kindName(b) === "Folder") - Number(kindName(a) === "Folder") || collator.compare(a.name, b.name);
}

/** Code-unit order, like Rust's string order the Trash catalog uses. */
function order(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function inTree(node: TreeNode): boolean {
  const kind = kindName(node);
  return kind === "Folder" || kind === "Document";
}

type Index = { children: Map<string, TreeNode[]>; lower: Map<string, string>; trash: number };

export class TreeModel {
  /** The backend's tree version these nodes are (0 before the first snapshot). */
  version = 0;
  /** Insertion order is snapshot order, then nodes added later. */
  private byId = new Map<string, TreeNode>();
  private index: Index | null = null;
  /** Deltas that arrived before the one they follow, by their `from`. */
  private waiting = new Map<number, TreeDelta>();

  replace(snapshot: TreeSnapshot): void {
    this.byId = new Map(snapshot.nodes.map((node) => [node.id, node]));
    this.version = snapshot.version ?? 0;
    for (const [from, delta] of this.waiting) if (delta.to <= this.version || from < this.version) this.waiting.delete(from);
    this.index = null;
    this.drain();
  }

  /**
   * Applies `delta` when it follows the current version, and then every
   * waiting delta that follows it. A delta from before the current version
   * (already in a snapshot) is ignored; one from after it waits. Returns
   * whether the nodes changed.
   */
  apply(delta: TreeDelta | null | undefined): boolean {
    if (!delta || delta.from === delta.to || delta.to <= this.version) return false;
    if (delta.from !== this.version) {
      this.waiting.set(delta.from, delta);
      return false;
    }
    this.patch(delta);
    this.drain();
    return true;
  }

  /** A delta is missing: the nodes are behind the backend until it arrives. */
  get behind(): boolean {
    return this.waiting.size > 0;
  }

  /** Browser mode: changes made on the page, without versions. */
  change(upsert: TreeNode[], remove: string[] = []): void {
    for (const id of remove) this.byId.delete(id);
    for (const node of upsert) this.byId.set(node.id, node);
    this.index = null;
  }

  get(id: string | null | undefined): TreeNode | undefined {
    return id ? this.byId.get(id) : undefined;
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  get size(): number {
    return this.byId.size;
  }

  nodes(): IterableIterator<TreeNode> {
    return this.byId.values();
  }

  /** The folders and documents in `parent`, sorted. */
  children(parent: string): readonly TreeNode[] {
    return this.indexed().children.get(parent) ?? [];
  }

  /** The rows of the tree with the folders in `expanded` open. */
  visible(expanded: ReadonlySet<string>): TreeItem[] {
    const items: TreeItem[] = [];
    const visit = (parent: string, depth: number): void => {
      for (const node of this.children(parent)) {
        items.push({ node, depth });
        if (expanded.has(node.id)) visit(node.id, depth + 1);
      }
    };
    visit(ROOT_ID, 0);
    return items;
  }

  /** Folders and documents whose name contains `query`, sorted, at most `limit`. */
  search(query: string, limit: number): { items: TreeItem[]; more: number } {
    const wanted = query.trim().toLocaleLowerCase();
    const { lower } = this.indexed();
    const found: TreeNode[] = [];
    for (const [id, name] of lower) if (name.includes(wanted)) found.push(this.byId.get(id)!);
    found.sort(compare);
    return { items: found.slice(0, limit).map((node) => ({ node, depth: 0 })), more: Math.max(0, found.length - limit) };
  }

  trashCount(): number {
    return this.indexed().trash;
  }

  /** Trash entries in Notebook's order: newest first, then by name; earlier builds' entries last. */
  trash(): TreeNode[] {
    const entries = [...this.byId.values()].filter((node) => kindName(node) === "TrashEntry");
    const legacy = (node: TreeNode): number => Number(node.origin?.legacy ?? false);
    return entries.sort((a, b) =>
      legacy(a) - legacy(b)
      || (b.origin?.deleted_at ?? -1) - (a.origin?.deleted_at ?? -1)
      || order(a.name.toLowerCase(), b.name.toLowerCase())
      || order(a.trash_entry_id ?? a.id, b.trash_entry_id ?? b.id));
  }

  /** "/a/b.md" for a folder or document. */
  pathOf(id: string): string {
    const parts: string[] = [];
    for (let node = this.byId.get(id); node && node.id !== ROOT_ID; node = node.parent ? this.byId.get(node.parent) : undefined) {
      parts.unshift(node.name);
    }
    return `/${parts.join("/")}`;
  }

  /** The folder or document of `kind` at "/a/b.md". */
  find(kind: "Folder" | "Document", path: string): TreeNode | undefined {
    const parts = path.split("/").filter(Boolean);
    let parent = ROOT_ID;
    let found: TreeNode | undefined;
    for (const [index, part] of parts.entries()) {
      const want = index === parts.length - 1 ? kind : "Folder";
      found = this.children(parent).find((node) => node.name === part && kindName(node) === want);
      if (!found) return undefined;
      parent = found.id;
    }
    return found;
  }

  /** The first document of the snapshot order (the one opened after unlock). */
  firstDocument(): string | undefined {
    for (const node of this.byId.values()) if (kindName(node) === "Document") return node.id;
    return undefined;
  }

  private patch(delta: TreeDelta): void {
    for (const id of delta.remove) this.byId.delete(id);
    for (const node of delta.upsert) this.byId.set(node.id, node);
    this.version = delta.to;
    this.index = null;
  }

  private drain(): void {
    for (let next = this.waiting.get(this.version); next; next = this.waiting.get(this.version)) {
      this.waiting.delete(this.version);
      this.patch(next);
    }
  }

  private indexed(): Index {
    if (this.index) return this.index;
    const children = new Map<string, TreeNode[]>();
    const lower = new Map<string, string>();
    let trash = 0;
    for (const node of this.byId.values()) {
      if (kindName(node) === "TrashEntry") trash++;
      if (!inTree(node) || !node.parent) continue;
      const siblings = children.get(node.parent);
      if (siblings) siblings.push(node);
      else children.set(node.parent, [node]);
      lower.set(node.id, node.name.toLocaleLowerCase());
    }
    for (const siblings of children.values()) siblings.sort(compare);
    this.index = { children, lower, trash };
    return this.index;
  }
}
