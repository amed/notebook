import assert from "node:assert/strict";
import { test } from "node:test";
import {
  IMPORT_PARALLEL,
  MAX_IMPORT_BYTES,
  foldersByLevel,
  importProgress,
  importStopped,
  importSummary,
  limitMessage,
  nameProblem,
  shownName,
  planImport,
  readImportText,
  runPool,
  scanDrop,
  uniqueName,
} from "../../src/folder-import.ts";

// FileSystemEntry stand-ins: readEntries answers `batch` entries per call
// (Chromium answers up to 100), asynchronously, then an empty batch.
function file(name, text = "text", type = "") {
  return new File([text], name, { type });
}
function fileEntry(name, value = file(name)) {
  return { name, isFile: true, isDirectory: false, file: (ok) => setTimeout(() => ok(value)) };
}
function dirEntry(name, children, { batch = 2, onRead } = {}) {
  return {
    name,
    isFile: false,
    isDirectory: true,
    createReader() {
      let next = 0;
      return {
        readEntries(ok) {
          onRead?.();
          setTimeout(() => {
            const part = children.slice(next, next + batch);
            next += part.length;
            ok(part);
          });
        },
      };
    },
  };
}
const names = (scan) => scan.files.map(({ folders, file }) => [...folders, file.name].join("/"));

test("a nested drop is walked completely, reading every batch until an empty one", async () => {
  const many = Array.from({ length: 7 }, (_, index) => fileEntry(`note ${index}.md`));
  const drop = dirEntry("04-by-property", [
    fileEntry("readme.md"),
    dirEntry("deep", [dirEntry("deeper", [fileEntry("leaf.txt")]), ...many], { batch: 3 }),
    dirEntry("empty", []),
    fileEntry("page.html"),
  ]);
  const scan = await scanDrop([drop, file("loose.markdown")]);
  assert.equal(scan.over, null);
  assert.deepEqual(scan.folders, [
    ["04-by-property"],
    ["04-by-property", "deep"],
    ["04-by-property", "deep", "deeper"],
    ["04-by-property", "empty"],
  ]);
  assert.deepEqual(names(scan).sort(), [
    "04-by-property/deep/deeper/leaf.txt",
    ...many.map((entry) => `04-by-property/deep/${entry.name}`),
    "04-by-property/page.html",
    "04-by-property/readme.md",
    "loose.markdown",
  ].sort());
});

test("hidden entries are counted, never entered, and unsupported files are skipped", async () => {
  const git = dirEntry(".git", [fileEntry("config")], { onRead: () => assert.fail(".git was entered") });
  const scan = await scanDrop([
    dirEntry("docs", [fileEntry(".DS_Store"), git, fileEntry("photo.png", file("photo.png", "png", "image/png")), fileEntry("data.csv", file("data.csv", "a,b", "text/csv"))]),
    file(".hidden.md"),
  ]);
  assert.equal(scan.hidden, 3);
  assert.deepEqual(names(scan), ["docs/data.csv"]);
  assert.deepEqual(scan.skipped, [{ path: "docs/photo.png", reason: "unsupported file type" }]);
});

test("a drop over a limit stops the walk", async () => {
  let opened = 0;
  const counted = (name) => ({ ...fileEntry(name), file: (ok) => { opened++; setTimeout(() => ok(file(name))); } });
  const big = dirEntry("big", Array.from({ length: 10 }, (_, index) => counted(`${index}.md`)), { batch: 1 });
  const scan = await scanDrop([big], { files: 3, folders: 5, entries: 100 });
  assert.equal(scan.over, "files");
  assert.equal(opened, 4, "the walk stopped at the fourth file");
  const folders = Array.from({ length: 4 }, (_, index) => dirEntry(`f${index}`, []));
  assert.equal((await scanDrop(folders, { files: 10, folders: 3, entries: 100 })).over, "folders");
  const wide = dirEntry("wide", Array.from({ length: 50 }, (_, index) => fileEntry(`${index}.png`)), { batch: 10 });
  assert.equal((await scanDrop([wide], { files: 10, folders: 10, entries: 20 })).over, "entries");
  assert.match(limitMessage("files"), /more than 5,000 files.*at most 5,000 files and 2,000 folders/);
});

test("names collide without case and get a number, as the backend names them", () => {
  const taken = new Set(["04-by-property", "notes.md", "notes 2.md"]);
  assert.equal(uniqueName(taken, "04-By-Property"), "04-By-Property 2");
  assert.equal(uniqueName(taken, "Notes.md"), "Notes 3.md");
  assert.equal(uniqueName(taken, "fresh.md"), "fresh.md");
  assert.equal(uniqueName(new Set([".env"]), ".env"), ".env 2");
});

