// End-to-end run of the built web version (dist-web/) against a throwaway
// MinIO, in Playwright Chromium and WebKit at phone (375x812), tablet
// (768x1024) and desktop (1280x800) sizes: connect, list, open a note the
// desktop codec wrote, preview, edit, save, create a folder and a note,
// reload (the config is remembered), forget the device. It writes what the
// web app saved to $E2E_EXPECT for the desktop codec to verify
// (src-tauri/tests/web_compat.rs). scripts/web-e2e.sh runs all of it.
//
// Environment: E2E_WEB_URL, E2E_MINIO_URL, E2E_BUCKET, E2E_PREFIX, E2E_AK,
// E2E_SK, E2E_PHRASE, E2E_SHOTS (screenshot dir), E2E_EXPECT (JSON out),
// E2E_BROWSERS (default "chromium,webkit").
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, webkit } from "playwright-core";

const env = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
};
const WEB = env("E2E_WEB_URL");
const MINIO = env("E2E_MINIO_URL");
const SHOTS = env("E2E_SHOTS");
const DESKTOP_NOTE = "From desktop/Desktop note.md";
/** Names of this run, so a rerun on the same bucket never meets its own leftovers. */
const RUN = Date.now().toString(36);
mkdirSync(SHOTS, { recursive: true });

const SIZES = (process.env.E2E_SIZES ? (list) => list.filter((size) => process.env.E2E_SIZES.split(",").includes(size.name)) : (list) => list)([
  { name: "phone", viewport: { width: 375, height: 812 }, touch: true },
  { name: "tablet", viewport: { width: 768, height: 1024 }, touch: true },
  { name: "desktop", viewport: { width: 1280, height: 800 }, touch: false },
]);
const ENGINES = { chromium, webkit };
const expected = { documents: {}, folders: [] };
const log = (line) => process.stdout.write(`${line}\n`);

async function editorText(page) {
  return page.evaluate(() => document.querySelector(".cm-content").cmTile.root.view.state.doc.toString());
}

async function typeLines(page, lines) {
  for (const [index, line] of lines.entries()) {
    if (index > 0) await page.keyboard.press("Enter");
    if (line) await page.keyboard.insertText(line);
  }
}

async function row(page, name) {
  const locator = page.locator(".web-tree .tree-row", { has: page.locator(".node-label", { hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) }) });
  await locator.first().waitFor({ state: "visible", timeout: 15_000 });
  return locator.first();
}

async function openDrawerIfPhone(page, size) {
  if (size.name !== "phone") return;
  if (!(await page.locator(".web-shell.drawer-open").count())) await page.locator(".web-menu").click();
  await page.locator(".web-shell.drawer-open .web-sidebar").waitFor({ state: "visible" });
}

/** `text` is a substring or a RegExp; "Saved" must be /^Saved$/ ("Unsaved changes" contains it). */
async function waitStatus(page, text) {
  try {
    await page.locator(".web-status", { hasText: text }).waitFor({ timeout: 20_000 });
  } catch (error) {
    throw new Error(`status "${text}" not shown; it reads "${await page.locator(".web-status").textContent()}"`, { cause: error });
  }
}

async function shot(page, label) {
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(SHOTS, `${label}.png`) });
}

async function fillConnect(page, { name, phrase }) {
  await page.fill('input[name="name"]', name);
  await page.fill('input[name="bucket"]', env("E2E_BUCKET"));
  await page.fill('input[name="region"]', "us-east-1");
  await page.fill('input[name="prefix"]', env("E2E_PREFIX"));
  await page.fill('input[name="endpoint"]', MINIO);
  await page.fill('input[name="access-key-id"]', env("E2E_AK"));
  await page.fill('input[name="secret-access-key"]', env("E2E_SK"));
  await page.fill('input[name="phrase"]', phrase);
  await page.locator('button[type="submit"]').click();
}

