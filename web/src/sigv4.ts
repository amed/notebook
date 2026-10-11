// AWS Signature Version 4 (header authorization) with WebCrypto, for S3.
// S3 rules: the path is URI-encoded once and never normalized; the query is
// sorted by encoded name, then value; header values are trimmed with inner
// runs of spaces collapsed. tests/web/sigv4.test.mjs runs AWS's published
// signing test suite and S3's documented examples against it.
// No DOM and no runtime imports beyond ./bytes, so Node can test it.

import { toHex, utf8 } from "./bytes.ts";

export interface Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string | null;
}

export interface SignRequest {
  method: string;
  url: URL;
  /** Extra headers to sign and send (lowercase or not). `host` and `x-amz-date` are added. */
  headers?: Record<string, string>;
  /** Hex SHA-256 of the body, or "UNSIGNED-PAYLOAD". */
  payloadHash: string;
  region: string;
  service: string;
  credentials: Credentials;
  now: Date;
  /** S3 needs x-amz-content-sha256; the generic test suite does not send it. */
  contentSha256Header?: boolean;
}

export interface Signed {
  /** Headers to send (without `host`, which the browser sets from the URL). */
  headers: Record<string, string>;
  canonicalRequest: string;
  stringToSign: string;
  signature: string;
}

export const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/** RFC 3986 encoding of everything but A-Z a-z 0-9 - . _ ~ (and "/" when `keepSlash`). */
export function uriEncode(value: string, keepSlash: boolean): string {
  let out = "";
  for (const byte of utf8(value)) {
    const char = String.fromCharCode(byte);
    if (/[A-Za-z0-9\-._~]/.test(char) || (keepSlash && char === "/")) out += char;
    else out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

function decodeComponent(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, "%20"));
  } catch {
    return value;
  }
}

/** The canonical query string of `url` (names and values decoded, re-encoded, sorted). */
export function canonicalQuery(url: URL): string {
  const search = url.search.startsWith("?") ? url.search.slice(1) : url.search;
  if (!search) return "";
  const pairs = search
    .split("&")
    .filter((part) => part.length > 0)
    .map((part) => {
      const equals = part.indexOf("=");
      const name = equals < 0 ? part : part.slice(0, equals);
      const value = equals < 0 ? "" : part.slice(equals + 1);
      return [uriEncode(decodeComponent(name), false), uriEncode(decodeComponent(value), false)] as const;
    });
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  return pairs.map(([name, value]) => `${name}=${value}`).join("&");
}

/** The canonical URI: the path as sent, each segment encoded once (S3 never normalizes). */
export function canonicalUri(url: URL): string {
  const path = url.pathname || "/";
  return path
    .split("/")
    .map((segment) => uriEncode(decodeComponent(segment), false))
    .join("/");
}

function trimValue(value: string): string {
  return value.trim().replace(/ +/g, " ");
}

export async function sha256Hex(data: Uint8Array<ArrayBuffer> | string): Promise<string> {
  const bytes = typeof data === "string" ? utf8(data) : data;
  return toHex(new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes)));
}

async function hmac(key: Uint8Array<ArrayBuffer>, data: string): Promise<Uint8Array<ArrayBuffer>> {
  const subtle = globalThis.crypto.subtle;
  const imported = await subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await subtle.sign("HMAC", imported, utf8(data)));
}

/** "20150830T123600Z" */
export function amzDate(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

export async function sign(request: SignRequest): Promise<Signed> {
  const date = amzDate(request.now);
  const day = date.slice(0, 8);
  const headers = new Map<string, string>();
  for (const [name, value] of Object.entries(request.headers ?? {})) headers.set(name.toLowerCase(), value);
  headers.set("host", request.url.host);
  headers.set("x-amz-date", date);
  if (request.contentSha256Header) headers.set("x-amz-content-sha256", request.payloadHash);
  const token = request.credentials.sessionToken;
  if (token) headers.set("x-amz-security-token", token);

  const names = [...headers.keys()].sort();
  const canonicalHeaders = names.map((name) => `${name}:${trimValue(headers.get(name)!)}\n`).join("");
  const signedHeaders = names.join(";");
  const canonicalRequest = [
    request.method.toUpperCase(),
    canonicalUri(request.url),
    canonicalQuery(request.url),
    canonicalHeaders,
    signedHeaders,
    request.payloadHash,
  ].join("\n");
  const scope = `${day}/${request.region}/${request.service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", date, scope, await sha256Hex(canonicalRequest)].join("\n");

  let key = await hmac(utf8(`AWS4${request.credentials.secretAccessKey}`), day);
  key = await hmac(key, request.region);
  key = await hmac(key, request.service);
  key = await hmac(key, "aws4_request");
  const signature = toHex(await hmac(key, stringToSign));
  key.fill(0);

  const out: Record<string, string> = {};
  for (const name of names) if (name !== "host") out[name] = headers.get(name)!;
  out.authorization = `AWS4-HMAC-SHA256 Credential=${request.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { headers: out, canonicalRequest, stringToSign, signature };
}