test("the plan recreates the hierarchy below the target without overwriting", async () => {
  const scan = await scanDrop([
    dirEntry("Projects", [fileEntry("A.md"), fileEntry("a.md"), dirEntry("Sub", [fileEntry("x.md")]), dirEntry("empty", [])]),
    file("Inbox.md"),
  ]);
  const plan = planImport(scan, ["projects", "Inbox.md"]);
  assert.deepEqual(plan.folders.map(({ index, parent, name, depth }) => ({ index, parent, name, depth })), [
    { index: 0, parent: null, name: "Projects 2", depth: 0 },
    { index: 1, parent: 0, name: "Sub", depth: 1 },
    { index: 2, parent: 0, name: "empty", depth: 1 },
  ]);
  assert.deepEqual(plan.files.map(({ folder, name, path }) => ({ folder, name, path })), [
    { folder: 1, name: "x.md", path: "Projects/Sub/x.md" },
    { folder: 0, name: "A.md", path: "Projects/A.md" },
    { folder: 0, name: "a 2.md", path: "Projects/a.md" },
    { folder: null, name: "Inbox 2.md", path: "Inbox.md" },
  ]);
  assert.deepEqual(foldersByLevel(plan.folders).map((level) => level.map((folder) => folder.name)), [["Projects 2"], ["Sub", "empty"]]);
});

test("reserved and invalid names are refused with a reason; a refused folder takes its contents", async () => {
  assert.match(nameProblem("_deleted"), /reserved/);
  assert.match(nameProblem("_Delete"), /reserved/);
  assert.match(nameProblem("a\\b"), /not allowed/);
  assert.match(nameProblem("é".repeat(128)), /255 bytes/);
  assert.equal(nameProblem("_deleted notes"), null);
  const scan = await scanDrop([dirEntry("top", [dirEntry("_deleted", [fileEntry("x.md")]), fileEntry("_delete"), fileEntry("ok.md")])]);
  // "_delete" has no extension and no type: unsupported before its name matters.
  const plan = planImport(scan, []);
  assert.deepEqual(plan.files.map((planned) => planned.path), ["top/ok.md"]);
  assert.deepEqual(plan.folders.map((folder) => folder.name), ["top"]);
  assert.deepEqual(plan.skipped.map((skip) => skip.path).sort(), ["top/_delete", "top/_deleted"]);
  assert.match(plan.skipped.find((skip) => skip.path === "top/_deleted").reason, /reserved.*contents were skipped/);
  const reserved = planImport({ folders: [], files: [{ folders: [], file: file("_deleted", "x", "text/plain") }], skipped: [], hidden: 0, over: null }, []);
  assert.deepEqual(reserved.skipped, [{ path: "_deleted", reason: "the name is reserved for deleted items" }]);
});

test("files over 16 MiB are skipped before reading; text must be strict UTF-8", async () => {
  const big = { name: "big.md", size: MAX_IMPORT_BYTES + 1, type: "", arrayBuffer: () => assert.fail("read") };
  const plan = planImport({ folders: [], files: [{ folders: [], file: big }], skipped: [], hidden: 0, over: null }, []);
  assert.deepEqual(plan.skipped, [{ path: "big.md", reason: "files are limited to 16 MiB" }]);
  await assert.rejects(readImportText(big), /16 MiB/);
  assert.equal(await readImportText(file("ok.md", "héllo")), "héllo");
  await assert.rejects(readImportText(new File([new Uint8Array([0x68, 0xff, 0x69])], "bad.md")), /not UTF-8/);
});

test("the pool runs every job, at most 8 at a time", async () => {
  let running = 0;
  let most = 0;
  const done = [];
  await runPool(Array.from({ length: 30 }, (_, index) => index), IMPORT_PARALLEL, async (index) => {
    running++;
    most = Math.max(most, running);
    await new Promise((resolve) => setTimeout(resolve, index % 3));
    running--;
    done.push(index);
  });
  assert.equal(IMPORT_PARALLEL, 8);
  assert.equal(most, 8);
  assert.deepEqual(done.sort((a, b) => a - b), Array.from({ length: 30 }, (_, index) => index));
  await runPool([], 8, async () => assert.fail("no job"));
});

