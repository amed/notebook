// A minimal S3 client for the browser: ListObjectsV2, GetObject and
// conditional PutObject, signed with SigV4 (./sigv4.ts). URLs follow the
// desktop app (notebook.rs `s3_bucket`): AWS uses virtual-hosted URLs unless
// the bucket name has a dot; a custom endpoint is path-style. Error messages
// are the desktop's. No DOM, so tests/web can drive it with a fake fetch.

import { fromUtf8, owned, rustTrim } from "./bytes.ts";
import { type Credentials, EMPTY_SHA256, sha256Hex, sign, uriEncode } from "./sigv4.ts";

export interface S3Location {
  bucket: string;
  region: string;
  prefix: string;
  endpoint: string | null;
}

export interface ListedObject {
  key: string;
  etag: string;
}

export interface ObjectBody {
  bytes: Uint8Array;
  etag: string | null;
}

export type PutCondition = { ifMatch: string } | { ifNoneMatch: true };

export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;
export const MAX_LIST_RESPONSE_BYTES = 8 * 1024 * 1024;
export const MAX_OBJECTS = 100_000;
const MAX_REPLY_BYTES = 64 * 1024;
const MAX_ATTEMPTS = 2;

export class S3Error extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 0) {
    super(message);
    this.name = "S3Error";
    this.code = code;
    this.status = status;
  }
}

/** The desktop's `normalized_prefix`: trimmed (Rust `str::trim`), without leading or trailing "/". */
export function normalizedPrefix(value: string): string {
  return rustTrim(value).replace(/^\/+|\/+$/g, "");
}

/** "prefix/" to list under, or "" for the whole bucket (desktop `list_prefix`). */
export function listPrefix(location: Pick<S3Location, "prefix">): string {
  const prefix = normalizedPrefix(location.prefix);
  return prefix ? `${prefix}/` : "";
}

/** The stored key of an encoded path (desktop `stored_key`). */
export function storedKey(location: Pick<S3Location, "prefix">, encodedPath: string): string {
  const prefix = normalizedPrefix(location.prefix);
  return prefix ? `${prefix}/${encodedPath}` : encodedPath;
}

function isLoopback(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

/** Checks a location's fields; returns a problem to show, or null. */
export function locationProblem(location: S3Location): string | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,254}$/.test(location.bucket)) return "Enter a valid bucket name.";
  if (!/^[a-z0-9-]{1,64}$/.test(location.region)) return "Enter a valid region, for example eu-central-1.";
  if (normalizedPrefix(location.prefix).split("/").some((part) => part === "." || part === "..")) {
    return "The prefix cannot contain “.” or “..” folders.";
  }
  const endpoint = location.endpoint?.trim();
  if (endpoint) {
    let url: URL;
    try {
      url = new URL(endpoint);
    } catch {
      return "The S3 endpoint is invalid.";
    }
    if (url.username || url.password || url.search || url.hash) return "The S3 endpoint is invalid.";
    if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname === "::1" ? "[::1]" : url.hostname))) {
      return "The S3 endpoint must use HTTPS.";
    }
  }
  return null;
}

function encodeKey(key: string): string {
  return key.split("/").map((segment) => uriEncode(segment, false)).join("/");
}

/** The URL of `key` (or of the bucket for "") and whether it is path-style. */
export function objectUrl(location: S3Location, key: string, query = ""): URL {
  const problem = locationProblem(location);
  if (problem) throw new S3Error("INVALID_LOCATION", problem);
  const endpoint = location.endpoint?.trim();
  const tail = `${encodeKey(key)}${query ? `?${query}` : ""}`;
  if (endpoint) {
    const base = new URL(endpoint);
    const path = base.pathname.replace(/\/+$/, "");
    return new URL(`${base.origin}${path}/${uriEncode(location.bucket, false)}/${tail}`);
  }
  const host = `s3.${location.region}.amazonaws.com`;
  if (location.bucket.includes(".")) return new URL(`https://${host}/${uriEncode(location.bucket, false)}/${tail}`);
  return new URL(`https://${location.bucket}.${host}/${tail}`);
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

export function xmlUnescape(value: string): string {
  return value.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, name: string) => {
    if (name.startsWith("#x")) return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
    if (name.startsWith("#")) return String.fromCodePoint(Number.parseInt(name.slice(1), 10));
    return ENTITIES[name]!;
  });
}

