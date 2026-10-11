// The web version's static files: the preview frame page is the desktop's,
// the HTML page has no inline script and gets its CSP from the build, and the
// deploy samples carry the headers a <meta> policy cannot set.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

test("the preview frame page is the desktop's, byte for byte", () => {
  assert.equal(read("web/public/preview.html"), read("public/preview.html"));
});

test("index.html: CSP placeholder, no inline script, no third-party resource", () => {
  const html = read("web/index.html");
  assert.match(html, /<meta http-equiv="Content-Security-Policy" content="%NOTEBOOK_CSP%" \/>/);
  assert.match(html, /<meta name="referrer" content="no-referrer" \/>/);
  assert.match(html, /viewport-fit=cover/);
  for (const script of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) {
    assert.match(script[0], /\ssrc="\.\/src\/main\.ts"/);
    assert.equal(script[1].trim(), "");
  }
  assert.ok(!/https?:\/\//.test(html.replace(/<!--[\s\S]*?-->/g, "")), "no absolute URLs");
});

test("the build's policy: strict defaults, S3 origins only from the documented variable", async () => {
  const { default: config } = await import("../../web/vite.config.ts");
  const plugin = config.plugins.find((item) => item.name === "notebook-web-csp");
  const policyFor = (extra) => {
    if (extra === undefined) delete process.env.NOTEBOOK_WEB_CONNECT_SRC;
    else process.env.NOTEBOOK_WEB_CONNECT_SRC = extra;
    plugin.configResolved({ command: "build" });
    return /content="([^"]+)"/.exec(plugin.transformIndexHtml('<meta content="%NOTEBOOK_CSP%">'))[1];
  };
  const policy = new Map(policyFor(undefined).split("; ").map((part) => [part.split(" ")[0], part.slice(part.indexOf(" ") + 1)]));
  assert.equal(policy.get("default-src"), "'self'");
  assert.equal(policy.get("script-src"), "'self'");
  assert.equal(policy.get("connect-src"), "'self' https://*.amazonaws.com");
  assert.equal(policy.get("img-src"), "'self' data:");
  assert.equal(policy.get("frame-src"), "'self'");
  assert.equal(policy.get("object-src"), "'none'");
  assert.equal(policy.get("base-uri"), "'none'");
  assert.equal(policy.get("form-action"), "'none'");
  assert.match(policyFor("https://acc.r2.cloudflarestorage.com http://127.0.0.1:9000"), /connect-src 'self' https:\/\/\*\.amazonaws\.com https:\/\/acc\.r2\.cloudflarestorage\.com http:\/\/127\.0\.0\.1:9000;/);
  for (const bad of ["http://s3.example.com", "https://x.example/path", "*", "'unsafe-inline'", "https://a.example;script-src *"]) {
    assert.throws(() => policyFor(bad), /NOTEBOOK_WEB_CONNECT_SRC/, bad);
  }
  delete process.env.NOTEBOOK_WEB_CONNECT_SRC;
});

test("deploy samples set frame-ancestors, nosniff, referrer and HSTS", () => {
  const headers = read("web/deploy/_headers");
  assert.match(headers, /^\/\n {2}Content-Security-Policy: %NOTEBOOK_CSP%; frame-ancestors 'none'$/m);
  assert.match(headers, /^\/preview\.html\n {2}Content-Security-Policy: default-src 'none';.*frame-ancestors 'self'$/m);
  for (const header of ["X-Content-Type-Options: nosniff", "Referrer-Policy: no-referrer", "Strict-Transport-Security: max-age=", "Permissions-Policy: "]) assert.ok(headers.includes(header), header);
  const nginx = read("web/deploy/nginx.conf");
  assert.match(nginx, /frame-ancestors 'none'/);
  assert.match(nginx, /frame-ancestors 'self'/);
  for (const header of ["X-Content-Type-Options nosniff", "Referrer-Policy no-referrer", "Strict-Transport-Security", "Permissions-Policy"]) assert.ok(nginx.includes(header), header);
});
