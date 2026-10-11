// The sidebar tree's DOM. Rows are kept by node id and reused: selecting
// changes two rows, expanding inserts or removes only that folder's rows, and
// a change to the nodes touches only the rows that changed. One set of
// listeners on the tree serves every row.
import { kindName, type TreeNode } from "./ipc";
import type { TreeItem, TreeModel } from "./tree-model";
import { icon } from "./ui/primitives";

interface TreeViewState {
  selected: string;
  expanded: ReadonlySet<string>;
  query: string;
}

interface TreeActions {
  activate(id: string): void;
  rename(id: string): void;
  menu(id: string, x: number, y: number): void;
  key(id: string, event: KeyboardEvent): void;
  /** `moved` was dropped on the folder `folder`. */
  drop(moved: string, folder: string): void;
}

/** Search shows at most this many rows, then "N more". */
const SEARCH_LIMIT = 200;
const NODE_TYPE = "text/x-notebook-node";

type Row = { element: HTMLElement; label: HTMLElement; disclosure: HTMLElement; name: string; depth: number; open: boolean | null };

export class TreeView {
  private rows = new Map<string, Row>();
  private shown: string[] = [];
  private selected: string | null = null;
  private more: HTMLElement | null = null;
  private readonly icons: Record<"chevron" | "folder" | "document", HTMLElement>;

  constructor(private readonly host: HTMLElement, private readonly model: TreeModel, actions: TreeActions) {
    this.icons = { chevron: icon("chevron"), folder: icon("folder"), document: icon("document") };
    const rowAt = (target: EventTarget | null): HTMLElement | null =>
      target instanceof Element ? target.closest<HTMLElement>(".tree-row[data-node-id]") : null;
    const folderAt = (target: EventTarget | null): HTMLElement | null => {
      const row = rowAt(target);
      const node = this.model.get(row?.dataset.nodeId);
      return row && node && kindName(node) === "Folder" ? row : null;
    };
    host.addEventListener("click", (event) => {
      const id = rowAt(event.target)?.dataset.nodeId;
      if (id) actions.activate(id);
    });
    host.addEventListener("dblclick", (event) => {
      const id = rowAt(event.target)?.dataset.nodeId;
      if (!id) return;
      event.preventDefault();
      actions.rename(id);
    });
    host.addEventListener("contextmenu", (event) => {
      const id = rowAt(event.target)?.dataset.nodeId;
      if (!id) return;
      event.preventDefault();
      actions.menu(id, event.clientX, event.clientY);
    });
    host.addEventListener("keydown", (event) => {
      const id = rowAt(event.target)?.dataset.nodeId;
      if (id) actions.key(id, event);
    });
    host.addEventListener("dragstart", (event) => {
      const id = rowAt(event.target)?.dataset.nodeId;
      if (id) event.dataTransfer?.setData(NODE_TYPE, id);
    });
    host.addEventListener("dragover", (event) => {
      const row = folderAt(event.target);
      if (!row) return;
      event.preventDefault();
      row.classList.add("drop-target");
    });
    host.addEventListener("dragleave", (event) => {
      const row = rowAt(event.target);
      if (row && !(event.relatedTarget instanceof Node && row.contains(event.relatedTarget))) row.classList.remove("drop-target");
    });
    host.addEventListener("drop", (event) => {
      const row = folderAt(event.target);
      if (!row) return;
      event.preventDefault();
      row.classList.remove("drop-target");
      const moved = event.dataTransfer?.getData(NODE_TYPE);
      const folder = row.dataset.nodeId!;
      if (moved && moved !== folder) actions.drop(moved, folder);
    });
  }

  /** Shows the tree (or the search results) for `state`, changing only rows that differ. */
  render(state: TreeViewState): void {
    let items: TreeItem[];
    let more = 0;
    if (state.query.trim()) ({ items, more } = this.model.search(state.query, SEARCH_LIMIT));
    else items = this.model.visible(state.expanded);
    const desired: HTMLElement[] = [];
    this.shown = [];
    for (const { node, depth } of items) {
      const kind = kindName(node);
      const row = this.rows.get(node.id) ?? this.create(node, kind);
      this.update(row, node, depth, kind === "Folder" ? state.expanded.has(node.id) : null);
      desired.push(row.element);
      this.shown.push(node.id);
    }
    if (more) desired.push(this.moreRow(more));
    this.select(state.selected);
    reconcile(this.host, desired);
    // Rows of nodes that are gone are not kept.
    for (const id of this.rows.keys()) if (!this.model.has(id)) this.rows.delete(id);
  }