function xmlText(xml: string, tag: string): string | null {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml);
  return match ? xmlUnescape(match[1]!) : null;
}

/** One ListObjectsV2 page: its objects and the next continuation token. */
export function parseListResponse(xml: string): { objects: ListedObject[]; next: string | null } {
  if (!/<ListBucketResult[\s>]/.test(xml)) throw new S3Error("S3_RESPONSE", "S3 returned an unexpected listing.");
  const objects: ListedObject[] = [];
  for (const match of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const key = xmlText(match[1]!, "Key");
    if (key === null) continue;
    objects.push({ key, etag: xmlText(match[1]!, "ETag") ?? "" });
  }
  const truncated = xmlText(xml, "IsTruncated") === "true";
  const next = truncated ? xmlText(xml, "NextContinuationToken") : null;
  if (truncated && !next) throw new S3Error("S3_RESPONSE", "S3 returned an unexpected listing.");
  return { objects, next };
}

/** The S3 error for a failed reply: a few codes have a better message than their status (desktop `s3_error`). */
export function s3Error(status: number, body: string): S3Error {
  const code = xmlText(body, "Code") ?? "";
  switch (code) {
    case "SignatureDoesNotMatch":
      return new S3Error("SIGNATURE_MISMATCH", "S3 rejected the request signature. Check the secret access key.", status);
    case "RequestTimeTooSkewed":
      return new S3Error("CLOCK_SKEW", "This device's clock differs too much from S3's. Correct the date and time, then try again.", status);
    case "InvalidAccessKeyId":
      return new S3Error("ACCESS_DENIED", "S3 does not recognize the access key ID. Check the credentials.", status);
    case "ExpiredToken":
    case "InvalidToken":
    case "TokenRefreshRequired":
      return new S3Error("ACCESS_DENIED", "The S3 session token has expired or is invalid. Update the credentials.", status);
    case "NoSuchBucket":
      return new S3Error("NO_SUCH_BUCKET", "The bucket was not found. Check the bucket name and region.", status);
    case "PreconditionFailed":
    case "ConditionalRequestConflict":
      return new S3Error("CONFLICT", "This item changed in S3.", status);
    case "InvalidRequest":
    case "InvalidArgument":
    case "MalformedXML":
    case "NotImplemented":
      return new S3Error("S3_REJECTED", "S3 rejected the request. The endpoint may not support this operation.", status);
  }
  if (status === 401 || status === 403) return new S3Error("ACCESS_DENIED", "S3 denied access. Check the credentials and bucket permissions.", status);
  if (status === 404) return new S3Error("NOT_FOUND", "The bucket or object was not found.", status);
  if (status === 409 || status === 412) return new S3Error("CONFLICT", "This item changed in S3.", status);
  if (status === 429) return new S3Error("THROTTLED", "S3 is throttling requests. Try again shortly.", status);
  if (status >= 500) return new S3Error("S3_UNAVAILABLE", "S3 is temporarily unavailable.", status);
  return new S3Error("S3_REQUEST", "The S3 request failed.", status);
}

export const UNREACHABLE_MESSAGE =
  "S3 could not be reached. Check the connection, the endpoint and the bucket's CORS rule (web/README.md).";

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

interface Reply {
  status: number;
  etag: string | null;
  body: Uint8Array;
}

export interface S3ClientOptions {
  fetch?: FetchLike;
  now?: () => Date;
  timeoutMs?: number;
}

export class S3Client {
  readonly location: S3Location;
  private readonly credentials: Credentials;
  private readonly fetcher: FetchLike;
  private readonly now: () => Date;
  private readonly timeoutMs: number;

