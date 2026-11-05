// `npm run dev:web` only (`apply: "serve"`): an in-memory S3 bucket on the
// dev server's own origin, at TEST_NOTEBOOK.path, holding the sample notes of
// ./test-notebook.ts encrypted with the real codec (./test-seed.ts, on the
// first request). It answers what web/src/s3.ts sends (ListObjectsV2,
// GetObject, PutObject with If-Match / If-None-Match) and does not check
// signatures. Same origin: no CORS, and the dev CSP's connect-src 'self'
// already allows it.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import type { ListedObject, ObjectBody, PutCondition } from "../src/s3.ts";
import { S3Error } from "../src/s3.ts";
import { TEST_NOTEBOOK } from "./test-notebook.ts";

/** Implements web/src/vault.ts RemoteStore. */
class MemoryBucket {
  readonly objects = new Map<string, { bytes: Uint8Array; etag: string }>();
  private counter = 0;

  async list(prefix: string): Promise<ListedObject[]> {
    return [...this.objects.keys()].filter((key) => key.startsWith(prefix)).sort().map((key) => ({ key, etag: this.objects.get(key)!.etag }));
  }

  async get(key: string): Promise<ObjectBody> {
    const object = this.objects.get(key);
    if (!object) throw new S3Error("NOT_FOUND", "The S3 object no longer exists.", 404);
    return { bytes: object.bytes, etag: object.etag };
  }

  async put(key: string, body: Uint8Array, condition: PutCondition): Promise<string> {
    const object = this.objects.get(key);
    if ("ifNoneMatch" in condition ? object : object?.etag !== condition.ifMatch) throw new S3Error("CONFLICT", "This item changed in S3.", 412);
    const etag = `"test-${++this.counter}"`;
    this.objects.set(key, { bytes: body, etag });
    return etag;
  }
}

const escape = (value: string): string => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function send(response: ServerResponse, status: number, body: string | Uint8Array = "", etag?: string): void {
  response.statusCode = status;
  if (etag) response.setHeader("ETag", etag);
  response.setHeader("Content-Type", typeof body === "string" ? "application/xml" : "application/octet-stream");
  response.end(body);
}

const error = (code: string): string => `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code></Error>`;

async function readBody(request: IncomingMessage): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return new Uint8Array(Buffer.concat(chunks));
}

async function handle(bucket: MemoryBucket, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  const [name, ...parts] = url.pathname.split("/").slice(1);
  if (name !== TEST_NOTEBOOK.bucket) return send(response, 404, error("NoSuchBucket"));
  const key = parts.map(decodeURIComponent).join("/");
  if (request.method === "GET" && key === "" && url.searchParams.get("list-type") === "2") {
    const objects = await bucket.list(url.searchParams.get("prefix") ?? "");
    const contents = objects.map((object) => `<Contents><Key>${escape(object.key)}</Key><ETag>${escape(object.etag)}</ETag></Contents>`).join("");
    return send(response, 200, `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>${name}</Name><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`);
  }
  if (request.method === "GET") {
    const object = bucket.objects.get(key);
    return object ? send(response, 200, object.bytes, object.etag) : send(response, 404, error("NoSuchKey"));
  }
  if (request.method === "PUT") {
    const body = await readBody(request);
    const ifMatch = request.headers["if-match"];
    try {
      const etag = await bucket.put(key, body, typeof ifMatch === "string" ? { ifMatch } : { ifNoneMatch: true });
      return send(response, 200, "", etag);
    } catch {
      return send(response, 412, error("PreconditionFailed"));
    }
  }
  send(response, 405, error("MethodNotAllowed"));
}

export function testS3(): Plugin {
  return {
    name: "notebook-web-test-s3",
    apply: "serve",
    configureServer(server) {
      const bucket = new MemoryBucket();
      let ready: Promise<void> | null = null;
      server.middlewares.use(TEST_NOTEBOOK.path, (request, response) => {
        ready ??= server.ssrLoadModule("/dev/test-seed.ts").then((module) => (module as typeof import("./test-seed.ts")).seed(bucket));
        void ready.then(() => handle(bucket, request, response)).catch((problem: unknown) => {
          server.config.logger.error(`test notebook: ${problem instanceof Error ? problem.message : String(problem)}`);
          send(response, 500, error("InternalError"));
        });
      });
    },
  };
}
