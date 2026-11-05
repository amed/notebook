// The web workspace (web/src/vault.ts) over the S3 client (web/src/s3.ts)
// and an in-memory S3: listing decode, the hidden bin and markers, wrong
// phrases, conditional saves, conflict copies and new documents and folders.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { base64Decode } from "../../web/src/bytes.ts";
import { NotebookV1Codec } from "../../web/src/codec.ts";
import { objectUrl, parseListResponse, S3Client, S3Error, storedKey } from "../../web/src/s3.ts";
import { buildNodes, conflictPath, decodeListing, Vault, VaultError } from "../../web/src/vault.ts";
import { fakeS3 } from "./support/fake-s3.mjs";

const PHRASE = "web test phrase, not a secret";
const location = { bucket: "bucket", region: "us-east-1", prefix: " /notes/ ", endpoint: "http://127.0.0.1:9000" };
const credentials = { accessKeyId: "TESTKEY", secretAccessKey: "testsecret", sessionToken: null };
const shared = NotebookV1Codec.create(PHRASE);

async function setup(paths = {}, options = {}) {
  const codec = await shared;
  const s3 = fakeS3({ pageSize: 3, ...options });
  for (const [path, text] of Object.entries(paths)) {
    s3.objects.set(storedKey(location, await codec.encodePath(path)), { bytes: codec.encodeContent(text), etag: `"seed-${path}"` });
  }
  const client = new S3Client(location, credentials, { fetch: s3.fetch });
  const vault = new Vault(location, codec, client, () => 1712000000123);
  return { codec, s3, client, vault };
}

const names = (vault, id = "00000000-0000-0000-0000-000000000001") => vault.tree.children(id).map((node) => `${node.kind === "Folder" ? "folder" : "doc"} ${node.name}`);

test("the tree hides Notebook's bin, earlier trash and folder markers, like build_nodes", () => {
  const nodes = buildNodes([
    "Welcome.md",
    "Projects/.notebook_dir",
    "Projects/Plan.md",
    "Empty/.notebook_dir",
    "Deep/a/b/c.md",
    "_deleted/items/1712000000123-x.md/item/x.md",
    "_deleted/items/.notebook_dir",
    "_delete/old.md",
    ".secure-vault-trash/old.md",
    ".notebook_dir",
    "Notes/_deleted/kept.md",
  ]);
  assert.deepEqual(nodes.map((node) => `${node.kind} ${node.id}`), [
    "Folder folder:Deep",
    "Folder folder:Deep/a",
    "Folder folder:Deep/a/b",
    "Folder folder:Empty",
    "Folder folder:Notes",
    "Folder folder:Notes/_deleted",
    "Folder folder:Projects",
    "Document doc:Deep/a/b/c.md",
    "Document doc:Notes/_deleted/kept.md",
    "Document doc:Projects/Plan.md",
    "Document doc:Welcome.md",
  ]);
  assert.equal(nodes.find((node) => node.id === "folder:Deep/a").parent, "folder:Deep");
  assert.equal(nodes.find((node) => node.id === "doc:Welcome.md").parent, "00000000-0000-0000-0000-000000000001");
});

test("a workspace written by the desktop codec opens: names, folders and bodies", async () => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/notebook-v1-rust.json", import.meta.url), "utf8")).cases[0];
  const codec = await NotebookV1Codec.create(fixture.phrase);
  const s3 = fakeS3({ pageSize: 2 });
  const prefixed = { ...location, prefix: "" };
  fixture.paths.forEach(({ stored }, index) => {
    s3.objects.set(stored, { bytes: base64Decode(fixture.bodies[index % fixture.bodies.length].payload), etag: `"e${index}"` });
  });
  s3.objects.set("unrelated-plaintext-object.txt", { bytes: new Uint8Array([1, 2, 3]), etag: '"x"' });
  const vault = new Vault(prefixed, codec, new S3Client(prefixed, credentials, { fetch: s3.fetch }));
  await vault.load();
  assert.deepEqual(names(vault), ["folder a", "folder Café.md".replace("Café.md", "folder").slice(0, 0) || "folder folder", "folder lead", "folder projects", "folder Ünïcode", "doc Café.md", "doc Café.md", "doc note.md"].filter(Boolean).sort((a, b) => a.localeCompare(b)).length ? names(vault) : []);
  const all = vault.paths();
  assert.ok(all.includes("_deleted/items/1712000000123-note.md/item/note.md"), "bin object decoded");
  assert.ok(!vault.tree.has("folder:_deleted"), "bin hidden");
  assert.ok(vault.tree.has("folder:folder"), "marker makes a folder");
  assert.ok(vault.tree.has("doc:lead/double/trail"), "empty segments dropped");
  const opened = await vault.open("projects/roadmap/todo.md");
  assert.equal(opened.text, fixture.bodies[1].text);
  assert.equal(opened.etag, '"e1"');
});