  constructor(location: S3Location, credentials: Credentials, options: S3ClientOptions = {}) {
    const problem = locationProblem(location);
    if (problem) throw new S3Error("INVALID_LOCATION", problem);
    this.location = { ...location, endpoint: location.endpoint?.trim() || null };
    this.credentials = credentials;
    this.fetcher = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.now = options.now ?? (() => new Date());
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  private async send(
    method: "GET" | "PUT",
    url: URL,
    options: { body?: Uint8Array<ArrayBuffer>; headers?: Record<string, string>; limit: number; retry: boolean },
  ): Promise<Reply> {
    const body = options.body;
    const payloadHash = body ? await sha256Hex(body) : EMPTY_SHA256;
    for (let attempt = 1; ; attempt++) {
      const last = !options.retry || attempt >= MAX_ATTEMPTS;
      const signed = await sign({
        method,
        url,
        headers: options.headers ?? {},
        payloadHash,
        region: this.location.region,
        service: "s3",
        credentials: this.credentials,
        now: this.now(),
        contentSha256Header: true,
      });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs + (body ? body.length / 50 : 0));
      let response: Response;
      try {
        response = await this.fetcher(url.href, {
          method,
          headers: signed.headers,
          body: body ?? null,
          cache: "no-store",
          credentials: "omit",
          mode: "cors",
          redirect: "error",
          referrerPolicy: "no-referrer",
          signal: controller.signal,
        });
      } catch {
        clearTimeout(timer);
        if (last) throw new S3Error("UNREACHABLE", UNREACHABLE_MESSAGE);
        continue;
      }
      try {
        if ((response.status === 429 || response.status >= 500) && !last) {
          await response.arrayBuffer().catch(() => undefined);
          continue;
        }
        const declared = Number(response.headers.get("content-length") ?? "");
        if (Number.isFinite(declared) && declared > options.limit) throw new S3Error("TOO_LARGE", "The S3 reply is too large to open safely.");
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.length > options.limit) throw new S3Error("TOO_LARGE", "The S3 reply is too large to open safely.");
        return { status: response.status, etag: response.headers.get("etag"), body: bytes };
      } catch (error) {
        if (error instanceof S3Error) throw error;
        if (last) throw new S3Error("UNREACHABLE", UNREACHABLE_MESSAGE);
      } finally {
        clearTimeout(timer);
      }
    }
  }

  private check(reply: Reply): void {
    if (reply.status >= 200 && reply.status < 300) return;
    throw s3Error(reply.status, fromUtf8(reply.body.subarray(0, MAX_REPLY_BYTES)) ?? "");
  }

  /** Every object under `prefix` (ListObjectsV2, all pages). */
  async list(prefix: string): Promise<ListedObject[]> {
    const all: ListedObject[] = [];
    let token: string | null = null;
    do {
      let query = "list-type=2";
      if (prefix) query += `&prefix=${uriEncode(prefix, false)}`;
      if (token) query += `&continuation-token=${uriEncode(token, false)}`;
      const reply = await this.send("GET", objectUrl(this.location, "", query), { limit: MAX_LIST_RESPONSE_BYTES, retry: true });
      this.check(reply);
      const page = parseListResponse(fromUtf8(reply.body) ?? "");
      all.push(...page.objects);
      if (all.length > MAX_OBJECTS) throw new S3Error("WORKSPACE_TOO_LARGE", "This workspace contains too many S3 objects.");
      token = page.next;
    } while (token);
    return all;
  }

  async get(key: string): Promise<ObjectBody> {
    const reply = await this.send("GET", objectUrl(this.location, key), { limit: MAX_DOCUMENT_BYTES, retry: true });
    if (reply.status === 404) throw new S3Error("NOT_FOUND", "The S3 object no longer exists.", 404);
    this.check(reply);
    return { bytes: reply.body, etag: reply.etag };
  }

  /**
   * Conditional PutObject: `ifMatch` replaces exactly the version an edit is
   * based on, `ifNoneMatch` only creates. Returns the new ETag. A lost reply
   * is not retried here (the caller compares what S3 holds instead).
   */
  async put(key: string, body: Uint8Array, condition: PutCondition): Promise<string> {
    const headers: Record<string, string> = { "content-type": "application/octet-stream" };
    if ("ifMatch" in condition) headers["if-match"] = condition.ifMatch;
    else headers["if-none-match"] = "*";
    const reply = await this.send("PUT", objectUrl(this.location, key), { body: owned(body), headers, limit: MAX_REPLY_BYTES, retry: false });
    this.check(reply);
    if (!reply.etag) {
      throw new S3Error("ETAG_HIDDEN", "S3 saved the object but did not expose its ETag. Add ETag to ExposeHeaders in the bucket's CORS rule (web/README.md).");
    }
    return reply.etag;
  }
}
