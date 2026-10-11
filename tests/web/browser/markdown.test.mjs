// The web Markdown preview (web/src/markdown.ts: marked + DOMPurify) in real
// browsers (Playwright Chromium, and WebKit when installed): the desktop's
// malicious corpus (src-tauri/src/preview.rs) renders without active content,
// and heading ids, links and images follow the desktop's rules.
// Run: npm run test:web:browser (needs `npx playwright-core install chromium webkit`).
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "vite";

let browsers = [];
let bundle = "";

async function launch() {
  const { chromium, webkit } = await import("playwright-core");
  const found = [];
  for (const [name, type] of [["chromium", chromium], ["webkit", webkit]]) {
    try {
      found.push({ name, browser: await type.launch() });
    } catch {
      /* Not installed: skipped. */
    }
  }
  return found;
}

before(async () => {
  const entry = fileURLToPath(new URL("../../../web/src/markdown.ts", import.meta.url));
  const output = await build({
    configFile: false,
    logLevel: "silent",
    build: { write: false, minify: false, lib: { entry, formats: ["es"], fileName: "markdown" } },
  });
  bundle = (Array.isArray(output) ? output[0] : output).output[0].code;
  browsers = await launch();
});

after(async () => {
  for (const { browser } of browsers) await browser.close();
});

test("runs in the installed browsers", (t) => {
  assert.ok(browsers.some(({ name }) => name === "chromium"), "Chromium is required: npx playwright-core install chromium");
  t.diagnostic(`browsers: ${browsers.map(({ name }) => name).join(", ")}`);
});

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

/** Renders every source into the live page and returns what the DOM holds. */
async function render(sources) {
  assert.ok(browsers.length, "no Playwright browser is installed");
  const results = [];
  for (const { name, browser } of browsers) {
    const page = await browser.newPage();
    const dialogs = [];
    page.on("dialog", (dialog) => {
      dialogs.push(dialog.message());
      void dialog.dismiss();
    });
    await page.setContent("<!doctype html><html><head><meta charset=utf-8></head><body><div class=preview id=out></div></body></html>");
    await page.addScriptTag({ type: "module", content: `${bundle}\nwindow.__render = renderMarkdown;` });
    await page.waitForFunction(() => typeof window.__render === "function");
    const rendered = await page.evaluate((list) => list.map((source) => {
      const out = document.getElementById("out");
      out.replaceChildren(window.__render(source));
      const elements = [...out.querySelectorAll("*")].map((element) => ({
        tag: element.localName,
        attributes: Object.fromEntries([...element.attributes].map((attribute) => [attribute.name, attribute.value])),
      }));
      return { source, html: out.innerHTML, elements };
    }), sources);
    await page.waitForTimeout(150); // let any onerror/onload that slipped through fire
    results.push({ name, rendered, dialogs, pwned: await page.evaluate(() => Boolean(window.__pwned)) });
    await page.close();
  }
  return results;
}

const TAGS = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "blockquote", "pre", "code", "em", "strong", "del", "a", "img", "table", "thead", "tbody", "tr", "th", "td", "hr", "br", "sup", "section", "input", "span"]);
const ATTRIBUTES = {
  a: ["href", "rel"], img: ["src", "alt", "title"], input: ["type", "checked", "disabled"], th: ["align"], td: ["align"],
  h1: ["id"], h2: ["id"], h3: ["id"], h4: ["id"], h5: ["id"], h6: ["id"], span: ["class"], sup: ["class"], section: ["class", "id"],
};
const SAFE_IMAGE = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

