// A static file server for dist-web/ that applies dist-web/_headers the way
// Netlify and Cloudflare Pages do (exact paths and "/*" splats, merged), so
// the end-to-end run exercises the deployed headers, CSP included.
//   node tests/web-e2e/serve.mjs <dist-web dir> <port>
import { createServer } from "node:http";
import { readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".json": "application/json", ".png": "image/png", ".ico": "image/x-icon",
};

export function parseHeaders(text) {
  const rules = [];
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    if (!/^\s/.test(line)) {
      current = { path: line.trim(), headers: [] };
      rules.push(current);
    } else if (current) {
      const colon = line.indexOf(":");
      current.headers.push([line.slice(0, colon).trim(), line.slice(colon + 1).trim()]);
    }
  }
  return rules;
}

function matches(rule, path) {
  if (rule.endsWith("/*")) return path.startsWith(rule.slice(0, -1));
  return rule === path;
}

export function serve(dir, port) {
  const root = resolve(dir);
  const rules = parseHeaders(readFileSync(join(root, "_headers"), "utf8"));
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const path = decodeURIComponent(url.pathname);
    let file = normalize(join(root, path === "/" ? "index.html" : path));
    if (!file.startsWith(root) || path === "/_headers") {
      response.writeHead(404).end();
      return;
    }
    try {
      if (statSync(file).isDirectory()) file = join(file, "index.html");
      const body = readFileSync(file);
      const headers = { "content-type": TYPES[extname(file)] ?? "application/octet-stream" };
      for (const rule of rules) if (matches(rule.path, path)) for (const [name, value] of rule.headers) headers[name] = value;
      response.writeHead(200, headers).end(request.method === "HEAD" ? undefined : body);
    } catch {
      response.writeHead(404, { "content-type": "text/plain" }).end("not found");
    }
  });
  return new Promise((done) => server.listen(port, "127.0.0.1", () => done(server)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [dir = "dist-web", port = "4173"] = process.argv.slice(2);
  await serve(dir, Number(port));
  console.log(`serving ${dir} on http://127.0.0.1:${port}`);
}
