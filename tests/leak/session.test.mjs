// Local leakage scan after a scripted session (spec section 16). Linux only:
// tauri-driver has no macOS backend, and on Windows the app's config folder
// cannot be redirected away from the real profile.
//
//   npm run tauri -- build --debug --no-bundle
//   xvfb-run -a npm run test:leak        (needs dbus-daemon, gnome-keyring, webkit2gtk-driver, tauri-driver)
//
// The session runs the debug build: only debug builds accept a loopback
// http:// S3 endpoint, and this one is an in-process fake. The app stores the
// secrets file's master key in a Secret Service: the test starts its own
// D-Bus session bus and gnome-keyring inside the profile, so the app never
// reaches the desktop's real keychain, and the keyring file is scanned too.
//
// Random canaries go into a folder name, a document name, the document text
// (three edits, the last one staged while S3 is unreachable, so the outbox
// holds it), the S3 secret key and the remembered phrase. The session also
// renders the preview, locks, unlocks with the remembered phrase, reads the
// document back, moves it to Trash and restores it. Then, with the app shut
// down, scripts/leak-scan/ searches the whole profile (config, secrets,
// outbox, WebView data and caches, temp, XDG_RUNTIME_DIR runtime files, the
// keyring), new files in the system temp folders and the caller's
// XDG_RUNTIME_DIR, the captured driver and app output, and every raw object
// in the bucket. Any hit fails, and so does a file in the profile that the
// scan could not read.
//
// NOTEBOOK_LEAK_APP overrides the app binary (default: the debug build).

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { By, Key, until } from "selenium-webdriver";
import { scanPaths } from "../../scripts/leak-scan/leak-scan.mjs";
import { TauriApp, tail } from "../e2e/driver.mjs";
import { startFakeS3 } from "./fake-s3.mjs";

const IDENTIFIER = "com.securemd.vault";
const STEP_MS = 60_000;
const root = fileURLToPath(new URL("../..", import.meta.url));
const application = resolve(
  root,
  process.env.NOTEBOOK_LEAK_APP || join(process.env.CARGO_TARGET_DIR || "src-tauri/target", "debug", "notebook-vault"),
);
const skip = process.platform !== "linux" && "the leakage session runs on Linux only (see the header)";

const stem = `LK${randomBytes(6).toString("hex")}`;
const CANARY = {
  folder: `${stem}folder`,
  name: `${stem}name`,
  body: `${stem}body`,
  edit: `${stem}edit`,
  offline: `${stem}offline`,
  secret: `${stem}secret`,
  phrase: `${stem}phrase`,
};
const canaries = [stem, ...Object.values(CANARY)];

const app = new TauriApp(application, "notebook-leak-");
let s3 = null;
let secretService = null;
let session = null;
const started = Date.now();

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
const css = (selector) => By.css(selector);
const find = (selector) => session.wait(until.elementLocated(css(selector)), STEP_MS, `no ${selector}`);

