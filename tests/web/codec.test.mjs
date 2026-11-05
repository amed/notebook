// The web codec (web/src/codec.ts) against the desktop's: vectors written by
// the Rust codec (src-tauri/tests/web_compat.rs) must be reproduced and
// decrypted here byte for byte, and the vectors written here are decrypted by
// the Rust codec in web_compat.rs (`cargo test --test web_compat`).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { base64Decode, base64UrlDecode, base64UrlEncode, rustTrim } from "../../web/src/bytes.ts";
import { CodecError, NONCE_LEN, NotebookV1Codec } from "../../web/src/codec.ts";

const load = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
const rust = load("notebook-v1-rust.json");
const web = load("notebook-v1-web.json");
const canonical = (path) => path.split("/").filter(Boolean).join("/");

test("the desktop fixture comes from the Rust codec and covers the trim rule", () => {
  assert.match(rust.about, /src-tauri\/src\/compat\/notebook_v1\.rs/);
  const phrases = rust.cases.map((item) => item.phrase);
  assert.ok(phrases.some((phrase) => phrase.includes("\u0085")), "U+0085 case");
  assert.ok(phrases.some((phrase) => phrase.startsWith("﻿")), "U+FEFF case");
});

test("the TS codec reproduces every Rust path and decrypts every Rust body", async () => {
  let paths = 0;
  let bodies = 0;
  for (const item of rust.cases) {
    const codec = await NotebookV1Codec.create(item.phrase);
    assert.equal(codec.keyReference(), item.key_reference, "key reference");
    for (const { logical, stored } of item.paths) {
      assert.equal(await codec.encodePath(logical), stored, `encode_path(${JSON.stringify(logical)})`);
      assert.equal(await codec.decodePath(stored), canonical(logical));
      paths++;
    }
    for (const { text, payload } of item.bodies) {
      const bytes = base64Decode(payload);
      assert.equal(codec.decodeContent(bytes), text);
      // GCM-SIV is deterministic for a nonce: with Rust's nonce, TS writes Rust's bytes.
      assert.deepEqual(codec.encodeContent(text, bytes.subarray(0, NONCE_LEN)), bytes);
      bodies++;
    }
    codec.wipe();
  }
  assert.ok(paths >= 30 && bodies >= 20, `${paths} paths, ${bodies} bodies`);
});

test("the web fixture is current: TS paths match Rust's and TS bodies decrypt", async () => {
  assert.match(web.about, /web\/src\/codec\.ts/);
  assert.deepEqual(web.cases.map((item) => item.phrase), rust.cases.map((item) => item.phrase));
  for (const [index, item] of web.cases.entries()) {
    const codec = await NotebookV1Codec.create(item.phrase);
    assert.equal(item.key_reference, rust.cases[index].key_reference);
    assert.deepEqual(item.paths, rust.cases[index].paths);
    for (const { text, payload } of item.bodies) assert.equal(codec.decodeContent(base64Decode(payload)), text);
    codec.wipe();
  }
});

test("phrases are trimmed like Rust's str::trim and never normalized", async () => {
  assert.equal(rustTrim(" \t\u0085a b 　\n"), "a b");
  assert.equal(rustTrim("﻿x﻿"), "﻿x﻿");
  const reference = async (phrase) => (await NotebookV1Codec.create(phrase)).keyReference();
  assert.equal(await reference(" phrase\u0085"), await reference("phrase"));
  assert.notEqual(await reference("﻿phrase"), await reference("phrase"));
  assert.notEqual(await reference("Café"), await reference("Café"));
  await assert.rejects(NotebookV1Codec.create(" \u0085  "), (error) => error instanceof CodecError && error.code === "EMPTY_PHRASE");
});

test("another phrase, a flipped bit or a non-canonical name fails closed", async () => {
  const right = await NotebookV1Codec.create("right phrase");
  const wrong = await NotebookV1Codec.create("wrong phrase");
  const name = await right.encodePath("private/note.md");
  await assert.rejects(wrong.decodePath(name), (error) => error.code === "INVALID_PATH");
  const body = right.encodeContent("classified");
  assert.throws(() => wrong.decodeContent(body), (error) => error.code === "INVALID_CONTENT");
  for (let index = 0; index < body.length; index++) {
    const tampered = body.slice();
    tampered[index] ^= 0x01;
    assert.throws(() => right.decodeContent(tampered), CodecError);
  }
  assert.throws(() => right.decodeContent(body.subarray(0, 27)), (error) => error.code === "INVALID_CONTENT");
  // Strict base64url: padding, other alphabets and non-zero trailing bits are refused, as in Rust.
  const segment = name.split("/")[0];
  assert.ok(base64UrlDecode(segment));
  assert.equal(base64UrlDecode(`${segment}=`), null);
  assert.equal(base64UrlDecode("ab+/"), null);
  assert.equal(base64UrlDecode("AB"), null, "trailing bits");
  assert.equal(base64UrlDecode("A"), null, "length 1 mod 4");
  assert.equal(base64UrlEncode(base64UrlDecode("AA")), "AA");
});

test("bodies are random-nonce, nonce-prefixed and keep a leading BOM", async () => {
  const codec = await NotebookV1Codec.create("phrase");
  const one = codec.encodeContent("﻿same text");
  const two = codec.encodeContent("﻿same text");
  assert.notDeepEqual(one.subarray(0, NONCE_LEN), two.subarray(0, NONCE_LEN));
  assert.equal(one.length, NONCE_LEN + new TextEncoder().encode("﻿same text").length + 16);
  assert.equal(codec.decodeContent(one), "﻿same text");
});
