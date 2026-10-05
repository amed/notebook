// The Markdown preview replaces only the changed run of top-level blocks
// (src/dom-patch.ts), so typing in one paragraph swaps one block.
import assert from "node:assert/strict";
import { test } from "node:test";
import { changedRun } from "../../src/dom-patch.ts";

const same = (a, b) => a === b;
const apply = (old, next) => {
  const { start, endOld, endNext } = changedRun(old, next, same);
  return { result: [...old.slice(0, start), ...next.slice(start, endNext), ...old.slice(endOld)], replaced: endOld - start, inserted: endNext - start };
};

test("an edit inside one block replaces exactly that block", () => {
  const { result, replaced, inserted } = apply(["h1", "p1", "p2", "p3"], ["h1", "p1", "p2*", "p3"]);
  assert.deepEqual(result, ["h1", "p1", "p2*", "p3"]);
  assert.equal(replaced, 1);
  assert.equal(inserted, 1);
});

test("unchanged blocks are not touched", () => {
  assert.deepEqual(changedRun(["a", "b"], ["a", "b"], same), { start: 2, endOld: 2, endNext: 2 });
});

test("inserted, removed and repeated blocks keep the result exact", () => {
  for (const [old, next] of [
    [["a", "b", "c"], ["a", "x", "b", "c"]],
    [["a", "b", "c"], ["a", "c"]],
    [["a", "a", "a"], ["a", "a"]],
    [["a", "b", "a"], ["a", "a"]],
    [[], ["a", "b"]],
    [["a", "b"], []],
    [["a", "b", "c"], ["x", "y", "z"]],
  ]) {
    assert.deepEqual(apply(old, next).result, next, JSON.stringify([old, next]));
  }
});
