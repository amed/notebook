// Links in the Markdown preview: heading slugs (the same function as
// preview.rs `slug`), internal hrefs, and how relative links and wikilinks
// resolve against the tree before anything opens.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  encodeTarget,
  fragmentIds,
  HeadingIds,
  joinVaultPath,
  nameKey,
  parseInternalHref,
  pathIndex,
  previewHref,
  resolveDocLink,
  resolveInternalLink,
  resolveWikiLink,
  slugify,
  VaultIndex,
  wikiHref,
} from "../../src/vault-links.ts";
import { parseMarkdownOutline } from "../../src/outline.ts";

const ROOT = "root";
const folder = (id, parent, name) => ({ id, parent, name, folder: true });
const doc = (id, parent, name) => ({ id, parent, name, folder: false });

function vault() {
  return new VaultIndex(ROOT, [
    { id: ROOT, parent: null, name: "Vault", folder: true },
    folder("notes", ROOT, "Notes"),
    folder("a", ROOT, "a"),
    folder("ab", "a", "b"),
    folder("space", ROOT, "My Folder"),
    folder("cafe", ROOT, "Café"),
    doc("welcome", ROOT, "Welcome.md"),
    doc("top", ROOT, "top.html"),
    doc("other", "notes", "Other.md"),
    doc("plan", "notes", "Plan.md"),
    doc("plan-html", "notes", "Plan.html"),
    doc("deep", "ab", "Deep Note.md"),
    doc("spaced", "space", "Read me.md"),
    doc("menu", "cafe", "Menü.md"),
    doc("index-a", "a", "index.md"),
    doc("index-b", "ab", "index.md"),
    doc("todo-notes", "notes", "Todo.md"),
    doc("todo-space", "space", "Todo.md"),
  ]);
}

test("slugs follow GitHub, as preview.rs writes them", () => {
  for (const [text, slug] of [
    ["Hello World", "hello-world"],
    ["  What's new?  ", "--whats-new--"],
    ["Tom & Jerry", "tom--jerry"],
    ["snake_case and-dash", "snake_case-and-dash"],
    ["Über Größe", "über-größe"],
    ["Ünïcödé 日本語 Ελληνικά", "ünïcödé-日本語-ελληνικά"],
    ["été", "été"],
    ["Release 2.0 (beta)", "release-20-beta"],
    ["<script>", "script"],
    ['"onclick=alert(1)', "onclickalert1"],
    // The whole text is lowercased, so a final sigma is ς (github-slugger, Rust's str::to_lowercase).
    ["ΣΊΣΥΦΟΣ", "σίσυφος"],
    ["ΟΔΟΣ ΣΤΟ ΣΠΙΤΙ", "οδος-στο-σπιτι"],
    ["Σ", "σ"],
    ["!!!", ""],
  ]) assert.equal(slugify(text), slug, text);
  assert.equal(Array.from(slugify("é".repeat(500))).length, 200);
});

test("repeated headings get numbered ids", () => {
  const ids = new HeadingIds();
  assert.deepEqual(
    ["Intro", "Intro", "Intro", "Intro 1", "__proto__", "!!!", "?"].map((text) => ids.next(text)),
    ["h-intro", "h-intro-1", "h-intro-2", "h-intro-1-1", "h-__proto__", "h-", "h--1"],
  );
});

test("outline labels give the ids preview.rs writes", () => {
  // The same headings as preview.rs heading_ids_keep_intraword_underscores_and_code:
  // main.ts finds the editor line of a link's heading by these ids.
  const markdown = [
    "## parse_config",
    "## snake_case_name",
    "## `parse_markdown()`",
    "## __proto__",
    "## a _b_ c",
    "## my__var",
    "## foo\\_bar",
    "## [`code`](https://x.example)",
    "## __init__.py",
    "## `__init__`",
    "## ΟΔΟΣ",
  ].join("\n\n");
  const ids = new HeadingIds();
  assert.deepEqual(parseMarkdownOutline(markdown).map((item) => ids.next(item.text)), [
    "h-parse_config",
    "h-snake_case_name",
    "h-parse_markdown",
    "h-proto",
    "h-a-b-c",
    "h-my__var",
    "h-foo_bar",
    "h-code",
    "h-initpy",
    "h-__init__",
    "h-οδος",
  ]);
  // A link to it written with ς or in capitals.
  assert.deepEqual(fragmentIds("οδος"), ["h-οδος"]);
  assert.deepEqual(fragmentIds("%CE%9F%CE%94%CE%9F%CE%A3"), ["h-οδος"]);
});