test("one summary: counts, the first 20 names with reasons, never contents", () => {
  assert.equal(importSummary({ files: 3, folders: 1, skipped: [], failed: [], hidden: 2 }), null);
  const skipped = Array.from({ length: 23 }, (_, index) => ({ path: `docs/img ${index}.png`, reason: "unsupported file type" }));
  const failed = [{ path: "docs/bad.md", reason: "the file is not UTF-8 text" }];
  const summary = importSummary({ files: 12, folders: 3, skipped, failed, hidden: 1 });
  assert.equal(summary.title, "Some items were not imported");
  const lines = summary.text.split("\n");
  assert.equal(lines[0], "Imported 12 files and 3 folders.");
  assert.equal(lines[1], "23 items skipped, 1 item failed, 1 hidden item left out.");
  assert.equal(lines[2], "docs/bad.md: the file is not UTF-8 text");
  assert.equal(lines.length, 2 + 20 + 1);
  assert.equal(lines.at(-1), "…and 4 more.");
  const nothing = importSummary({ files: 0, folders: 0, skipped: [{ path: "04-by-property/a.png", reason: "unsupported file type" }], failed: [], hidden: 0 });
  assert.equal(nothing.title, "Nothing was imported");
  assert.equal(nothing.text.split("\n")[0], "1 item skipped.");
  assert.equal(importSummary({ files: 1, folders: 0, skipped: [{ path: "a.png", reason: "unsupported file type" }], failed: [], hidden: 0 }).text.split("\n")[0], "Imported 1 file.");
  assert.equal(importProgress(11, 340), "Importing 12 of 340…");
  assert.equal(importProgress(340, 340), "Importing 340 of 340…");
});

test("control and text-direction characters are refused and never reach the dialog as such", async () => {
  for (const name of ["a\nImported 5,000 files.\nb.md", "x\u202Egnp.md", "tab\there.md", "bell\u0007.md", "c1\u0085.md", "iso\u2066late.md"]) {
    assert.match(nameProblem(name), /control or text-direction/, JSON.stringify(name));
  }
  assert.equal(nameProblem("Résumé – 日本語.md"), null);
  const scan = await scanDrop([dirEntry("top", [fileEntry("a\nImported 5,000 files.\nb.png"), fileEntry("x\u202Egnp.md"), fileEntry("ok.md")])]);
  const plan = planImport(scan, []);
  assert.deepEqual(plan.files.map((planned) => planned.path), ["top/ok.md"]);
  const summary = importSummary({ files: 1, folders: 1, skipped: plan.skipped, failed: [], hidden: 0 });
  const lines = summary.text.split("\n");
  assert.equal(lines.length, 2 + 2, "one line per problem, none forged");
  assert.ok(lines.every((line) => !/[\u202E\u0000-\u001F]/.test(line)));
  assert.equal(shownName("a\nb\u202Ec"), "a\uFFFDb\uFFFDc");
});

test("names with leading spaces before a dot are hidden as well", async () => {
  const scan = await scanDrop([dirEntry("top", [dirEntry(" .git", [fileEntry("config.txt")]), fileEntry("  .DS_Store"), fileEntry("ok.md")])]);
  assert.equal(scan.hidden, 2);
  assert.deepEqual(scan.folders, [["top"]]);
  assert.deepEqual(names(scan), ["top/ok.md"]);
});

test("a folder that cannot be read is reported and not created", async () => {
  let calls = 0;
  const broken = {
    name: "top",
    isFile: false,
    isDirectory: true,
    createReader: () => ({
      readEntries(ok, fail) {
        calls++;
        setTimeout(() => (calls === 1 ? ok([fileEntry("a.md"), fileEntry("b.md")]) : fail(new Error("gone"))));
      },
    }),
  };
  const scan = await scanDrop([dirEntry("outer", [broken, fileEntry("c.md")])]);
  assert.deepEqual(scan.folders, [["outer"]], "top is not planned as an empty folder");
  assert.deepEqual(names(scan), ["outer/c.md"]);
  assert.deepEqual(scan.skipped, [{ path: "outer/top", reason: "could not be read" }]);
  const summary = importSummary({ files: 1, folders: 1, skipped: scan.skipped, failed: [], hidden: 0 });
  assert.equal(summary.text, "Imported 1 file and 1 folder.\n1 item skipped.\nouter/top: could not be read");
});

test("an import stopped by a lock or switch is summarized without names", () => {
  assert.equal(importStopped(3, 1), "The import stopped because the workspace was locked or switched. 3 files and 1 folder were imported before it stopped.");
  assert.equal(importStopped(0, 0), "The import stopped because the workspace was locked or switched. Nothing was imported.");
});
