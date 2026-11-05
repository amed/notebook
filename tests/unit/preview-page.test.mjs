// public/preview.html is the static page the HTML preview frame loads
// (src/html-preview.ts). Its policy must be in force before any page markup
// is inserted, and it must stay free of scripts and styles: Tauri adds a nonce
// to the CSP header for every <style> in a bundled page, which would switch
// off 'unsafe-inline' and drop the previewed page's own CSS.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const page = readFileSync(new URL("../../public/preview.html", import.meta.url), "utf8");

test("the preview frame page renders in standards mode", () => {
  assert.match(page, /^<!doctype html>/i);
});

test("the preview frame page denies every network destination before content arrives", () => {
  const policy = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(page)?.[1];
  assert.ok(policy, "policy <meta> missing");
  const directives = new Map(policy.split(";").map((part) => {
    const [name, ...sources] = part.trim().split(/\s+/);
    return [name, sources.join(" ")];
  }));
  assert.equal(directives.get("default-src"), "'none'");
  assert.equal(directives.get("style-src"), "'unsafe-inline'");
  for (const name of ["img-src", "media-src", "font-src"]) assert.equal(directives.get(name), "data:");
  assert.equal(directives.get("form-action"), "'none'");
  assert.equal(directives.get("base-uri"), "'none'");
  for (const name of ["script-src", "connect-src", "frame-src", "child-src"]) assert.ok(!directives.has(name), `${name} must fall back to default-src`);
});

test("the preview frame page has no scripts, styles or links of its own", () => {
  assert.doesNotMatch(page, /<(?:script|style|link|base|iframe)\b/i);
});
