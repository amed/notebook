// Writes tests/web/fixtures/notebook-v1-web.json with the TypeScript codec
// (web/src/codec.ts): the phrases, paths and texts of the desktop fixture,
// encrypted here. src-tauri/tests/web_compat.rs decrypts this file with the
// desktop codec. Run: node tests/web/write-vectors.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { base64Encode } from "../../web/src/bytes.ts";
import { NotebookV1Codec } from "../../web/src/codec.ts";

const rustFile = new URL("./fixtures/notebook-v1-rust.json", import.meta.url);
const webFile = new URL("./fixtures/notebook-v1-web.json", import.meta.url);
const rust = JSON.parse(readFileSync(rustFile, "utf8"));

const cases = [];
for (const source of rust.cases) {
  const codec = await NotebookV1Codec.create(source.phrase);
  const paths = [];
  for (const { logical } of source.paths) paths.push({ logical, stored: await codec.encodePath(logical) });
  const bodies = source.bodies.map(({ text }) => ({ text, payload: base64Encode(codec.encodeContent(text)) }));
  cases.push({ phrase: source.phrase, key_reference: codec.keyReference(), paths, bodies });
  codec.wipe();
}
const document = {
  about: "Written by tests/web/write-vectors.mjs with the web codec (web/src/codec.ts). Test data only; the phrases are not secrets.",
  cases,
};
writeFileSync(webFile, `${JSON.stringify(document, null, 2)}\n`);
console.log(`wrote ${cases.length} cases to tests/web/fixtures/notebook-v1-web.json`);
