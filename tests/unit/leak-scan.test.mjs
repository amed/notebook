import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { canaryPatterns, scanPaths } from "../../scripts/leak-scan/leak-scan.mjs";

const CANARY = "LEAKCANARY_7f3a9c21";
const script = fileURLToPath(new URL("../../scripts/leak-scan/leak-scan.mjs", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "leak-scan-test-"));
after(() => {
  try {
    chmodSync(join(dir, "locked", "secret.log"), 0o600);
  } catch {}
  rmSync(dir, { recursive: true, force: true });
});

function place(name, bytes) {
  const path = join(dir, name);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, bytes);
  return path;
}

test("finds the canary in every encoding it is searched as", () => {
  // "hex" and "HEX" would be one file on a case-insensitive disk.
  const fileName = (encoding) => `${encoding === "HEX" ? "hex-upper" : encoding}.bin`;
  const utf8 = Buffer.from(CANARY);
  const cases = {
    "utf-8": utf8,
    "utf-16le": Buffer.from(CANARY, "utf16le"),
    "utf-16be": Buffer.from(CANARY, "utf16le").swap16(),
    hex: Buffer.from(utf8.toString("hex")),
    HEX: Buffer.from(utf8.toString("hex").toUpperCase()),
  };
  for (const lead of [0, 1, 2]) {
    // The canary inside a longer base64 value, starting at each byte alignment.
    const value = Buffer.concat([Buffer.from("xyz".slice(0, lead)), utf8, Buffer.from("tail")]);
    cases[`base64+${lead}`] = Buffer.from(`{"v":"${value.toString("base64")}"}`);
  }
  const root = join(dir, "encodings");
  for (const [encoding, bytes] of Object.entries(cases)) place(`encodings/${fileName(encoding)}`, Buffer.concat([Buffer.from("prefix "), bytes, Buffer.from(" suffix")]));
  const { hits, files } = scanPaths([root], [CANARY]);
  assert.equal(files, Object.keys(cases).length);
  for (const encoding of Object.keys(cases)) {
    assert.ok(hits.some((hit) => hit.file.endsWith(fileName(encoding)) && hit.encoding === encoding), `no ${encoding} hit`);
  }
});

test("ciphertext, other text and near misses are clean", () => {
  const root = join(dir, "clean");
  place("clean/random.bin", Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 131 + 7) % 256)));
  place("clean/near.txt", "LEAKCANARY_7f3a9c2 LEAKCANARY_7F3A9C21 leakcanary_7f3a9c21");
  const { hits, files } = scanPaths([root], [CANARY]);
  assert.equal(files, 2);
  assert.deepEqual(hits, []);
});

test("a canary across a read-chunk boundary is found once, at its offset", () => {
  const offset = 4 * 1024 * 1024 - 7;
  const bytes = Buffer.alloc(offset + 64);
  Buffer.from(CANARY).copy(bytes, offset);
  const path = place("chunk/big.bin", bytes);
  const { hits } = scanPaths([path], [CANARY]);
  assert.deepEqual(hits.map((hit) => [hit.encoding, hit.offset]), [["utf-8", offset]]);
});

test("newerThan skips older files; links are not followed; missing paths are reported", () => {
  const old = place("filters/old.txt", CANARY);
  utimesSync(old, new Date(0), new Date(0));
  const outside = place("outside/target.txt", CANARY);
  try {
    symlinkSync(outside, join(dir, "filters", "link.txt"));
  } catch {
    // Windows without the symlink privilege: the link case is not tested there.
  }
  const result = scanPaths([{ path: join(dir, "filters"), newerThan: Date.now() - 60_000 }, join(dir, "nowhere")], [CANARY]);
  assert.deepEqual(result.hits, []);
  assert.equal(result.files, 0);
  assert.deepEqual(result.missing, [join(dir, "nowhere")]);
});

test("short canaries are refused; patterns are distinct", () => {
  assert.throws(() => canaryPatterns("short"), /at least 8 bytes/);
  const patterns = canaryPatterns(CANARY);
  assert.equal(new Set(patterns.map((pattern) => pattern.bytes.toString("latin1"))).size, patterns.length);
});

test("the command line exits 1 on a hit, 0 when clean and 2 on a usage error", () => {
  const hit = place("cli/hit.log", `log line ${CANARY}\n`);
  const clean = place("cli/clean.log", "nothing here\n");
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
  const found = run("--canary", CANARY, hit);
  assert.equal(found.status, 1, found.stderr);
  assert.match(found.stderr, /HIT "LEAKCANARY_7f3a9c21" as utf-8/);
  assert.equal(run("--canary", CANARY, clean).status, 0);
  assert.equal(run(clean).status, 2);
  assert.equal(run("--canary", CANARY, join(dir, "missing")).status, 2);
});

// An unreadable file was never searched, so the command line must not report it clean.
// Root and Windows can still read a mode-000 file; the test is skipped there.
const locked = place("locked/secret.log", `phrase ${CANARY}\n`);
chmodSync(locked, 0);
let lockedReadable = true;
try {
  readFileSync(locked);
} catch {
  lockedReadable = false;
}
test("an unreadable file is listed and fails the command line unless allowed", { skip: lockedReadable && "mode 000 is still readable here" }, () => {
  const result = scanPaths([join(dir, "locked")], [CANARY]);
  assert.equal(result.hits.length, 0);
  assert.deepEqual(result.skipped.map((entry) => entry.path), [join(realpathSync(dir), "locked", "secret.log")]);
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
  const strict = run("--canary", CANARY, join(dir, "locked"));
  assert.equal(strict.status, 2, strict.stderr);
  assert.match(strict.stderr, /skipped .*secret\.log/);
  assert.equal(run("--canary", CANARY, "--allow-unreadable", join(dir, "locked")).status, 0);
});
