// tauri-driver session for the end-to-end and leakage tests: an isolated
// profile, tauri-driver in its own process group, and its captured output
// (which includes the app's stdout and stderr). Linux and Windows only.

import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Builder } from "selenium-webdriver";

export const windows = process.platform === "win32";
const SESSION_TIMEOUT_MS = 60_000;
const HEADLESS_HINT = "`dbus-run-session -- xvfb-run -a npm run test:e2e`";

export function tail(text, length = 4000) {
  return text.length > length ? `…${text.slice(-length)}` : text;
}

export function within(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

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
// so its config, WebView data, caches and temp files live in a throwaway directory.
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
  } else {
    env.TMPDIR = join(dir, "tmp");
    mkdirSync(env.TMPDIR, { recursive: true });
    // GLib, dconf and WebKitGTK put runtime files and sockets here; GLib wants mode 0700.
    env.XDG_RUNTIME_DIR = join(dir, "run");
    mkdirSync(env.XDG_RUNTIME_DIR, { recursive: true, mode: 0o700 });
    chmodSync(env.XDG_RUNTIME_DIR, 0o700);
  }
  for (const key of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME"]) {
    mkdirSync(env[key], { recursive: true });
  }
  return env;
}

export class TauriApp {
  /** The WebDriver session, once `start` resolved. */
  session = null;
  /** The throwaway profile (HOME); removed by `stop` unless `keepProfile`. */
  profile = null;
  /** tauri-driver's output so far, the app's included (last 4 MB). */
  log = "";
  #driver = null;

  constructor(application, prefix = "notebook-e2e-") {
    this.application = application;
    this.prefix = prefix;
    // A failed or timed-out hook must not leave the driver or the app running.
    process.once("exit", () => this.abandon());
    for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]]) {
      process.once(signal, () => {
        this.abandon();
        process.exit(code);
      });
    }
  }

  /** Makes the throwaway profile now, for files the app should find in it (`start` makes it otherwise). */
  createProfile() {
    this.profile ??= mkdtempSync(join(tmpdir(), this.prefix));
    return this.profile;
  }

  /** Starts tauri-driver and a session; `env` adds to the isolated environment. */
  async start(env = {}) {
    const server = await this.#startDriver({ ...isolatedEnv(this.createProfile()), ...env });
    const starting = new Builder()
      .usingServer(`${server}/`)
      .withCapabilities({ browserName: "wry", "tauri:options": { application: this.application } })
      .build();
    try {
      this.session = await within(starting, SESSION_TIMEOUT_MS);
    } catch (error) {
      starting.then((late) => late.quit()).catch(() => {});
      const display = !windows && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
      throw new Error(
        `could not start a WebDriver session: ${error.message}\n` +
          (display ? `No display is set; on a headless Linux machine run ${HEADLESS_HINT}.\n` : "") +
          `driver log:\n${tail(this.log)}`,
      );
    }
    return this.session;
  }

  /** Ends the session and the driver's process group, then removes the profile unless kept. */
  async stop({ keepProfile = false } = {}) {
    if (this.session) {
      await within(this.session.quit(), 15_000).catch(() => {});
      this.session = null;
    }
    const driver = this.#driver;
    if (driver) {
      const running = driver.exitCode === null && driver.signalCode === null;
      const exited = running ? once(driver, "exit") : Promise.resolve();
      this.#kill("SIGTERM");
      if (!(await within(exited, 5_000).then(() => true, () => false))) {
        this.#kill("SIGKILL");
        await within(exited, 5_000).catch(() => {});
      }
      // tauri-driver kills only its direct child; anything left in the group goes too.
      if (!windows) this.#kill("SIGKILL");
      this.#driver = null;
    }
    if (this.profile && !keepProfile) this.removeProfile();
  }

  removeProfile() {
    if (!this.profile) return;
    rmSync(this.profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    this.profile = null;
  }

  abandon() {
    this.#kill("SIGKILL");
    try {
      if (this.profile) rmSync(this.profile, { recursive: true, force: true });
    } catch {
      // best effort while exiting
    }
  }

  #kill(signal) {
    const driver = this.#driver;
    if (!driver?.pid) return;
    try {
      // tauri-driver runs in its own process group, which also holds the native driver
      // and the app it launched. On Windows its job object takes them down with it.
      if (windows) driver.kill(signal);
      else process.kill(-driver.pid, signal);
    } catch {
      // already gone
    }
  }

  async #startDriver(env) {
    const port = await freePort();
    const args = ["--port", String(port), "--native-port", String(await freePort())];
    if (process.env.TAURI_NATIVE_DRIVER) args.push("--native-driver", process.env.TAURI_NATIVE_DRIVER);
    const command = process.env.TAURI_DRIVER || "tauri-driver";
    const driver = spawn(command, args, { env, detached: !windows, stdio: ["ignore", "pipe", "pipe"] });
    this.#driver = driver;
    const collect = (chunk) => {
      this.log += chunk;
      if (this.log.length > 4_000_000) this.log = this.log.slice(-4_000_000);
    };
    driver.stdout.on("data", collect);
    driver.stderr.on("data", collect);
    driver.on("error", (error) => collect(`\n${error.message}\n`));
    driver.unref();
    driver.stdout.unref();
    driver.stderr.unref();
    const error = await once(driver, "spawn").then(() => null, (failure) => failure);
    if (error) {
      throw new Error(
        `could not run ${command} (${error.code}). Install it with \`cargo install tauri-driver --locked\` or set TAURI_DRIVER.`,
      );
    }

    const url = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (driver.exitCode !== null || driver.signalCode !== null) {
        throw new Error(`tauri-driver exited early (${driver.exitCode ?? driver.signalCode}):\n${tail(this.log)}`);
      }
      try {
        const response = await fetch(`${url}/status`, { signal: AbortSignal.timeout(2_000) });
        if (response.ok) return url;
      } catch {
        // not listening yet
      }
      await new Promise((wait) => setTimeout(wait, 250));
    }
    throw new Error(`tauri-driver did not become ready within 30 s:\n${tail(this.log)}`);
  }
}
