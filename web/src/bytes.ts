// Byte helpers shared by the codec, the S3 signer and the secrets store.
// No DOM and no runtime imports, so tests/web can run them in Node.

const URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const STD_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function lookup(alphabet: string): Int16Array {
  const table = new Int16Array(128).fill(-1);
  for (let index = 0; index < alphabet.length; index++) table[alphabet.charCodeAt(index)] = index;
  return table;
}
const URL_TABLE = lookup(URL_ALPHABET);
const STD_TABLE = lookup(STD_ALPHABET);

function encode(bytes: Uint8Array, alphabet: string, pad: boolean): string {
  let out = "";
  let index = 0;
  for (; index + 2 < bytes.length; index += 3) {
    const n = (bytes[index]! << 16) | (bytes[index + 1]! << 8) | bytes[index + 2]!;
    out += alphabet[n >> 18]! + alphabet[(n >> 12) & 63]! + alphabet[(n >> 6) & 63]! + alphabet[n & 63]!;
  }
  const rest = bytes.length - index;
  if (rest === 1) {
    const n = bytes[index]! << 16;
    out += alphabet[n >> 18]! + alphabet[(n >> 12) & 63]! + (pad ? "==" : "");
  } else if (rest === 2) {
    const n = (bytes[index]! << 16) | (bytes[index + 1]! << 8);
    out += alphabet[n >> 18]! + alphabet[(n >> 12) & 63]! + alphabet[(n >> 6) & 63]! + (pad ? "=" : "");
  }
  return out;
}

/**
 * Strict decoding as Rust's `base64` 0.22 general-purpose engines do it:
 * only the alphabet's characters, no length that leaves 1 character over,
 * and zero trailing bits (a non-canonical encoding is refused, so a key is
 * either the same object in both apps or undecodable in both).
 */
function decode(text: string, table: Int16Array): Uint8Array | null {
  const length = text.length;
  if (length % 4 === 1) return null;
  const out = new Uint8Array(Math.floor((length * 3) / 4));
  let buffer = 0;
  let bits = 0;
  let written = 0;
  for (let index = 0; index < length; index++) {
    const code = text.charCodeAt(index);
    const value = code < 128 ? table[code]! : -1;
    if (value < 0) return null;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[written++] = (buffer >> bits) & 0xff;
    }
    buffer &= (1 << bits) - 1;
  }
  if (buffer !== 0) return null;
  return out;
}

/** base64url without padding (Rust `URL_SAFE_NO_PAD`). */
export function base64UrlEncode(bytes: Uint8Array): string {
  return encode(bytes, URL_ALPHABET, false);
}

/** Strict base64url without padding; null when Rust's `URL_SAFE_NO_PAD` would refuse it. */
export function base64UrlDecode(text: string): Uint8Array | null {
  return decode(text, URL_TABLE);
}

/** Standard base64 with padding. */
export function base64Encode(bytes: Uint8Array): string {
  return encode(bytes, STD_ALPHABET, true);
}

/** Standard base64 with canonical padding; null otherwise. */
export function base64Decode(text: string): Uint8Array | null {
  if (text.length % 4 !== 0) return null;
  const padding = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0;
  return decode(text.slice(0, text.length - padding), STD_TABLE);
}

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

export function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || /[^0-9a-f]/i.test(hex)) throw new Error("invalid hex");
  const out = new Uint8Array(hex.length / 2);
  for (let index = 0; index < out.length; index++) out[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  return out;
}

const encoder = new TextEncoder();
// fatal: invalid UTF-8 fails as Rust's `from_utf8` does; ignoreBOM: a leading
// U+FEFF is text, as in Rust, never silently dropped.
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export function utf8(text: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(text);
}

/** The text of UTF-8 `bytes`, or null when they are not valid UTF-8. */
export function fromUtf8(bytes: Uint8Array): string | null {
  try {
    return decoder.decode(bytes);
  } catch {
    return null;
  }
}

export function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** A copy backed by its own ArrayBuffer (what WebCrypto's BufferSource wants). */
export function owned(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy;
}

/** Rust's `str::trim`: Unicode White_Space at both ends (JS `trim` differs: it trims U+FEFF, keeps U+0085). */
export function rustTrim(text: string): string {
  return text.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "");
}