async function waitFor(what, check, ms = STEP_MS) {
  const deadline = Date.now() + ms;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await check();
      if (last) return last;
    } catch (error) {
      last = error.message;
    }
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${what} (last: ${JSON.stringify(last)})\ndriver log:\n${tail(app.log, 3000)}`);
}

const syncState = () => session.executeScript(`return document.querySelector(".statusbar .sync")?.className ?? ""`);
const rowId = (text) =>
  session.executeScript(
    `return [...document.querySelectorAll(".tree-row[data-node-id]")].find((row) => row.textContent.includes(arguments[0]))?.dataset.nodeId ?? null`,
    text,
  );

/**
 * A private D-Bus session bus with gnome-keyring on it, both under `dir`.
 * The keyring's login collection is the default one the app writes to.
 */
async function startSecretService(dir) {
  mkdirSync(join(dir, "keyring-home"), { recursive: true });
  // Runtime files of the bus, the keyring and every service the bus starts
  // for the app (portals, the accessibility bus) stay in the profile too.
  const runtime = join(dir, "run");
  mkdirSync(runtime, { recursive: true, mode: 0o700 });
  chmodSync(runtime, 0o700);
  const bus = spawn("dbus-daemon", ["--session", "--nofork", "--nopidfile", "--print-address=1", `--address=unix:path=${join(dir, "bus")}`], {
    env: { ...process.env, XDG_RUNTIME_DIR: runtime },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const address = await new Promise((resolveAddress, reject) => {
    bus.once("error", (error) => reject(new Error(`could not run dbus-daemon (${error.code})`)));
    bus.stdout.once("data", (chunk) => resolveAddress(String(chunk).split("\n")[0].trim()));
  });
  const env = { ...process.env, HOME: join(dir, "keyring-home"), XDG_RUNTIME_DIR: runtime, DBUS_SESSION_BUS_ADDRESS: address };
  const keyring = spawn("gnome-keyring-daemon", ["--foreground", "--unlock", "--components=secrets"], { env, stdio: ["pipe", "ignore", "inherit"] });
  let failed = null;
  keyring.once("error", (error) => {
    failed = error;
  });
  keyring.stdin.end("leak-scan-keyring");
  const stop = () => {
    for (const child of [keyring, bus]) child.kill("SIGTERM");
  };
  try {
    await waitFor("gnome-keyring's default collection", () => {
      if (failed) throw new Error(`could not run gnome-keyring-daemon (${failed.code})`);
      if (keyring.exitCode !== null) throw new Error(`gnome-keyring-daemon exited (${keyring.exitCode})`);
      const send = (...args) => execFileSync("dbus-send", ["--session", "--print-reply", ...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      // Asking org.freedesktop.secrets before the daemon owns the name would
      // start a second, passwordless keyring through D-Bus activation.
      if (!send("--dest=org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus.NameHasOwner", "string:org.freedesktop.secrets").includes("true")) return false;
      return send("--dest=org.freedesktop.secrets", "/org/freedesktop/secrets", "org.freedesktop.Secret.Service.ReadAlias", "string:default").includes("/collection/");
    }, 20_000);
  } catch (error) {
    stop();
    throw error;
  }
  return { address, stop };
}

/** Files under `dir`, recursively. */
function filesIn(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? filesIn(join(dir, entry.name)) : entry.isFile() ? [join(dir, entry.name)] : [],
  );
}

const configDir = () => join(app.profile, ".config", IDENTIFIER);
const outboxDir = () => join(app.profile, ".local", "share", IDENTIFIER, "outbox");

async function typeInEditor(text) {
  const editor = await find(".cm-content");
  await editor.click();
  await session.actions().keyDown(Key.CONTROL).sendKeys(Key.END).keyUp(Key.CONTROL).perform();
  await editor.sendKeys(text);
}

async function save() {
  await session.actions().keyDown(Key.CONTROL).sendKeys("s").keyUp(Key.CONTROL).perform();
}

// `own` lists the folders whose unreadable files fail the test (default: all
// scanned roots). A file the scanner could not read was never searched. The
// shared temp folders legitimately hold other users' files, such as
// systemd-private-*, so the final scan passes only the profile and evidence.
function assertClean(result, where, own) {
  const report = result.hits.map((hit) => `${hit.canary} as ${hit.encoding} in ${hit.file} at byte ${hit.offset}`);
  assert.deepEqual(report, [], `plaintext found in ${where}`);
  const inside = (path) => !own || own.some((folder) => path === folder || path.startsWith(folder + sep));
  const unread = result.skipped.filter((entry) => inside(entry.path)).map((entry) => `${entry.path} (${entry.reason})`);
  assert.deepEqual(unread, [], `unreadable files in ${where} were not scanned`);
}

before(
  async () => {
    if (skip) return;
    assert.ok(existsSync(application), `app binary not found at ${application}; build it with \`npm run tauri -- build --debug --no-bundle\` or set NOTEBOOK_LEAK_APP`);
    s3 = await startFakeS3();
    secretService = await startSecretService(join(app.createProfile(), "session-bus"));
    session = await app.start({ DBUS_SESSION_BUS_ADDRESS: secretService.address });
  },
  { timeout: 180_000 },
);

