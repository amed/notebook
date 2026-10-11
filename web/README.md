# Notebook on the web

A small, mobile-first web version of Notebook: a static site that opens the
same encrypted S3 workspace as the desktop app. Notes, names and folders are
encrypted and decrypted in the browser with the desktop's Notebook v1 codec,
so a bucket and phrase open identically in both apps. The site ships with no
notes, no sample workspace and no configuration: the first visit asks you to
connect your workspace.

It lives next to the desktop app and reuses its modules (the stylesheet and
theme, the CodeMirror editor, the HTML preview frame, the tree model, vault
links, the navigation guards and the new-file rules). The desktop app's
`index.html`, `src/boot.ts` and `src-tauri/` are unchanged.

## Build, run, deploy

```sh
npm ci
npm run dev:web        # http://127.0.0.1:1430, live reload
npm run build:web      # type-check, then the static site in dist-web/
npm run preview:web    # serve dist-web/ on http://127.0.0.1:1431
```

Size: about 158 KB of JavaScript (54 KB gzipped) and 77 KB of CSS (14 KB)
to connect, browse and read; the editor (CodeMirror, 552 KB, 192 KB gzipped)
loads on the first Edit. No fonts are bundled (system fonts, as the desktop).

`dist-web/` is the whole site: `index.html`, `preview.html` (the sandboxed
HTML preview frame), `favicon.svg`, `assets/` and `_headers`. There is no server code.
Copy it to any static host over **HTTPS** (WebCrypto only works in a secure
context; `localhost` is the exception). Asset paths are relative, so a
sub-path such as `https://example.com/notes/` works.

- **Netlify, Cloudflare Pages**: deploy `dist-web/`. They apply
  `dist-web/_headers`, generated from `web/deploy/_headers` with the same
  Content-Security-Policy as the page's `<meta>` tag plus `frame-ancestors`.
- **nginx**: see `web/deploy/nginx.conf`.
- **Anything else** (S3 + CloudFront, GitHub Pages…): the `<meta>` policy
  still applies. Add the headers from `web/deploy/_headers` if the host allows
  it, at least `frame-ancestors 'none'` (a `<meta>` policy cannot set it).

Use a dedicated origin (its own host name) for Notebook: any other page on
the same origin can read what this one stores (see "Security model").

### S3-compatible endpoints

The policy lets the page connect to `'self'` and `https://*.amazonaws.com`
only. For another provider, list its origin(s), space-separated, at build time:

```sh
NOTEBOOK_WEB_CONNECT_SRC="https://<account>.r2.cloudflarestorage.com" npm run build:web
```

Entries must be `https://` origins (a leading `*.` is allowed) or `http://`
on `localhost`, `127.0.0.1` or `[::1]` (local testing). Custom endpoints are
addressed path-style (`https://endpoint/bucket/key`), AWS virtual-hosted
(`https://bucket.s3.region.amazonaws.com/key`, path-style for bucket names
with dots), exactly like the desktop app.

## Required bucket CORS rule

The browser talks to S3 directly, so the bucket must allow the site's origin.
Replace `https://notes.example.com` with your site's origin (shown on the
Connect screen). In the S3 console (Bucket > Permissions > Cross-origin
resource sharing):

```json
[
  {
    "AllowedOrigins": ["https://notes.example.com"],
    "AllowedMethods": ["GET", "PUT", "POST", "DELETE", "HEAD"],
    "AllowedHeaders": ["authorization", "content-type", "content-md5", "x-amz-*", "if-match", "if-none-match"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3000
  }
]
```

With the AWS CLI the same rule is wrapped in `CORSRules`:

```sh
aws s3api put-bucket-cors --bucket YOUR-BUCKET --cors-configuration '{"CORSRules":[{"AllowedOrigins":["https://notes.example.com"],"AllowedMethods":["GET","PUT","POST","DELETE","HEAD"],"AllowedHeaders":["authorization","content-type","content-md5","x-amz-*","if-match","if-none-match"],"ExposeHeaders":["ETag"],"MaxAgeSeconds":3000}]}'
```

