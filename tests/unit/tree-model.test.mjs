// Node 22.18+ strips the TypeScript types from the imported source file.
// The sidebar's Trash count is read from the tree model when the sidebar is
// drawn. Restore and Move to Trash apply their delta without drawing (the
// caller draws once, after following the change); a path that then only
// moved the selection left the count and the rows stale. The model now says
// whether its nodes changed since the sidebar was last drawn.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ROOT_ID, TRASH_ID, TreeModel } from "../../src/tree-model.ts";

const folder = (id, parent, name) => ({ id, parent, name, kind: "Folder" });
const doc = (id, parent, name) => ({ id, parent, name, kind: "Document" });
const entry = (key, name, deletedAt) => ({
  id: `trash-${key}`,
  parent: TRASH_ID,
  name,
  kind: "TrashEntry",
  trash_entry_id: key,
  origin: { name, original_path: name, location: "", deleted_at: deletedAt, item_kind: "Document", item_count: 0, doc_count: 1, folder_count: 0, image_count: 0, legacy: false },
});

function drawnModel() {
  const tree = new TreeModel();
  tree.replace({
    version: 10,
    nodes: [
      { id: ROOT_ID, parent: null, name: "Vault", kind: "Root" },
      { id: TRASH_ID, parent: null, name: "Trash", kind: "Trash" },
      folder("folder:Notes", ROOT_ID, "Notes"),
      doc("document:a.md", ROOT_ID, "a.md"),
      entry("bin:2-b-md", "b.md", 2),
      entry("bin:1-c-md", "c.md", 1),
    ],
  });
  tree.markDrawn();
  return tree;
}

test("Delete permanently: the count drops and the sidebar has to be drawn again", () => {
  const tree = drawnModel();
  assert.equal(tree.trashCount(), 2);
  assert.equal(tree.needsDraw, false);
  assert.equal(tree.apply({ from: 10, to: 11, upsert: [], remove: ["trash-bin:2-b-md"] }), true);
  assert.equal(tree.trashCount(), 1);
  assert.deepEqual(tree.trash().map((node) => node.name), ["c.md"]);
  assert.equal(tree.needsDraw, true, "a delta applied without drawing leaves the sidebar stale");
  tree.markDrawn();
  assert.equal(tree.needsDraw, false);
});

test("Empty Trash removes every entry", () => {
  const tree = drawnModel();
  tree.apply({ from: 10, to: 11, upsert: [], remove: ["trash-bin:1-c-md", "trash-bin:2-b-md"] });
  assert.equal(tree.trashCount(), 0);
  assert.deepEqual(tree.trash(), []);
  assert.equal(tree.needsDraw, true);
});

test("Restore: the document is back in its folder, its entry is gone", () => {
  const tree = drawnModel();
  tree.apply({ from: 10, to: 12, upsert: [doc("document:Notes/b.md", "folder:Notes", "b.md")], remove: ["trash-bin:2-b-md"] });
  assert.equal(tree.trashCount(), 1);
  assert.deepEqual(tree.children("folder:Notes").map((node) => node.name), ["b.md"]);
  assert.equal(tree.needsDraw, true, "the restored row and the count wait for a draw");
});

test("Move to Trash: the entry is counted, the document leaves the tree", () => {
  const tree = drawnModel();
  tree.apply({ from: 10, to: 11, upsert: [entry("bin:3-a-md", "a.md", 3)], remove: ["document:a.md"] });
  assert.equal(tree.trashCount(), 3);
  assert.equal(tree.trash()[0].name, "a.md", "newest first");
  assert.equal(tree.has("document:a.md"), false);
  assert.equal(tree.needsDraw, true);
});

test("a delta that waits changes nothing to draw until the one before it arrives", () => {
  const tree = drawnModel();
  assert.equal(tree.apply({ from: 11, to: 12, upsert: [], remove: ["trash-bin:1-c-md"] }), false);
  assert.equal(tree.behind, true);
  assert.equal(tree.trashCount(), 2);
  assert.equal(tree.needsDraw, false);
  assert.equal(tree.apply({ from: 10, to: 11, upsert: [], remove: ["trash-bin:2-b-md"] }), true);
  assert.equal(tree.trashCount(), 0, "both deltas applied in order");
  assert.equal(tree.needsDraw, true);
});

test("a delta already in the snapshot, or one that changes nothing, needs no draw", () => {
  const tree = drawnModel();
  assert.equal(tree.apply({ from: 9, to: 10, upsert: [], remove: ["trash-bin:2-b-md"] }), false);
  assert.equal(tree.apply({ from: 10, to: 10, upsert: [], remove: [] }), false);
  assert.equal(tree.trashCount(), 2);
  assert.equal(tree.needsDraw, false);
});

test("a new snapshot and browser-mode changes need a draw too", () => {
  const tree = drawnModel();
  tree.change([entry("local:x", "x.md", 5)], ["document:a.md"]);
  assert.equal(tree.trashCount(), 3);
  assert.equal(tree.needsDraw, true);
  tree.markDrawn();
  tree.replace({ version: 20, nodes: [{ id: ROOT_ID, parent: null, name: "Vault", kind: "Root" }] });
  assert.equal(tree.trashCount(), 0);
  assert.equal(tree.needsDraw, true);
});
