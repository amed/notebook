#!/usr/bin/env node
// Sets the app version everywhere a release build reads it.
// Usage: node scripts/set-version.mjs [--root <dir>] <major.minor.patch[-N]>

import { randomBytes } from "node:crypto";
import {
  accessSync,
  chmodSync,
  constants,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const USAGE = "Usage: node scripts/set-version.mjs [--root <dir>] <major.minor.patch[-N]>";

function fail(message) {
  console.error(`set-version: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  let root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      console.log(USAGE);
      process.exit(0);
    } else if (arg === "--root") {
      if (i + 1 >= argv.length) fail("--root needs a directory");
      root = resolve(argv[++i]);
    } else if (arg.startsWith("--root=")) {
      root = resolve(arg.slice("--root=".length));
    } else if (arg.startsWith("-") && !/^-\d/.test(arg)) {
      fail(`unknown option ${arg}\n${USAGE}`);
    } else {
      positional.push(arg);
    }
  }
  if (positional.length !== 1) fail(USAGE);
  return { root, version: positional[0] };
}

// The field limits are Windows Installer's, and Tauri's MSI bundler rejects
// non-numeric pre-releases. Build metadata is rejected so tags stay unambiguous.
function validateVersion(version) {
  if (/^v\d/.test(version)) fail(`"${version}": omit the leading "v"; the tag adds it`);
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(0|[1-9]\d*))?$/.exec(version);
  if (!match) {
    fail(`"${version}" is not major.minor.patch or major.minor.patch-N (N numeric, as MSI requires)`);
  }
  const [, major, minor, patch, pre] = match;
  const limits = [
    ["major", major, 255],
    ["minor", minor, 255],
    ["patch", patch, 65535],
    ["pre-release", pre, 65535],
  ];
  for (const [name, value, max] of limits) {
    if (value !== undefined && Number(value) > max) {
      fail(`${name} ${value} exceeds the MSI limit of ${max}`);
    }
  }
}

function updateJson(text, file, apply) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    fail(`${file} is not valid JSON: ${error.message}`);
  }
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const format = (value) => `${JSON.stringify(value, null, 2)}\n`.replaceAll("\n", eol);
  if (format(data) !== text) {
    fail(`${file} is not formatted as 2-space JSON with a trailing newline; refusing to reformat it`);
  }
  const previous = apply(data);
  return { previous, text: format(data) };
}

function setJsonVersion(target, file, label, version) {
  if (!target || typeof target.version !== "string") fail(`${file} has no string "version" in ${label}`);
  const previous = target.version;
  target.version = version;
  return previous;
}

function replaceOnce(text, file, what, pattern, replace) {
  const matches = [...text.matchAll(pattern)];
  if (matches.length !== 1) fail(`${file}: expected exactly one ${what}, found ${matches.length}`);
  const [match] = matches;
  const previous = match.groups.version;
  return {
    previous,
    text: text.slice(0, match.index) + replace(match) + text.slice(match.index + match[0].length),
  };
}

function packageSection(text, file) {
  const start = /^\[package\][ \t]*\r?$/m.exec(text);
  if (!start) fail(`${file} has no [package] table`);
  const rest = text.slice(start.index + start[0].length);
  const next = /^[ \t]*\[/m.exec(rest);
  const end = start.index + start[0].length + (next ? next.index : rest.length);
  return { start: start.index, end };
}

const { root, version } = parseArgs(process.argv.slice(2));
validateVersion(version);

const files = {
  packageJson: "package.json",
  packageLock: "package-lock.json",
  tauriConf: "src-tauri/tauri.conf.json",
  cargoToml: "src-tauri/Cargo.toml",
  cargoLock: "src-tauri/Cargo.lock",
};

const reason = (error) => error.code ?? error.message;
const originals = new Map();

const read = (file) => {
  try {
    const text = readFileSync(join(root, file), "utf8");
    originals.set(file, text);
    return text;
  } catch (error) {
    fail(`cannot read ${join(root, file)}: ${reason(error)}`);
  }
};

// Each file is replaced whole through a temporary sibling and a rename. If any
// step fails, the files already replaced get their original text back.
function writeAll(changes) {
  const targets = [];
  for (const [file, text] of changes) {
    try {
      const path = realpathSync(join(root, file));
      accessSync(path, constants.W_OK);
      const temp = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`);
      targets.push({ file, path, temp, text, mode: statSync(path).mode & 0o7777 });
    } catch (error) {
      fail(`cannot write ${file}: ${reason(error)}; nothing was changed`);
    }
  }

  const created = new Set();
  const removeTemps = () => {
    for (const temp of created) rmSync(temp, { force: true });
  };

  for (const target of targets) {
    try {
      writeFileSync(target.temp, target.text, { flag: "wx", mode: target.mode });
      created.add(target.temp);
      chmodSync(target.temp, target.mode);
    } catch (error) {
      removeTemps();
      fail(`cannot write ${target.file}: ${reason(error)}; nothing was changed`);
    }
  }

  const replaced = [];
  for (const target of targets) {
    try {
      renameSync(target.temp, target.path);
      created.delete(target.temp);
      replaced.push(target);
    } catch (error) {
      removeTemps();
      const unrestored = [];
      for (const done of replaced) {
        try {
          writeFileSync(done.path, originals.get(done.file));
        } catch {
          unrestored.push(done.file);
        }
      }
      const outcome = unrestored.length
        ? `could not restore ${unrestored.join(", ")}; check ${unrestored.length === 1 ? "it" : "them"} by hand`
        : "restored the files already written";
      fail(`cannot replace ${target.file}: ${reason(error)}; ${outcome}`);
    }
  }
}

