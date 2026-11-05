// A small in-memory S3 for the leakage session: path-style ListObjectsV2,
// GET, PUT (conditional, and copy), DELETE and DeleteObjects, which is what
// the app sends. `offline` drops every connection, as a dead network does.
// It keeps every object's raw bytes for the bucket canary scan.

import { createServer } from "node:http";

const xml = (text) => text.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
const error = (code) => `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code></Error>`;

export async function startFakeS3() {
  /** key → { body: Buffer, etag: string } */
  const objects = new Map();
  const requests = [];
  let version = 0;
  const state = { offline: false };

  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      if (state.offline) {
        request.socket.destroy();
        return;
      }
      const body = Buffer.concat(chunks);
      const url = new URL(request.url, "http://s3.invalid");
      const [, , ...rest] = url.pathname.split("/");
      const key = decodeURIComponent(rest.join("/"));
      const reply = (status, payload = "", headers = {}) => {
        response.writeHead(status, { "Content-Length": Buffer.byteLength(payload), ...headers });
        response.end(payload);
      };
      const method = request.method;
      const current = objects.get(key);

      if (method === "GET" && url.searchParams.has("list-type")) {
        requests.push("LIST");
        const prefix = url.searchParams.get("prefix") ?? "";
        const contents = [...objects]
          .filter(([name]) => name.startsWith(prefix))
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([name, object]) => `<Contents><Key>${xml(name)}</Key><LastModified>2026-01-01T00:00:00.000Z</LastModified><ETag>${xml(object.etag)}</ETag><Size>${object.body.length}</Size><StorageClass>STANDARD</StorageClass></Contents>`)
          .join("");
        reply(200, `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`);
        return;
      }
      if (method === "POST" && url.searchParams.has("delete")) {
        requests.push("DELETE_OBJECTS");
        for (const [, name] of body.toString("utf8").matchAll(/<Key>([^<]*)<\/Key>/g)) {
          objects.delete(name.replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">"));
        }
        reply(200, "<DeleteResult></DeleteResult>");
        return;
      }
      if (method === "PUT" && request.headers["x-amz-copy-source"]) {
        requests.push("COPY");
        const source = decodeURIComponent(String(request.headers["x-amz-copy-source"]).replace(/^\/?[^/]+\//, ""));
        const from = objects.get(source);
        if (!from) return reply(404, error("NoSuchKey"));
        const wanted = request.headers["x-amz-copy-source-if-match"];
        if (wanted && wanted !== from.etag) return reply(412, error("PreconditionFailed"));
        objects.set(key, { body: from.body, etag: from.etag });
        reply(200, `<CopyObjectResult><ETag>${xml(from.etag)}</ETag></CopyObjectResult>`);
        return;
      }
      if (method === "GET") {
        requests.push("GET");
        if (!current) return reply(404, error("NoSuchKey"));
        response.writeHead(200, { "Content-Length": current.body.length, ETag: current.etag });
        response.end(current.body);
        return;
      }
      if (method === "PUT") {
        requests.push("PUT");
        const ifMatch = request.headers["if-match"];
        if ((request.headers["if-none-match"] && current) || (ifMatch && ifMatch !== current?.etag)) {
          return reply(412, error("PreconditionFailed"));
        }
        version += 1;
        const etag = `"v${version}"`;
        objects.set(key, { body, etag });
        reply(200, "", { ETag: etag });
        return;
      }
      if (method === "DELETE") {
        requests.push("DELETE");
        const ifMatch = request.headers["if-match"];
        if (ifMatch && ifMatch !== current?.etag) return reply(412);
        objects.delete(key);
        reply(204);
        return;
      }
      reply(400, error("InvalidRequest"));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    endpoint: `http://127.0.0.1:${server.address().port}`,
    objects,
    requests,
    state,
    count: (kind) => requests.filter((name) => name === kind).length,
    close: () => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}
