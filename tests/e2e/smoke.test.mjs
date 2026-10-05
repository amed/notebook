// tauri-driver smoke test (spec section 16, "Cross-platform"). Linux and Windows
// only; tauri-driver has no macOS backend, so macOS uses the manual checklist.
//
//   npm run tauri -- build --no-bundle
//   npm run test:e2e            (Linux without a display: dbus-run-session -- xvfb-run -a npm run test:e2e)
//
// NOTEBOOK_E2E_APP overrides the app binary (default: the release build), TAURI_DRIVER the
// tauri-driver binary and TAURI_NATIVE_DRIVER the native driver (msedgedriver.exe on
// Windows). Do not use TAURI_APP_PATH: tauri-cli reads it as the src-tauri directory.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Builder, By, until } from "selenium-webdriver";

const SETUP_TITLE = "Connect your encrypted workspace";
const STARTUP_FAILURE = "could not start";
const SESSION_TIMEOUT_MS = 60_000;
const RENDER_TIMEOUT_MS = 60_000;
const HOOK_TIMEOUT_MS = 180_000;
const TEST_TIMEOUT_MS = 30_000;
const APP_ORIGIN = /^(tauri:\/\/localhost|https?:\/\/tauri\.localhost)(\/|$)/;
const BUILD_HINT = "`npm run tauri -- build --no-bundle`";
const HEADLESS_HINT = "`dbus-run-session -- xvfb-run -a npm run test:e2e`";

const windows = process.platform === "win32";
const root = fileURLToPath(new URL("../..", import.meta.url));
// src-tauri/tauri.linux.conf.json renames the Linux binary so it cannot clash with
// the original Notebook app's /usr/bin/notebook.
const binary = windows ? "notebook.exe" : "notebook-vault";
const application = resolve(
  root,
  process.env.NOTEBOOK_E2E_APP ||
    join(process.env.CARGO_TARGET_DIR || "src-tauri/target", "release", binary),
);
const unsupported =
  process.platform === "darwin" && "tauri-driver has no macOS backend; use the manual checklist";
const testOptions = { skip: unsupported, timeout: TEST_TIMEOUT_MS };

let driverProcess = null;
let driverLog = "";
let session = null;
let profile = null;
let rendered = null;

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

// The app inherits this environment through tauri-driver and the native driver,
// so its config, WebView data and caches live in a throwaway directory.
function isolatedEnv(dir) {
  const env = {
    ...process.env,
    HOME: dir,
    XDG_CONFIG_HOME: join(dir, ".config"),
    XDG_DATA_HOME: join(dir, ".local", "share"),
    XDG_CACHE_HOME: join(dir, ".cache"),
    XDG_STATE_HOME: join(dir, ".local", "state"),
  };
  if (windows) {
    // Known-folder lookups ignore APPDATA, so only the WebView2 profile can be redirected.
    Object.assign(env, { USERPROFILE: dir, WEBVIEW2_USER_DATA_FOLDER: join(dir, "WebView2") });
  }
  for (const key of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME"]) {
    mkdirSync(env[key], { recursive: true });
  }
  return env;
}

function tail(text, length = 4000) {
  return text.length > length ? `…${text.slice(-length)}` : text;
}

function killDriver(signal) {
  if (!driverProcess?.pid) return;
  try {
    // tauri-driver runs in its own process group, which also holds the native driver
    // and the app it launched. On Windows its job object takes them down with it.
    if (windows) driverProcess.kill(signal);
    else process.kill(-driverProcess.pid, signal);
  } catch {
    // already gone
  }
}

