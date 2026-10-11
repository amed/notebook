// Node 22.18+ strips the TypeScript types from the imported source file.
import assert from "node:assert/strict";
import { test } from "node:test";
import { documentWindowProblem, documentWindowRequest, documentWindowUrl } from "../../src/document-window.ts";

const ID = `n-${"a".repeat(64)}`;

test("only ?window=document is a document window", () => {
  assert.equal(documentWindowRequest(""), null);
  assert.equal(documentWindowRequest("?id=n-1"), null);
  assert.equal(documentWindowRequest("?window=main&id=n-1"), null);
  assert.deepEqual(documentWindowRequest(`?window=document&id=${ID}`), { id: ID });
});

test("the id round-trips through the URL, encoded", () => {
  const odd = "n-a b&c=d/é?#";
  const url = documentWindowUrl(odd);
  assert.ok(!url.includes(" ") && !url.includes("é") && !url.includes("#"), url);
  assert.deepEqual(documentWindowRequest(url.slice(url.indexOf("?"))), { id: odd });
  // window.rs encodes the same way (form encoding).
  assert.deepEqual(documentWindowRequest("?window=document&id=n-a+b%26c%3Dd%2F%C3%A9%3F%23"), { id: odd });
});

test("a missing or oversized id is unusable, not another document", () => {
  assert.deepEqual(documentWindowRequest("?window=document"), { id: "" });
  assert.deepEqual(documentWindowRequest(`?window=document&id=${"x".repeat(257)}`), { id: "" });
});

test("a window without a document says why and never shows a name", () => {
  assert.equal(documentWindowProblem("LOCKED").title, "Workspace locked");
  assert.equal(documentWindowProblem("WINDOW_STALE").title, "Workspace locked");
  assert.equal(documentWindowProblem("INVALID_INPUT").title, "Document not found");
  assert.equal(documentWindowProblem(null).title, "Document not opened");
});