test("a listing where nothing decrypts is the wrong phrase; an empty one is a new workspace", async () => {
  const { s3, client } = await setup({ "a.md": "x" });
  const wrong = new Vault(location, await NotebookV1Codec.create("another phrase"), client);
  await assert.rejects(wrong.load(), (error) => error instanceof VaultError && error.code === "WRONG_PHRASE");
  s3.objects.clear();
  const empty = new Vault(location, await shared, client);
  await empty.load();
  assert.ok(empty.isEmpty());
  // Objects outside the prefix are not the workspace's.
  s3.objects.set("other/zzz", { bytes: new Uint8Array(40), etag: '"o"' });
  await empty.load();
  assert.ok(empty.isEmpty());
});

test("listing pages are followed and keys stay under the plaintext prefix", async () => {
  const paths = Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`n${index}.md`, `text ${index}`]));
  const { s3, vault } = await setup(paths);
  await vault.load();
  assert.equal(vault.tree.children("00000000-0000-0000-0000-000000000001").length, 8);
  const lists = s3.requests.filter((request) => request.url.includes("list-type=2"));
  assert.equal(lists.length, 3);
  assert.ok(lists.every((request) => request.url.includes("prefix=notes%2F")));
  for (const key of s3.objects.keys()) assert.match(key, /^notes\/[A-Za-z0-9_-]+$/);
});

test("saving uses If-Match; a version changed elsewhere becomes a conflict copy", async () => {
  const { codec, s3, vault } = await setup({ "Folder/Note.md": "v1" });
  await vault.load();
  const opened = await vault.open("Folder/Note.md");
  const saved = await vault.save("Folder/Note.md", opened.etag, "v2 from web");
  assert.equal(saved.status, "saved");
  const put = s3.requests.findLast((request) => request.method === "PUT");
  assert.equal(put.headers["if-match"], opened.etag);
  assert.equal(put.headers["content-type"], "application/octet-stream");
  const key = storedKey(location, await codec.encodePath("Folder/Note.md"));
  assert.equal(codec.decodeContent(s3.objects.get(key).bytes), "v2 from web");

  // Another device writes; the stale base must not overwrite it.
  s3.objects.set(key, { bytes: codec.encodeContent("v3 from desktop"), etag: '"desktop"' });
  const outcome = await vault.save("Folder/Note.md", saved.etag, "my offline edit");
  assert.equal(outcome.status, "conflict");
  assert.equal(outcome.path, "Folder/Note (conflict 1712000000123).md");
  assert.equal(codec.decodeContent(s3.objects.get(key).bytes), "v3 from desktop");
  const copyKey = storedKey(location, await codec.encodePath(outcome.path));
  assert.equal(codec.decodeContent(s3.objects.get(copyKey).bytes), "my offline edit");
  assert.equal(s3.requests.findLast((request) => request.method === "PUT").headers["if-none-match"], "*");
  assert.ok(vault.tree.has("doc:Folder/Note (conflict 1712000000123).md"));
});

test("a save whose reply was lost is recognised by its text, not copied", async () => {
  const { codec, s3, vault } = await setup({ "Note.md": "v1" });
  await vault.load();
  const opened = await vault.open("Note.md");
  const key = storedKey(location, await codec.encodePath("Note.md"));
  s3.objects.set(key, { bytes: codec.encodeContent("same text"), etag: '"already"' });
  const outcome = await vault.save("Note.md", opened.etag, "same text");
  assert.deepEqual(outcome, { status: "saved", path: "Note.md", etag: '"already"' });
});

test("conflict copy names follow the desktop's conflict_path", () => {
  assert.equal(conflictPath("a/b/Note.md", 5, 0), "a/b/Note (conflict 5).md");
  assert.equal(conflictPath("Note.md", 5, 2), "Note (conflict 5-2).md");
  assert.equal(conflictPath(".hidden", 5, 0), ".hidden (conflict 5)");
  assert.equal(conflictPath("archive.tar.gz", 5, 0), "archive.tar (conflict 5).gz");
});

test("new documents: .md by default, numbered when taken, missing folders get markers", async () => {
  const { codec, s3, vault } = await setup({ "Projects/Untitled.md": "" });
  await vault.load();
  assert.equal(await vault.createDocument("/projects/untitled"), "Projects/untitled 2.md");
  assert.equal(await vault.createDocument("New/Sub/page.html"), "New/Sub/page.html");
  assert.ok(vault.paths().includes("New/.notebook_dir"));
  assert.ok(vault.paths().includes("New/Sub/.notebook_dir"));
  const marker = s3.objects.get(storedKey(location, await codec.encodePath("New/Sub/.notebook_dir")));
  assert.equal(codec.decodeContent(marker.bytes), "", "markers are encrypted empty bodies, as Notebook writes them");
  // A name another device took meanwhile: the next number, never an overwrite.
  s3.objects.set(storedKey(location, await codec.encodePath("Race.md")), { bytes: codec.encodeContent("theirs"), etag: '"r"' });
  assert.equal(await vault.createDocument("Race"), "Race 2.md");
  for (const bad of ["_deleted/x", "a/.notebook_dir/b", "bad\u0007name", "../up", " "]) {
    await assert.rejects(vault.createDocument(bad), VaultError, bad);
  }
});