function within(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function startDriver(env) {
  const port = await freePort();
  const args = ["--port", String(port), "--native-port", String(await freePort())];
  if (process.env.TAURI_NATIVE_DRIVER) args.push("--native-driver", process.env.TAURI_NATIVE_DRIVER);
  const command = process.env.TAURI_DRIVER || "tauri-driver";
  driverProcess = spawn(command, args, { env, detached: !windows, stdio: ["ignore", "pipe", "pipe"] });
  const collect = (chunk) => {
    driverLog = tail(driverLog + chunk, 64_000);
  };
  driverProcess.stdout.on("data", collect);
  driverProcess.stderr.on("data", collect);
  driverProcess.on("error", (error) => collect(`\n${error.message}\n`));
  // A failed or timed-out hook must not keep the runner alive; the exit handler
  // below still kills the driver.
  driverProcess.unref();
  driverProcess.stdout.unref();
  driverProcess.stderr.unref();
  const spawnError = once(driverProcess, "spawn").then(
    () => null,
    (error) => error,
  );
  const error = await spawnError;
  if (error) {
    throw new Error(
      `could not run ${command} (${error.code}). Install it with \`cargo install tauri-driver --locked\` or set TAURI_DRIVER.`,
    );
  }

  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (driverProcess.exitCode !== null || driverProcess.signalCode !== null) {
      throw new Error(`tauri-driver exited early (${driverProcess.exitCode ?? driverProcess.signalCode}):\n${tail(driverLog)}`);
    }
    try {
      const response = await fetch(`${url}/status`, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return url;
    } catch {
      // not listening yet
    }
    await new Promise((wait) => setTimeout(wait, 250));
  }
  throw new Error(`tauri-driver did not become ready within 30 s:\n${tail(driverLog)}`);
}

async function stopDriver() {
  if (session) {
    await within(session.quit(), 15_000).catch(() => {});
    session = null;
  }
  if (driverProcess) {
    const running = driverProcess.exitCode === null && driverProcess.signalCode === null;
    const exited = running ? once(driverProcess, "exit") : Promise.resolve();
    killDriver("SIGTERM");
    if (!(await within(exited, 5_000).then(() => true, () => false))) {
      killDriver("SIGKILL");
      await within(exited, 5_000).catch(() => {});
    }
    // tauri-driver kills only its direct child; anything left in the group goes too.
    if (!windows) killDriver("SIGKILL");
    driverProcess = null;
  }
  if (profile) {
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    profile = null;
  }
}

function inPage(script) {
  return session.executeScript(script);
}

// Waits until #app shows either the setup screen or the startup-failure card.
async function waitForFirstScreen() {
  const deadline = Date.now() + RENDER_TIMEOUT_MS;
  let last = { url: "", text: null, error: null };
  while (Date.now() < deadline) {
    try {
      last = await inPage(`
        const app = document.querySelector("#app");
        return { url: location.href, text: app ? app.innerText : null, error: null };
      `);
      if (last.text?.includes(SETUP_TITLE) || last.text?.includes(STARTUP_FAILURE)) return last;
    } catch (error) {
      last = { ...last, error: error.message };
    }
    await new Promise((wait) => setTimeout(wait, 250));
  }
  return { ...last, timedOut: true };
}

function abandon() {
  killDriver("SIGKILL");
  try {
    if (profile) rmSync(profile, { recursive: true, force: true });
  } catch {
    // best effort while exiting
  }
}

process.once("exit", abandon);
for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]]) {
  process.once(signal, () => {
    abandon();
    process.exit(code);
  });
}

before(
  async () => {
    if (unsupported) return;
    if (!existsSync(application)) {
      throw new Error(
        `app binary not found at ${application}. Build it with ${BUILD_HINT} or set NOTEBOOK_E2E_APP.`,
      );
    }
    if (windows && process.env.APPDATA) {
      const realConfig = join(process.env.APPDATA, "com.securemd.vault", "config.json");
      assert.ok(
        !existsSync(realConfig),
        `${realConfig} exists; on Windows the app's config folder cannot be redirected, so run this test on a clean profile (for example CI).`,
      );
    }
    profile = mkdtempSync(join(tmpdir(), "notebook-e2e-"));
    const server = await startDriver(isolatedEnv(profile));
    const starting = new Builder()
      .usingServer(`${server}/`)
      .withCapabilities({ browserName: "wry", "tauri:options": { application } })
      .build();
    try {
      session = await within(starting, SESSION_TIMEOUT_MS);
    } catch (error) {
      starting.then((late) => late.quit()).catch(() => {});
      const display = !windows && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
      throw new Error(
        `could not start a WebDriver session: ${error.message}\n` +
          (display ? `No display is set; on a headless Linux machine run ${HEADLESS_HINT}.\n` : "") +
          `driver log:\n${tail(driverLog)}`,
      );
    }
    rendered = await waitForFirstScreen();
  },
  { timeout: HOOK_TIMEOUT_MS },
);

after(stopDriver, { timeout: HOOK_TIMEOUT_MS });

