import assert from "node:assert/strict";
import { test } from "node:test";
import { parseVaultFilePath } from "../../src/file-path.ts";

test("new file paths default to Markdown and stay rooted", () => {
  assert.deepEqual(parseVaultFilePath("/projects/current/Release notes"), {
    directories: ["projects", "current"],
    name: "Release notes.md",
    absolute: "/projects/current/Release notes.md",
  });
});

test("explicit HTML and text extensions are preserved", () => {
  assert.equal(parseVaultFilePath("/site/index.html").name, "index.html");
  assert.equal(parseVaultFilePath("notes.txt").name, "notes.txt");
});

test("unsafe, reserved and folder-only paths are rejected", () => {
  for (const path of ["/folder/", "/../note", "/_deleted/note", "folder\\note", "/.secure-vault-dir/note"]) {
    assert.throws(() => parseVaultFilePath(path), undefined, path);
  }
});
