#!/usr/bin/env node
// Local leakage scan (spec section 16): searches every file under the given
// paths for canary strings and fails on any hit. Point it, after a scripted
// session and app shutdown, at the app's config, data, cache and temp
// folders, the WebView's data folder, the outbox and a captured log.
//
//   node scripts/leak-scan/leak-scan.mjs --canary <text> [--canary <text>…]
//        [--newer-than <ms since epoch | ISO date>] [--allow-unreadable] <path>…
//
// Each canary is searched as UTF-8, UTF-16LE, UTF-16BE, hex (lower and upper)
// and base64 (standard and URL alphabets, all three byte alignments). Compressed
// data is not unpacked. Symbolic links below the given paths are not followed.
// Exit status: 0 no hit, 1 a hit, 2 usage error, a missing path or an
// unreadable file (listed; `--allow-unreadable` lists it and still exits 0).
// No dependencies; `tests/leak/` imports `scanPaths`.

import { closeSync, lstatSync, openSync, readdirSync, readSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CHUNK = 4 * 1024 * 1024;
const MIN_CANARY_BYTES = 8;

/** The byte patterns one canary is searched as. */
export function canaryPatterns(canary) {
  const utf8 = Buffer.from(canary, "utf8");
  if (utf8.length < MIN_CANARY_BYTES) throw new Error(`a canary needs at least ${MIN_CANARY_BYTES} bytes: ${JSON.stringify(canary)}`);
  const utf16le = Buffer.from(canary, "utf16le");
  const patterns = [
    ["utf-8", utf8],
    ["utf-16le", utf16le],
    ["utf-16be", Buffer.from(utf16le).swap16()],
    ["hex", Buffer.from(utf8.toString("hex"))],
    ["HEX", Buffer.from(utf8.toString("hex").toUpperCase())],
  ];
  // Base64 at each alignment: only the characters made of canary bytes alone.
  for (let lead = 0; lead < 3; lead += 1) {
    const encoded = Buffer.concat([Buffer.alloc(lead), utf8]).toString("base64");
    const text = encoded.slice(lead ? 4 : 0, Math.floor((lead + utf8.length) / 3) * 4);
    patterns.push([`base64+${lead}`, Buffer.from(text)]);
    const url = text.replaceAll("+", "-").replaceAll("/", "_");
    if (url !== text) patterns.push([`base64url+${lead}`, Buffer.from(url)]);
  }
  return patterns.map(([encoding, bytes]) => ({ canary, encoding, bytes }));
}

/** Hits of `patterns` in `buffer`, offsets shifted by `base`. */
function find(buffer, patterns, base, file, hits) {
  for (const pattern of patterns) {
    for (let at = buffer.indexOf(pattern.bytes); at !== -1; at = buffer.indexOf(pattern.bytes, at + 1)) {
      hits.push({ file, offset: base + at, canary: pattern.canary, encoding: pattern.encoding });
    }
  }
}

/** Scans one regular file in chunks that overlap by the longest pattern. */
function scanFile(file, size, patterns, longest, hits) {
  const fd = openSync(file, "r");
  try {
    const buffer = Buffer.alloc(Math.min(Math.max(size, 1), CHUNK) + longest);
    // buffer[0, carried) is the previous chunk's tail, searched again with the next bytes.
    let carried = 0;
    let base = 0;
    for (;;) {
      const read = readSync(fd, buffer, carried, buffer.length - carried, null);
      const filled = carried + read;
      // Report only hits that start before the tail kept for the next round.
      const reported = read === 0 ? filled : Math.max(filled - longest + 1, 0);
      const before = hits.length;
      find(buffer.subarray(0, filled), patterns, base, file, hits);
      for (let index = hits.length - 1; index >= before; index -= 1) {
        if (hits[index].offset - base >= reported) hits.splice(index, 1);
      }
      if (read === 0) break;
      buffer.copy(buffer, 0, reported, filled);
      carried = filled - reported;
      base += reported;
    }
  } finally {
    closeSync(fd);
  }
}

/**
 * Scans `roots` (files or directories, `{ path, newerThan? }` or a path string)
 * for `canaries`. Returns the hits and what was looked at.
 */
export function scanPaths(roots, canaries) {
  const patterns = canaries.flatMap(canaryPatterns);
  const longest = Math.max(...patterns.map((pattern) => pattern.bytes.length));
  const result = { hits: [], files: 0, bytes: 0, skipped: [], missing: [] };
  const visit = (path, newerThan) => {
    let stat;
    try {
      stat = lstatSync(path);
    } catch (error) {
      result.skipped.push({ path, reason: error.code ?? String(error) });
      return;
    }
    if (stat.isDirectory()) {
      let names;
      try {
        names = readdirSync(path);
      } catch (error) {
        result.skipped.push({ path, reason: error.code ?? String(error) });
        return;
      }
      for (const name of names.sort()) visit(join(path, name), newerThan);
      return;
    }
    // Sockets, pipes, devices and symbolic links hold no file contents of their own.
    if (!stat.isFile()) return;
    if (newerThan !== undefined && stat.mtimeMs < newerThan) return;
    try {
      const hits = [];
      scanFile(path, stat.size, patterns, longest, hits);
      // ASCII in UTF-16LE also reads as UTF-16BE one byte earlier: report it once.
      const le = new Set(hits.filter((hit) => hit.encoding === "utf-16le").map((hit) => `${hit.canary}\0${hit.offset}`));
      result.hits.push(...hits.filter((hit) => hit.encoding !== "utf-16be" || !le.has(`${hit.canary}\0${hit.offset + 1}`)));
      result.files += 1;
      result.bytes += stat.size;
    } catch (error) {
      result.skipped.push({ path, reason: error.code ?? String(error) });
    }
  };
  for (const root of roots) {
    const { path, newerThan } = typeof root === "string" ? { path: root } : root;
    // A root given as a link (macOS's /tmp, say) is followed; links inside are not.
    let absolute;
    try {
      absolute = realpathSync(resolve(path));
    } catch {
      result.missing.push(resolve(path));
      continue;
    }
    visit(absolute, newerThan);
  }
  return result;
}

function parseTime(value) {
  const number = Number(value);
  const time = Number.isFinite(number) ? number : Date.parse(value);
  if (!Number.isFinite(time)) throw new Error(`--newer-than: not a time: ${value}`);
  return time;
}

const USAGE = "usage: leak-scan.mjs --canary <text> [--canary <text>…] [--newer-than <time>] [--allow-unreadable] <path>…";

function main(argv) {
  const canaries = [];
  const paths = [];
  let newerThan;
  let allowUnreadable = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--canary") canaries.push(argv[++index] ?? "");
    else if (argument === "--allow-unreadable") allowUnreadable = true;
    else if (argument === "--newer-than") newerThan = parseTime(argv[++index] ?? "");
    else if (argument === "--help" || argument === "-h") {
      console.log(USAGE);
      return 0;
    } else paths.push(argument);
  }
  if (!canaries.length || !paths.length) {
    console.error(USAGE);
    return 2;
  }
  const result = scanPaths(paths.map((path) => ({ path, newerThan })), canaries);
  for (const path of result.missing) console.error(`leak-scan: missing ${path}`);
  for (const { path, reason } of result.skipped) console.error(`leak-scan: skipped ${path} (${reason})`);
  for (const hit of result.hits) console.error(`leak-scan: HIT ${JSON.stringify(hit.canary)} as ${hit.encoding} in ${hit.file} at byte ${hit.offset}`);
  console.log(`leak-scan: ${result.files} files, ${result.bytes} bytes, ${canaries.length} canaries, ${result.hits.length} hits`);
  if (result.hits.length) return 1;
  if (result.missing.length) return 2;
  return result.skipped.length && !allowUnreadable ? 2 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`leak-scan: ${error.message}`);
    process.exitCode = 2;
  }
}