test("fragments map to generated ids, also when written as heading text", () => {
  assert.deepEqual(fragmentIds("h-intro"), ["h-intro", "h-h-intro"]);
  assert.deepEqual(fragmentIds("footnote-2"), ["footnote-2", "h-footnote-2"]);
  assert.deepEqual(fragmentIds("My%20Heading"), ["h-my-heading"]);
  assert.deepEqual(fragmentIds("My Heading"), ["h-my-heading"]);
  assert.deepEqual(fragmentIds("h-gr%C3%B6%C3%9Fe"), ["h-größe", "h-h-größe"]);
  assert.deepEqual(fragmentIds("Größe & Maß"), ["h-größe--maß"]);
  assert.deepEqual(fragmentIds("%E0%A4%A"), ["h-e0a4a"]);
  assert.deepEqual(fragmentIds("!!!"), []);
});

test("internal hrefs carry only a target and a heading", () => {
  assert.deepEqual(parseInternalHref("nb-doc:../a/My%20Note.md#h-part"), { kind: "doc", target: "../a/My Note.md", fragment: "h-part" });
  assert.deepEqual(parseInternalHref("nb-wiki:Caf%C3%A9"), { kind: "wiki", target: "Café", fragment: null });
  assert.deepEqual(parseInternalHref("nb-wiki:Note#"), { kind: "wiki", target: "Note", fragment: null });
  for (const href of ["nb-doc:", "nb-doc:%0A", "nb-doc:%E0%A4%A", "https://example.com", "javascript:alert(1)", "#h-x", "NB-DOC:a.md", `nb-doc:${"a".repeat(1025)}`]) {
    assert.equal(parseInternalHref(href), null, href);
  }
  assert.equal(encodeTarget("My Folder/Café (1).md", true), "My%20Folder/Caf%C3%A9%20%281%29.md");
  assert.equal(encodeTarget("a/b", false), "a%2Fb");
});

test("names compare as Notebook compares them", () => {
  assert.equal(nameKey("README.MD"), "readme.md");
  assert.equal(nameKey("Café.md"), nameKey("CAFÉ.md"));
  assert.equal(nameKey("ΟΔΟΣ"), "οδοσ");
});

test("relative paths start in the linking document's folder", () => {
  assert.deepEqual(joinVaultPath("/Notes/Plan.md", "Other.md"), ["Notes", "Other.md"]);
  assert.deepEqual(joinVaultPath("Notes/Plan.md", "./x/../Other.md"), ["Notes", "Other.md"]);
  assert.deepEqual(joinVaultPath("/Notes/Plan.md", "../a/b/"), ["a", "b"]);
  assert.deepEqual(joinVaultPath("/Notes/Plan.md", "/top.html"), ["top.html"]);
  assert.equal(joinVaultPath("/Notes/Plan.md", "../../x.md"), null);
  assert.equal(joinVaultPath("/Welcome.md", "../x.md"), null);
});

test("document links resolve without case, percent-decoded, relative to the folder", () => {
  const index = vault();
  const resolve = (from, target) => resolveDocLink(index, from, target);
  assert.deepEqual(resolve("/Notes/Plan.md", "Other.md"), { kind: "document", id: "other" });
  assert.deepEqual(resolve("/Notes/Plan.md", "other.MD"), { kind: "document", id: "other" });
  assert.deepEqual(resolve("/Notes/Plan.md", "../a/b/deep note.md"), { kind: "document", id: "deep" });
  assert.deepEqual(resolve("/Welcome.md", "notes/other.md"), { kind: "document", id: "other" });
  assert.deepEqual(resolve("/Welcome.md", "top.html"), { kind: "document", id: "top" });
  assert.deepEqual(resolve("/a/b/Deep Note.md", "/Welcome.md"), { kind: "document", id: "welcome" });
  assert.deepEqual(resolve("/Welcome.md", "CAFÉ/menü.md"), { kind: "document", id: "menu" });
  // Without an extension: the ".md" document, as in Obsidian.
  assert.deepEqual(resolve("/Welcome.md", "Notes/Other"), { kind: "document", id: "other" });
  // Folders select the folder.
  assert.deepEqual(resolve("/Welcome.md", "My Folder/"), { kind: "folder", id: "space" });
  assert.deepEqual(resolve("/Welcome.md", "notes"), { kind: "folder", id: "notes" });
  assert.deepEqual(resolve("/a/b/Deep Note.md", ".."), { kind: "folder", id: "a" });
  // Missing, above the root, or a document where a folder is wanted.
  for (const target of ["Notes/Missing.md", "../../etc/passwd", "Welcome.md/", "Notes/Other.md/x.md", "./"]) {
    assert.deepEqual(resolve("/Welcome.md", target), { kind: "missing" }, target);
  }
});

