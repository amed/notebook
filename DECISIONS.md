# Notebook — implementation decisions

This file records places where the build specification is silent, internally
inconsistent, or requires an owner decision. Security and data safety take
precedence.

## Experimental native format (not active for S3 interoperability)

The following SMDV envelope decisions are retained for a possible future vault
type. The current app does not write this format; the primary format is the
Notebook-compatible format described below.

- The vault-key wrap authenticates a canonical **pre-wrap header**, because the
  complete stored header contains the wrap ciphertext and therefore cannot be
  its own associated data. The pre-wrap header contains `vault_id`, `created`
  and `kdf`, serialized as compact JSON with struct field order. The stored
  `wrap` object contains base64url-without-padding nonce and ciphertext.
- Envelope associated data is unambiguous binary:
  `SMDV || 0x01 || vault_uuid(16) || object_uuid(16) || kind(1)`.
- The index-body object ID is the vault ID. Header JSON is capped at 64 KiB,
  the decrypted index at 50 MiB, documents at 50 MiB, and images at 20 MiB.
- Integers in the binary index prefix are little-endian as specified. JSON is
  UTF-8 and compact on upload. Readers do not depend on JSON field order.

## Unicode and names

`unicode-normalization` is the one required dependency not named in the stack
table. Rust's standard library has no NFC implementation. Names are NFC,
trimmed, limited to 255 Unicode scalar values, reject `/` and controls, and are
compared with Unicode lowercase mapping. Suffix generation truncates safely at
a scalar boundary so the result remains within 255 characters.

## Setup and credentials

- A 403 response without `s3:ListBucket` cannot distinguish a missing index
  from denied access. `connection_test` reports `AccessDenied`; vault creation
  remains available only as an explicit, conditional `If-None-Match: *` action,
  which can never overwrite a vault.
- Superseded by "Workspaces and remembered phrase" below: credentials are
  sealed in `secrets.json` per workspace id. The keychain account derived from
  the bucket and prefix tuple is only read once, to migrate an earlier build.
- v1 officially supports AWS S3. Endpoint override exists for testing and
  compatible providers, but those providers are not certified. Non-HTTPS
  endpoints are accepted only in debug/test builds and only for loopback hosts.

## Product behavior

- `.html` and `.htm` documents are source-editable and render as static
  pages in one persistent iframe per preview pane (`src/html-preview.ts`).
  The frame loads the static same-origin `public/preview.html`, and the parent
  inserts the sanitized page into it. Why not `srcdoc`, blob, data or
  `about:blank` frames: wry runs the app's `on_navigation` guard for subframes
  on macOS and Linux, and the guard denies `about:srcdoc`, `blob:` and
  `data:` (empty frames); and in an `about:blank` frame an `#id` link resolved
  against the app URL and loaded `index.html` into the frame (blank pane),
  because WebKit never calls listeners the parent adds to a frame document
  without `allow-scripts`. `preview.html` is an app URL, so the guard allows
  it, `#id` links scroll natively, and no Rust change was needed.
  - The sandbox is `allow-same-origin` only: no scripts, forms, popups,
    downloads or top navigation. `preview.html` carries a deny-by-default
    policy `<meta>` (only inline CSS and `data:` images, media and fonts) that
    is in force before any page markup is inserted; the app CSP header
    applies too. The sanitizer removes scripts, frames, objects, `link`,
    `meta`, `base`, `template`, `foreignObject`, the SMIL animation elements,
    `on*`/`autofocus`/`target`/`download` attributes and every URL except
    `#id`, `data:` raster images and web/mail links. SVG, MathML, `noscript`,
    forms (inert) and inline CSS stay.
  - Removed scripts are counted; the pane then shows "Scripts are off in the
    preview (N not run)." instead of a silently blank page.
  - Web and mail links become `preview.html?open=<url>`. The app CSP
    (`frame-src 'self'`) blocks any other frame destination before the Rust
    guard sees it, and the page cannot run script, so the click reloads the
    frame instead; the parent's `load` listener repaints, clears the URL and
    asks the user in the app's link dialog before `link_open`.
  - A render with unchanged text does nothing. An edit keeps the scroll
    position and replaces only the changed top-level body children while the
    `<head>` and `<html>`/`<body>` attributes are unchanged; another document
    starts at the top. Edit mode keeps the hidden frame (except for documents
    over 512 KB, see "Fewer UI changes"). Every frame `load` repaints, so a
    frame that is navigated anywhere heals itself.
- Rust owns the canonical plaintext, but the currently visible Monaco model
  necessarily contains an ephemeral JavaScript string. Lock writes the open
  document's edit to the outbox, gives the uploads 3 s, calls `vault_lock`
  (see "Save model"), disposes every model and
  the editor, drops the page's decrypted names and texts (tree, sample cache,
  search, open dialogs) and re-renders the unlock screen in place. The WebView
  is not reloaded, so strings already created in the JS heap are left to
  garbage collection; a reload (F5, context menu) ends the Rust session.
- `notebook.rs` is the only production module that signs S3 requests or accesses
  persisted Notebook-compatible objects. It also owns non-secret config and OS
  keychain integration so secrets do not cross the IPC boundary after setup.
- Commands available while locked are config, credential, connection, create,
  unlock, lock, activity and flush/status-related calls. All content commands
  fail closed.
- Rename, move and trash first upload the staged edits of every document they
  move, and refuse ("not uploaded yet") while S3 cannot take them, so no
  outbox entry ever points at a key that is gone.
- Search ranking is exact-prefix, word-prefix, substring, then recency. Size is
  UTF-8 byte size.
- Tauri's typed invoke transport carries image bytes as a `Uint8Array`; Rust
  rejects oversized or invalid payloads before retaining them. This preserves
  the no-filesystem-path trust boundary even though it is not a custom HTTP IPC
  body/header pair.

## Release owner choices

- Object-size padding is disabled in v1, as the specification states.
- Bucket noncurrent-version retention is owned by the user; the README suggests
  30–90 days and explains the trade-off.
- Signing/notarization identities are injected only in release CI. Unsigned
  local artifacts remain supported for development.

## S3 format

- PBKDF2-HMAC-SHA256, 120,000 iterations, with fixed domain-separated salts
  `notebook::remote-encryption::{path|content|reference}`;
- AES-256-GCM-SIV for both path segments and document bytes;
- deterministic path nonces equal to the first 12 bytes of
  `SHA256("notebook::path::" || plaintext_parent_path)`;
- base64url-without-padding encoded path segments;
- bodies equal `random_nonce(12) || ciphertext_and_tag`, with no envelope;
- the phrase is trimmed but deliberately not NFC-normalized, matching the
  existing implementation exactly.

The dependencies `aes-gcm-siv` and `pbkdf2` are audited RustCrypto crates and
avoid hand-written cryptographic primitives. Interoperable browsing necessarily
uses `ListObjectsV2`. This supersedes the original index-only S3 layout and its
no-LIST request budget. The newer SMDV envelope remains research code and is not
written into a Notebook-compatible prefix.

Recoverable Trash was first represented under the reserved logical path
`.secure-vault-trash/<entry UUID>/<original path>`. This is superseded by
"Trash is Notebook's `_deleted` bin" below; the namespace is now read-only.

## `freezePrototype` is off