test("renders the setup screen on a fresh profile", testOptions, async () => {
  const { url, text, error, timedOut } = rendered;
  assert.ok(
    text?.includes(SETUP_TITLE),
    `expected "${SETUP_TITLE}" in #app${timedOut ? ` within ${RENDER_TIMEOUT_MS / 1000} s` : ""}.\n` +
      `url: ${url || "(unknown)"}\n#app text: ${JSON.stringify(text)}\n` +
      (error ? `last WebDriver error: ${error}\n` : "") +
      (timedOut
        ? "A binary built with plain `cargo build` or `tauri dev` loads the Vite dev URL instead of the bundled frontend.\n"
        : "") +
      `driver log:\n${tail(driverLog, 2000)}`,
  );
  assert.match(
    url,
    APP_ORIGIN,
    `the app loaded ${url}, not the embedded frontend; rebuild with ${BUILD_HINT} (a \`tauri dev\` build at the same path loads the Vite dev server)`,
  );
  // innerText still reports text that is hidden by CSS, so check what is actually rendered.
  const heading = await session.findElement(By.css("#app .auth-card h1"));
  assert.equal(await heading.getText(), SETUP_TITLE, "setup heading is in the DOM but not visibly rendered");
  assert.ok(await heading.isDisplayed(), "setup heading is not displayed");
});

test("does not show the startup-failure card", testOptions, () => {
  assert.ok(
    !rendered.text?.includes(STARTUP_FAILURE),
    `the app showed its startup-failure card: ${JSON.stringify(rendered.text)}`,
  );
});

test("IPC answers config_get with an empty config", testOptions, async () => {
  const config = await inPage(`
    return window.__TAURI_INTERNALS__.invoke("config_get").then(
      (c) => ({ bucket: c.bucket, credentials_stored: c.credentials_stored }),
      (e) => ({ error: String(e) }),
    );
  `);
  assert.deepEqual(config, { bucket: "", credentials_stored: false });
});

test("the CSP blocks an injected inline script", testOptions, async () => {
  const result = await inPage(`
    return new Promise((done) => {
      let violated = null;
      document.addEventListener("securitypolicyviolation", (event) => { violated = event.violatedDirective; }, { once: true });
      const probe = document.createElement("script");
      probe.textContent = "document.documentElement.dataset.cspProbe = 'ran'";
      document.head.append(probe);
      setTimeout(() => {
        probe.remove();
        done({ ran: document.documentElement.dataset.cspProbe === "ran", violated });
      }, 300);
    });
  `);
  assert.equal(result.ran, false, "inline script ran: the CSP is missing or not enforced");
  assert.match(String(result.violated), /^script-src/);
});

