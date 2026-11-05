// An in-memory S3 behind a fetch function, for tests/web: path-style
// requests to http://127.0.0.1:9000/<bucket>/..., ListObjectsV2 pages,
// GetObject, PutObject with If-Match / If-None-Match. It checks that every
// request carries a SigV4 authorization and a matching x-amz-content-sha256.
import { createHash } from "node:crypto";

const escape = (value) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function fakeS3({ bucket = "bucket", pageSize = 1000, exposeEtag = true } = {}) {
  const objects = new Map();
  const requests = [];
  let counter = 0;
  const etagOf = (bytes) => `"${createHash("md5").update(bytes).digest("hex")}-${++counter}"`;
  const reply = (status, body = "", headers = {}) => new Response(status === 204 ? null : body, { status, headers });
  const error = (status, code) => reply(status, `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>x</Message></Error>`);

  async function fetch(input, init = {}) {
    const url = new URL(input);
    const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]));
    const body = init.body ? new Uint8Array(init.body) : new Uint8Array();
    requests.push({ method: init.method, url: url.href, headers, size: body.length });
    if (!/^AWS4-HMAC-SHA256 Credential=[^/]+\/\d{8}\/[a-z0-9-]+\/s3\/aws4_request, SignedHeaders=[a-z0-9;-]+, Signature=[0-9a-f]{64}$/.test(headers.authorization ?? "")) {
      return error(403, "AccessDenied");
    }
    if (headers["x-amz-content-sha256"] !== createHash("sha256").update(body).digest("hex")) return error(400, "XAmzContentSHA256Mismatch");
    const parts = url.pathname.split("/").slice(1);
    if (parts.shift() !== bucket) return error(404, "NoSuchBucket");
    const key = parts.map(decodeURIComponent).join("/");
    if (init.method === "GET" && key === "" && url.searchParams.get("list-type") === "2") {
      const prefix = url.searchParams.get("prefix") ?? "";
      const start = Number(url.searchParams.get("continuation-token") ?? "0");
      const keys = [...objects.keys()].filter((name) => name.startsWith(prefix)).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
      const page = keys.slice(start, start + pageSize);
      const more = start + pageSize < keys.length;
      const contents = page.map((name) => `<Contents><Key>${escape(name)}</Key><ETag>${escape(objects.get(name).etag)}</ETag><Size>${objects.get(name).bytes.length}</Size></Contents>`).join("");
      return reply(200, `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${bucket}</Name><Prefix>${escape(prefix)}</Prefix><KeyCount>${page.length}</KeyCount><IsTruncated>${more}</IsTruncated>${more ? `<NextContinuationToken>${start + pageSize}</NextContinuationToken>` : ""}${contents}</ListBucketResult>`);
    }
    const object = objects.get(key);
    const exposed = (etag) => (exposeEtag ? { etag } : {});
    if (init.method === "GET") return object ? reply(200, object.bytes, exposed(object.etag)) : error(404, "NoSuchKey");
    if (init.method === "PUT") {
      if (headers["if-none-match"] === "*" && object) return error(412, "PreconditionFailed");
      if (headers["if-match"] !== undefined && (!object || object.etag !== headers["if-match"])) return object ? error(412, "PreconditionFailed") : error(404, "NoSuchKey");
      const etag = etagOf(body);
      objects.set(key, { bytes: body, etag });
      return reply(200, "", exposed(etag));
    }
    return error(405, "MethodNotAllowed");
  }

  return { fetch, objects, requests };
}
