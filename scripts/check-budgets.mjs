#!/usr/bin/env node
// Size budgets for the built frontend (`npm run build` first). CI fails when
// a file grows past its budget or the build gains a file kind it should not
// have. The budgets are the 2026-10-05 performance overhaul's sizes plus about
// 10% headroom (main JS 734,502 B, CSS 70,526 B, boot 9,252 B, dist 815,038 B).
// Raise a budget only on purpose, in the same change that needs it.
//
//   node scripts/check-budgets.mjs [distDir]

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const BUDGETS = {
  /** The CodeMirror app chunk (main-*.js). */
  mainJs: 808_000,
  /** The boot entry (index-*.js) that installs the guards and imports main. */
  bootJs: 10_200,
  /** theme.css, the one stylesheet. */
  css: 77_600,
  /** Everything Tauri embeds into the binary. */
  dist: 896_500,
};

const root = fileURLToPath(new URL("..", import.meta.url));
const dist = resolve(process.argv[2] ?? join(root, "dist"));

function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}

let all;
try {
  all = files(dist).map((path) => ({ path, name: relative(dist, path).replaceAll("\\", "/"), size: statSync(path).size }));
} catch (error) {
  console.error(`check-budgets: cannot read ${dist} (${error.code ?? error.message}); run \`npm run build\` first.`);
  process.exit(2);
}

const problems = [];
const rows = [];
const kind = (name) => {
  if (/^assets\/main-[\w-]+\.js$/.test(name)) return "mainJs";
  if (/^assets\/index-[\w-]+\.js$/.test(name)) return "bootJs";
  if (/^assets\/[\w-]+\.css$/.test(name)) return "css";
  if (name === "index.html" || name === "preview.html") return "html";
  return null;
};

const seen = { mainJs: 0, bootJs: 0, css: 0, html: 0 };
for (const file of all) {
  const which = kind(file.name);
  if (!which) {
    // A worker chunk, a font, a lazily split chunk or a source map: none belong in the build.
    problems.push(`unexpected file ${file.name} (${file.size} B): the build has one boot chunk, one main chunk, one stylesheet and two pages`);
    continue;
  }
  seen[which] += 1;
  if (which === "html") continue;
  const gzip = gzipSync(readFileSync(file.path), { level: 9 }).length;
  rows.push([file.name, file.size, gzip, BUDGETS[which]]);
  if (file.size > BUDGETS[which]) problems.push(`${file.name} is ${file.size} B, over its ${BUDGETS[which]} B budget`);
}
for (const [which, count] of Object.entries(seen)) {
  const expected = which === "html" ? 2 : 1;
  if (count !== expected) problems.push(`expected ${expected} ${which} file(s), found ${count}`);
}

// The CSP has worker-src 'none'; a worker must not come back inlined either.
for (const file of all.filter((f) => f.name.endsWith(".js"))) {
  const text = readFileSync(file.path, "utf8");
  for (const pattern of [/\bnew\s+(?:Shared)?Worker\s*\(/, /\bimportScripts\s*\(/, /serviceWorker\.register/]) {
    if (pattern.test(text)) problems.push(`${file.name} starts a worker (${pattern.source})`);
  }
}

const total = all.reduce((sum, file) => sum + file.size, 0);
rows.push(["dist total", total, null, BUDGETS.dist]);
if (total > BUDGETS.dist) problems.push(`dist is ${total} B, over its ${BUDGETS.dist} B budget`);

const width = Math.max(...rows.map(([name]) => name.length));
for (const [name, size, gzip, budget] of rows) {
  const headroom = (((budget - size) / budget) * 100).toFixed(1);
  console.log(`${name.padEnd(width)}  ${String(size).padStart(9)} B${gzip === null ? "" : `  (gzip ${gzip} B)`}  budget ${budget} B, ${headroom}% left`);
}
if (problems.length) {
  for (const problem of problems) console.error(`check-budgets: ${problem}`);
  process.exit(1);
}
console.log("check-budgets: all within budget");