function assertSafe({ source, elements, html }) {
  for (const { tag, attributes } of elements) {
    assert.ok(TAGS.has(tag), `${tag} in ${JSON.stringify(source)} -> ${html}`);
    for (const [name, value] of Object.entries(attributes)) {
      assert.ok((ATTRIBUTES[tag] ?? []).includes(name), `${tag}[${name}] in ${JSON.stringify(source)} -> ${html}`);
      if (name === "href") assert.match(value, /^(?:https?:|mailto:|nb-doc:|nb-wiki:|#(?:h-|footnote-))/i, html);
      if (name === "src") assert.match(value, SAFE_IMAGE, html);
      if (name === "class") assert.match(value, /^(?:blocked-image|footnote-reference|footnote-definition-label|footnote-definition)$/, html);
      if (name === "type") assert.equal(value, "checkbox");
      if (name === "id") assert.match(value, /^h-/);
      assert.ok(!/javascript:|vbscript:|data:text|<script/i.test(value), `${name}=${value}`);
    }
    if (tag === "input") assert.ok("disabled" in attributes, html);
  }
}

const CORPUS = [
  "<script>alert(1)</script>",
  "<ScRiPt>alert(1)</sCrIpT>",
  "before <script>alert(1)</script> after",
  "<img src=x onerror=alert(1)>",
  "<IMG SRC=\"x\" ONERROR=\"alert(1)\">",
  "<svg onload=alert(1)><circle r=1 /></svg>",
  "<svg><script>alert(1)</script></svg>",
  "<math><mi xlink:href=\"javascript:alert(1)\">x</mi></math>",
  "<iframe src=\"https://evil.example/\"></iframe>",
  "<iframe srcdoc=\"<script>alert(1)</script>\"></iframe>",
  "<object data=\"https://evil.example/x.swf\"></object>",
  "<embed src=\"https://evil.example/x\">",
  "<style>body { display: none }</style>",
  "<link rel=stylesheet href=https://evil.example/x.css>",
  "<meta http-equiv=\"refresh\" content=\"0;url=https://evil.example/\">",
  "<base href=\"https://evil.example/\">",
  "<form action=\"https://evil.example/\"><input name=q></form>",
  "<a href=\"javascript:alert(1)\">raw link</a>",
  "<div onclick=alert(1)>*markdown inside html*</div>",
  "<div>\n\n*nested* [x](javascript:alert(1)) <b onmouseover=alert(1)>b</b>\n\n</div>",
  "<details open ontoggle=alert(1)><summary>x</summary></details>",
  "<!-- <script>alert(1)</script> -->",
  "<![CDATA[<script>alert(1)</script>]]>",
  "&lt;script&gt;alert(1)&lt;/script&gt;",
  "&#60;script&#62;alert(1)&#60;/script&#62;",
  "[click](javascript:alert(1))",
  "[click](JaVaScRiPt:alert(1))",
  "[click](java&#x09;script:alert(1))",
  "[click](&#106;avascript:alert(1))",
  "[click](vbscript:msgbox(1))",
  "[click](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)",
  "[click](data:image/png;base64,iVBORw0KGgo=)",
  "[click](//evil.example/protocol-relative)",
  "[click](relative/path.md)",
  "[click](file:///etc/passwd)",
  "[click](tauri://localhost/)",
  "<javascript:alert(1)>",
  "[ref]\n\n[ref]: javascript:alert(1)",
  "[x](https://example.com \"a\\\" onmouseover=\\\"alert(1)\")",
  "![x](javascript:alert(1))",
  "![x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)",
  "![x](data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+)",
  "![x](data:image/svg+xml,<svg onload=alert(1)>)",
  "![x](data:image/png;base64,iVBOR\"onerror=\"alert(1))",
  "![x](https://tracker.example/pixel.gif)",
  "![x](//tracker.example/pixel.gif)",
  "![x](file:///etc/passwd)",
  "![a\" onerror=\"alert(1)](https://x.example/a.png)",
  "![ok](data:image/png;base64,iVBORw0KGgo= \"t\\\" onerror=\\\"alert(1)\")",
  "[![inner](https://x.example/a.png)](javascript:alert(1))",
  "![outer ![inner](https://x.example/a.png)](data:image/png;base64,iVBORw0KGgo=)",
  "Footnote[^<img src=x onerror=alert(1)>]\n\n[^<img src=x onerror=alert(1)>]: <script>alert(1)</script>",
  "| <script>alert(1)</script> | <img src=x onerror=alert(1)> |\n|---|:-:|\n| [x](javascript:alert(1)) | ![y](https://x.example/y.png) |",
  "- [x] <input type=text onfocus=alert(1) autofocus>",
  "<input type=\"checkbox\" onclick=alert(1)>",
  "<span class=\"blocked-image\" onclick=alert(1)>fake</span>",
  "<section id=\"app\">clobber</section>",
  "```html\n<script>alert(1)</script>\n```",
  "`<script>alert(1)</script>`",
  "[[x\" onclick=\"alert(1)]]",
  "[[javascript:alert(1)]]",
  "<img src=x onerror=\"window.__pwned=1\">",
  "[x](<javascript:window.__pwned=1>)",
  "<noscript><p title=\"</noscript><img src=x onerror=window.__pwned=1>\">",
  "<svg><style><img src=x onerror=window.__pwned=1></style></svg>",
  "<math><mtext><table><mglyph><style><img src=x onerror=window.__pwned=1>",
];

test("the desktop's malicious corpus renders without active content", async () => {
  for (const { name, rendered, dialogs, pwned } of await render(CORPUS)) {
    for (const item of rendered) assertSafe(item);
    assert.deepEqual(dialogs, [], `${name}: a dialog opened`);
    assert.equal(pwned, false, `${name}: a payload ran`);
  }
});

test("raw HTML is shown as text and Markdown around it still renders", async () => {
  for (const { rendered } of await render(["<script>alert(1)</script>", "a <b onmouseover=alert(1)>bold</b> *em*", "<div>\n\n*nested*\n\n</div>"])) {
    assert.match(rendered[0].html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.match(rendered[1].html, /&lt;b onmouseover=alert\(1\)&gt;bold&lt;\/b&gt;/);
    assert.match(rendered[1].html, /<em>em<\/em>/);
    assert.match(rendered[2].html, /&lt;div&gt;/);
    assert.match(rendered[2].html, /<em>nested<\/em>/);
  }
});

const hrefs = (item) => item.elements.filter((element) => element.tag === "a").map((element) => element.attributes.href ?? null);
const ids = (item) => item.elements.filter((element) => /^h[1-6]$/.test(element.tag)).map((element) => element.attributes.id);

test("headings get the desktop's unique h-<slug> ids", async () => {
  for (const { name, rendered } of await render([
    "# Intro\n\n## Intro\n\nIntro\n-----\n\n## Intro 1\n\n### `code` *and* [link](https://x.example)\n\n# Über\n\n# `__proto__`\n\n> # Quoted",
    "```\n# not a heading\n```\n\n# Real",
    "# Größe & Maß ![img](https://x.example/a.png)",
  ])) {
    assert.deepEqual(ids(rendered[0]), ["h-intro", "h-intro-1", "h-intro-2", "h-intro-1-1", "h-code-and-link", "h-über", "h-__proto__", "h-quoted"], name);
    assert.deepEqual(ids(rendered[1]), ["h-real"], name);
    assert.deepEqual(ids(rendered[2]), ["h-größe--maß-"], `${name}: blocked images are not part of the id`);
  }
});

test("links: in-page, vault paths and wikilinks as the desktop writes them; others lose their target", async () => {
  for (const { name, rendered } of await render([
    "# Größe & Maß\n\n[a](#größe--maß) [b](#Gr%C3%B6%C3%9Fe%20%26%20Ma%C3%9F) [d](#h-x)",
    "[a](notes/other.md) [b](../a/b.md#Section%20Two) [c](Other%20Note.md?x=1#intro) [d](./My%20Folder/) [e](/top.html) [f](<with space.md>)",
    "[[Note]] [[Folder/Other Note#Part One|alias]] [[Note#A#B]] [[#Local heading]] [[Café]]",
    "[x](javascript:alert(1)) [x](data:text/html,hi) [x](//evil.example/) [x](nb-doc:Notes/a.md) [x](NB-WIKI:Note) [x](#) [x](c:/x.md)",
    "[site](https://example.com/a?b=1&c=2 \"title\") <https://example.org> <me@example.com>",
  ])) {
    assert.deepEqual(hrefs(rendered[0]), ["#h-gr%C3%B6%C3%9Fe--ma%C3%9F", "#h-gr%C3%B6%C3%9Fe--ma%C3%9F", "#h-h-x"], name);
    assert.deepEqual(hrefs(rendered[1]), ["nb-doc:notes/other.md", "nb-doc:../a/b.md#h-section-two", "nb-doc:Other%20Note.md#h-intro", "nb-doc:./My%20Folder/", "nb-doc:/top.html", "nb-doc:with%20space.md"], name);
    assert.deepEqual(hrefs(rendered[2]), ["nb-wiki:Note", "nb-wiki:Folder/Other%20Note#h-part-one", "nb-wiki:Note#h-b", "#h-local-heading", "nb-wiki:Caf%C3%A9"], name);
    assert.match(rendered[2].html, />alias<\/a>/);
    assert.deepEqual(hrefs(rendered[3]), [null, null, null, null, null, null, null], name);
    assert.deepEqual(hrefs(rendered[4]), ["https://example.com/a?b=1&c=2", "https://example.org", "mailto:me@example.com"], name);
    const links = rendered[4].elements.filter((element) => element.tag === "a");
    assert.ok(links.every((link) => link.attributes.rel === "noopener noreferrer" && !("title" in link.attributes)), name);
  }
});

test("only inline raster images load; everything else is blocked", async () => {
  const blocked = ["![remote](https://example.com/pixel.png)", "![relative](images/a.png)", "![svg](data:image/svg+xml;base64,PHN2Zz4=)", "![upper](DATA:IMAGE/PNG;base64,iVBORw0KGgo=)", "![not base64](data:image/png,raw)"];
  for (const { name, rendered } of await render([`![dot](${PNG} "Dot")`, ...blocked])) {
    const image = rendered[0].elements.find((element) => element.tag === "img");
    assert.deepEqual(image.attributes, { src: PNG, alt: "dot", title: "Dot" }, name);
    for (const item of rendered.slice(1)) {
      assert.ok(!item.elements.some((element) => element.tag === "img"), `${name}: ${item.source}`);
      assert.match(item.html, /<span class="blocked-image">Image blocked<\/span>/);
      assert.ok(!item.html.includes("example.com"));
    }
  }
});

test("tables keep alignment and task lists render disabled checkboxes", async () => {
  for (const { name, rendered } of await render(["| L | C | R |\n|:--|:-:|--:|\n| a | **b** | c |", "- [x] done\n- [ ] todo"])) {
    assert.match(rendered[0].html, /<th align="left">L<\/th>/, name);
    assert.match(rendered[0].html, /<td align="center"><strong>b<\/strong><\/td>/, name);
    const boxes = rendered[1].elements.filter((element) => element.tag === "input");
    assert.equal(boxes.length, 2, name);
    assert.ok(boxes.every((box) => box.attributes.type === "checkbox" && "disabled" in box.attributes), name);
    assert.ok("checked" in boxes[0].attributes && !("checked" in boxes[1].attributes), name);
  }
});