// The HTML preview frame (src/html-preview.ts) loads the static preview.html.
// A real click on an in-page link must scroll inside it; with the earlier
// about:blank frame WebKit loaded the app's index.html instead (blank pane).
// The page is painted as swapPage() and styleScrollbars() paint it: the frame
// keeps its own <html>, <head> and <body> (WebKit draws no scrollbar once the
// element that styled it is replaced) and the app's scrollbar style comes
// first in <head>, so the scrollbar must take room beside the page.
test("the HTML preview frame renders a page and scrolls to in-page links", testOptions, async () => {
  const result = await inPage(`
    return new Promise((done) => {
      let violated = null;
      document.addEventListener("securitypolicyviolation", (event) => {
        if (event.violatedDirective.startsWith("frame-src")) violated = event.violatedDirective;
      });
      const frame = document.createElement("iframe");
      frame.id = "e2e-html-preview";
      frame.style.cssText = "position: fixed; top: 0; left: 0; width: 400px; height: 300px; z-index: 9999";
      frame.setAttribute("sandbox", "allow-same-origin");
      frame.addEventListener("load", () => {
        const page = new DOMParser().parseFromString(
          "<!doctype html><html lang='en'><style>p { color: rgb(0, 128, 0) }</style><body class='page'><p id='ready'><a id='jump' href='#end'>Jump</a></p><div style='height: 3000px'></div><p id='end'>End</p>",
          "text/html",
        );
        const target = frame.contentDocument;
        const copyAttributes = (to, from) => {
          for (const { name } of [...to.attributes]) if (!from.hasAttribute(name)) to.removeAttribute(name);
          for (const { name, value } of from.attributes) to.setAttribute(name, value);
        };
        copyAttributes(target.documentElement, page.documentElement);
        copyAttributes(target.head, page.head);
        copyAttributes(target.body, page.body);
        target.head.replaceChildren(...[...page.head.childNodes].map((node) => target.importNode(node, true)));
        target.body.replaceChildren(...[...page.body.childNodes].map((node) => target.importNode(node, true)));
        const scrollbars = target.createElement("style");
        scrollbars.dataset.notebook = "scrollbars";
        scrollbars.textContent = "::-webkit-scrollbar { width: 12px; height: 12px } ::-webkit-scrollbar-thumb { background-color: rgba(0, 0, 0, 0.1) }";
        target.head.prepend(scrollbars);
        setTimeout(() => done({
          url: target.URL,
          mode: target.compatMode,
          color: frame.contentWindow.getComputedStyle(target.querySelector("#ready")).color,
          lang: target.documentElement.lang,
          bodyClass: target.body.className,
          firstInHead: target.head.firstElementChild?.dataset.notebook,
          gutter: frame.contentWindow.innerWidth - target.documentElement.clientWidth,
          violated,
        }), 100);
      }, { once: true });
      frame.src = "preview.html";
      document.body.append(frame);
    });
  `);
  try {
    assert.match(result.url, /\/preview\.html$/);
    assert.deepEqual(
      { mode: result.mode, color: result.color, lang: result.lang, bodyClass: result.bodyClass, firstInHead: result.firstInHead, violated: result.violated },
      { mode: "CSS1Compat", color: "rgb(0, 128, 0)", lang: "en", bodyClass: "page", firstInHead: "scrollbars", violated: null },
    );
    assert.ok(result.gutter > 0, `the frame scrollbar takes no room (${result.gutter} px): it is not drawn`);
    await session.switchTo().frame(await session.findElement(By.css("#e2e-html-preview")));
    try {
      await session.findElement(By.css("#jump")).click();
    } finally {
      await session.switchTo().defaultContent();
    }
    const after = await inPage(`
      const target = document.querySelector("#e2e-html-preview").contentDocument;
      return { url: target.URL, ready: target.querySelector("#ready")?.textContent, scrolled: target.scrollingElement.scrollTop > 0 };
    `);
    assert.match(after.url, /\/preview\.html#end$/);
    assert.deepEqual({ ready: after.ready, scrolled: after.scrolled }, { ready: "Jump", scrolled: true });
  } finally {
    await inPage('document.querySelector("#e2e-html-preview")?.remove();');
  }
});

test("the Monaco editor worker loads under the CSP", testOptions, async () => {
  const result = await inPage(`
    return new Promise((done) => {
      let violated = null;
      document.addEventListener("securitypolicyviolation", (event) => { violated = event.violatedDirective; }, { once: true });
      let worker;
      try {
        worker = self.MonacoEnvironment.getWorker();
      } catch (error) {
        done({ threw: error.name });
        return;
      }
      let error = null;
      worker.addEventListener("error", (event) => { error = event.message || "error"; });
      setTimeout(() => {
        worker.terminate();
        done({ error, violated });
      }, 1500);
    });
  `);
  assert.deepEqual(result, { error: null, violated: null });
});

test("auth card contains no raw undefined or [object Object]", testOptions, async () => {
  const found = await inPage(`
    const card = document.querySelector("#app .auth-card");
    if (!card) return null;
    const strings = [card.textContent];
    for (const element of [card, ...card.querySelectorAll("*")]) {
      for (const attribute of element.attributes) strings.push(attribute.value);
      if ("value" in element && typeof element.value === "string") strings.push(element.value);
    }
    return strings.filter((value) => /\\bundefined\\b|\\[object Object\\]/.test(value));
  `);
  assert.ok(found, "no .auth-card inside #app");
  assert.deepEqual(found, [], "raw undefined or [object Object] rendered in the auth card");
});

test("cookies, localStorage and sessionStorage are unused", testOptions, async () => {
  const storage = await inPage(`
    const size = (read) => {
      try {
        return read().length;
      } catch (error) {
        return "threw " + error.name;
      }
    };
    return { cookie: document.cookie, localStorage: size(() => localStorage), sessionStorage: size(() => sessionStorage) };
  `);
  assert.deepEqual(storage, { cookie: "", localStorage: 0, sessionStorage: 0 });
});

test("a link click opens the confirm dialog instead of navigating", testOptions, async () => {
  const target = "https://example.com/x";
  const before = await inPage("return location.href;");
  await inPage(`
    const link = document.createElement("a");
    link.id = "e2e-link";
    link.href = ${JSON.stringify(target)};
    link.textContent = "external link";
    document.querySelector("#app .auth-card").append(link);
  `);
  try {
    await session.findElement(By.css("#e2e-link")).click();
    const detail = await session.wait(until.elementLocated(By.css(".modal-overlay .modal-detail")), 5_000, "no confirm dialog appeared");
    assert.equal(await detail.getText(), target, "the confirm dialog does not show the full URL");
    assert.ok(await detail.isDisplayed(), "the confirm dialog is not displayed");
    assert.equal(await inPage("return location.href;"), before, "the link click navigated the WebView");
    await session.findElement(By.css(".modal-overlay .cancel")).click();
    assert.equal(await inPage('return document.querySelectorAll(".modal-overlay").length;'), 0, "Cancel did not close the dialog");
    assert.equal(await inPage("return location.href;"), before);
  } finally {
    await inPage(`
      document.querySelector("#e2e-link")?.remove();
      for (const overlay of document.querySelectorAll(".modal-overlay")) overlay.remove();
    `).catch(() => {});
  }
});

test("window.open does not create a window or navigate", testOptions, async () => {
  const before = await inPage("return location.href;");
  const handles = (await session.getAllWindowHandles()).length;
  const opened = await inPage('return window.open("https://example.com") === null;');
  assert.equal(opened, true, "window.open returned a window");
  await new Promise((wait) => setTimeout(wait, 500));
  assert.equal((await session.getAllWindowHandles()).length, handles, "window.open created a window");
  assert.equal(await inPage("return location.href;"), before, "window.open navigated the WebView");
});

test("page script cannot close or resize the window", testOptions, async () => {
  const handles = (await session.getAllWindowHandles()).length;
  const results = await inPage(`
    const attempt = (command, args) => window.__TAURI_INTERNALS__.invoke(command, args).then(
      () => "allowed",
      () => "denied",
    );
    return Promise.all([
      attempt("plugin:window|close", { label: "main" }),
      attempt("plugin:window|minimize", { label: "main" }),
      attempt("plugin:window|toggle_maximize", { label: "main" }),
      // Listening is granted (core:event:allow-listen) for Rust's "auto-lock"
      // event; emitting is not, so the page cannot talk to itself through Rust.
      attempt("plugin:event|listen", {
        event: "notebook-probe",
        target: { kind: "Any" },
        handler: window.__TAURI_INTERNALS__.transformCallback(() => {}),
      }),
      attempt("plugin:event|emit", { event: "auto-lock", payload: true }),
      // Granted, but closes the window only while a close waits for the page.
      attempt("close_after_flush", {}),
    ]);
  `);
  assert.deepEqual(results, ["denied", "denied", "denied", "allowed", "denied", "allowed"]);
  await new Promise((wait) => setTimeout(wait, 500));
  assert.equal((await session.getAllWindowHandles()).length, handles, "the window was closed");
  assert.match(await inPage("return location.href;"), APP_ORIGIN);
});

// Keep this test last: without the Rust navigation guard the WebView ends up on
// the probe page, which would break any test that runs after it.
test("the WebView never leaves the app, even when the page bypasses the link guard", testOptions, async () => {
  const requests = [];
  const server = createHttpServer((request, response) => {
    requests.push(request.url);
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<!doctype html><title>probe</title><p>probe page</p>");
  });
  await new Promise((listening) => server.listen(0, "127.0.0.1", listening));
  const probe = `http://127.0.0.1:${server.address().port}`;
  try {
    const before = await inPage("return location.href;");
    const handles = (await session.getAllWindowHandles()).length;
    // A detached link's click never reaches the document-level click handler.
    await inPage(`
      for (const [path, target] of [["/new-window", "_blank"], ["/link", ""]]) {
        const link = document.createElement("a");
        link.href = ${JSON.stringify(probe)} + path;
        if (target) link.target = target;
        link.click();
      }
    `);
    await new Promise((wait) => setTimeout(wait, 1_000));
    await inPage(`location.href = ${JSON.stringify(`${probe}/script`)};`);
    await new Promise((wait) => setTimeout(wait, 1_500));
    assert.equal(await inPage("return location.href;"), before, "the WebView navigated away from the app");
    assert.equal((await session.getAllWindowHandles()).length, handles, "a new window was opened");
    assert.deepEqual(requests, [], "the WebView requested a page outside the app");
  } finally {
    server.closeAllConnections();
    await new Promise((closed) => server.close(closed));
  }
});