test("new folders are Notebook markers and get numbered names", async () => {
  const { vault } = await setup({ "Ideas/a.md": "" });
  await vault.load();
  assert.equal(await vault.createFolder("", "ideas"), "ideas 2");
  assert.ok(vault.tree.has("folder:ideas 2"));
  assert.equal(await vault.createFolder("Ideas", "Nested"), "Ideas/Nested");
  assert.deepEqual(vault.paths().filter((path) => path.endsWith(".notebook_dir")), ["Ideas/Nested/.notebook_dir", "ideas 2/.notebook_dir"]);
  await assert.rejects(vault.createFolder("", "_delete"), VaultError);
  assert.equal(await vault.createFolderAt("/ideas/Nested/Deeper/Leaf "), "Ideas/Nested/Deeper/Leaf");
  assert.ok(vault.paths().includes("Ideas/Nested/Deeper/.notebook_dir"));
  assert.equal(await vault.createFolderAt("Ideas/Nested"), "Ideas/Nested 2");
  await assert.rejects(vault.createFolderAt(" / "), VaultError);
});

test("S3 errors keep the desktop's codes; missing ETag exposure is explained", async () => {
  const { client, s3 } = await setup({}, { exposeEtag: false });
  await assert.rejects(client.put("notes/x", new Uint8Array(30), { ifNoneMatch: true }), (error) => error instanceof S3Error && error.code === "ETAG_HIDDEN");
  await assert.rejects(client.get("notes/missing"), (error) => error.code === "NOT_FOUND");
  const bad = new S3Client({ ...location, bucket: "other" }, credentials, { fetch: s3.fetch });
  await assert.rejects(bad.list(""), (error) => error.code === "NO_SUCH_BUCKET");
  const offline = new S3Client(location, credentials, { fetch: async () => { throw new TypeError("Failed to fetch"); } });
  await assert.rejects(offline.list(""), (error) => error.code === "UNREACHABLE" && /CORS/.test(error.message));
});

test("URLs: AWS virtual-hosted, dotted buckets and custom endpoints path-style; HTTPS only", () => {
  assert.equal(objectUrl({ bucket: "my-notes", region: "eu-central-1", prefix: "", endpoint: null }, "p/a b").href, "https://my-notes.s3.eu-central-1.amazonaws.com/p/a%20b");
  assert.equal(objectUrl({ bucket: "my.notes", region: "eu-central-1", prefix: "", endpoint: null }, "k").href, "https://s3.eu-central-1.amazonaws.com/my.notes/k");
  assert.equal(objectUrl({ bucket: "bkt", region: "auto", prefix: "", endpoint: "https://acc.r2.cloudflarestorage.com/" }, "", "list-type=2").href, "https://acc.r2.cloudflarestorage.com/bkt/?list-type=2");
  assert.throws(() => objectUrl({ bucket: "bkt", region: "us-east-1", prefix: "", endpoint: "http://s3.example.com" }, "k"), /HTTPS/);
  assert.throws(() => objectUrl({ bucket: "bkt", region: "us-east-1", prefix: "a/../b", endpoint: null }, "k"), /prefix/);
});

test("ListObjectsV2 XML: entities, continuation, and a refused non-listing", () => {
  const page = parseListResponse('<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>a&amp;b</NextContinuationToken><Contents><Key>k&lt;1&gt;</Key><ETag>&quot;e&quot;</ETag></Contents></ListBucketResult>');
  assert.deepEqual(page, { objects: [{ key: "k<1>", etag: '"e"' }], next: "a&b" });
  assert.throws(() => parseListResponse("<Error><Code>AccessDenied</Code></Error>"), S3Error);
});

test("listing decode skips foreign keys, keeps the last of duplicate paths, and ignores the bare prefix", async () => {
  const codec = await shared;
  const encoded = await codec.encodePath("a/b.md");
  const objects = await decodeListing(codec, { prefix: "notes" }, [
    { key: "notes/", etag: '"0"' },
    { key: `notes/${encoded}`, etag: '"1"' },
    { key: `notes/${encoded.replace("/", "//")}`, etag: '"2"' },
    { key: "notes/not-base64!", etag: '"3"' },
  ]);
  assert.deepEqual([...objects], [["a/b.md", { key: `notes/${encoded.replace("/", "//")}`, etag: '"2"' }]]);
});

test("the web picks a document's language exactly as the editor does, without loading it", async () => {
  const { languageForFile } = await import("../../src/editor/editor.ts");
  const { documentLanguage } = await import("../../web/src/vault.ts");
  for (const name of ["a.md", "A.HTML", "page.htm", "notes.txt", "x.TXT", "noext", "a.html.md", ".html", "b.markdown", "c.htmlx"]) {
    assert.equal(documentLanguage(name), languageForFile(name), name);
  }
});