after(
  async () => {
    await app.stop();
    secretService?.stop();
    await s3?.close();
  },
  { timeout: 60_000 },
);

test("a full session leaves no plaintext on disk, in logs or in the bucket", { skip, timeout: 600_000 }, async () => {
  // Connect: credentials and the remembered phrase go to the sealed secrets file.
  await find("#setup-form");
  const fields = {
    bucket: "leak-bucket",
    prefix: "vault",
    endpoint: s3.endpoint,
    accessKeyId: "leak-access-key",
    secretAccessKey: CANARY.secret,
    phrase: CANARY.phrase,
  };
  for (const [name, value] of Object.entries(fields)) {
    const input = await find(`#setup-form input[name="${name}"]`);
    await input.clear();
    await input.sendKeys(value);
  }
  assert.ok(await (await find('#setup-form input[name="remember"]')).isSelected(), "Remember phrase is not checked by default");
  await (await find('#setup-form button[type="submit"]')).click();
  const opened = await waitFor("the workspace or a connect error", async () =>
    (await session.findElements(css(".workspace .tree"))).length > 0 ||
    (await session.executeScript(`return document.querySelector("#setup-error")?.textContent || ""`)));
  assert.equal(opened, true, `connect failed: ${opened}`);

  // A document in a new folder, both names carrying canaries.
  await (await find("#new-file")).click();
  const path = await find('.modal-overlay input[name="path"]');
  await path.clear();
  await path.sendKeys(`/${CANARY.folder}/${CANARY.name}`, Key.ENTER);
  await waitFor("the new document in the tree", () => rowId(CANARY.name));
  await find(".cm-content");

  await typeInEditor(`\n\nGrüße aus dem Test, 日本語. ${CANARY.body}\n`);
  await save();
  await waitFor("the first upload", async () => s3.count("PUT") > 0 && (await syncState()).includes("clean"));

  // The rendered preview holds the text in the DOM too.
  await (await find('[data-mode="split"]')).click();
  await waitFor("the preview", () => session.executeScript(`return document.querySelector(".preview")?.textContent.includes("Grüße") ?? false`));

  const puts = s3.count("PUT");
  await typeInEditor(`\nSecond edit ${CANARY.edit}\n`);
  await save();
  await waitFor("the second upload", async () => s3.count("PUT") > puts && (await syncState()).includes("clean"));

  // S3 unreachable: the next edit is staged into the outbox and stays there.
  s3.state.offline = true;
  await typeInEditor(`\nOffline edit ${CANARY.offline}\n`);
  await waitFor("the staged edit in the outbox", () => filesIn(outboxDir()).length > 0, 20_000);
  await (await find("#lock")).click();
  await find("#unlock-form");

  // While locked: the outbox and the secrets file hold only ciphertext.
  const outbox = filesIn(outboxDir());
  assert.ok(outbox.length > 0, "the outbox is empty; the offline edit was not staged");
  assert.ok(existsSync(join(configDir(), "secrets.json")), "no secrets.json was written");
  assertClean(scanPaths([outboxDir(), configDir()], canaries), "the outbox or the config folder");

  // Unlock with the remembered phrase; the queued edit uploads and decrypts.
  s3.state.offline = false;
  await (await find('#unlock-form button[type="submit"]')).click();
  await find(".workspace .tree");
  const folder = await waitFor("the folder row", () => rowId(CANARY.folder));
  if (!(await rowId(CANARY.name))) await (await find(`.tree-row[data-node-id="${folder}"]`)).click();
  const doc = await waitFor("the document row", () => rowId(CANARY.name));
  await (await find(`.tree-row[data-node-id="${doc}"]`)).click();
  await waitFor("the decrypted text", async () => {
    const text = await (await find(".cm-content")).getText();
    return [CANARY.body, CANARY.edit, CANARY.offline].every((canary) => text.includes(canary));
  });
  await waitFor("the outbox to drain", () => filesIn(outboxDir()).length === 0, 30_000);

  // Trash and restore: the deleted item's name and path go through S3 too.
  await session.actions().contextClick(await find(`.tree-row[data-node-id="${doc}"]`)).perform();
  await (await find(".context-menu .menu-danger")).click();
  await (await find(".modal-overlay button.confirm")).click();
  await waitFor("the document to leave the tree", async () => !(await rowId(CANARY.name)));
  await (await find(".trash-button")).click();
  await (await find(".modal-overlay .trash-row .button")).click();
  await waitFor("the restored document", () => rowId(CANARY.name));
  await session.executeScript(`document.querySelectorAll(".modal-overlay").forEach((overlay) => overlay.remove())`);

  await (await find("#lock")).click();
  await find("#unlock-form");
  await app.stop({ keepProfile: true });
  secretService.stop();
  await sleep(500);

  // Everything the session could have written, scanned after shutdown.
  const evidence = join(app.profile, "..", `${app.profile.split(/[\\/]/).pop()}-evidence`);
  mkdirSync(join(evidence, "bucket"), { recursive: true });
  writeFileSync(join(evidence, "driver-and-app.log"), app.log);
  writeFileSync(join(evidence, "bucket-keys.txt"), [...s3.objects.keys()].join("\n"));
  [...s3.objects.values()].forEach((object, index) => writeFileSync(join(evidence, "bucket", `${index}.bin`), object.body));
  assert.ok(s3.objects.size > 0, "the bucket is empty");

  const roots = [app.profile, evidence];
  // The runner's own XDG_RUNTIME_DIR too, in case anything still writes there.
  const sharedRoots = [tmpdir(), "/tmp", "/var/tmp", "/dev/shm", join(homedir(), ".local", "share", "keyrings"), process.env.XDG_RUNTIME_DIR];
  for (const shared of sharedRoots.filter(Boolean)) {
    if (!existsSync(shared)) continue;
    for (const name of readdirSync(shared)) {
      const path = join(shared, name);
      if (resolve(path) !== resolve(app.profile) && resolve(path) !== resolve(evidence)) roots.push({ path, newerThan: started });
    }
  }
  // The WebView keeps its data in the app's data folder, inside the profile.
  const appData = join(app.profile, ".local", "share", IDENTIFIER);
  assert.ok(["WebKitCache", "storage"].some((name) => existsSync(join(appData, name))), `no WebView data in ${appData}; the scan would miss it`);
  const result = scanPaths(roots, canaries);
  const areas = readdirSync(app.profile, { recursive: true, withFileTypes: true }).filter((entry) => entry.isDirectory()).length;
  console.log(
    `leak scan: ${result.files} files (${result.bytes} bytes) in ${roots.length} roots, ${areas} profile folders, ` +
      `${s3.objects.size} bucket objects, ${app.log.length} log characters, ${result.skipped.length} unreadable`,
  );
  // What was looked at, by folder (LEAK_SCAN_LIST=1 lists every file).
  const byFolder = new Map();
  for (const file of filesIn(app.profile)) {
    const parts = file.slice(app.profile.length + 1).split(/[\\/]/);
    const folder = parts.slice(0, Math.min(parts.length - 1, parts[0] === ".local" ? 3 : 2)).join("/") || ".";
    const [count, bytes] = byFolder.get(folder) ?? [0, 0];
    byFolder.set(folder, [count + 1, bytes + statSync(file).size]);
    if (process.env.LEAK_SCAN_LIST) console.log(`    ${file.slice(app.profile.length + 1)} ${statSync(file).size}`);
  }
  for (const [folder, [count, bytes]] of [...byFolder].sort()) console.log(`  ${folder}: ${count} files, ${bytes} bytes`);
  try {
    assertClean(result, "the profile, temp folders, logs or bucket", [realpathSync(app.profile), realpathSync(evidence)]);
  } finally {
    app.removeProfile();
    // The evidence folder goes too; a failed run printed every hit above.
    rmSync(evidence, { recursive: true, force: true });
  }
});