  /** Moves the selection: two rows change, and the focus stays where it is. */
  select(id: string): void {
    if (id !== this.selected) {
      const previous = this.selected === null ? undefined : this.rows.get(this.selected);
      if (previous) setSelected(previous.element, false);
      this.selected = id;
    }
    const row = this.rows.get(id);
    if (row) setSelected(row.element, true);
  }

  focus(id: string): void {
    const row = this.rows.get(id);
    if (row?.element.isConnected) row.element.focus();
  }

  /** The ids of the rows shown, top to bottom. */
  ids(): readonly string[] {
    return this.shown;
  }

  /** The row element of `id`, if shown. */
  element(id: string): HTMLElement | undefined {
    const row = this.rows.get(id);
    return row?.element.isConnected ? row.element : undefined;
  }

  clear(): void {
    this.rows.clear();
    this.shown = [];
    this.selected = null;
    this.host.replaceChildren();
  }

  private create(node: TreeNode, kind: string): Row {
    const element = document.createElement("div");
    element.className = "tree-row";
    element.setAttribute("role", "treeitem");
    element.dataset.nodeId = node.id;
    element.tabIndex = -1;
    element.setAttribute("aria-selected", "false");
    element.draggable = true;
    const disclosure = document.createElement("span");
    disclosure.className = "disclosure";
    if (kind === "Folder") disclosure.append(this.icons.chevron.cloneNode(true));
    const nodeIcon = document.createElement("span");
    nodeIcon.className = "node-icon";
    nodeIcon.append(this.icons[kind === "Folder" ? "folder" : "document"].cloneNode(true));
    const label = document.createElement("span");
    label.className = "node-label";
    element.append(disclosure, nodeIcon, label);
    const row: Row = { element, label, disclosure, name: "", depth: -1, open: null };
    this.rows.set(node.id, row);
    return row;
  }

  private update(row: Row, node: TreeNode, depth: number, open: boolean | null): void {
    if (row.name !== node.name) {
      row.name = node.name;
      row.label.textContent = node.name;
    }
    if (row.depth !== depth) {
      row.depth = depth;
      row.element.style.paddingLeft = `${7 + depth * 15}px`;
    }
    if (row.open !== open) {
      row.open = open;
      row.disclosure.classList.toggle("open", open === true);
      if (open !== null) row.element.setAttribute("aria-expanded", String(open));
    }
  }

  private moreRow(count: number): HTMLElement {
    if (!this.more) {
      this.more = document.createElement("div");
      this.more.className = "tree-more";
      this.more.setAttribute("role", "treeitem");
      this.more.setAttribute("aria-disabled", "true");
    }
    const text = `${count.toLocaleString()} more — type more of the name`;
    if (this.more.textContent !== text) this.more.textContent = text;
    return this.more;
  }
}

/** Writes only when the row's state differs, so an unchanged row costs nothing. */
function setSelected(element: HTMLElement, selected: boolean): void {
  if ((element.tabIndex === 0) === selected) return;
  element.classList.toggle("selected", selected);
  element.tabIndex = selected ? 0 : -1;
  element.setAttribute("aria-selected", String(selected));
}

/**
 * Makes `host`'s children exactly `desired`, in order, with few mutations:
 * rows that left are removed, new rows are inserted in runs, and rows that
 * stay are moved only when their order changed.
 */
function reconcile(host: HTMLElement, desired: readonly HTMLElement[]): void {
  const keep = new Set(desired);
  for (const child of [...host.children]) if (!keep.has(child as HTMLElement)) child.remove();
  let cursor = host.firstElementChild;
  let run: DocumentFragment | null = null;
  const flush = (): void => {
    if (!run) return;
    host.insertBefore(run, cursor);
    run = null;
  };
  for (const element of desired) {
    if (element === cursor) {
      flush();
      cursor = cursor.nextElementSibling;
    } else if (element.parentNode !== host) {
      (run ??= document.createDocumentFragment()).append(element);
    } else {
      flush();
      host.insertBefore(element, cursor);
    }
  }
  flush();
}
