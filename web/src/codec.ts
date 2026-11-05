// The Notebook v1 remote-encryption codec, byte-compatible with the desktop
// app's src-tauri/src/compat/notebook_v1.rs (and so with Notebook itself):
// - Three keys from the phrase (Rust `str::trim`, no Unicode normalization),
//   each PBKDF2-HMAC-SHA256 with 120,000 rounds and the salt
//   "notebook::remote-encryption::{path|content|reference}".
// - Every non-empty "/"-separated segment of a logical path is sealed with
//   AES-256-GCM-SIV under the path key and the nonce SHA-256("notebook::path::"
//   || plaintext parent path)[..12], then base64url-encoded without padding.
//   The configured S3 prefix is never part of the logical path.
// - A body is a random 12-byte nonce followed by the AES-256-GCM-SIV
//   ciphertext and tag of the UTF-8 text under the content key.
// tests/web/codec.test.mjs checks this file against vectors written by the
// Rust codec, and src-tauri/tests/web_compat.rs decrypts what this writes.

import { gcmsiv } from "@noble/ciphers/aes.js";
import { base64UrlDecode, base64UrlEncode, concat, fromUtf8, owned, rustTrim, toHex, utf8 } from "./bytes.ts";

export const PBKDF2_ROUNDS = 120_000;
export const NONCE_LEN = 12;
export const TAG_LEN = 16;
export const DIRECTORY_MARKER = ".notebook_dir";

export type CodecErrorCode = "EMPTY_PHRASE" | "INVALID_PATH" | "INVALID_CONTENT" | "INVALID_UTF8";

export class CodecError extends Error {
  readonly code: CodecErrorCode;
  constructor(code: CodecErrorCode) {
    super(code);
    this.name = "CodecError";
    this.code = code;
  }
}

async function deriveKey(label: string, phrase: Uint8Array): Promise<Uint8Array> {
  const subtle = globalThis.crypto.subtle;
  const base = await subtle.importKey("raw", owned(phrase), "PBKDF2", false, ["deriveBits"]);
  const bits = await subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: utf8(`notebook::remote-encryption::${label}`), iterations: PBKDF2_ROUNDS },
    base,
    256,
  );
  return new Uint8Array(bits);
}

async function pathNonce(parent: string): Promise<Uint8Array> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", utf8(`notebook::path::${parent}`));
  return new Uint8Array(digest, 0, NONCE_LEN).slice();
}

function joinSegment(parent: string, segment: string): string {
  return parent ? `${parent}/${segment}` : segment;
}

export class NotebookV1Codec {
  private pathKey: Uint8Array;
  private contentKey: Uint8Array;
  private reference: Uint8Array;
  /** Path nonces by plaintext parent path: a listing shares few parents. */
  private nonces = new Map<string, Promise<Uint8Array>>();

  private constructor(path: Uint8Array, content: Uint8Array, reference: Uint8Array) {
    this.pathKey = path;
    this.contentKey = content;
    this.reference = reference;
  }

  /** Derives the keys (three PBKDF2 runs; about a second on a phone). */
  static async create(phrase: string): Promise<NotebookV1Codec> {
    const trimmed = rustTrim(phrase);
    if (!trimmed) throw new CodecError("EMPTY_PHRASE");
    const bytes = utf8(trimmed);
    try {
      const [path, content, reference] = await Promise.all([
        deriveKey("path", bytes),
        deriveKey("content", bytes),
        deriveKey("reference", bytes),
      ]);
      const short = reference.slice(0, 8);
      reference.fill(0);
      return new NotebookV1Codec(path, content, short);
    } finally {
      bytes.fill(0);
    }
  }

  /** The first 8 bytes of the reference key, hex (Rust `key_reference`). */
  keyReference(): string {
    return toHex(this.reference);
  }

  private nonceFor(parent: string): Promise<Uint8Array> {
    let nonce = this.nonces.get(parent);
    if (!nonce) {
      if (this.nonces.size > 50_000) this.nonces.clear();
      nonce = pathNonce(parent);
      this.nonces.set(parent, nonce);
    }
    return nonce;
  }

  /** Seals every non-empty segment of `logicalPath` (Rust `encode_path`). */
  async encodePath(logicalPath: string): Promise<string> {
    const encoded: string[] = [];
    let parent = "";
    for (const segment of logicalPath.split("/").filter((part) => part.length > 0)) {
      const nonce = await this.nonceFor(parent);
      encoded.push(base64UrlEncode(gcmsiv(this.pathKey, nonce).encrypt(utf8(segment))));
      parent = joinSegment(parent, segment);
    }
    return encoded.join("/");
  }

  /** Opens every segment of a stored path (Rust `decode_path`). */
  async decodePath(storedPath: string): Promise<string> {
    const decoded: string[] = [];
    let parent = "";
    for (const segment of storedPath.split("/").filter((part) => part.length > 0)) {
      const sealed = base64UrlDecode(segment);
      if (!sealed) throw new CodecError("INVALID_PATH");
      const nonce = await this.nonceFor(parent);
      let plain: Uint8Array;
      try {
        plain = gcmsiv(this.pathKey, nonce).decrypt(sealed);
      } catch {
        throw new CodecError("INVALID_PATH");
      }
      const name = fromUtf8(plain);
      if (name === null) throw new CodecError("INVALID_UTF8");
      parent = joinSegment(parent, name);
      decoded.push(name);
    }
    return decoded.join("/");
  }

  /** nonce || ciphertext || tag of `text` (Rust `encode_content`); `nonce` only for tests. */
  encodeContent(text: string, nonce?: Uint8Array): Uint8Array<ArrayBuffer> {
    const iv = nonce ?? globalThis.crypto.getRandomValues(new Uint8Array(NONCE_LEN));
    if (iv.length !== NONCE_LEN) throw new CodecError("INVALID_CONTENT");
    const plain = utf8(text);
    try {
      return concat(iv, gcmsiv(this.contentKey, iv).encrypt(plain));
    } finally {
      plain.fill(0);
    }
  }

  /** The text of a stored body (Rust `decode_content`). */
  decodeContent(payload: Uint8Array): string {
    if (payload.length < NONCE_LEN + TAG_LEN) throw new CodecError("INVALID_CONTENT");
    let plain: Uint8Array;
    try {
      plain = gcmsiv(this.contentKey, payload.subarray(0, NONCE_LEN)).decrypt(payload.subarray(NONCE_LEN));
    } catch {
      throw new CodecError("INVALID_CONTENT");
    }
    const text = fromUtf8(plain);
    plain.fill(0);
    if (text === null) throw new CodecError("INVALID_UTF8");
    return text;
  }

  /** Overwrites the keys; the codec is unusable afterwards. */
  wipe(): void {
    this.pathKey.fill(0);
    this.contentKey.fill(0);
    this.reference.fill(0);
    this.nonces.clear();
  }
}