async function run(engineName, size) {
  const label = `${engineName}-${size.name}`;
  const folder = `Web ${label} ${RUN}`;
  const browser = await ENGINES[engineName].launch();
  const context = await browser.newContext({
    viewport: size.viewport,
    hasTouch: size.touch,
    isMobile: engineName === "chromium" && size.name === "phone",
    colorScheme: "dark",
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();
  const problems = [];
  const origins = new Set();
  page.on("console", (message) => {
    // The browser itself logs the conflict step's expected 412 reply; the app logs nothing.
    if (message.type() === "error" && !/^Failed to load resource: the server responded with a status of 412\b/.test(message.text())) {
      problems.push(`console: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => problems.push(`page error: ${error.message}`));
  page.on("dialog", (dialog) => {
    problems.push(`dialog: ${dialog.message()}`);
    void dialog.dismiss();
  });
  page.on("request", (request) => origins.add(new URL(request.url()).origin));
  if (process.env.E2E_DEBUG) {
    context.on("response", async (response) => {
      const request = response.request();
      if (request.method() === "PUT" || request.method() === "GET") log(`debug ${request.method()} ${response.status()} ${new URL(request.url()).pathname.slice(-12)} if-match=${(await request.allHeaders())["if-match"] ?? "-"} etag=${response.headers().etag ?? "-"}`);
    });
  }
  await context.addInitScript(() => {
    window.__csp = [];
    document.addEventListener("securitypolicyviolation", (event) => window.__csp.push(`${event.violatedDirective} ${event.blockedURI}`));
  });

  // 1. A clean start: no config, the connect screen.
  await page.goto(WEB);
  await page.getByRole("heading", { name: "Connect your workspace" }).waitFor();
  assert.equal(await page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith("notebook.")).length), 0);
  await shot(page, `${label}-dark-1-connect`);

  // 2. A wrong phrase is refused before anything is stored.
  if (size.name === "desktop") {
    await fillConnect(page, { name: `E2E ${label}`, phrase: "certainly not the phrase" });
    await page.locator(".web-form-error", { hasText: "phrase does not match" }).waitFor({ timeout: 30_000 });
    assert.equal(await page.evaluate(() => localStorage.getItem("notebook.config.v2")), null);
  }

  // 3. Connect; the desktop's note is listed.
  await fillConnect(page, { name: `E2E ${label}`, phrase: env("E2E_PHRASE") });
  await page.locator(".web-shell").waitFor({ timeout: 30_000 });
  await openDrawerIfPhone(page, size);
  await (await row(page, "From desktop")).click();
  await shot(page, `${label}-dark-2-list`);
  await (await row(page, "Desktop note.md")).click();

  // 4. Preview: rendered Markdown, the desktop's heading ids, an in-page link.
  const preview = page.locator(".web-doc .preview");
  await preview.locator("h1#h-written-by-the-desktop-app").waitFor({ timeout: 20_000 });
  assert.equal(await preview.locator("h2#h-checklist").count(), 1);
  assert.equal(await preview.locator('input[type="checkbox"][disabled]').count(), 2);
  const before = page.url();
  await preview.locator('a[href="#h-checklist"]').click();
  assert.equal(page.url(), before, "an in-page link does not navigate");
  await shot(page, `${label}-dark-3-preview`);
  // No horizontal scrolling, and on touch screens every control is at least 44 px.
  const layout = await page.evaluate(() => ({
    pageOverflow: document.documentElement.scrollWidth > window.innerWidth,
    barOverflow: [...document.querySelectorAll(".web-topbar, .web-title")].some((element) => element.scrollWidth > element.clientWidth + 1 && getComputedStyle(element).overflow !== "hidden"),
    actionsInside: [...document.querySelectorAll(".web-topbar button")].filter((button) => button.offsetParent).every((button) => button.getBoundingClientRect().right <= window.innerWidth + 0.5),
    // Controls only: the preview's disabled task-list boxes are content, not targets.
    small: [...document.querySelectorAll(".web-shell button, .web-shell input")]
      .filter((element) => element.offsetParent && !element.closest("[inert], .cm-editor, .preview") && element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height < 44)
      .map((element) => `${element.localName}.${element.className} ${Math.round(element.getBoundingClientRect().height)}px`),
  }));
  assert.equal(layout.pageOverflow, false, `${label}: horizontal scroll`);
  assert.equal(layout.barOverflow, false, `${label}: top bar overflows`);
  assert.equal(layout.actionsInside, true, `${label}: a top bar button is cut off`);
  if (size.touch) assert.deepEqual(layout.small, [], `${label}: touch targets under 44 px`);

  // 5. Edit and save with the keyboard shortcut (If-Match).
  await page.locator(".web-mode").click();
  await page.locator(".cm-content").waitFor({ timeout: 20_000 });
  await page.locator(".cm-content").click();
  await page.keyboard.press("ControlOrMeta+End");
  await typeLines(page, ["", `Edited on the web (${label}).`]);
  assert.equal(await page.locator(".web-save").isEnabled(), true, "Save is enabled once edited");
  await page.keyboard.press("ControlOrMeta+s");
  await waitStatus(page, /^Saved$/);
  expected.documents[DESKTOP_NOTE] = await editorText(page);
  assert.ok(expected.documents[DESKTOP_NOTE].endsWith(`Edited on the web (${label}).`));
  await shot(page, `${label}-dark-4-edit`);

  // 5b. Another device saves the same note first: this save must not overwrite
  // it (If-Match fails in S3) and becomes a conflict copy next to it.
  if (size.name === "desktop") {
    const other = await context.newPage(); // the same browser profile: it opens the remembered workspace
    await other.goto(WEB);
    await other.locator(".web-shell").waitFor({ timeout: 30_000 });
    await (await row(other, "From desktop")).click();
    await (await row(other, "Desktop note.md")).click();
    await other.locator(".web-mode").click();
    await other.locator(".cm-content").waitFor({ timeout: 20_000 });
    await other.locator(".cm-content").click();
    await other.keyboard.press("ControlOrMeta+End");
    await typeLines(other, ["", `Other tab (${label} ${RUN}).`]);
    await other.keyboard.press("ControlOrMeta+s");
    await waitStatus(other, /^Saved$/);
    expected.documents[DESKTOP_NOTE] = await editorText(other);
    await other.close();
    await page.locator(".cm-content").click();
    await page.keyboard.press("ControlOrMeta+End");
    await typeLines(page, ["", `Stale tab (${label} ${RUN}).`]);
    await page.keyboard.press("ControlOrMeta+s");
    await waitStatus(page, "changed elsewhere");
    const copyName = await page.locator(".web-name").textContent();
    assert.match(copyName, /^Desktop note \(conflict \d+\)\.md$/);
    expected.documents[`From desktop/${copyName}`] = await editorText(page);
    assert.ok(expected.documents[`From desktop/${copyName}`].endsWith(`Stale tab (${label} ${RUN}).`));
    assert.ok(!expected.documents[DESKTOP_NOTE].includes(`Stale tab (${label} ${RUN}).`));
    await row(page, copyName);
    await shot(page, `${label}-dark-4b-conflict`);
  }

  // 6. A new folder (Notebook marker) and a new note in it (If-None-Match).
  await openDrawerIfPhone(page, size);
  await page.getByRole("button", { name: "New folder" }).click();
  await page.locator(".web-modal input").fill(folder);
  await page.locator(".web-modal .confirm").click();
  await row(page, folder);
  expected.folders.push(folder);
  await openDrawerIfPhone(page, size);
  await page.getByRole("button", { name: "New note" }).click();
  const prompt = page.locator(".web-modal input");
  assert.equal(await prompt.inputValue(), `${folder}/Untitled`, "new notes go to the selected folder");
  await prompt.fill(`${folder}/Note from ${label}`);
  await page.locator(".web-modal .confirm").click();
  await page.locator(".cm-content").waitFor({ timeout: 20_000 });
  await page.locator(".web-name", { hasText: `Note from ${label}.md` }).waitFor();
  await page.locator(".cm-content").click();
  await typeLines(page, [`# Hello from ${label}`, "", "Some **bold** text, a [[Desktop note]] link and Ünïcödé 名前."]);
  await page.locator(".web-save").click();
  await waitStatus(page, /^Saved$/);
  const notePath = `${folder}/Note from ${label}.md`;
  expected.documents[notePath] = await editorText(page);
  assert.match(expected.documents[notePath], /^# Hello from /);
  if (size.name === "desktop") {
    assert.equal(await page.locator('.web-doc[data-mode="split"]').count(), 1, "wide screens open new notes in Split");
    await page.locator(".web-doc .preview h1", { hasText: `Hello from ${label}` }).waitFor();
  } else {
    await page.locator(".web-mode").click();
  }
  // The wikilink resolves against the tree and opens the desktop note.
  await page.locator('.web-doc .preview a[href="nb-wiki:Desktop%20note"]').click();
  await page.locator(".web-name", { hasText: "Desktop note.md" }).waitFor({ timeout: 20_000 });

  // 7. An HTML note renders in the sandboxed frame without running scripts.
  if (size.name === "desktop") {
    await page.getByRole("button", { name: "New note" }).click();
    await page.locator(".web-modal input").fill(`${folder}/page.html`);
    await page.locator(".web-modal .confirm").click();
    await page.locator(".cm-content").waitFor();
    await page.locator(".cm-content").click();
    await page.keyboard.insertText("<h1>HTML from the web</h1><p>Static page.</p><script>alert(1)</script><img src=x onerror=alert(2)>");
    await page.keyboard.press("ControlOrMeta+s");
    await waitStatus(page, /^Saved$/);
    expected.documents[`${folder}/page.html`] = await editorText(page);
    if (!(await page.locator('.web-doc[data-mode="split"]').count())) await page.locator(".web-split").click();
    const frame = page.frameLocator(".web-doc .preview iframe.html-preview");
    await frame.locator("h1", { hasText: "HTML from the web" }).waitFor({ timeout: 20_000 });
    assert.equal(await frame.locator("script").count(), 0);
    await shot(page, `${label}-dark-5-html`);
  }

  // 8. Title search.
  await openDrawerIfPhone(page, size);
  await page.locator(".web-search .search").fill("desktop note");
  await (await row(page, "Desktop note.md")).waitFor();
  await page.locator(".web-search .search").fill("");

  // 9. Reload: the config is remembered and the workspace opens by itself.
  const config = JSON.parse(await page.evaluate(() => localStorage.getItem("notebook.config.v2")));
  assert.deepEqual(Object.keys(config), ["version", "auto_lock_minutes", "theme", "accent", "active_workspace", "workspaces"]);
  assert.equal(config.version, 2);
  assert.equal(config.workspaces[0].endpoint, MINIO);
  assert.equal(config.workspaces[0].prefix, env("E2E_PREFIX"));
  const secrets = await page.evaluate(() => localStorage.getItem("notebook.secrets.v1"));
  for (const secret of [env("E2E_SK"), env("E2E_PHRASE"), env("E2E_AK")]) assert.ok(!secrets.includes(secret), "no plaintext secret in localStorage");
  assert.ok(!JSON.stringify(config).includes(env("E2E_AK")), "the config holds only the masked key id");
  await page.reload();
  await page.locator(".web-shell").waitFor({ timeout: 30_000 });
  await openDrawerIfPhone(page, size);
  await row(page, folder);

  // Light theme screenshots of the same screens.
  await page.emulateMedia({ colorScheme: "light" });
  await shot(page, `${label}-light-6-list`);
  await (await row(page, "From desktop")).click();
  await (await row(page, "Desktop note.md")).click();
  await preview.locator("h1#h-written-by-the-desktop-app").waitFor({ timeout: 20_000 });
  await shot(page, `${label}-light-7-preview`);
  await page.emulateMedia({ colorScheme: "dark" });

  // 10. Forget this device: config, sealed secrets and the IndexedDB key go.
  await openDrawerIfPhone(page, size);
  await page.getByRole("button", { name: "Forget this device" }).click();
  await page.locator(".web-modal .confirm").click();
  await page.getByRole("heading", { name: "Connect your workspace" }).waitFor();
  assert.equal(await page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith("notebook.")).length), 0);
  if (engineName === "chromium") {
    const databases = await page.evaluate(async () => (await indexedDB.databases()).map((db) => db.name));
    assert.ok(!databases.includes("notebook-web"), "the sealing key's database is deleted");
  }
  await page.reload();
  await page.getByRole("heading", { name: "Connect your workspace" }).waitFor();

  const csp = await page.evaluate(() => window.__csp);
  assert.deepEqual(csp, [], `${label}: CSP violations`);
  assert.deepEqual(problems, [], `${label}: console errors or dialogs`);
  const allowed = new Set([new URL(WEB).origin, new URL(MINIO).origin]);
  for (const origin of origins) assert.ok(allowed.has(origin) || origin === "null", `${label}: request to ${origin}`);
  await browser.close();
  const extra = size.name === "desktop" ? ", wrong phrase refused, conflict copy, HTML preview" : "";
  log(`ok ${label}: connect, list, open, preview, edit, save, new folder, new note, wikilink, search, reload, forget${extra}`);
}

const engines = (process.env.E2E_BROWSERS ?? "chromium,webkit").split(",").filter(Boolean);
for (const engine of engines) {
  for (const size of SIZES) await run(engine, size);
}
writeFileSync(env("E2E_EXPECT"), `${JSON.stringify(expected, null, 2)}\n`);
log(`wrote ${Object.keys(expected.documents).length} documents and ${expected.folders.length} folders to ${env("E2E_EXPECT")}`);