`ExposeHeaders: ETag` is required: saves are conditional on the ETag of the
version you opened, and the browser hides response headers that are not
exposed. The web version sends only GET and PUT today; HEAD, POST and DELETE
are listed so the same rule keeps working for the desktop app's operations
should they come to the web. MinIO has no bucket CORS API; set
`MINIO_API_CORS_ALLOW_ORIGIN=https://notes.example.com` on the server instead.
Without the rule, connecting fails with "S3 could not be reached… CORS rule".

### Credentials

Create a dedicated IAM user (or role) for Notebook, limited to the bucket and
prefix, for example (prefix `notes`):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": "s3:ListBucket", "Resource": "arn:aws:s3:::YOUR-BUCKET",
      "Condition": { "StringLike": { "s3:prefix": ["notes/*"] } } },
    { "Effect": "Allow", "Action": ["s3:GetObject", "s3:PutObject"], "Resource": "arn:aws:s3:::YOUR-BUCKET/notes/*" }
  ]
}
```

The desktop app also needs `s3:DeleteObject` (Trash, rename, move).
Temporary credentials (a session token) are accepted.

## What it does

- **Connect**: workspace name, bucket, region, prefix, optional endpoint,
  access key ID, secret, optional session token, encryption phrase,
  "Remember on this device" (on by default). The phrase is checked against the
  workspace before anything is stored: a listing in which nothing decrypts is
  refused as a wrong phrase. An empty bucket or prefix starts a new workspace.
- **Browse**: folders and documents as the desktop shows them. Notebook's
  `_deleted` bin, the earlier `_delete` and `.secure-vault-trash` namespaces
  and `.notebook_dir` folder markers are hidden; keys that do not decrypt with
  the phrase are skipped. **Search** filters by title.
- **Read**: Markdown in the preview (headings get the desktop's `h-<slug>`
  ids, `#heading` links scroll, relative links and `[[wikilinks]]` open other
  notes), `.html` documents in the desktop's sandboxed preview frame, `.txt`
  as plain text. External links open in a new tab after a confirmation.
- **Edit** with the desktop's CodeMirror editor (loaded on first use), Split
  on screens 1100 px and wider. **Save** with the button, Ctrl+S / ⌘S, and
  before opening another note, Lock or Forget; the page warns before closing
  with unsaved changes and tries to save when it is hidden.
- **New note** (a path from the root; no extension means `.md`; missing
  folders are created) and **New folder** (a Notebook `.notebook_dir` marker).
  Names follow the desktop's rules and get " 2", " 3"… when taken.
- **Lock** forgets the keys in memory. **Forget this device** removes the
  config, the sealed secrets and the sealing key from the browser (your S3
  data is not touched).

### Saving and conflicts

A save is a conditional PUT with `If-Match` on the ETag of the version you
opened (new items use `If-None-Match: *`), as in the desktop app. If another
device changed or removed the note meanwhile, S3 refuses the write and your
text is saved next to it as `Name (conflict <timestamp>).md` (the desktop's
`conflict_path` naming); the original keeps the other device's version and
the editor continues on the copy. A save whose reply was lost is recognised
by comparing the decrypted text in S3, so it does not create a copy.

### Not included

Trash (move to, restore, empty), rename, move, delete, import, image paste,
a workspace manager (the web version keeps one workspace; connecting another
replaces it), settings (theme and accent are read from the config; the theme
follows the OS by default), auto-lock, the outline, document windows, the
offline outbox (nothing is kept locally: an edit that cannot be saved stays
in the page until you save or leave), footnotes in the preview.

## Configuration in the browser

The same meaning and field names as the desktop's files:

- `localStorage["notebook.config.v2"]`: the desktop `config.json` v2 object,
  `{version: 2, auto_lock_minutes, theme, accent, active_workspace,
  workspaces: [{id, name, bucket, region, prefix, endpoint,
  masked_access_key_id, remember_declined?}]}`. Nothing secret.
- `localStorage["notebook.secrets.v1"]`: the desktop `secrets.json` shape,
  `{version: 1, workspaces: {<id>: {s3?, phrase?}}}`. `s3` is the desktop's
  `StoredCredentials` JSON (`access_key_id`, `secret_access_key`,
  `session_token`). Each value is `base64(nonce || ciphertext || tag)`,
  AES-256-GCM under a **non-extractable** WebCrypto key kept in IndexedDB
  (`notebook-web` / `keys`), the browser's stand-in for the key the desktop
  keeps in the OS keychain. The associated data is the desktop's context
  `notebook::secrets::v1::<workspace>::<field>`, so a value copied to another
  workspace or field does not open. (The desktop seals with AES-256-GCM-SIV;
  WebCrypto has no GCM-SIV and the keys differ anyway, so the two files are
  never interchangeable.)
