// The web version: a static site built from web/ into dist-web/
// (`npm run build:web`, `npm run dev:web`). It shares src/ with the desktop
// app but has its own entry and HTML, so the desktop build is unchanged.
//
// The Content-Security-Policy <meta> is written here. S3 requests may go to
// AWS (https://*.amazonaws.com) and to the origins listed, space-separated,
// in NOTEBOOK_WEB_CONNECT_SRC at build time, for example
//   NOTEBOOK_WEB_CONNECT_SRC="https://<account>.r2.cloudflarestorage.com" npm run build:web
// Each entry is an https origin (a leading "*." wildcard is allowed) or an
// http origin on localhost / 127.0.0.1 / [::1] (local testing).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import { testS3 } from "./dev/test-s3.ts";

const root = fileURLToPath(new URL(".", import.meta.url));
const ORIGIN = /^(?:https:\/\/(?:\*\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*(?::\d{1,5})?|http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?)$/i;

function connectSources(): string[] {
  const extra = (process.env.NOTEBOOK_WEB_CONNECT_SRC ?? "").split(/\s+/).filter(Boolean);
  for (const source of extra) {
    if (!ORIGIN.test(source)) throw new Error(`NOTEBOOK_WEB_CONNECT_SRC: "${source}" is not an https origin (or an http origin on localhost)`);
  }
  return ["'self'", "https://*.amazonaws.com", ...extra];
}

function policy(dev: boolean): string {
  const connect = connectSources();
  if (dev) connect.push("ws://127.0.0.1:1430");
  return [
    "default-src 'self'",
    "script-src 'self'",
    // CodeMirror (style-mod) and the editor set styles at run time.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src ${connect.join(" ")}`,
    "frame-src 'self'",
    "worker-src 'none'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}

function contentSecurityPolicy(): Plugin {
  let dev = false;
  return {
    name: "notebook-web-csp",
    configResolved(config) {
      dev = config.command === "serve";
    },
    transformIndexHtml(html) {
      if (!html.includes("%NOTEBOOK_CSP%")) throw new Error("web/index.html lost its CSP placeholder");
      return html.replace("%NOTEBOOK_CSP%", policy(dev));
    },
    // dist-web/_headers (Netlify, Cloudflare Pages): the same policy as a header, plus frame-ancestors.
    generateBundle() {
      const template = readFileSync(new URL("./deploy/_headers", import.meta.url), "utf8");
      this.emitFile({ type: "asset", fileName: "_headers", source: template.replaceAll("%NOTEBOOK_CSP%", policy(false)) });
    },
  };
}

export default defineConfig({
  root,
  base: "./",
  publicDir: "public",
  clearScreen: false,
  envPrefix: "NOTEBOOK_WEB_PUBLIC_",
  // testS3: `npm run dev:web` only, an in-memory bucket with sample notes (web/dev/).
  plugins: [contentSecurityPolicy(), testS3()],
  server: {
    host: "127.0.0.1",
    port: 1430,
    strictPort: true,
    fs: { allow: [fileURLToPath(new URL("..", import.meta.url))] },
  },
  preview: { host: "127.0.0.1", port: 1431, strictPort: true },
  build: {
    outDir: "../dist-web",
    emptyOutDir: true,
    target: "es2022",
    minify: "oxc",
    sourcemap: false,
    modulePreload: { polyfill: false },
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 1_000,
  },
});