Spec section 11 asks for `app.security.freezePrototype: true`. With it, the
release build opened to a blank window: Monaco's compiled TypeScript namespaces
assign `KeyCodeUtils.toString = ...` (and similar) on plain objects at module
load, which throws once `Object.prototype` is frozen (the JavaScript "override
mistake"). The same failure can be triggered later by any library code that
assigns a property named like an `Object.prototype` member, including keys
derived from document text, so patching the few known sites at build time
would not be robust.

The option is therefore disabled. What remains in place: `script-src 'self'`
with no inline scripts or `eval`, `withGlobalTauri: false`, per-command
capabilities, typed IPC payloads that are never merged into shared objects,
Markdown preview HTML sanitized in Rust, isolated static-page HTML preview,
and the navigation guard. The frontend loads through `src/boot.ts`, which shows an explicit
startup error instead of a blank window if the bundle ever fails to evaluate.
The end-to-end test catches a re-enabled `freezePrototype`: the release build
then shows that startup error and four tests fail.

## Process hygiene

`src-tauri/src/hardening.rs` runs before the window opens: `tracing` to stderr
only (`warn` in release, `debug` in debug), a panic hook that prints only the
source location, and in release builds `RLIMIT_CORE = 0` on Unix plus
`PR_SET_DUMPABLE = 0` on Linux. `rustix` (already in the dependency graph)
provides the Linux `prctl` call without `unsafe` in this crate. Windows Error
Reporting dumps are outside the app's control and are documented in the README.

## Preview rendering

- **`preview_render(text)` replaces the spec's `render_preview(doc_id)`.**
  `doc_update` uploads straight to S3 and Rust keeps no edited buffer, so a
  render by document ID would show the last saved version and cost an S3 GET
  plus a decrypt per render. `preview_render` is a pure function of the editor
  text (16 MiB cap, blocking thread). `render_preview` and its permission were
  removed, because nothing calls them.
- The frontend calls it 300 ms after the last edit, only while Split or Preview
  is shown and only when the document, its text or its language changed since
  the last render (see "Fewer UI changes"). A sequence number drops responses
  that arrive after a newer edit, a document switch, lock or settings. Text
  over 16 MiB is not sent, and a render error shows the backend's safe
  message.
- HTML documents bypass the Markdown renderer and use the persistent
  static-page iframe described above. The app CSP permits only same-origin
  frames; the frame page's own policy denies every network destination.
- Markdown documents expose a heading outline parsed in the frontend after the
  same 300 ms edit delay, only while the outline is shown. ATX and Setext
  headings are nested by level, fenced code is ignored, and each branch or the
  whole tree can be folded. Selecting a heading reveals its source line in
  Monaco without changing the document.
- pulldown-cmark with tables, strikethrough, task lists and footnotes; raw HTML
  and HTML blocks are shown as text. ammonia uses the spec allowlist plus
  `span` (blocked-image placeholder). Links keep `href` only for https, http,
  mailto and `#footnote-N`, and get `rel="noopener noreferrer"`. Relative and
  `//host` links lose their `href`: v1 has no links between documents, and
  `//host` would resolve against the app origin. `ol start` is dropped.
- **Only inline raster images are shown.** This build stores pasted images
  inline (`image_add` returns a `data:` URI) and has no `secure-img` scheme.
  Images other than `data:image/(png|jpeg|gif|webp);base64,...` become
  `<span class="blocked-image">Image blocked</span>`, so opening a document
  never contacts a third party. This is enforced by rewriting parser events
  and by an ammonia attribute filter; the CSP keeps `img-src 'self' data:`.
- Table alignment is emitted as `align`, since pulldown-cmark emits `style`.
  Footnotes become `<sup class="footnote-reference"><a href="#footnote-N">`
  and `<section class="footnote-definition" id="footnote-N">`: pulldown's
  `div` is not allowlisted, and its ids come from labels in the document,
  which could shadow the app's own element ids. The frontend scrolls to
  `#footnote-N` itself; `link_open` rejects fragments.
- Task-list checkboxes are forced to `type="checkbox" disabled`.
- Lists, quotes, items, footnotes, emphasis and links nested deeper than 32
  are flattened into their parent: html5ever and ammonia take time quadratic
  in the depth, and a 100 KB `- - - …` line took seconds to tens of seconds.
- The frontend parses the returned HTML in an inert `<template>` and, as
  defense in depth, re-applies the image rule and `rel`. The small TypeScript
  renderer runs only in a plain browser (`npm run dev` without Tauri).

## Links, navigation and new windows

- **External links go through the `link_open` command; the webview has no
  opener permission.** Spec section 11 grants `tauri-plugin-opener` to the
  webview with URL scopes. The plugin (2.7.0) is registered with its injected
  link-click script off, and no `opener:*` permission is granted. `link_open`
  parses the URL with the `url` crate and accepts only absolute `https:`,
  `http:` and `mailto:` URLs without user info, control characters or
  whitespace, at most 2048 characters as typed and after normalization. The
  normalized URL goes to the plugin's Rust API. Anything else returns
  `LINK_REJECTED`; a failed launch returns `LINK_OPEN_FAILED`. Why: the
  plugin's scopes are glob matches on the raw string, while one parser-based
  rule in Rust is exact and testable, and a compromised webview cannot reach
  `open_path` or other schemes.
- `src/navigation.ts`, installed first in `boot.ts`, cancels every `click`,
  `auxclick`, Enter `keydown` and `contextmenu` on `a[href]`/`area[href]` in
  the capture phase. Allowed links open an HTML confirm dialog showing the
  full URL as text (Cancel focused); only after confirmation is `link_open`
  called with that string. Other schemes are ignored. `window.open` is replaced
  by a non-writable function returning null. Supported UTF-8 document drops are
  consumed by the workspace importer and image drops by the editor; anything
  no in-page target accepts is refused, so a drop never navigates the WebView.
- **Rust is the backstop.** The main window has `"create": false` and is built
  in setup with `WebviewWindowBuilder::from_config`, `on_navigation` and an
  `on_new_window` handler that always denies. Allowed: exactly the origin wry
  serves on this platform (`tauri://localhost` on macOS and Linux;
  `http://tauri.localhost` on Windows, `https://` only with `useHttpsScheme`)
  with no port or user info, plus the configured `devUrl` origin in debug
  builds only. The other `tauri.localhost` origins would reach whatever
  listens on loopback. Notebook state is managed before the window opens, so
  the first `config_get` cannot race it.
- `mailto:` links may carry only `to`, `cc`, `bcc`, `subject`, `body` and
  `in-reply-to` (decoded, any case): some mail clients honour `attach=` and
  would attach a local file to the draft.

## Keychain, config and outbox

- (Before workspaces; now only the migration reads these entries.) The
  credential JSON is stored as UTF-8 bytes (`set_secret`/`get_secret`) and
  wiped from memory after use. Windows Credential Manager allows 2560 bytes per
  item and `set_password` stores UTF-16, which limits a session token to about
  1158 characters (about 2438 as UTF-8). macOS and Secret Service items were
  already UTF-8. A Windows item written by an earlier build fails to parse and
  returns `NO_CREDENTIALS` ("Enter them again"); setup then overwrites it.
- keyring errors map to `NO_CREDENTIALS`, `KEYCHAIN_TOO_LONG`,
  `KEYCHAIN_UNAVAILABLE` (per-OS message; on Linux it names GNOME Keyring or
  KWallet) and a catch-all `KEYCHAIN`. If the config says no credentials are
  stored, Rust returns `NO_CREDENTIALS` without touching the keychain, and
  credentials are checked before the phrase. On unlock the frontend sends
  `NO_CREDENTIALS` and `KEYCHAIN_UNAVAILABLE` back to setup with the message
  and the non-secret fields prefilled; other failures show the backend's safe
  message or a neutral fallback, never a guessed "wrong phrase".
- keyring's `crypto-rust` feature encrypts the Secret Service session on the
  D-Bus. The `.deb` and `.rpm` recommend `gnome-keyring`.
- The outbox lives in `app_local_data_dir/outbox` (`%LOCALAPPDATA%` on
  Windows, `~/.local/share/<id>` on Linux, unchanged on macOS), so a roaming
  profile cannot replay stale ciphertext on another PC. On Unix the config and
  outbox folders are 0700 and their files 0600, also for leftover temp files.
- **One outbox folder per vault.** `outbox/<24 hex>` is SHA-256 over endpoint,
  bucket and normalized prefix (each followed by a zero byte), so edits queued
  for one vault are never PUT into another bucket or prefix after the
  connection settings change, and a prefix-scoped IAM policy no longer makes
  every unlock fail on another vault's leftovers. Replay reads only that
  folder and skips keys outside the vault's prefix. Flat `outbox/*.pending`
  files of earlier builds move into the current vault's folder only when the
  key is under its prefix and both the name and the body decrypt with the
  unlocked phrase (an older copy of an already queued object is dropped, a
  newer one replaces it, as a new save would). Anything else is left
  untouched; Rust logs only the count.
- Windows credentials still roam with roaming profiles: keyring 3.6.3
  hard-codes `CRED_PERSIST_ENTERPRISE`. The README says so.

## Windows build and WebView settings

- Release builds use the Windows GUI subsystem; debug builds keep the console.
- On MSVC targets, `build.rs` drops tauri-build's own manifest and has the
  linker embed `windows-app-manifest.xml` (a verbatim copy of tauri-build
  2.7.1's Common-Controls v6 manifest) into every artifact. tauri-build embeds
  it into bins only, so the lib test harness would load comctl32 v5 and fail
  with `STATUS_ENTRYPOINT_NOT_FOUND`.
- The WiX upgrade code is pinned to `08062c0b-9240-5662-a76f-d07edbb452d3`,
  the value Tauri already derives from the product name, so existing MSIs
  still upgrade and a later rename does too.
- `generalAutofillEnabled: false`: WebView2 autofill may ignore
  `autocomplete="off"` and would keep typed values in the WebView2 profile.
  Every input also has `autocomplete="off"` and `spellcheck="false"`.

## Network

- reqwest's `system-proxy` feature is on: proxy environment variables apply on
  every OS, plus the system proxy settings on macOS and Windows.
- TLS uses rustls with the bundled webpki-roots on every OS. The OS and
  enterprise trust stores are deliberately not trusted, so TLS-inspecting
  proxies are unsupported. TLS failures are not yet reported distinctly; they
  surface as `UNREACHABLE` ("S3 could not be reached.").
- **One S3 client per unlocked session.** It is built at unlock, kept in the
  session (refresh reuses it), rebuilt when credentials change while
  unlocked, and dropped on lock, reload and connection change. Its pool keeps
  connections alive (90 s idle, 8 per host, TCP keepalive 30 s), so after
  unlock a command opens no new connection; before, every command built a
  client and paid a TCP and TLS handshake (at 40 ms RTT a document open took
  143 ms, now 51 ms).
- Each attempt has a deadline: 5 s to connect, 15 s to the response headers
  plus 1 s per MiB sent, and 15 s plus 1 s per MiB to read the body. Each
  call is tried twice (busy 429/5xx or network failures); further retries are
  the frontend's backoff. A network that silently drops traffic fails a call
  in about 31 s instead of 158 s. HTTP/2 is off (S3 speaks HTTP/1.1).

## Editor line endings and keyboard

- Every Monaco model is set to LF after it is created and after its text is
  replaced. On Windows Monaco would otherwise default new documents to CRLF and
  write CRLF to S3. Documents that contain CRLF are normalized when opened and
  saved as LF on the next edit.
- Backspace and Delete move the selected item to Trash only outside text
  fields, the editor and modals.
- Modals settle their promise on Escape, the close button and an outside click.

## npm registry and DOMPurify

- A project `.npmrc` pins `registry=https://registry.npmjs.org/`, and every
  `resolved` URL in `package-lock.json` points there, so installs and CI never
  depend on a private mirror.
- `"overrides": { "dompurify": "3.4.16" }` lifts monaco-editor 0.57.0's exact
  pin past GHSA-p98j-92pf-mc4p, so `npm audit --omit=dev` passes without
  lowering the audit level. Monaco still ships and uses its own vendored
  DOMPurify 3.4.15. With hover, suggestions and parameter hints off, it only
  renders the editor's own constant messages, never document text. Remove the
  override once Monaco depends on 3.4.16 or later.

## Supply-chain policy (`src-tauri/deny.toml`, cargo-deny 0.20.2)

- `[graph] targets` lists the four shipping triples, so macOS-, Windows- and
  Linux-only crates are checked from any host. **Known gap:** cargo-deny drops
  keyring's macOS backend (security-framework 3.x, security-framework-sys)
  from its graph, so bans, licenses and advisories never see it. `cargo audit
  --file src-tauri/Cargo.lock` covers its advisories and stays a required CI
  step.
- **Advisories:** vulnerabilities always fail; `yanked = "deny"`;
  `unmaintained` and `unsound` are `"all"`, so transitive crates are gated too.
  Each exception is an `ignore` entry with a reason:
  - RUSTSEC-2024-0370, proc-macro-error 1.0.4: a build-time proc macro from
    gtk-rs 0.18 glib-macros/gtk3-macros via Tauri on Linux, with no
    replacement until Tauri leaves gtk3.
  - RUSTSEC-2024-0429, glib 0.18 `VariantStrIter`: Linux-only, fixed only in
    glib >= 0.20, which Tauri 2 cannot use; nothing calls
    `Variant::array_iter_str`. Remove both when Tauri moves to gtk4.
- **Licenses:** permissive only: 0BSD, Apache-2.0, Apache-2.0 WITH
  LLVM-exception, BSD-2-Clause, BSD-3-Clause, BSL-1.0, CC0-1.0,
  CDLA-Permissive-2.0 (webpki-roots data), ISC, MIT, MIT-0, Unicode-3.0,
  Unicode-DFS-2016, Zlib. Some are unused today and allowed so that a new
  permissive dependency needs no policy change. Zlib is required only by
  foldhash; the other crates offer it only as an OR alternative. MPL-2.0
  (file-level copyleft) is allowed only through per-crate exceptions for the
  unmodified transitive crates cssparser, cssparser-macros, dtoa-short,
  selectors (Tauri's HTML parsing) and option-ext (via dirs). ring declares
  `Apache-2.0 AND ISC` itself, so no `clarify` entry is needed.
- **Bans:** openssl, openssl-sys and native-tls (rustls only, spec section 2;
  this also enforces keyring's `crypto-rust` over `crypto-openssl` and keeps
  the Linux packages free of a libssl dependency). Wildcard requirements are
  denied. Duplicate versions are allowed: they come from Tauri, gtk-rs and
  RustCrypto splits we cannot unify.
- **Sources:** the crates.io index only.

## CI and release workflows

- **CI** runs on pushes to `main`, pull requests and manual dispatch with a
  read-only token. The test job runs fmt, clippy `-D warnings` and
  `cargo test` with `--locked` on Ubuntu 22.04, macOS and Windows. The audit
  job runs `npm audit --omit=dev`, `cargo audit` and `cargo deny --locked
  check` (`npm run audit` runs the first two locally).
- The end-to-end jobs (Linux, Windows) test the **release** binary, built with
  `npm run tauri -- build --no-bundle -- --locked`, so release-only code
  (core-dump hardening, `panic = "abort"`, LTO, strip) runs under test. Linux
  runs under `dbus-run-session -- xvfb-run -a`, so no app-launched dbus-daemon
  outlives the run. Windows gets an Edge WebDriver matching WebView2 from
  `msedgedriver-tool`, pinned to a commit, as Tauri's WebDriver guide
  recommends. macOS has no tauri-driver backend and uses the manual checklist.
- **Release:** tauri-action only builds. A final `publish` job, the only job
  with `contents: write`, creates the draft release "Notebook v<version>"
  with `gh` and attaches the installers, so no write token sits in
  the environment of npm and Cargo build scripts, and parallel jobs cannot
  create duplicate drafts. It refuses to modify an already published release.
- Release builds use no dependency caches and pass `--locked` to cargo through
  tauri-cli's trailing arguments (`-- --locked`; tauri-cli 2.12 adds them to
  both per-architecture builds of a universal macOS build). Third-party actions
  in the build job, which can see the Apple secrets, are pinned to commit SHAs.
- The version job checks the tag against every field `set-version.mjs` writes
  and applies the same rule to tag and manual runs. A `-N` version becomes a
  GitHub prerelease. Manual runs never create a release, even from a tag.
- macOS signing secrets are exported only when non-empty, in all-or-none
  groups; a partial group fails the build. `APPLE_SIGNING_IDENTITY` must
  accompany the certificate because `tauri.conf.json` sets
  `signingIdentity: "-"`. `TAURI_BUNDLER_DMG_IGNORE_CI=false` keeps tauri's CI
  behavior of skipping the Finder AppleScript (no custom DMG layout).
- Asset names replace spaces with dots, as GitHub would, and a
  `SHA256SUMS.txt` matching those names is attached. The `rpm` apt package is
  not installed anywhere: tauri-bundler builds `.rpm` files in-process.
- `-N` pre-releases have a known cost: apt and dnf sort `0.2.0-1` after
  `0.2.0`, so moving from a pre-release package to the final release is a
  downgrade on Linux. The README documents the workaround. MSI and AppImage are
  unaffected. Whether to keep the `-N` scheme is an owner decision.

## End-to-end smoke test (`npm run test:e2e`)

- `tests/e2e/smoke.test.mjs` uses `node:test` and one dev dependency,
  `selenium-webdriver` pinned to 4.49.0 (the client Tauri's WebDriver guide
  uses; dev-only, audited by a plain `npm audit`). It connects to the local
  `tauri-driver` with `usingServer(...)`, so Selenium Manager never downloads a
  driver. The script is `node --test "tests/e2e/*.test.mjs"`: Node 22 treats a
  folder argument as a module path, and the quoted glob also works in cmd.exe.
- `NOTEBOOK_E2E_APP` overrides the binary (default
  `src-tauri/target/release/notebook-vault` on Linux, `notebook.exe` on
  Windows).
  `TAURI_APP_PATH` is not used, because tauri-cli reads it as the `src-tauri`
  directory.
- The app runs with a temporary `HOME` and `XDG_*` folders, so on Linux it
  never touches the developer's profile. On Windows only the WebView2 profile
  can be redirected, so the test refuses to run if a real
  `%APPDATA%\com.securemd.vault\config.json` exists.
- tauri-driver runs in its own process group (a job object on Windows), which
  is killed in `after`, on exit and on SIGINT/SIGTERM. Each test has a 30 s
  timeout.
- Checked: the setup heading is actually displayed (WebDriver `isDisplayed`,
  not `innerText`); the page origin is the embedded frontend; `config_get`
  answers over IPC; the CSP blocks an injected inline script and allows the
  Monaco worker; no `undefined`/`[object Object]` and no web storage; a link
  click shows the confirm dialog with the full URL and does not navigate;
  `window.open` creates no window. The last test bypasses the frontend guard
  (a detached link's `click()`, a `target="_blank"` link and a scripted
  `location.href`) against a local probe server, and asserts that the WebView
  stays on the app origin, opens no window and sends the probe no request, so
  the Rust `on_navigation`/`on_new_window` guard itself is under test.
  Removing `on_navigation` fails that test; a link handler that navigates
  instead of confirming fails the link test.

## Version helper (`scripts/set-version.mjs`)

- `npm run version:set -- <version>` writes one version to `package.json`,
  `package-lock.json` (top level and `packages[""]`), `tauri.conf.json`,
  `Cargo.toml` (`[package]` only) and `Cargo.lock` (only the app's entry).
- Accepted: `MAJOR.MINOR.PATCH` or `MAJOR.MINOR.PATCH-N` with numeric `N`, no
  leading zeros, major and minor at most 255, patch and `N` at most 65535.
  These are the Windows Installer limits, and Tauri's MSI bundler rejects
  non-numeric pre-releases. Build metadata (`+...`) and a leading `v` are
  rejected so tags stay unambiguous; the tag adds the `v`.
- JSON is rewritten as 2-space JSON with a trailing newline, keeping CRLF if
  present; a file not already in that format is refused rather than
  reformatted. TOML and lock files are edited by targeted replacement, which
  must match exactly once.
- Every file is validated, and write access checked, before anything is
  written. Each file is written to a temporary sibling (original mode kept) and
  renamed into place; if a rename fails, already replaced files are restored
  and any file that could not be restored is named. Unchanged files are not
  rewritten. No dependencies; `--root <dir>` exists for testing.

## README scope

- Install commands use shell globs because release assets use dots for spaces
  while workflow artifacts keep spaced names under `release/bundle/<format>/`.
- The README carries the noncurrent-version retention suggestion (30–90 days),
  the "What the app cannot protect" list (spec section 11, including Windows
  Error Reporting and unpadded object sizes), the manual release checklist from
  spec section 16, and the user-visible behavior above: preview rules and link
  confirmation, the per-OS credential stores (Windows roaming, Linux Secret
  Service with GNOME Keyring recommended and KWallet needing its Secret Service
  interface), proxy support and the bundled TLS roots.

## Renamed to Notebook (owner decision, 2026-10-01)

- The display and product name is **Notebook** (window title, `productName`,
  UI, docs, release title "Notebook v<version>"). Crate and binary are
  `notebook`; the library is `notebook_app` so the crate root is not confused
  with the `notebook` command module.
- Unchanged on purpose, because existing data depends on them: the bundle
  identifier `com.securemd.vault` (config, data and WebView folders, so
  settings carry over), the keychain service names, config and outbox file
  names, the `secure-md-vault::` hash tags that name pending outbox files, the
  Trash namespace, the Monaco URI schemes, and the pinned WiX `upgradeCode`
  (an MSI of the old name is upgraded in place). Notebook's own identifier
  `io.github.dengezar.notebook` is not reused.
- Linux: `productName` is kebab-cased into the deb and rpm package name, and
  neither bundler has a package-name option. Plain "Notebook" would build the
  package `notebook` with `/usr/bin/notebook` and `notebook.png` icons, the
  same package name and files as the original app's cargo-deb and
  cargo-generate-rpm packages, so installing one would replace or break the
  other. `src-tauri/tauri.linux.conf.json` therefore sets `productName`
  "Notebook Vault" and `mainBinaryName` `notebook-vault` (package, command,
  icons and file names `notebook-vault` / "Notebook Vault"), and
  `src-tauri/linux/main.desktop`, Tauri's default template with a fixed
  `Name=Notebook`, keeps the launcher name. `tauri build` renames the Linux
  binary, so the Linux e2e default is `target/release/notebook-vault`.
- Windows: the original app creates the Start menu shortcut
  `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Notebook.lnk`, the
  exact path the per-user NSIS installer would overwrite (and its uninstaller
  would then delete). NSIS `startMenuFolder` "Notebook Vault" puts ours in a
  folder instead. The install folders differ
  (`%LOCALAPPDATA%\Notebook` vs `%LOCALAPPDATA%\Programs\Notebook`), and only
  the original app puts `notebook.exe` on `PATH`.
- macOS: the DMG installs `/Applications/Notebook.app`; the original app
  installs `~/Applications/Notebook.app` with a different bundle identifier,
  so both coexist but Launchpad and Spotlight show two "Notebook" apps. An
  older `/Applications/Secure Markdown Vault.app` has the same identifier and
  should be deleted by hand.

## Trash is Notebook's `_deleted` bin (owner decision, 2026-10-01)

Supersedes the spec's Trash design (`.origin` tandem files) and this app's
earlier `.secure-vault-trash/<UUID>/<original path>` layout. Items deleted in
Notebook never showed up, because Notebook keeps its own bin.

- Layout, from Notebook's `src/app/deleted_items.rs`: the item moves to
  `_deleted/items/<id>/item/<name>`; its original parent is recorded as the
  folder `_deleted/items/<id>/parent/<original parent>`. Before the move the
  app writes, in Notebook's order, the `.notebook_dir` markers for
  `_deleted/items` (only when absent), `<id>/item` and the parent path. The id
  is `<Unix ms>-<name>` with every non-ASCII-alphanumeric character turned
  into `-` and the ends trimmed (`deleted-item` if nothing is left), then
  `-2`, `-3`, ... while the container exists. Segments are encrypted with the
  Notebook codec, so keys stay opaque.
- Listing rebuilds Notebook's S3 tree from the object paths (markers create
  folders but no nodes; folders before files, by lowercase name) and applies
  its catalog rules: the first child of `item/` is the item, the longest
  folder path under `parent/` is the original location, the count is every
  node below a folder, the time is the id's leading number, and entries sort
  newest first, then by name. `src-tauri/src/deleted_items.rs` holds this
  logic.
- Restore matches Notebook: the original path, with the parent folder's
  marker created when it is missing; an occupied path is refused
  (`RESTORE_CONFLICT`), never overwritten or renamed, and the UI offers
  Restore to… (folder and name). It also refuses when a document now has the
  name of an original ancestor folder, where Notebook would hide that
  document behind a new folder. After the move the whole container is
  deleted, like Notebook.
- Delete permanently and Empty Trash delete only the objects of listed
  entries; an incomplete container that Notebook does not list is left
  alone, and nothing is emptied automatically.
- `_deleted`, `_delete` and `.secure-vault-trash` are reserved names, as
  Notebook reserves the first two. At the top level they are hidden from the
  tree, quick open, search and counts (Notebook hides only `_deleted`).
- Legacy `.secure-vault-trash` entries stay listed (deletion time unknown),
  restorable and purgeable; new deletions never use the namespace.
- `scripts/notebook-compat.sh` checks all of this against Notebook's own code
  on a throwaway MinIO; see README, Testing.

## Review fixes: saves, ids, outbox, close (2026-10-01)

- **An edit is saved only into the document it was typed in.** The
  wrong-document save (the debounced save used whatever was selected when the
  timer fired; a failed or slow `doc_open` left the selection on another
  document) is fixed in `src/documents.ts`: the pending edit carries its
  document id, saves run one after another, the previous document is saved
  before the next is requested, only the newest open may switch the editor,
  and a failed open keeps the open document and says so. `tests/unit/` runs
  the review's three reproductions with Node's test runner (CI runs it; five
  mutations of the fix each fail a test).
- **Ids follow paths, so rename and move return the new id.** `node_rename`
  now returns `CreatedNode` like `node_move`. The frontend saves before a
  rename, move or trash (and refuses when that save failed and the item holds
  the open document), holds debounced saves while it runs, then looks up the
  open document, selection and expanded folders by their new paths. A renamed
  or moved open document stays in the editor with its undo history; a trashed
  one is replaced by the first document.
- **Closing saves first.** While unlocked, `CloseRequested` is prevented and
  the page saves and calls `close_after_flush`, which closes the window only
  while such a close is pending (5 s fallback; see "Save model"). On macOS
  the default menu's Quit (which terminates without a close event) is
  replaced by an item that closes the window. The webview no longer has the
  window close, minimize and toggle-maximize permissions, and the unused
  `listenToVaultEvents` is gone. Rust emits one event, `auto-lock` (the only
  use of `core:event:allow-listen`).
- **Lock, a workspace switch and moving the open workspace clear the page**
  (see Product behavior). Rust checks idleness every 10 s
  (`check_idle_session`; `activity_ping` records activity): it emits
  `auto-lock` so the page saves and locks, and a minute later ends the
  session itself if the page did not. The page has its own timer too. Neither
  idle lock applies while the active workspace's phrase is remembered (see
  "Workspaces and remembered phrase").
- Images dropped onto the editor use the paste path (PNG, JPEG, GIF, WebP,
  8 MiB, inline `data:`), inserted at the drop point. Markdown, text and HTML
  files dropped into the workspace are decoded as strict UTF-8, limited to
  16 MiB, encrypted in the same conditional create as their content, and
  imported into the targeted/current folder. Other drops remain refused.
- Access key IDs must be printable ASCII and are checked before anything is
  stored; the masked ID is cut by characters. A pasted zero-width space
  crashed `credentials_set` before.
- A saved bucket without stored credentials opens setup with the
  "No S3 credentials" message instead of asking for the phrase first.

## Save model: local outbox first, S3 rarely (2026-10-02)

The user asked for fewer API calls and found autosave bad. Every edit used
to be uploaded 700 ms after a pause: 226 uploads (4.5 MB) and 6,626 status
bar writes in 30 minutes of writing, a PUT for Cmd+S without a change, and a
save that took 158 s on a dead network while the close fallback destroyed the
window at 40 s, before the outbox was written: the edit was lost.

- **Durable vs synced.** `doc_stage(id, text)` encrypts the text and writes it
  to the vault's outbox file (fsynced, then renamed; no request) and returns
  `Clean` when the text equals the version it is based on (the entry is
  dropped). `doc_commit(id)` uploads the staged ciphertext with `If-Match` on
  the base version's ETag and sends nothing when nothing is staged.
  `doc_open` returns a staged edit (`dirty: true`) without a request.
- **When.** The frontend (`src/documents.ts`) stages 1 s after typing pauses
  and commits on Cmd/Ctrl+S, document switch (in the background, after the
  next document is shown), window blur or hidden, close, lock, 30 s idle and
  120 s of continuous editing. Cmd/Ctrl+S on a document without unsynced
  edits sends nothing. One timer serves all of it; a keystroke never creates
  or clears a timer.
- **Journal state** (Rust, per S3 key, cleared on lock): the staged
  ciphertext and a generation, and the base version (ETag and text SHA-256,
  set by open and by each upload). The base, not the latest listing, is the
  `If-Match`, so a Refresh cannot turn another device's change into a silent
  overwrite. Uploads of one key are serialised; a stage never waits for an
  upload. An edit staged during an upload stays queued and its outbox entry
  is re-based on the new ETag (otherwise its replay would hit 412 and leave a
  spurious conflict copy). A conflict, or an object deleted or moved on
  another device (also during replay, which used to fail every unlock with
  `NOT_FOUND`), keeps the edit as a conflict copy.
- **Close and lock** write the outbox (milliseconds), give S3 at most 3 s,
  then close or `vault_lock` regardless; the next unlock replays the outbox.
  Only a failed outbox write keeps the window open or pauses the lock, with
  the user's existing messages. Measured with the S3 blackholed: outbox
  written after 7 ms, window closed after 3.0 s, the next unlock replayed the
  edit.
- **Status dot**: an 8 px dot with the state in its tooltip, written only on
  transitions (two per typing burst): clean (muted), unsynced (accent),
  uploading for over 1 s (pulse), offline (amber, "Offline — saved on this
  device"), failed (red, "Save failed"). A click uploads now or retries.
  Offline uploads back off 15, 30, 60, 120, 300 s, retry at once on focus and
  `online`, and idle uploads wait meanwhile.
- **Measured** (`tests/unit/save-model.test.mjs`, same traces as the audit):
  uploads per 30 minutes 225.9 → 15.1, per 5 minutes 38.8 → 3.1, status
  updates 6,405 → 30. `src-tauri/tests/s3_budget.rs` checks with an in-process
  fake S3: one connection for a whole session, 0 requests to stage or to
  commit a clean document, the close-during-hang replay, the re-base rule,
  conflicts and offline retries.
- Other devices see edits 30–120 s later than before; Cmd/Ctrl+S syncs at
  once. `doc_update` is gone; there is no combined stage-and-upload call, so
  an upload hanging on S3 can never hold up the next outbox write.

## Fewer UI changes (2026-10-02)

The user asked for the fewest UI changes and for a word count that does not
update by itself. Measured with the Playwright UI harness (a mocked backend,
a 5,000-line Markdown document, 36 typed keys per run):

- **Word count on demand.** The status bar shows a **Word count** button
  instead of a live count. A click computes words, characters (code points),
  lines and the selected words once and shows them in a small panel above the
  button; HTML documents count the page text (DOMParser, no tags, scripts or
  styles; block elements separate words). The panel never updates: an edit, a
  selection change, a document switch, Esc, a pointerdown elsewhere, window
  blur and lock close it, so it never shows stale numbers. The button keeps
  the editor's focus (mousedown does not move it). Before, every keystroke
  counted the whole text and rewrote the label (36 status-bar records per 36
  keys, plus one full-text copy per key).
- **Status bar writes only on change.** The save dot was already written
  only on state transitions; the language, title and path labels and the
  outline toggle's attributes are now written only when their value differs,
  and `.statusbar` has `contain: layout paint`. Typing: 39 status-bar records
  → 3 (the clean → unsynced transition) per 36 keys.
- **Render keys.** A `textVersion` counter is bumped by every edit and model
  switch. The preview renders only when it is shown (Split or Preview) and
  `(document, textVersion, language)` changed; the outline only while it is
  shown and `(document, textVersion)` changed, or after a fold. In Edit mode
  with the outline closed a keystroke schedules nothing, and the debounce
  uses one timer that is re-armed only when it fires early (a keystroke never
  creates or clears a timer). Toggling the outline never re-renders the
  preview; Edit → Split with unchanged text renders nothing, because Edit mode
  keeps the hidden preview DOM.
- **Markdown blocks are patched.** Within one document, only the changed run
  of top-level preview blocks is replaced (`src/dom-patch.ts`, `isEqualNode`
  on the common prefix and suffix); another document replaces everything and
  starts at the top. Typing in Split mode: 6,998 preview nodes replaced per
  pause → 2. After a document switch the first render waits for the editor's
  paint (rAF, then a task): the switch to the big document's long task went
  103 → 85 ms.
- **Large documents.** Over 512 KB of text the preview pauses: "Preview paused
  for large documents." with a **Render** button that renders the current
  text once; typing never re-renders it, and Edit mode does not keep its
  hidden copy. The 16 MiB hard cap stays. With the HTML preview the note sits
  above the page frame.
- **Mode and outline toggles** send no IPC: 376 KB `preview_render` → 0 and
  6,998–7,004 preview nodes → 0 for Edit, Split, Preview and outline open or
  close. Building the outline itself takes 4–8 ms for 501 headings. The long
  tasks that remain on these toggles (about 100 ms for Split and outline
  open, about 320 ms for Preview) are Monaco re-wrapping the 5,000 lines at
  the new width: 0 in Preview mode, where only the preview pane reflows. That
  is plan item C7 (simple wrapping above 32 KB, no layout at width 0).
- **Not done: `content-visibility: auto` on preview blocks.** Measured: no
  layout gain on outline toggles (16 vs 18 ms over 6 toggles), and each list
  grew by about 2 px, because the containment it implies stops the first and
  last items' margins from collapsing through the list.
- **Context menu.** The sidebar menu used to close on any pointerdown,
  including one on its own items, so no item ever ran with the mouse. It now
  uses `ContextMenu` from `ui/primitives.ts`: it closes on a pointerdown
  outside the menu, Esc (focus returns), and window blur; arrow keys, Home and
  End move between items. The items are unchanged (New file…, New folder on
  folders; Rename…; Move to Trash), and double-click and F2 still rename.

## Workspaces and remembered phrase (owner decision, 2026-10-03)

Supersedes the spec's single vault (§12: one keychain entry per vault, a
config with one connection) and its phrase-never-stored, always auto-locking
design (§4 key hierarchy, §14 idle lock).

- **Model.** `config.json` (version 2) holds the global preferences (theme,
  accent, auto-lock minutes), `active_workspace` and `workspaces[]`: `id`
  (random UUID, stable across renames), `name` (1–64 characters, unique
  ignoring case), bucket, region, prefix, endpoint and a masked access key ID
  for display. It never holds a secret. `secrets.json` (format of
  `src/secrets.rs`) holds, per workspace id, field `s3` (the credential JSON)
  and field `phrase`, each sealed with AES-256-GCM-SIV under a context that
  binds format version, workspace id and field. Only a random 32-byte master
  key is in the keychain (service `com.securemd.vault`, account
  `secrets-master-key`, bytes via `set_secret`). Both files are written
  through a 0600 temporary file, renamed, and the folder fsynced.
- **Commands.** `workspaces_list`, `workspace_save` (absent `id` creates; the
  first workspace becomes active; absent `credentials`/`phrase` keep what is
  stored; `remember_phrase: false` forgets the phrase), `workspace_delete`
  (refused with `WORKSPACE_UNLOCKED` for the active unlocked workspace),
  `workspace_select` (ends the session; selecting the active one is a no-op),
  and `vault_unlock(passphrase?, remember?)`. Everything is validated before
  anything is written; `secrets.json` is written before `config.json`, and a
  create whose config write fails takes its sealed values back out.
  `config_get` reports the active workspace. `config_set`, `credentials_set`
  and `vault_create` (and their permissions) were removed once the frontend
  no longer called them: `workspace_save` and `vault_unlock` cover them, and
  nothing that edits a workspace can wipe its credentials.
  (`connection_test` predates workspaces and is left as it was.)
- **Sessions.** A session belongs to the active workspace and carries the
  location it was unlocked with; S3 commands use that, not the config. Editing
  the active workspace's bucket, region, prefix or endpoint ends the session
  (region too: the client signs for it); renaming does not, and new
  credentials switch the unlocked session's client at once. An unlock whose
  workspace was switched or edited while S3 answered fails with
  `WORKSPACE_CHANGED` instead of installing a session for the wrong
  workspace; a phrase change installs its new session only if the workspace
  is still active and unlocked at the location it migrated.
- **Upload journal per session.** Two workspaces with the same phrase and
  prefix share S3 keys, so the in-memory upload journal belongs to one
  session at a time (given to it when the session is installed, taken back
  by lock, switch, unlock and idle lock). Opens, stages and uploads use it
  only while it is still their session's: an upload of workspace A that
  answers after the user switched to B and edited the same path changes
  nothing of B (no re-base, no staging into A's outbox); A's outbox file
  stays and A's next unlock settles it. Regression test:
  `a_slow_upload_of_one_workspace_never_writes_into_another`.
- **Remembered phrase.** Without `passphrase`, `vault_unlock` opens the stored
  phrase (`NO_STORED_PHRASE` when there is none or it cannot be opened). The
  phrase is stored or forgotten only after the listing proved it: a
  `WRONG_PHRASE` never changes what is stored. Absent `remember` leaves the
  stored phrase as it is. A phrase change updates a remembered phrase before
  any old-key object is deleted. A phrase is stored or forgotten only for the
  location it was proven at: a workspace moved meanwhile is
  `WORKSPACE_CHANGED`. `check_idle_session` skips the idle lock while the
  active workspace's phrase is remembered. An explicit "don't remember"
  (`remember: false`, or `remember_phrase: false` in `workspace_save`) is
  kept as `remember_declined` (not secret) and reported in the summary, so
  the unlock screen offers Remember unchecked for that workspace until the
  user checks it again; otherwise Remember starts checked.
- **Keychain safety.** A keychain read error is returned as is
  (`KEYCHAIN_UNAVAILABLE` etc.); a new master key is created only when the
  keychain has none and a value must be sealed, so a locked keychain never
  gets its key replaced. A missing key makes stored values unreadable
  (`NO_CREDENTIALS` "cannot be read", `NO_STORED_PHRASE`), never deleted. When
  the last value goes, `secrets.json` is deleted and the master key leaves
  the keychain, unless a set-aside `secrets.unreadable-*.json` is in the
  folder (its values need that key to be recovered). The master-key lock is held across every change of
  `secrets.json` (lock order: master key, then state), so a concurrent change
  cannot seal with a key that is being deleted. Keychain access sits behind a
  `Keychain` trait; tests and the S3 harness use a memory implementation, and
  under `cfg(test)` the OS adapter is routed to keyring's mock store.
- **Migration.** A config without `version` and with a bucket becomes one
  active workspace named after the bucket; it is written back at load. If the
  old config said credentials were stored, the workspace records the old
  keychain account (`legacy_keychain_user`, a hash, not a secret). On first
  use the credential is read, sealed into `secrets.json` (after `config.json`
  holds the id), and only once that file is durable is the old entry deleted
  and the marker cleared; while the marker is there, every first use of the
  credentials retries the move (also after a crash or a denied delete), and
  the old entry is deleted only while `secrets.json` holds a copy that opens;
  once it does, a keychain that refuses the old entry (a denied prompt) never
  keeps the workspace closed.
  New credentials for such a workspace delete the old entry, and keep the
  marker if the keychain refuses; deleting the workspace deletes the old
  entry first and changes nothing if the keychain refuses. An old entry that
  does not parse is left in the keychain. A `config.json`/`secrets.json` this
  build cannot parse (damaged or newer) is renamed to
  `*.unreadable-<ms>.json`; one that exists but cannot be read (permissions,
  I/O, a sharing violation) is left in place and never written during that
  run (`CONFIG_UNREADABLE`/`SECRETS_UNREADABLE`; the page says to restart).
  Outbox folders stay keyed by endpoint, bucket and prefix, so queued edits
  still replay into the right bucket. Moving a workspace to another bucket or
  prefix, or deleting it, while edits wait in an outbox folder no other
  workspace uses is `OUTBOX_PENDING` unless the request says
  `leave_pending` (the page asks first); the files stay on disk. A new
  endpoint for the same bucket and prefix moves them to its folder.
- **One process per profile.** Each process loads both files once and
  rewrites them whole, so two processes on one profile would erase each
  other's workspaces and could delete the master key the other still uses.
  `NotebookState::load` takes an OS file lock on `notebook.lock` beside
  `config.json` for the life of the process (`File::try_lock`, released by
  the OS on exit or crash). A second process reads and writes nothing:
  every workspace command, the master key and both files are refused with
  `PROFILE_IN_USE`, and the page shows "Notebook is already open". A file
  system without locks runs unguarded rather than not at all.
- **Threat model, honestly.** With a remembered phrase, whoever can run code
  as the user while they are logged in (or copy `secrets.json` plus the
  keychain item) can open the workspace without knowing the phrase: the OS
  keychain releases the master key to this app without a prompt, and nothing
  locks the workspace on idle. The phrase and credentials are protected at
  rest only as well as the user account and keychain are. This matches the
  original Notebook app. What still holds: nothing secret is in
  `config.json`, logs or IPC replies; sealed values cannot be moved between
  workspaces or fields; S3 sees only ciphertext; and a workspace without a
  remembered phrase behaves as before (phrase asked at unlock, idle lock
  applies).
- **Interface.** A picker at the top of the sidebar shows the active
  workspace; its menu lists every workspace (a check on the active one) and
  "Manage workspaces…". Switching saves like Lock (`flushForExit`, then 3 s
  of `flush_all`), calls `workspace_select`, then opens the workspace with its
  remembered phrase ("Opening <name>…") or shows its unlock screen. The
  manager (from the picker and Settings) adds, edits, switches and deletes;
  the old "Connection settings" path, which locked and showed the setup
  screen, is now "Edit workspace" and never wipes anything. Launch follows the
  same routing (`launchStep` in `src/workspaces.ts`): no workspace → first-run
  screen; missing credentials → that workspace's connect screen; remembered
  phrase → open; otherwise unlock. A failed open falls back to the unlock
  screen (or the connect screen for `NO_CREDENTIALS`/`KEYCHAIN_UNAVAILABLE`)
  with a safe message. The frontend idle timer is skipped like the Rust one
  while the active phrase is remembered. Switch, lock, move and delete make
  the editor read-only while the open document is saved and stage anything
  typed before the session ends; an unlock that answers after a switch, lock
  or delete started renders nothing (a generation counter), and Switch/Edit
  are disabled while one runs. Form problems show under the field they name.
  Only the top dialog takes input (the page and lower dialogs are `inert`),
  and focus returns to what opened a dialog when it closes. Settings → Manage
  workspaces and Change phrase open on top of Settings, so unsaved settings
  stay. Refinements, with reasons: the unlock screen's Remember box is
  checked unless the user last unchecked it for that workspace (owner's
  default, and an explicit "no" sticks); a phrase typed in Edit workspace is stored
  without an S3 check, since there is no session to test it with (a wrong one
  only sends the next launch to the unlock screen); missing credentials get a
  full connect screen, because unlock cannot succeed without them; adding a
  workspace does not switch to it; editing the open workspace's location
  asks first and reopens it, and deleting the open workspace locks it first
  (the backend refuses to delete it unlocked). Browser mode uses
  `MemoryWorkspaces`, an in-memory stand-in with the commands' rules.

## One header row, HTML preview scrollbar, soft wrap (2026-10-03)

The user asked for a visible scrollbar in the HTML preview, one title, VS
Code's soft-wrap shortcut, no brand block, and one clean row of buttons.

- **One header row.** The title bar (brand block "Notebook · Encrypted S3
  workspace · AES-256-GCM-SIV", Refresh, Settings, Lock) is gone, with its
  CSS and the unused title-bar and tab-strip tokens. The content header holds
  the breadcrumb and one group of 28 px icon buttons (`.header-action`):
  Outline, Edit / Split / Preview (a group of the same icon buttons,
  `aria-pressed`; the pressed one has the open outline toggle's tint, so the
  earlier framed pill and its `--segmented-*` tokens are gone), a divider,
  Refresh, Settings, Lock; each has a tooltip and
  an `aria-label` and is a Tab stop. The sidebar header (workspace picker, New
  file, New folder, all 28 px) is 40 px tall with the same bottom divider, so
  both headers read as one line. At 820×560 nothing overlaps or wraps
  (breadcrumb 345 px, buttons 219 px, page width = viewport).
- **One title.** "Untitled.html" over "/Untitled.html" became one breadcrumb,
  "Folder / Sub / name": folders muted, name medium weight, only the name at
  the vault root, the vault path as tooltip. The folders sit in a
  right-to-left box with their text isolated left-to-right, so they are cut
  from the left with an ellipsis. They are `flex: 1 1 0` with
  `max-width: max-content`: they start at zero and grow only into the room
  the name leaves, so the name is cut only when it alone no longer fits. (A
  first `flex-shrink: 1000` still took a fraction of a pixel from the name,
  enough for an ellipsis on "notes.html" while 175 px of folders showed;
  now the name box equals its text width in Chromium and WKWebView.)
- **HTML preview scrollbar: root cause.** WebKit gives a frame whose page has
  no `::-webkit-scrollbar` styles a custom scrollbar styled from the owning
  `<iframe>` element. theme.css's global scrollbar rules match the iframe, so
  the frame got the app theme's thumb, `rgba(255, 255, 255, 0.1)` in dark
  mode, on the always-white page: invisible. Proof in a WKWebView harness
  (tauri:// scheme with the app CSP, real AppKit wheel and key events, window
  pixels from the window server): the page did scroll (5 wheel ticks 200 px,
  Page Down and Space 640 px each, Down arrow 40 px) and had a 12 px gutter,
  but the pixel at the thumb was 255 (white on white) in dark mode and 234 in
  light mode. Putting a style into the page alone was not enough: WebKit ties
  a frame's styled scrollbar to the element that styled it, and once a paint
  replaced the page's `<html>` the scrollbar had no parts (gutter 0, nothing
  drawn).
- **Fix.** Every paint puts one `<style>` built from the theme.css tokens
  (`--scrollbar-size`, `-thumb-inset`, `-thumb-min-length`, `-thumb-radius`,
  `-thumb-alpha`, `-active-thumb-alpha`, `--html-preview-scrollbar-ink`,
  `-ink-dark-page`) first in the page's `<head>`, so the page's own scrollbar
  styles still win. The track takes the page's background (WebKit leaves it
  out from under a frame's scrollbar) and the thumb is dark on a light page
  and light on a dark one. A whole-page swap keeps the frame's `<html>`,
  `<head>` and `<body>` and copies the page's attributes onto them. After:
  thumb pixel 234 on the white page in dark and light mode, also after a
  `<head>` edit, a document switch and a theme switch; on a `#15171c` page
  the track is the page colour and the thumb 59,60,64. Chromium (browser
  mode): 12 px gutter, the style first in `<head>`, the wheel scrolls.
- **Soft wrap.** Option+Z on macOS, Alt+Z elsewhere (`altKey` and
  `keyCode` 90, the key printed Z in the active layout, as VS Code resolves
  it; Cmd/Ctrl+Z stays Undo), or **Wrap** in the status bar
  (`aria-pressed`, struck through when off). One setting for every document
  until the app quits, on by default. The key is caught on `window` in the
  capture phase, ahead of Monaco, so the editor never types "Ω"; text fields
  and dialogs keep it (real AppKit events: "Ω" typed in Quick open and in the
  New file dialog, wrap unchanged; toggled from the editor and a sidebar row).
  `event.code` was rejected: it is the physical US position, so on QWERTZ
  (German, Swiss, Czech) Option+Z typed "Ω" and Option+Y toggled wrap.
  With `keyCode`, German AppKit events in WKWebView: the key printed Z
  (code `KeyY`, keyCode 90) toggles without typing, the key printed Y types
  "¥", and US Option+Z still toggles.
  Documents of 2 MB and more now follow the setting too, always with the
  "simple" strategy; advanced wrapping, which froze the app for 20 s on a
  12 MB page, is never used for them. A document that crosses 2 MB while open
  switches strategy at its next open, as before. They wrap at a fixed column
  (`wordWrapColumn`), not `bounded`: bounded wrapping depends on the viewport,
  so every layout change re-wrapped all 12 MB, twice for a pane resize
  (Monaco, then the readable-width column) and at column 1 in Preview mode,
  where the hidden editor lays out 5 px wide (230 to 261 ms in WKWebView for
  Edit→Preview, the outline toggle and a narrower pane). Now a hidden editor
  keeps its layout, and for a large document the column follows the pane
  once, 250 ms after the width last changed (about 100 ms of work); until
  then the text may run past the right edge. Measured on 12 MB documents
  (116,118 lines, and one 12 MB line), longest main-thread task: toggle 65 to
  104 ms in Chromium and 81 to 129 ms in WKWebView; open with wrap on 70 to
  173 ms (Chromium) and 136 to 164 ms (WKWebView, import included);
  Edit↔Split↔Preview, the outline toggle and pane width changes 0 to 107 ms
  in both (WKWebView at 820×560 and 1180×760, Chromium at 1280×800).
- **Outline drawer over the editor.** Below 850 px the outline is a drawer
  (z-index 10) over the editor, and Monaco's horizontal scrollbar (z-index 11,
  shown with wrap off) was drawn over it and took its clicks. `.editor-host`
  is now `isolation: isolate`, so Monaco's z-indexes stay inside the editor.
- **e2e.** The HTML preview test paints its frame the way `swapPage()` and
  the scrollbar style do (frame keeps `<html>`, `<head>`, `<body>`; style
  first in `<head>`) and asserts the scrollbar takes room (WebKitGTK: pass).

## Resizable panes, Quick open clear, outline close (2026-10-03)

- **Quick open** has a clear button (×, "Clear search", an icon button like
  the header's) inside the field, shown only while it holds text. A click
  empties it, shows the whole tree and keeps the focus (and caret) in the
  field; Esc clears first, a second Esc leaves the field.
- **Outline close** (×) sits after Expand / Collapse and does what the
  header's outline button does (its `aria-expanded` follows); the focus goes
  to that button, which opens the outline again.
- **Resizable panes.** Handles (`role="separator"`, vertical, focusable,
  `aria-valuenow/min/max/text`) on the sidebar's edge, the outline's edge
  facing the editor and the editor / preview edge in Split. Pointer drag with
  pointer capture, `col-resize`; double-click resets that pane; Left / Right
  move 16 px (Shift 64 px), Home / End go to the limits. Ranges: sidebar 180
  to 480 px, outline 180 to 420 px (its header's Expand, Collapse and × need about 170 px; below 224 px the header drops the "Outline" title: a container query on the header, since one on the panel re-checked all 2,900 rows of a 12 MB document's outline on every frame, 57 ms in WebKit), Split ratio 0.2 to 0.8 with each pane at
  least 240 px. `src/panel-layout.ts` (pure, unit-tested) fits the saved
  sizes into the window from `window.innerWidth` alone: when room runs out
  the panes keep 240 px, then the outline gives way, then the sidebar; the
  content keeps 400 px (header buttons plus breadcrumb), so 820×560 has no
  overlap. What is saved stays the user's size, and comes back in a wider
  window; a key or drag that cannot move a pane further keeps it. Narrow
  windows are compared with innerWidth, not matchMedia: WebKit answered a
  resize event with the previous size's `matches`.
- **No browser storage, one IPC per change.** `layout_set({ sidebar_width,
  outline_width, split_ratio })` (validated, written durably with the other
  preferences, no S3 request, permission `allow-layout-set`) is called once
  when a drag ends, on a double-click, or 500 ms after the last resize key
  (and before the window closes); never per pointer move. `config.json` gets
  `"layout"`; `config_get` returns it, a config without it gets the defaults
  (280, 240, 0.5) and a bad value is repaired to its default without making
  the file unreadable. Browser mode keeps the sizes in memory.
- **Stacked Split.** Below 851 px Split stacks the editor above the preview
  (unchanged), so the split handle is hidden there; a vertical one would have
  two panes of about 240 px in 560 px of height to share. The outline is a
  drawer there; its handle stays on the drawer's edge and the drawer leaves
  240 px of the editor visible. The fixed narrow sidebar (220 px) is gone:
  the user's width applies, fitted as above.
- **How widths reach the layout.** Each drag frame (rAF, one per frame
  whatever the pointer rate) writes `--sidebar-width`, `--outline-width` and
  `--split-ratio` on the style of the elements whose own rules use them
  (`.workspace`, `.editor-area`, `.outline-panel`, the handles), only when a
  value changed; nothing reads layout. They are registered with `@property`
  as not inherited. As plain (inherited) custom properties on `.workspace`
  every frame restyled the whole window: with a 12 MB document open its
  2,900-heading outline made each frame 50 to 66 ms in WebKit (18 fps) with
  spikes of 563 to 1,351 ms. Inheriting them explicitly (`inherit` on the
  containers) was rejected: WebKit did not restyle such a child when only
  the parent's value changed, so the grid lagged one change behind. A
  transparent overlay covers the window during a drag, so the HTML preview's
  iframe never takes the pointer and the cursor stays `col-resize`; showing
  it restyles one element (a class on `:root` restyled everything).
- **Narrow margins off `:root`.** The narrow-window `--file-margins` is now
  set on `.editor-host` and `.preview` (monaco.ts reads it from the editor's
  element). Set on `:root`, crossing 850 px restyled every element: 430 ms
  in WebKit with that outline open; before this change the crossing was
  cheap only because the sidebar width changed at the same time (proof: the
  old code with a constant sidebar took 450 ms; adding a 1 px sidebar change
  made it 74 ms).
- **Measured** (12 MB Markdown, 116,000 lines, wrap on, Split, outline with
  2,903 headings; WKWebView harness with real AppKit mouse events, 120 Hz
  drags over 3 s per handle): 51 to 60 fps while dragging; longest main-thread
  task 99 to 144 ms, which is the large-document re-wrap when the pointer
  rests at a limit for over 250 ms (editor at its 240 px minimum: 144 ms);
  after the drag 101 to 121 ms (the one re-wrap). At 820×560: 59 to 60 fps,
  longest 104 ms. Window resizes 1280↔1000↔820: longest 111 to 126 ms.
  Chromium (browser mode, synthetic pointer events, a hidden pane drawing
  about once a second): no task over 62 ms.
  Real AppKit drags of the split edge across the HTML page's iframe follow
  the pointer (ratio 0.5 to 0.68 mid-drag); a drag released outside the
  window ends normally.
- **Review fixes.**
  - *No sidebar jump at 850 px.* The content's least width no longer depends
    on the breakpoint: it is what Split and the outline need side by side
    (outline minimum plus two 240 px panes, or one pane without Split), also
    when Split stacks and the outline is a drawer. Before, crossing 850 px
    raised the sidebar's limit by 260 px (190 to 450 px in Split with the
    outline) and the drawer could cover 82 % of the content (72 to 81 px of
    editor left at 820×560). Now the sidebar moves at most 1 px per pixel of
    window and the drawer leaves 240 px of the editor (unit-tested from 820
    to 900 px); at 820×560 in Split with the outline the sidebar gives way to
    180 px, as it does in wide windows when room runs out.
  - *Tab order follows the screen.* The outline handle now follows the
    outline and the split handle follows the editor in the DOM (both are
    absolutely positioned, so the grid is unchanged). Placed after the
    preview, forward Tab never reached them: Monaco keeps Tab for indenting.
  - *Hit areas off the scrollbars.* Each 8 px target starts on its divider
    and reaches into the pane to its right (Monaco's left gutter, the
    preview's margin); centred, it took 3 to 4 px of the file tree's, the
    outline's and Monaco's scrollbars. The accent line stays on the divider.
  - *Every document wraps at a fixed column.* Below 2 MB the editor wrapped
    `bounded` with the advanced (DOM-measuring) strategy, so each frame of a
    drag re-wrapped the whole document whenever the editor was narrower than
    the readable width, which is always the case in Split. WKWebView, real
    drags in Split, longest tasks before: 1.9 MB 1 to 2 fps with 2.3 to 6.2 s
    freezes; 0.5 MB 3 to 6 fps, 1.07 and 1.41 s; 50 KB 19 fps. Now soft wrap
    uses `wordWrapColumn` for every document (fitReadableWidth keeps the
    column inside the pane, so `bounded` added nothing but the re-wraps);
    from 16 KB the column follows once, 250 ms after the width settles (as
    2 MB documents already did); from 64 KB the wrapping counts characters
    (`simple`), so the right edge of Markdown's proportional text is a little
    more ragged. With wrap on, `scrollBeyondLastColumn` is 0: Monaco's 4
    columns gave a line that fills the column a horizontal scrollbar once the
    margin is narrower than about 34 px. 64 KB rather than 128 KB: one
    advanced re-wrap of 123 KB took 131 to 173 ms, too close to 200 ms.
  - *Measured after the fixes* (same harness, Split, 3 handles, 400 ms rest
    at the far end): 15 KB, 73 KB, 0.2, 0.5 and 1.9 MB at 59 to 60 fps with no task
    over 50 ms during or after a drag (0.5 and 1.9 MB also with the outline,
    and window resizes 1280↔1000↔820 with no task over 50 ms); 50 to 63 KB
    (advanced, deferred) one re-wrap of 60 to 87 ms; 12 MB unchanged: 51 to
    59 fps, longest 104 to 138 ms during, 106 to 122 ms after, resizes 117
    to 124 ms.