test("an href from the preview resolves with its decoded path and heading", () => {
  const index = vault();
  const link = parseInternalHref("nb-doc:../My%20Folder/Read%20me.md#h-setup");
  assert.equal(link.fragment, "h-setup");
  assert.deepEqual(resolveInternalLink(index, "/Notes/Plan.md", link), { kind: "document", id: "spaced" });
  const wiki = parseInternalHref("nb-wiki:deep%20note#h-x");
  assert.deepEqual(resolveInternalLink(index, "/Welcome.md", wiki), { kind: "document", id: "deep" });
});

test("wikilinks match by name, Markdown first, nearest wins, ties are ambiguous", () => {
  const index = vault();
  const resolve = (from, target) => resolveWikiLink(index, from, target);
  assert.deepEqual(resolve("/Welcome.md", "Other"), { kind: "document", id: "other" });
  assert.deepEqual(resolve("/Welcome.md", "deep NOTE"), { kind: "document", id: "deep" });
  // "Plan" is Plan.md and Plan.html: Markdown first; the full name picks either.
  assert.deepEqual(resolve("/Welcome.md", "Plan"), { kind: "document", id: "plan" });
  assert.deepEqual(resolve("/Welcome.md", "plan.html"), { kind: "document", id: "plan-html" });
  // Two index.md: the nearer one wins.
  assert.deepEqual(resolve("/a/b/Deep Note.md", "index"), { kind: "document", id: "index-b" });
  assert.deepEqual(resolve("/a/x.md", "index"), { kind: "document", id: "index-a" });
  assert.deepEqual(resolve("/Welcome.md", "Todo"), { kind: "ambiguous", count: 2 });
  // Folders narrow it down.
  assert.deepEqual(resolve("/Welcome.md", "My Folder/Todo"), { kind: "document", id: "todo-space" });
  assert.deepEqual(resolve("/Welcome.md", "notes/todo.md"), { kind: "document", id: "todo-notes" });
  assert.deepEqual(resolve("/Welcome.md", "b/index"), { kind: "document", id: "index-b" });
  // Missing, and targets that are no names here.
  for (const target of ["Nothing", "javascript:alert(1)", "https://evil.example/", "  ", "Other/Todo"]) {
    assert.deepEqual(resolve("/Welcome.md", target), { kind: "missing" }, target);
  }
});

test("a document window tells its own document from the rest", () => {
  const index = pathIndex("Notes/Plan.md", "own");
  const own = { kind: "document", id: "own" };
  assert.deepEqual(resolveDocLink(index, "Notes/Plan.md", "Plan.md"), own);
  assert.deepEqual(resolveDocLink(index, "Notes/Plan.md", "../notes/plan.md"), own);
  assert.deepEqual(resolveWikiLink(index, "Notes/Plan.md", "plan"), own);
  assert.deepEqual(resolveWikiLink(index, "Notes/Plan.md", "Notes/Plan"), own);
  assert.deepEqual(resolveDocLink(index, "Notes/Plan.md", "Other.md"), { kind: "missing" });
  assert.deepEqual(resolveWikiLink(index, "Notes/Plan.md", "Other"), { kind: "missing" });
  // Its folder is not its document: the main window selects the folder.
  assert.deepEqual(resolveDocLink(index, "Notes/Plan.md", "./"), { kind: "folder", id: "path:0" });
});

test("browser mode writes the hrefs preview.rs writes", () => {
  assert.equal(previewHref("#Größe%20&%20Maß"), "#h-gr%C3%B6%C3%9Fe--ma%C3%9F");
  assert.equal(previewHref("#footnote-2"), "#footnote-2");
  assert.equal(previewHref("#!!!"), null);
  assert.equal(previewHref("https://example.com/a?b"), "https://example.com/a?b");
  assert.equal(previewHref("../a/b.md#Section%20Two"), "nb-doc:../a/b.md#h-section-two");
  assert.equal(previewHref("Other%20Note.md?x=1#intro"), "nb-doc:Other%20Note.md#h-intro");
  for (const dest of ["javascript:alert(1)", "nb-doc:x.md", "//evil.example/", "\\\\host/x", "a%0A.md"]) {
    assert.equal(previewHref(dest), null, dest);
  }
  assert.equal(wikiHref("Folder/Other Note#Part One"), "nb-wiki:Folder/Other%20Note#h-part-one");
  assert.equal(wikiHref("Note#A#B"), "nb-wiki:Note#h-b");
  assert.equal(wikiHref("#Local heading"), "#h-local-heading");
  assert.equal(wikiHref("javascript:alert(1)"), "nb-wiki:javascript%3Aalert%281%29");
  assert.equal(wikiHref(" "), null);
});