const updates = [];

updates.push([
  files.packageJson,
  updateJson(read(files.packageJson), files.packageJson, (data) =>
    setJsonVersion(data, files.packageJson, "the top level", version),
  ),
]);

updates.push([
  files.packageLock,
  updateJson(read(files.packageLock), files.packageLock, (data) => {
    const previous = setJsonVersion(data, files.packageLock, "the top level", version);
    setJsonVersion(data.packages?.[""], files.packageLock, 'packages[""]', version);
    return previous;
  }),
]);

updates.push([
  files.tauriConf,
  updateJson(read(files.tauriConf), files.tauriConf, (data) =>
    setJsonVersion(data, files.tauriConf, "the top level", version),
  ),
]);

const cargoToml = read(files.cargoToml);
const section = packageSection(cargoToml, files.cargoToml);
const packageTable = cargoToml.slice(section.start, section.end);
const crateName = /^name[ \t]*=[ \t]*"(?<name>[^"]+)"[ \t]*\r?$/m.exec(packageTable)?.groups.name;
if (!crateName) fail(`${files.cargoToml} has no name in [package]`);
const tomlUpdate = replaceOnce(
  packageTable,
  files.cargoToml,
  'version = "..." line in [package]',
  /^(?<lead>version[ \t]*=[ \t]*")(?<version>[^"]*)"/gm,
  (match) => `${match.groups.lead}${version}"`,
);
updates.push([
  files.cargoToml,
  {
    previous: tomlUpdate.previous,
    text: cargoToml.slice(0, section.start) + tomlUpdate.text + cargoToml.slice(section.end),
  },
]);

const escapedName = crateName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
updates.push([
  files.cargoLock,
  replaceOnce(
    read(files.cargoLock),
    files.cargoLock,
    `[[package]] entry for ${crateName}`,
    new RegExp(
      `^(?<lead>\\[\\[package\\]\\]\\r?\\nname = "${escapedName}"\\r?\\nversion = ")(?<version>[^"]*)"`,
      "gm",
    ),
    (match) => `${match.groups.lead}${version}"`,
  ),
]);

writeAll(
  updates
    .filter(([file, update]) => update.text !== originals.get(file))
    .map(([file, update]) => [file, update.text]),
);

const width = Math.max(...updates.map(([file]) => file.length));
for (const [file, update] of updates) {
  const change = update.previous === version ? `${version} (unchanged)` : `${update.previous} -> ${version}`;
  console.log(`${file.padEnd(width)}  ${change}`);
}