- With "Remember" off, only the non-secret workspace entry (with
  `remember_declined: true`) is stored; credentials and phrase stay in memory
  and are asked again after a reload.

## Encryption

Byte-compatible with `src-tauri/src/compat/notebook_v1.rs` (and Notebook):
PBKDF2-HMAC-SHA256 with 120,000 rounds and the salts
`notebook::remote-encryption::{path|content|reference}` (WebCrypto); the
phrase trimmed exactly like Rust's `str::trim` (Unicode White_Space, which
differs from JavaScript's `trim` for U+0085 and U+FEFF) and never normalized;
every path segment sealed with AES-256-GCM-SIV under the nonce
`SHA-256("notebook::path::" || plaintext parent path)[..12]` and encoded as
base64url without padding (decoded strictly, as Rust does); bodies as a
random 12-byte nonce followed by the GCM-SIV ciphertext and tag; the prefix
stays plaintext. AES-GCM-SIV comes from `@noble/ciphers` (audited, no
dependencies).

The proof runs both ways: `tests/web/codec.test.mjs` reproduces every path
written by the Rust codec, decrypts its bodies and re-encrypts them to the
same bytes with the same nonces; `cargo test --test web_compat` (in
`src-tauri/`) decrypts what the TypeScript codec wrote. The MinIO run below
checks whole documents across both apps.

## Security model

Protected: note text, document and folder names and folder structure (S3 and
anyone with bucket access see only ciphertext, sizes and timestamps). The
phrase never leaves the browser.

The site is static and has no third-party code at run time: no CDN, fonts,
analytics or inline scripts. A strict CSP (`script-src 'self'`, `connect-src`
limited to S3, `object-src 'none'`, `base-uri 'none'`, `form-action 'none'`,
`frame-ancestors 'none'` in the headers) limits what injected markup could do.
`style-src` allows `'unsafe-inline'` because the editor sets styles at run
time; images are `'self'` and `data:` only, so CSS cannot reach the network.
Markdown is sanitized with DOMPurify to the desktop's allowlist (no raw HTML,
links only http/https/mailto/`#`/vault links, images only inline
PNG/JPEG/GIF/WebP); HTML documents render in a script-less sandboxed frame
with a deny-all policy. Nothing is logged to the console.

Limits to be aware of:

- **Script running on this origin can use the stored secrets.** The sealing
  key cannot be exported, which keeps the credentials and phrase unreadable in
  a copy of the browser profile, a backup or a disk image, but an XSS on the
  hosting origin (or a malicious browser extension) runs as the page and can
  ask the browser to decrypt them, and can read notes while the workspace is
  open. Host Notebook on its own origin, keep the CSP, and do not add
  third-party scripts.
- Use a dedicated IAM user scoped to the bucket and prefix (above), so a leaked
  key cannot reach anything else, and rotate it if a device is lost.
- On shared or borrowed devices turn "Remember on this device" off, and use
  "Forget this device" when done.
- Whoever controls the hosting can change the code it serves. Host it
  yourself or on a provider you trust.

## Tests

```sh
npm run test:web          # codec vectors both ways, SigV4 (AWS test suite and S3 examples),
                          # config and sealing, tree and saves against an in-memory S3,
                          # the CSP and the deploy headers
npm run test:web:browser  # Markdown sanitizer attack corpus in Chromium and WebKit
                          # (needs: npx playwright-core install chromium webkit)
npm run test:web:e2e      # throwaway MinIO in Docker, Playwright at 375x812, 768x1024 and
                          # 1280x800 in Chromium and WebKit, plus the desktop codec reading
                          # and writing the same workspace (scripts/web-e2e.sh)
(cd src-tauri && cargo test --test web_compat)   # Rust side of the codec vectors
```

Vectors: `tests/web/fixtures/notebook-v1-rust.json` is written by the Rust
codec (`NOTEBOOK_WRITE_WEB_VECTORS=1 cargo test --test web_compat`),
`notebook-v1-web.json` by the TypeScript one (`node tests/web/write-vectors.mjs`).
