# Notebook — implementation decisions

This file records places where the build specification is silent, internally
inconsistent, or requires an owner decision. Security and data safety take
precedence.

## Names

`validate_name` (notebook.rs) trims a name and refuses an empty one, one over
255 bytes, `/`, `\`, NUL and control characters, `.`, `..`, `.notebook_dir`
and the Trash names. Names are not NFC-normalized; siblings are compared with
Unicode lowercase mapping. `unicode-normalization` (Rust's standard library
has no NFC) is used only for heading slugs.

## Setup and credentials

- Credentials are sealed in `secrets.json` per workspace id (see "Workspaces
  and remembered phrase"). The keychain item of builds before workspaces is
  read once, to migrate it.
- v1 officially supports AWS S3. Endpoint override exists for testing and
  compatible providers, but those providers are not certified. Non-HTTPS
  endpoints are accepted only in debug builds and only for `localhost` and
  `127.0.0.1`.

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
  - Removed scripts are counted; the status bar then shows "Scripts off (N)"
    (with a tooltip) instead of a silently blank page. The pane itself never
    carries the note (2026-10-05), and focus mode and document windows,
    which hide the status bar, show none.
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
- Rust owns the canonical plaintext, but the editor's document states
  necessarily contain ephemeral JavaScript strings. Lock writes the open
  document's edit to the outbox, gives the uploads 3 s, calls `vault_lock`
  (see "Save model"), destroys the editor with every kept document state, drops the page's decrypted names and texts (tree, sample cache,
  search, open dialogs) and re-renders the unlock screen in place. The WebView
  is not reloaded, so strings already created in the JS heap are left to
  garbage collection; a reload (F5, context menu) ends the Rust session.
- `notebook.rs` (with `notebook/` and `secrets.rs`) is the only code that
  signs S3 requests, accesses Notebook-compatible objects, and reads or writes
  the config, `secrets.json` and the OS keychain, so secrets do not cross the
  IPC boundary after setup.
- Commands available while locked are config, credential, connection, create,
  unlock, lock, activity and flush/status-related calls. All content commands
  fail closed.
- Rename, move and trash first upload the staged edits of every document they
  move, and refuse ("not uploaded yet") while S3 cannot take them, so no
  outbox entry ever points at a key that is gone.
- Quick open filters the tree in the page (`TreeModel.search`): names that
  contain the query without case, in tree order, at most 200 shown.
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
uses `ListObjectsV2`. This replaces the spec's SMDV envelope and index-only
layout (with its no-LIST request budget), which were never shipped; their
research code was removed (see "Cleanup").

## `freezePrototype` is on

`app.security.freezePrototype` is `true` (spec section 11): Tauri freezes
`Object.prototype` in every window's main frame before any other script
runs. The static-page preview frame is not frozen, and nothing runs in it
(its sandbox has no `allow-scripts`). The CodeMirror bundle and
`@tauri-apps/api` run unchanged under it. The Monaco build did not: a library
assigned `toString` on plain objects at load, which throws once the prototype
is frozen. The smoke e2e test checks `Object.isFrozen(Object.prototype)` and
that the startup-failure card from `src/boot.ts` is absent. That card replaces
a blank window if a future dependency breaks under the freeze. Alongside it:
`script-src 'self'` with no inline scripts or `eval`, `withGlobalTauri:
false`, per-command capabilities, typed IPC payloads that are never merged
into shared objects, Markdown preview HTML sanitized in Rust, the sandboxed
static-page preview and the navigation guard.

## Process hygiene

`src-tauri/src/hardening.rs` runs before the window opens: `tracing` to stderr
only (`warn` in release, `debug` in debug), a panic hook that prints only the
source location, and in release builds `RLIMIT_CORE = 0` on Unix plus
`PR_SET_DUMPABLE = 0` on Linux. `rustix` (already in the dependency graph)
provides the Linux `prctl` call without `unsafe` in this crate. Windows Error
Reporting dumps are outside the app's control and are documented in the README.

## Preview rendering

- **`preview_render(text)` replaces the spec's `render_preview(doc_id)`.** A
  render by document id would show the last staged or uploaded version, not
  what is typed. `preview_render` is a pure function of the editor text
  (16 MiB cap, blocking thread).
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
  whole tree can be folded. Selecting a heading shows it in the panes shown
  (see "Markdown navigation").
- pulldown-cmark with tables, strikethrough, task lists and footnotes; raw HTML
  and HTML blocks are shown as text. ammonia uses the spec allowlist plus
  `span` (blocked-image placeholder). Links keep `href` only for https, http,
  mailto, `#footnote-N`, `#h-<slug>` and the internal `nb-doc:` / `nb-wiki:`
  forms (relative links and wikilinks, see "Markdown navigation"), and get
  `rel="noopener noreferrer"`. `//host` links lose their `href`: they would
  resolve against the app origin. `ol start` is dropped.
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

- keyring errors map to `NO_CREDENTIALS`, `KEYCHAIN_TOO_LONG`,
  `KEYCHAIN_UNAVAILABLE` (per-OS message; on Linux it names GNOME Keyring or
  KWallet) and a catch-all `KEYCHAIN`. If `secrets.json` holds no credentials
  for the workspace (and no earlier build's item awaits migration), Rust
  returns `NO_CREDENTIALS` without touching the keychain, and credentials are
  checked before the phrase. On unlock the frontend sends `NO_CREDENTIALS` and
  `KEYCHAIN_UNAVAILABLE` to the workspace's connect screen with the message;
  other failures show the backend's safe message or a neutral fallback, never
  a guessed "wrong phrase".
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
- Stored credentials roam with Windows roaming profiles: `secrets.json` is in
  `%APPDATA%`, and keyring 3.6.3 hard-codes `CRED_PERSIST_ENTERPRISE` for the
  master key. The README says so.

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

- The editor keeps LF only: CodeMirror splits lines on LF, CRLF and CR and
  joins them with LF (no `lineSeparator` is set), also for pasted text, so
  nothing writes CRLF to S3. Documents that contain CRLF are normalized when
  opened and saved as LF on the next edit.
- Backspace and Delete move the selected item to Trash only outside text
  fields, the editor and modals.
- Modals settle their promise on Escape, the close button and an outside click.

## npm registry

- A project `.npmrc` pins `registry=https://registry.npmjs.org/`, and every
  `resolved` URL in `package-lock.json` points there, so installs and CI never
  depend on a private mirror. `package.json` has no `overrides`.

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
  read-only token. The test job runs `npm run build` (type check and bundle),
  `npm run test:unit`, fmt, clippy `-D warnings` and `cargo test` with
  `--locked` on Ubuntu 22.04, macOS and Windows. The audit job runs
  `npm audit --omit=dev`, `cargo audit` and `cargo deny --locked check`
  (`npm run audit` runs the same three locally).
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
  answers over IPC; the CSP blocks an injected inline script, applies the
  editor's style sheets and starts no worker (`worker-src 'none'`); no `undefined`/`[object Object]` and no web storage; a link
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
  Trash namespace, and the pinned WiX `upgradeCode`
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

Replaces the spec's Trash design (`.origin` tandem files) and this app's
earlier `.secure-vault-trash` layout, so an item deleted in either app shows
in both.

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
  window close, minimize and toggle-maximize permissions.
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
- A workspace without stored credentials opens its connect screen with the
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
  (5 s for a text over 2 Mi characters, 2026-10-05; at the latest 10 s after
  the first unstaged edit) and commits on
  Cmd/Ctrl+S, document switch (in the background, after the next document
  is shown), window blur or hidden, close, lock, 30 s idle and 120 s of
  continuous editing. Cmd/Ctrl+S on a document without unsynced
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
  once. There is no combined stage-and-upload call, so an upload hanging on
  S3 can never hold up the next outbox write.

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
- **Large documents.** Over 512 KB of text, Split pauses its preview:
  "Preview paused for large documents." with a **Render** button that renders
  the current text once; typing never re-renders it (the note comes back
  above the last render), and Edit mode does not keep its hidden copy. The
  note goes as soon as the text is rendered (it used to stay above a rendered
  HTML page). Preview, focus mode and document windows are for reading:
  there a large document renders by itself once per open or text change
  (2026-10-05). The 16 MiB hard cap stays.
- **Mode and outline toggles** send no IPC: 376 KB `preview_render` → 0 and
  6,998–7,004 preview nodes → 0 for Edit, Split, Preview and outline open or
  close. Building the outline itself takes 4–8 ms for 501 headings.
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
  capture phase, ahead of the editor, so it never types "Ω"; text fields
  and dialogs keep it (real AppKit events: "Ω" typed in Quick open and in the
  New file dialog, wrap unchanged; toggled from the editor and a sidebar row).
  `event.code` was rejected: it is the physical US position, so on QWERTZ
  (German, Swiss, Czech) Option+Z typed "Ω" and Option+Y toggled wrap.
  With `keyCode`, German AppKit events in WKWebView: the key printed Z
  (code `KeyY`, keyCode 90) toggles without typing, the key printed Y types
  "¥", and US Option+Z still toggles.
  How lines wrap: see "Editor: CodeMirror 6 instead of Monaco".
- **Outline drawer over the editor.** Below 850 px the outline is a drawer
  (z-index 10) over the editor. `.editor-host` is `isolation: isolate`, so
  the editor's own z-indexes stay inside it and never cover the drawer.
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
  outline_width, split_ratio, preview_zoom })` (validated, written durably
  with the other preferences, no S3 request, permission `allow-layout-set`)
  is called once when a drag ends, on a double-click, or 500 ms after the
  last resize key (and before the window closes); never per pointer move.
  Every value is optional and the ones not given stay, so the zoom (sent
  alone) never resets sizes another window changed. `config.json` gets
  `"layout"`; `config_get` returns it, a config without it gets the defaults
  (280, 240, 0.5, 100) and a bad value is repaired to its default without
  making the file unreadable. Browser mode keeps the sizes in memory.
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
  set on `.editor-host` and `.preview` (the editor's margins use it there). Set on `:root`, crossing 850 px restyled every element: 430 ms
  in WebKit with that outline open; before this change the crossing was
  cheap only because the sidebar width changed at the same time (proof: the
  old code with a constant sidebar took 450 ms; adding a 1 px sidebar change
  made it 74 ms).
- **Measured** (12 MB Markdown, Split, outline with 2,903 headings; WKWebView
  harness with real AppKit drags): 51 to 60 fps while dragging, 59 to 60 fps
  at 820×560. Drags of the split edge across the HTML page's iframe follow
  the pointer, and a drag released outside the window ends normally.
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
    preview, forward Tab never reached them: the editor keeps Tab for
    indenting.
  - *Hit areas off the scrollbars.* Each 8 px target starts on its divider
    and reaches into the pane to its right (the editor's or the preview's
    margin); centred, it took 3 to 4 px of the file tree's, the outline's and
    the editor's scrollbars. The accent line stays on the divider.

## Delete permanently on AWS, folder import (2026-10-05)

- *Delete permanently failed on AWS with "S3 denied access".* Purge used one
  presigned DeleteObjects (rusty-s3 0.10.2): `POST /?delete=1`, only `host`
  signed, Content-MD5 sent unsigned. MinIO accepts that; AWS answered 403
  while CopyObject and single DeleteObject (Move to Trash) passed. The
  signature itself is right: AWS's own signer (aws-sigv4 1.4.2) computes the
  same one for that input. What differs from the AWS SDKs is the request:
  they send `?delete` with no value (the only form AWS documents) and sign
  Content-MD5 with the other headers present. Without an AWS account at hand
  the exact rule AWS applied is unconfirmed, so two changes:
  - The request is now what the SDKs send: `?delete`, Content-MD5 and
    Content-Type signed (`delete_objects_url`, signed with rusty-s3's public
    `signing::sign`; jiff, already in the graph, gives it the time). A unit
    test pins the signature aws-sigv4 computes for it; MinIO accepts it and
    answers SignatureDoesNotMatch when the signed MD5 is changed.
  - A refused batch (400, 401, 403, 405, 411, 501, a 200 carrying an
    `<Error>` or no `<DeleteResult>`) or per-key errors other than NoSuchKey
    fall back to unconditional DeleteObject requests for exactly those keys,
    8 at a time; once S3 refuses these credentials (AccessDenied, signature,
    clock), the requests not yet sent are skipped. Unless the code is
    transient (InternalError, SlowDown…), the S3Remote remembers for the
    session and later purges go straight to single deletes; a new unlock
    tries the batch again. Errors every request would get (unknown key,
    clock skew, expired token, missing bucket) are reported, not retried.
    Empty Trash and Restore's clean-up of the bin container use the same
    path. Budgets (fake S3): batch accepted 1 request; refused 1 + N; later
    in the session N.
  - Single deletes run in two waves: an entry's markers (`item/.notebook_dir`,
    `parent/**`) first, its item (`item/<name>…`) only once they are gone.
    Notebook lists an entry only while its item exists, so after a failure
    the entry stays in Trash and a retry removes what is left; deleting the
    item first could leave markers no entry lists and no purge reaches.
    After a failed purge the frontend takes the session's tree again and
    redraws the Trash dialog from it. (Not covered: a batch accepted except
    for an entry's markers, whose single retries fail too; Empty Trash does
    not sweep such leftover containers, to delete only listed entries.)
- *S3 error codes.* Replies are mapped by S3's `<Code>` (letters and digits
  only) before the status: SignatureDoesNotMatch, RequestTimeTooSkewed,
  InvalidAccessKeyId, expired tokens, NoSuchBucket and invalid-request codes
  get their own message. S3's message text never reaches the UI, and the one
  log line (batch delete disabled) holds only the status and code. 501 is no
  longer retried.
- *Folder import.* Dropping a folder said "unsupported file type": the drop
  handler read `dataTransfer.files`, where a folder is a 0-byte File. The
  handler now takes `webkitGetAsEntry()` for each item during the event and
  walks folders with `readEntries` until it returns an empty batch
  (`src/folder-import.ts`, pure and unit-tested). Hidden entries are counted
  and never entered; reserved or invalid names are refused (a folder with
  its contents); names are made unique without case below the drop target,
  as the backend does, so a dropped `Notes` next to `notes` becomes
  `Notes 2` rather than merging. Folders are created level by level with
  `folder_create`, then documents with `doc_create` into the returned ids, 8
  at a time: one PUT per folder and file, deltas applied without listing,
  the tree drawn at most twice a second. Limits: 5,000 files, 2,000 folders,
  20,000 entries walked; over a limit nothing is created. Browser mode, a
  synthetic drop of 5 folders and 302 files: no long task (over 50 ms).
  A lock or switch ends the import: the check runs again after each file is
  read, right before its request (ids are paths, so a late request would
  land in the other workspace), late deltas are dropped, and the dialog then
  gives counts only, never names. Names with control or text-direction
  characters are refused (the backend refuses control characters for every
  new name), names like ` .git` count as hidden, the summary shows such
  characters as U+FFFD, and a folder that cannot be read is reported and not
  created.

## Trash count, focus mode, reading and writing (2026-10-05)

- *The Trash count did not follow Move to Trash and Restore.* Rust's deltas
  were right (a unit test pins that Restore, Delete permanently and Empty
  Trash remove the entry's node and Move to Trash adds one). The frontend
  applied those deltas without drawing, so that the caller draws once after
  following the change, but two paths then only moved the selection (two
  rows): Move to Trash of the open document opens the first document, and
  Restore of a document opens it. The count, and in the first case the
  trashed row, stayed until the next full draw. The tree model now counts
  its changes and the sidebar marks what it drew (`needsDraw`,
  `markDrawn`); moving the selection draws everything when the model
  changed, and a delta applied without drawing is drawn on the next frame
  if nothing drew it (an import keeps its own timer). `tree-model.ts` no
  longer imports `ipc.ts` at runtime (`kindName` moved there and is
  re-exported), so `tests/unit/tree-model.test.mjs` runs it; it failed
  before the change. Browser mode now keeps Trash like the app (entries,
  Restore, Delete permanently, Empty Trash) instead of dropping trashed
  items, so the count can be checked there.
- *Focus mode (F9).* One class on `.shell` hides the sidebar, header,
  status bar, outline and resize handles; the panes keep their DOM, nothing
  reloads, and the editor and preview stay centred at the readable width.
  It opens in Preview (every document has one: Markdown blocks, the HTML
  page, plain text as is; the task's "plain text stays in writing" assumed
  plain text had no preview, which it has here). The OS window title is the
  file name, through `getCurrentWindow().setTitle` (capability
  `core:window:allow-set-title`, nothing else added), and "Notebook" again
  on leaving, lock, auto-lock and workspace switch, so no name stays in the
  Window menu once locked. Leaving gives back the view mode from before;
  only someone who entered from Preview and leaves writing gets the last
  writing mode. Esc leaves too, unless a dialog, a menu or a text field
  (the editor included) has it. F2 and Delete, which act on the hidden
  sidebar's selection, do nothing; Quick open, New file, New folder and a
  file drop leave focus mode first, as their UI is in the sidebar. No new
  navigation.
- *An open outline stays laid out in focus mode.* Shown again from
  `display: none`, the 54,011 headings of a 12 MB test document took one
  842 ms task when focus mode ended. The panel now keeps its width out of
  the grid with `visibility` and `content-visibility: hidden`, and the
  resizers do not refit in focus mode. Browser mode (Chrome), that 12 MB
  document: entering, leaving and both toggles, 9 transitions with the
  outline closed and 6 with it open: no task over 50 ms; each key handler
  0 to 4 ms.
  WebKit was not measured.
- *HTML pages in focus mode* (since 2026-10-05 also in Split and Preview,
  see "Preview banners and zoom"). The page's frame runs no script, so after a
  click in it the page keeps every key, and focus mode has nothing else to
  click. While a page is shown, a 250 ms poll gives the keys back
  to the preview once no text is selected in the page (Copy still works
  while it is) and the mouse button is up (the frame is not `:active`;
  without that, a press held before the drag lost the keys mid-selection
  and Cmd+C then copied nothing), and arrow, page, space, Home and End
  keys on the preview scroll the page's frame. A poll, because a click
  that activates the window right in the page sends the parent no event.
- *Reading and writing (Cmd+Shift+V, Ctrl+Shift+V off macOS).* Replaces the
  Edit, Split, Preview cycle on the same keys: Edit or Split goes to
  Preview, Preview back to the last writing mode; in focus mode Preview and
  the editor alone. Caught in the capture phase ahead of the editor (no paste
  and match style in it); Quick open and dialogs keep the keys.
  `keyCode` 86 like Alt+Z, so it is the key printed V on any layout. The
  rules are pure (`src/view-mode.ts`, unit-tested).
- *Not checked in the app:* the title IPC call and the permission at
  runtime, F9 and Cmd+Shift+V in WKWebView (browser mode, Chrome only).
  Cmd+Shift+N is New folder, so it is not free for another command.

## Document windows, one writer per document (2026-10-05)

- *Open in new window* (header button, a document's sidebar menu,
  Cmd/Ctrl+Shift+O, since Cmd+Shift+N is New folder): Rust's
  `open_document_window` builds a `doc-<uuid>` window from a copy of the
  main window's `tauri.conf.json` entry (same webview settings), 860 x 900
  fitted to the screen, minimum 480 x 360, cascading from the main window,
  titled with the file name. `window.rs` builds every window through one
  function, so each gets the navigation guard, `on_new_window` Deny and the
  close guard (now per window label; the main window's fallback is 10 s, as
  it first closes its document windows). Only a reload of the main window
  ends the session.
- *The URL is not trusted.* The page gets `index.html?window=document&id=…`
  (form-encoded) only to know it is a document window; `document_window_info`
  answers by the window's label which document it holds, and that is what
  it shows and writes (after a rename the URL's id is stale anyway).
- *Least privilege.* Document windows have their own capability
  (`capabilities/document-window.json`, windows `doc-*`): their document
  (open, stage, commit), preview, links, images, the close guard, activity,
  `core:event:allow-listen` and `document_window_close` for the Close
  button of a window with nothing to show (it closes only itself; see the
  review fixes below). No tree, Trash, workspace, lock
  or settings commands, and `config_get` is not needed (the theme and accent
  come with `document_window_info`). The main capability gains only
  `open_document_window` and `document_windows_close`.
- *One writer per document* (`notebook/doc_windows.rs`): the main window
  writes every document no document window holds; a document window holds
  one document of the session it was opened in. `doc_stage` and
  `doc_commit` refuse any other window (`NOT_WRITER`); `doc_open` answers
  the main window `read_only` for a held document and refuses a document
  window anything but its own. Before the hand-over the main window writes
  its pending edit to the outbox (the editor is read-only meanwhile) and
  then drops that document from its save model (`DocumentSession.handOff`),
  so it never retries or uploads it; the new window opens the staged text
  and uploads it. A read-only open never marks a document dirty.
- *Holds are session-scoped.* A hold records the session id; one of an
  ended session counts for nothing, so a leftover window can never write
  into a later session, even with the same paths (ids are path-derived).
  Lock, workspace switch, phrase change and quit first close every
  document window as its close button does (`document_windows_close`: it
  saves, then closes); one that cannot even write the outbox keeps the
  workspace open. As a backstop, `vault_lock`, `vault_unlock`,
  `workspace_*`, `passphrase_change`, a main-window reload and the forced
  idle lock destroy any window without a current hold.
- *Writer changes.* A document window's commit emits `document-committed`
  to the main window (the only other window showing it; with any conflict
  copy's tree delta), which re-reads the document from Rust's outbox or
  cache (no S3 request); its close emits `document-window-closed`, and the
  main window makes the document writable again. Opening the same document
  again focuses its window. Typing in a document window keeps the workspace
  open: `activity_ping` from it tells the main window, which runs the idle
  lock.
- *Rename, move, Trash.* Before any of them Rust asks the windows holding
  the item to write their pending edit to the outbox
  (`window.__notebookFlush`, answered by `document_window_flushed`, at most
  2 s); the change then uploads it as for the main window. Afterwards a
  hold follows its document to the new id (the window is retitled and
  told, `document-window-moved`); a document that left the tree (Trash)
  closes its window and the main window says so. A conflict copy made by a
  document window moves the hold to the copy, as the main window keeps
  editing a copy it made.
- *Document windows are focus mode for good.* F9 and Esc do nothing (no
  chrome to restore); Cmd/Ctrl+Shift+V toggles Preview and the editor,
  Cmd/Ctrl+S uploads, every other shortcut is off. A theme change in the
  main window reaches a document window when it next opens.
- *Checks.* Rust unit tests for the rules (hand-over, refusal of
  non-writers, read-only reads, release on close, session end and a new
  session, rename and Trash, conflict copy) and for the window URL; unit
  tests for the URL parsing, the new key and the hand-over in the save
  model. Browser mode: the document-window boot path (sample documents),
  and the IPC paths with a temporary stand-in page. Not run in the Tauri
  app (rules forbid the real profile): window creation, placement, focus,
  close guard and the capability at runtime.

## Review fixes: document windows, reading position (2026-10-05)

- *A read-only open moved the writer's base.* `doc_open` from the main
  window for a document another window writes set the journal base (the
  If-Match of the writer's next upload) to the version it read. After a
  Refresh had seen another device's change, the writer's next save then
  overwrote that change and said "Saved". Only the writer moves the base
  now; a reader's download still fills the cache. `s3_budget.rs` pins both
  sides (it failed before: the upload saved instead of making a conflict
  copy).
- *Edits typed in a document window during a rename, move or Trash.* The
  window wrote its pending edit when asked, but could stage again while S3
  copied the objects; `finish_moves` then dropped that edit with the old
  key (an orphaned outbox entry, a "Saved" that was not). Now the holders
  are frozen from just before `commit_subtree` until the change ends
  (`freeze_holds_within`, released however it ends): their `doc_stage` and
  `doc_commit` answer `BUSY`, checked again under the journal lock so an
  edit is either uploaded before the move or refused. The window itself is
  read-only from the flush request until `document-window-resume` (Rust
  emits it after the change, done or failed; 2 minutes at most), Cmd+S
  waits, and an edit refused meanwhile is written and uploaded under the
  document's new id. Tests: rename and Trash with a slow fake S3 (both
  failed before), and the freeze rules.
- *Open in new window* writes every pending edit first, also a failed
  outbox write of a document no longer open, which the hand-over would
  otherwise forget.
- *Events reach only their window.* The global `listen` receives every
  `emit_to` meant for any window (its target is Any), so each window now
  listens on itself (`getCurrentWebviewWindow().listen`); no permission
  change.
- *A document window closes only itself.* `core:window:allow-close` let it
  close any window by label, the main window included; the Close window
  button calls `document_window_close` (document windows only, through the
  close guard) instead.
- *No file name stays in the title.* Rust resets the main window's title
  on a reload of its page and on a forced idle lock; the page resets it
  otherwise, but a reloaded or hung page cannot.
- *Reading position.* Cmd+Shift+V, F9 and the Edit / Split / Preview
  buttons keep the place. A pane that stays shown keeps its own place
  (the preview by its top block, since WebKit has no scroll anchoring and
  the column widens with F9); a pane shown now opens where the other one
  was. Between editor lines and preview pixels, the headings present in
  both are fixed points, linear in between (`view-mode.ts`, two layout
  reads per mapping, unit-tested); HTML pages, plain text, large documents
  and a preview whose headings differ map proportionally, and a preview
  with nothing to scroll ("Preview paused") leaves the editor's place
  alone. The editor keeps its top line when its width changes (F9, mode
  switches).
- *Focus.* Leaving focus mode focuses the pane shown (it was the page
  body, where Backspace asked to trash the open document); a document
  window starts with the preview focused, so the keys scroll it at once.
- *Header and menu.* "Open in new window" is disabled without an open
  document. "Editing in another window" shrinks to its icon when the header
  is under 720 px (a container query; WebKit before Safari 16, on macOS 11,
  ignores it and keeps the full chip), so the file name keeps the room; its
  tooltip and label still say it. The sidebar menu shows ⌘⇧O / Ctrl+Shift+O
  at the item's end instead of an icon (the labels line up), and the Edit,
  Split and Preview tooltips name Cmd+Shift+V and F9.
- *E2E* (`tests/e2e/smoke.test.mjs`): a fresh profile is locked and the
  Linux run has neither a Secret Service keyring nor an S3 endpoint to
  unlock one, so no document window can open there; the new check pins that `open_document_window` answers
  `LOCKED` without a window, that page script cannot build a window
  (`plugin:webview|create_webview_window`, `plugin:window|create`), and
  that the document-window commands are refused to the main window.
- *Measured* (browser mode, Chrome, in a hidden pane where frames do not
  run): a 12.9 MB document with the outline closed, F9 and Cmd+Shift+V
  handlers 2 to 12 ms, no long task, and the editor's place kept; with its
  54,000-heading outline open, 54 to 130 ms per transition. Timed inside
  the handler, the reading position costs 0 to 1 ms and the rest is the
  page relayout (a bare class toggle plus layout: 52 to 69 ms), which now
  runs in the key handler instead of the next frame. The earlier "0 to 4
  ms" figure never included that relayout (no frame ran). One run showed
  340 and 590 ms for the first two toggles after building the 13 MB text;
  it did not recur. WebKit was not measured.

## Markdown navigation: heading ids, vault links, outline (2026-10-05)

Report: "Markdown navigation is not working." Three parts.

- *Heading ids.* preview.rs gives every heading `id="h-<slug>"`: the
  github-slugger rule (NFC, the whole text lowercased so a final `Σ` is `ς`,
  letters/numbers/marks, `-` and `_` kept, each whitespace a `-`, the rest dropped; cut at 200 chars;
  repeats `-1`, `-2`, …), from the heading's text and code (not image alt
  text or footnote marks). The fixed prefix means no document can produce an
  id of an app element or a global (`__proto__` is `h-__proto__`); document
  ids still never pass (raw HTML is text, heading attributes stay off, and
  the sanitizer admits an `id` only on h1–h6 as `h-` plus slug characters,
  or on footnote sections). `#Heading` links are rewritten to `#h-<slug>`,
  percent-encoded ASCII, and the sanitizer accepts only that exact form;
  `#footnote-N` stays. src/vault-links.ts `slugify` is the same function
  (tests on both sides use the same cases), so the frontend also accepts a
  fragment written as heading text.
- *Vault links.* Relative links and wikilinks (pulldown-cmark's
  `ENABLE_WIKILINKS`) become `nb-doc:<path>#<id>` / `nb-wiki:<target>#<id>`:
  a reserved scheme, not a data attribute, so they stay focusable links with
  Enter, middle click and the context-menu guard of every other link. Only
  the rewriter writes them (a document's own `nb-doc:` or `nb-wiki:` link
  loses its href), the target is percent-encoded with letters, digits,
  `-._~/` left, control characters and over-long targets are refused, and
  `is_internal_href` accepts only that canonical form. They carry a path
  and a heading, nothing else: navigation.ts hands them to main.ts only from
  inside `.preview`, main.ts resolves them against the tree (relative to the
  linking document's folder; names compare as NFC, lowercased per code
  point, then NFC again: `nameKey`), and opens a document,
  selects a folder, or shows "Link not found" / "Link is ambiguous". The
  WebView never loads them; the navigation guard and the CSP are unchanged.
  Wikilinks: exact name first, else name without extension with Markdown
  first; several are narrowed by the folders written in the link, then the
  one nearest the linking document wins (folder steps); a tie is ambiguous,
  not a guess. `..` above the root is missing, not clamped.
- *Document windows* hold no tree. `document_window_info` now also returns
  the document's vault path (asked again at each link, so renames and moves
  count): the window resolves a link against its own path only, scrolls
  itself for its own document, and otherwise calls `document_link_open`
  (document windows only, `allow-document-link-open`). Rust re-checks the
  href, takes the starting folder from the window's hold (never from the
  page), emits `document-link` to the main window and focuses it; the main
  window resolves and validates against its tree like its own links.
  Browser mode uses a BroadcastChannel instead.
- *Outline.* Selecting a heading no longer switches Preview to Split: Edit
  goes to the line, Preview scrolls the preview, Split does both; in Preview
  the focus stays in the outline. Outline items map to preview headings by
  index among the top-level headings when the counts match (outline.ts and
  the renderer both skip fenced code), else by the generated id of the text,
  else by the existing line mapping. Focus mode and document windows hide
  the outline by design; their heading links work. If the top-level counts
  differ, all headings outside block quotes are tried by index before the id
  (the outline counts a heading in a list item, never one in a quote). For
  the ids, outline.ts labels keep code spans, escaped characters and `_`
  inside words (CommonMark: no emphasis there), so `## parse_config` maps to
  `h-parse_config` as in preview.rs; both test suites check the same
  headings. Edit mode has only these labels to find a link's heading line.
- *Scrolling.* Only the preview pane scrolls (`scrollPaneTo`, 16 px of room),
  never its ancestors (`scrollIntoView` could move the shell). Every jump
  is instant: in-page link clicks no longer scroll smoothly (2026-10-05,
  "Footprint and hot paths"). As a native fragment
  link would, the target heading then takes the focus (tabindex -1 until it
  loses it, no ring, no scroll), so the next Tab goes on from there; only
  when the focus was in the preview or nowhere, never from the editor or
  the outline. `message()` focuses its OK button like `confirm()`, so
  "Link not found" closes with Enter or Escape.
- *Browser mode*'s stand-in renderer writes the same ids and hrefs
  (`previewHref`, `wikiHref`), and the sample documents link to each other,
  so all of this can be tried without the app.

## Preview banners and zoom (2026-10-05)

- **Banners.** "Scripts off (N)" moved from the HTML preview pane to the
  status bar (normal mode only); "Preview paused" is a Split-only state that
  goes once the text is rendered; Preview, focus mode and document windows
  render large documents by themselves (see "Large documents" above).
- **Zoom (content zoom, owner feedback 2026-10-05: "zoom applies only in
  focus mode", "the size label is disturbing").** Cmd/Ctrl+= (or +),
  Cmd/Ctrl+- and Cmd/Ctrl+0 zoom what is shown: ONE level scales the editor
  text and the preview (HTML page, Markdown and plain text) together, in
  steps of 50, 67, 80, 90, 100, 110, 125, 150, 175 and 200%
  (`src/preview-zoom.ts`, pure and unit-tested). The keys act in every mode
  (Edit, Split, Preview, focus mode) and in document windows, wherever the
  focus is, caught in the capture phase so the editor never types them;
  not under a dialog or without a document (CodeMirror binds none of them;
  the WebView's own zoom hotkeys stay off; the default macOS menu has no
  zoom items). A key held down zooms one step. The permanent "− 100% +"
  control is gone: the new level shows for 1 s centred near the top of the
  content (`.zoom-indicator`, over the preview or the editor, over both
  panes in Split), then fades (at once with reduced motion); it never takes
  the pointer and is a polite live region ("Zoom 110%"). After a click in an
  HTML page the frame keeps the keys; the 250 ms poll that gave them back
  in focus mode now runs whenever a page is shown (Split, Preview), so the
  zoom keys, Cmd+S and Cmd+Shift+V work again after a click in a page,
  except while text is selected in it (so Copy works).
- **How.** The HTML page gets CSS `zoom` on its root, one rule in the style
  element the preview already puts in the frame, so the text stays crisp,
  re-flows and `#id` jumps still land (checked in WKWebView and Chromium).
  WebKit and Chromium scale the frame's scrollbar with that zoom, so the
  scrollbar sizes are divided by it. The editor and the Markdown preview
  share one custom property, `--content-zoom`, set on `.editor-host` and
  `.preview` (not on a shared parent, which would restyle the outline's
  rows): font size, spacing and the readable width scale (no transform);
  CodeMirror re-measures its lines (`requestMeasure`, its box did not
  change). Each shown pane keeps its reading position (editor top line,
  preview block). One level for every window, saved 500 ms after the last
  change with `layout_set({ preview_zoom })` (50–200, integer; the config
  key keeps its name; document windows may call `layout_set` for this) and
  read back by `config_get` and `document_window_info`. Measured in the
  scratch WKWebView build: zoom steps on the 12 MB Markdown document in
  Edit and Split, longest frame 21 ms (the editor lays out only what is in
  view).
- **Cost.** A zoom step is one re-flow of the preview. For a 12 MB HTML page
  (152,000 elements) that is about 0.55 s in WKWebView (style 150 ms, layout
  365 ms; Chromium about 0.6 s), the same work as resizing the pane. The
  page therefore re-flows in the task after the next paint: the level, the
  editor and a Markdown preview show one frame after the key (about 10 ms,
  was 0.58 s, real key events in a WKWebView harness), and the page follows
  about 0.58 s after the key, keeping its scroll ratio. A key held down
  zooms one step (one re-flow); taps that queue up behind a re-flow are
  dispatched together and share the next one (three quick taps: two
  re-flows).
- **Not under 200 ms.** Measured on the same page in WKWebView (2026-10-05):
  `zoom` as an inline style on the root or body, or by editing the CSSOM
  rule, costs the same 540–585 ms (every element's style depends on the
  zoom); `transform: scale()` on the root with a matching width cuts it to
  about 270 ms (layout only) but makes the root the containing block of
  fixed elements; CSS `zoom` on the `<iframe>` does not scale the page in
  WebKit; `content-visibility: auto` on the page's blocks hung WKWebView
  (and its containment changes how arbitrary pages lay out: fixed elements,
  counters, floats, margins). None is used; the 0.55 s re-flow of a page
  this size is the limit.

## Editor: CodeMirror 6 instead of Monaco (owner decision, 2026-10-05)

Plan item D1, approved by the owner ("best performance and smallest
footprint"). `src/editor/editor.ts` is the editor; Monaco's features were
ported as listed below.

- **Dependencies** (exact pins; `npm audit` 0; no `codemirror`/basic-setup
  bundle, no `language-data`, no lint or completion UI):
  - `@codemirror/state` 6.7.6: document state, transactions, compartments.
  - `@codemirror/view` 6.43.13: the view; lays out only the lines in view.
  - `@codemirror/commands` 6.11.1: the standard keys and undo history.
  - `@codemirror/language` 6.12.4: highlighting, bracket matching, indent unit.
  - `@codemirror/lang-markdown` 6.5.2: Markdown (GFM) parsing, list keys.
  - `@codemirror/lang-html` 6.4.12: HTML, with its CSS and JavaScript.
  - `@codemirror/lang-css` 6.3.1 and `@codemirror/lang-javascript` 6.2.5:
    fenced css/js/ts code; lang-html already bundles them (no extra bytes).
  - `@codemirror/search` 6.7.2: find and replace (Cmd/Ctrl+F).
  - `@codemirror/autocomplete` 6.20.3: only `closeBrackets` (bracket
    pairing); lang-markdown and lang-html already depend on it.
  - `@lezer/highlight` 1.2.5: syntax tags and the class highlighter.
- **One view, one state per document.** Each document keeps its
  `EditorState` (text, selection, undo history, scroll) in an LRU of 10
  documents and at most 24 Mi characters besides the open one; a rename,
  move or conflict copy keeps it under the new id. Another window's text
  starts a new history; caret and scroll follow the changed span
  (`textChange`). `holds()` compares a kept document with
  the opened text piece by piece, without a copy.
- **Styling only in theme.css.** A `tagHighlighter` names `tok-*` classes,
  theme.css colours them with the `--md-*` / `--code-*` tokens (Obsidian's
  source mode), so dark, light and the accent follow live; `setTheme` is in
  `theme.ts`. CodeMirror's layout styles
  (a `<style>` element, allowed by `style-src 'unsafe-inline'`) carry one
  generated class, so the rules in section 9 carry one class more.
- **Readable width** is a margin on `.cm-content` (at least `--file-margins`,
  centred at `--file-line-width`), not padding, so CodeMirror's wrapping
  estimates use the real column. A click in a margin puts the caret on that
  line (start of line on the left).
- **Soft wrap** is `EditorView.lineWrapping` in a compartment, toggled by
  Alt+Z and **Wrap**. CodeMirror wraps only the lines it lays out, so no wrap
  column, strategy or deferred re-wrap is needed. Documents of 2 MB and more
  are plain text (no parsing or highlighting).
- **Pasted images fold.** A data URL's base64 of 4,096 characters or
  more shows as one atomic mark ("⋯ 2.4 MB"); the text is unchanged. Folds
  are found once per state (only tree leaves of 4,096+ characters are read)
  and then only on edited lines. Without them an image was one huge line:
  CodeMirror lays out an overlong wrapped line in full the first time
  (about 0.1 s per 1M characters; 1.6 s for 12 MB in Chromium).
- **Overlong lines stay unwrapped.** A document with a line of 512K
  characters or more outside folds opens unwrapped and **Wrap** says why.
  Cause: the `ViewState` constructor draws line gaps horizontally
  (`gap.draw(this, false)`), so the first wrapped measure takes the partial
  line's height and renders the whole line. Redrawing the gaps from outside
  made scrolling worse in a trial, so CodeMirror is not patched; worth an
  upstream report.
- **Keys.** Standard keymap, history, search and bracket keys. Tab inserts
  the document's indentation (a selection indents), Shift+Tab outdents,
  Esc then Tab leaves the editor; Alt+click adds a caret and Alt+Shift+drag
  selects a column (`rectangularSelection`). The indentation is detected
  when a document opens: a tab when more of the first 10,000 lines start
  with one than with spaces, else 2 or 4 spaces by the commoner step. As in
  Obsidian and VS Code, Enter continues Markdown lists
  and Backspace removes an empty item's marker, `(` `[` `{` pair (quotes too
  in HTML, not `<`), HTML closes tags, a URL pasted over selected text
  becomes a Markdown link. App keys (Alt+Z, F9, Cmd+Shift+V, zoom) still
  run first, in the capture phase.
- **Read-only** is `EditorState.readOnly`, and a `changeFilter` refuses every
  change of a read-only state whatever made it: lang-markdown's Enter and
  Backspace commands and its URL paste never check the facet, so in the main
  window (read-only while a document window writes) they reached the save
  model, failed with `NOT_WRITER`, blocked the next switch, and on lock or
  quit wrote the stale copy over the window's newer text. A refused
  keystroke, paste, cut or drop shows a note at the caret. An image pasted
  or dropped on a read-only document is refused before it is encrypted.
  Text dragged within the editor moves:
  `navigation.ts` lets drops on `.cm-content` through when they carry no
  files, and the editor refuses anything without text.
- **Not ported:** Monaco's ambiguous-character (homoglyph) highlighting.
  Control, zero-width and bidi characters show (`highlightSpecialChars`
  plus LRE, RLE, PDF, FSI and the word joiner, which its list lacks, so
  every "Trojan Source" control is marked).
- **CSP:** `worker-src 'none'` (no worker); the e2e test
  checks that styles apply (a `<style>` element and a constructed sheet)
  and that a worker is blocked (the constructor throws, or the policy
  reports and the worker errors) and never runs.
- **Measured** (scratch universal build in WKWebView, the baseline's harness
  and documents; two runs, the second with the display at 30 Hz):
  main JS 2,902,661 → 735,001 B (240,964 gzip -9), worker 303,930 → 0,
  CSS 160,329 → 76,369 B, dist 3,843,993 → 1,274,272 B; universal binary
  15,263,504 → 14,197,520 B. WebContent memory (RSS / footprint) idle
  242.7 / 103.6 → 78 / 48 MB, 1 MB open 318.7 / 191.0 → 95–101 / 74 MB,
  12 MB open 393.7 / 137.2 → 192–198 / 94–96 MB. Open to editor paint
  small / 1 MB / 12 MB 88 / 107 / 216 → 12–25 / 41–45 / 193–198 ms (12 MB:
  `doc_open` is 170 ms of it); switch 90 / 49 / 64 → 17 / 21 / 53–69 ms.
  Typing in 1 MB: p95 22 → 17–18 ms. 12 MB Markdown, the image note (11 MB
  line), a 12 MB one-line page and a 12 MB page: longest frame on open or
  switch 24–46 ms (up to 161 ms before `holds()`), wrap toggles 1–39 ms,
  scrolling 60 fps (30 at 30 Hz); typing in 12 MB p95 21 ms. Cold start to
  the vault tree 601 → 562 ms (median of 6).
  Not better: preview scrolling in Split (13–17 fps), Preview→Split with a
  rendered 1 MB preview (327–420 ms) and the outline toggle with it
  (226–319 ms, baseline 137–256); the 37,915-node preview reflows in each
  (not broken down yet).
- **Parity check (2026-10-05).** Checked in browser mode (Chromium) and in
  the scratch WKWebView build
  with real key events (NSEvent / CGEvent through `NSApp`): undo kept across
  open, switch, rename and move; read-only (with its note) while another
  window writes the document, writable again when it closes; Trash items
  are never opened for editing (Restore first) and trashing the open
  document closes it; Option/Alt+Z, also as QWERTZ sends it; Cmd+S
  (`doc_stage`, `doc_commit`); Cmd+Shift+V without pasting; F9 and Esc;
  outline jumps in Edit, Split and Preview; `#heading`, `[[wiki]]` and
  relative document links; image paste and drop insert Markdown at the
  caret / drop point; HTML highlighting; find and replace; selection word
  count; 12 MB documents; CR and CRLF become LF; Option+E then E composes
  "é" and an input method's marked text commits; `spellcheck`,
  `autocorrect` and `autocapitalize` are off. The e2e suite ran on Linux
  (WebKitGTK, tauri-driver); macOS has no tauri-driver backend.

## Footprint and hot paths (2026-10-05)

Owner direction: a working app first, then speed, then size. Each change was
measured against the build before it: a scratch universal build (scratch
identifier and HOME, fake S3 on loopback) driven in WKWebView with real key
events. The drivers and logs are in the scratchpad, not in the repo.

- **No bundled fonts.** The 14 Inter woff2 files (452,780 B) were never
  loaded on macOS or Windows: the stack starts with the system UI font
  (0 font requests and 0 loaded faces in WKWebView). Linux now falls back to
  the desktop's sans-serif. In WebKitGTK it renders in DejaVu Sans, which is
  readable (screenshot of the browser-mode build in the Linux e2e image).
  The OFL text went with the files. dist 1,273,422 → 815,016 B (19 → 5
  files); universal binary 14,197,520 → 13,302,560 B (arm64 6,726,416 →
  6,273,824; with the strip change below), app 14,072 → 13,196 KB. Cold
  start is unchanged: median 590 vs 584 ms over 6 interleaved runs.
- **CSS.** `contain: paint` on `.preview` gives the pane its own composited
  scroller. Without it, WebKit repainted the preview and the editor together
  in Split on every scroll step. With a 1 MB rendered preview: preview scroll
  in Split went from 17–18 to 60 fps (from 118–125 dropped frames in 3 s to
  0), editor scroll from 35 to 60 fps, Split → Preview from 246–282 to
  87–112 ms, Preview → Split from 315–352 to 84–107 ms, and outline
  open/close from 228–260 / 169–190 to 184–200 / 143–144 ms. `contain:
  layout paint` and `strict` measured the same, and so did containment on
  the editor or the outline, so only `paint` is kept. Also removed: dead
  rules (`.empty-card`, `.inline-title`), 25 unused tokens and the
  reduced-motion `scroll-behavior` (nothing scrolls smoothly any more). CSS
  76,146 → 70,526 B. Kept, because measuring showed no cost: the
  task-list `:has()` rules (inserting a 1 MB preview with 5,945 task items
  took 376 vs 374 ms without them), and the shadows (menus, modals and the
  narrow-window outline drawer only, never on a scrolling surface).
- **Instant jumps.** `scrollPaneTo` sets `scrollTop`. A `#heading` click in
  a 500 KB preview took 240–256 ms over 7–13 frames of smooth scrolling and
  now takes 11–14 ms in one frame (Split and Preview).
- **Large texts are staged less often.** Over 2 Mi characters (UTF-16
  units, read from the editor in O(1)), the outbox write waits for a 5 s
  pause instead of 1 s. Switch, Cmd/Ctrl+S, blur, close, lock and every
  upload still write it at once (unit tests). Each stage sends the whole
  text: 12 MB is 12.95 MB of JSON, 152–173 ms round trip, and 2–3 frames
  over 50 ms on the main thread (`toString` 4–6 ms, `JSON.stringify` 11–12
  ms, then the request body). Typing in four bursts with 1.6 s pauses: 4
  stages (51.8 MB) → 0, longest frame 56–60 → 31 ms. The 1 MB document
  still stages after 1 s. The whole session went from 56.7 to 17.8 MB of
  `doc_stage`. Incremental (diff) staging was not done: Rust would have to
  rebuild the text from UTF-16 offsets and could drift silently.
  Raw-bytes IPC would save only the 12 ms stringify.
- **Hardware AES on Apple silicon.** `aes` 0.8 and `polyval` 0.6 use the
  ARMv8 instructions only with `--cfg aes_armv8 --cfg polyval_armv8`.
  Without them every content encryption and decryption used the software
  fallback. `.cargo/config.toml` sets both for aarch64 macOS and Linux (the
  instructions are detected at runtime, with the fallback kept), and
  `sha2` is built at opt-level 3. Measured on a 12 MB text: encrypt 77 →
  20 ms, decrypt 83 → 26 ms, SHA-256 48 → 21 ms, with no change in size. In
  the app: the first open of a 12 MB document went from 170–172 to 87–89 ms
  of `doc_open` (193–195 → 111–128 ms to the editor's paint), a 12 MB page
  from 169 to 79–84 ms, a 1 MB document from 30 to 10–17 ms, and a 12 MB
  stage from 152–159 to 72–83 ms, and a 1 MB stage from 18–37 to 20–21 ms.
  Unlock with the remembered phrase is SHA-bound (PBKDF2-HMAC-SHA256,
  3 × 120,000 rounds), so cold start to the vault tree went from 496–507
  to 400–413 ms (6 interleaved runs). `sha2` 0.11, already in the graph for
  rusty-s3, uses the SHA instructions (4.3 ms), but `pbkdf2` 0.12 needs
  0.10, so that waits for its upgrade.
- **Stripping that does not depend on PATH.** The rustc strip step runs
  rust-objcopy, which needs rustup's environment to find libLLVM.dylib.
  Outside it, rustc only warned and shipped an unstripped binary (arm64
  9,488,936 B instead of 6,748,352 B). On macOS the linker now strips
  (`-Wl,-S -Wl,-x` from `build.rs`, release bins only, so dev builds keep
  their symbols). The rustc step is off there (`-C strip=none` in
  `.cargo/config.toml`, at the repo root so cargo runs from `src-tauri`, as
  the Tauri CLI does, and from the root, as CI does, both read it). Build
  scripts are not stripped. Result: 6,755,448 B through a rustup proxy and
  without one, and no warning. That is 7 KB more than objcopy's
  `--strip-all`. x86_64 is 7,389,952 B. Linux and Windows keep rustc's
  link-time strip.
- **Release profile, measured (arm64).** `s` 6.76 MB, 1 MB preview render 39
  ms. `z` 5.45 MB, render 107 ms. `z` with the hot crates at 3: 5.61 MB,
  but crypto twice as slow and everything else unmeasured at `z`. `3`
  8.31 MB, render 33 ms, encrypt 11 ms. `s` with the Markdown and sanitizer
  crates at 3: +66 KB for a 13% faster render. `s` with LTO,
  codegen-units 1 and `panic = "abort"` stays. The only new override is
  `sha2` at 3. Duplicate crates in the graph (html5ever 0.39/0.40,
  digest 0.10/0.11, base64 ×3) come from Tauri and rusty-s3. Every direct
  dependency is used, and so is every feature turned on (see "Cleanup").
- **Preview of long Markdown.** Typing in Split on a 500 KB document (just
  under the 512 KB pause) costs one `preview_render` of 528 KB → 824 KB in
  22–36 ms, and the block patch keeps the longest frame at 34–40 ms with
  no frame over 50 ms. So nothing is virtualised. A full 1 MB render is
  367–443 ms, almost all of it WebKit's style and layout of 38k nodes.
  `content-visibility` was ruled out earlier: it hung WebKit for minutes on
  62k blocks.
- **120 Hz: not enabled.** WebKit caps page rendering updates (rAF) at 60
  Hz through the internal feature `PreferPageRenderingUpdatesNear60FPSEnabled`.
  It is on by default, and only the private `_setEnabled:forFeature:` can
  turn it off (`-[WKPreferences _setPreferPageRenderingUpdatesNear60FPSEnabled:]`
  does not exist on macOS 26.6). The condition was not met: nothing here
  was measurably capped. Both displays run at 60 Hz (the built-in one could
  do 120 but is set to 60, and changing that is a system setting), and rAF
  ran at 60.3–60.5 fps, which is the display's rate. Scrolling, the main
  thing a higher rate would improve, is composited by WebKit off the main
  thread, and nothing in the app animates through rAF any more. Revisit
  with a 120 Hz display, in a separate small crate behind runtime
  `respondsToSelector:` checks, keeping `#![forbid(unsafe_code)]` in the
  app crate.

## Review fixes: read-only, saves, outline, switches (2026-10-05)

Found by the parity, performance and security reviews of the CodeMirror and
footprint steps; each was reproduced before it was fixed.

- **Read-only, indentation, column selection, bidi:** see the CodeMirror
  section (Read-only, Keys, Dropped). Unit tests run lang-markdown's own
  commands on a read-only state.
- **Staging has an upper wait.** Typing that never pauses for the stage delay
  (1 s, or 5 s over 2 Mi characters) is staged 10 s after its first unstaged
  edit (`maxStageWaitMs`). Before, a large document typed with 2–4 s pauses
  reached the outbox only at the 120 s upload, a blur or a switch, so a
  crash could lose two minutes. A 12 MB text costs one stage (about 80 ms)
  per 10 s of such typing.
- **The outline is bounded.** It drew every heading as nested DOM with a
  listener per row and kept it while hidden: on a 12 MB document (36,170
  headings, 168,796 nodes) opening took 1.4 s, the next editor focus froze
  WebKit for 9.9 s, the first key for 14.8 s, and footprint rose by about
  1 GB. Now rows are flat (`role="treeitem"` with `aria-level`, the same
  look), drawn 400 at a time (more as the end nears the view, an
  `IntersectionObserver`), one delegated click listener reads the row's
  index, a redraw is skipped when the document and its headings (level,
  line, text) are unchanged, and hiding the outline drops its rows. A fold
  keeps the rows drawn and the focus on its button. Measured (scratch build,
  real keys, two runs): 12 MB open 1,368–1,464 → 115–123 ms (1,802 nodes),
  no frame over 50 ms on focus, the first key's longest frame 14.8 s → 112
  ms, 27 of 27 keys at 100 ms painted with p95 19–22 ms (before: 2–5
  arrived), WebContent footprint with it open 987–1,429 → 121–126 MB; 1 MB
  open 134–161 → 43 ms, typing p95 45–51 → 19 ms, and with its preview
  rendered, outline open / close 134–136 / 66–68 → 40–45 / 14–15 ms. Still: each typing pause
  that changes a heading of a 12 MB document costs one 110–125 ms frame
  (the text is parsed again).
- **A switch back sends no text.** `doc_open(id, known_rev)` returns
  `text: null` when `known_rev` is the SHA-256 (hex) of the text it would
  return; `doc_stage` returns that rev too. The editor keeps the rev of the
  text a kept state was opened or staged with (staged: only when the state
  still holds exactly that text, `holds()`), and drops it at the first edit.
  Being a content hash, the rev needs no bookkeeping across windows, S3
  versions or conflict copies: any other text has another rev and is sent.
  The SHA-256 is already computed for every staged and cached text, so a
  rev costs nothing. Before, each switch back to a 12 MB document sent
  12.9 MB of JSON and allocated it twice. Measured: the reply is 143 B
  instead of 12,951,032 B, also after an edit and a switch away; a switch
  back to the 12 MB document paints in 18–26 ms (41–60 before), like the
  small one, and the app process no longer saw-tooths (footprint at most
  89 MB in a 10-switch loop, falling to 38; it climbed to 156 MB before).
- **Find panel.** A paste or drop in CodeMirror's find panel (inside
  `.editor-host`) no longer goes to the image handlers: an image on the
  clipboard was encrypted and inserted into the document instead of the
  search field.

## Cleanup (2026-10-05)

Behaviour unchanged; everything below was unused.

- **Rust.** The spec's research modules `crypto/`, `vault/` and `store/`
  (never in the module tree) and the empty `sync/` and `render/` are gone,
  and with them the direct dependencies `aes-gcm`, `argon2`, `bytes`, `hkdf`
  and `hmac` and the unused features `serde` of secrecy, url and uuid and
  `attributes` of tracing (Cargo.lock: 592 → 586 packages). The commands
  `connection_test` and `search_titles`, which no page called, are removed
  with their permissions, so the main window's capability is two commands
  smaller. `compat` is private, which showed `decode_listing` unused; it
  went with its test.
- **Frontend.** Removed `Toasts`, `Modals`, `formatBytes`, `formatDate`,
  `plural` and `clear` (`ui/primitives.ts`), four icons nothing drew, the
  `connectionTest` and `searchTitles` wrappers, the toast and `.modal-card` /
  `.modal-choice` rules and the tokens only they read. main.ts reuses
  folder-import.ts's `uniqueName` (`toLowerCase`, as the backend's
  `to_lowercase`; its own copy used `toLocaleLowerCase`). Exports used only
  inside their module are no longer exported. Main JS 738,866 → 738,072 B,
  CSS 70,551 → 68,662 B, dist 819,427 → 816,744 B.
- **Repository.** Removed the empty `benches/`, the `.env.example` for AWS
  tests that do not exist, the Android, iOS and Windows Store icons and the
  512 px `icons/icon.png` (only the five icons `tauri.conf.json` lists are
  bundled; the Unix window icon is the first PNG there, `32x32.png`).

## Guards: leakage scan and budgets in CI (2026-10-05)

- **Leakage scan (spec section 16).** `scripts/leak-scan/leak-scan.mjs`
  (Node, no dependencies) searches files for canaries as UTF-8, UTF-16LE,
  UTF-16BE, hex and base64 (both alphabets, all three alignments); exit 1 on
  a hit, exit 2 when a file could not be read (it was never searched;
  `--allow-unreadable` lists it and passes). Compressed data is not
  unpacked. `tests/leak/session.test.mjs` (`npm run test:leak`, CI job
  "Leak scan (Linux)") runs a scripted session with random canaries in a
  folder name, a document name, three edits, the S3 secret key and the
  remembered phrase: connect, create, save, preview, an edit staged while
  the fake S3 drops connections, lock, unlock with the remembered phrase,
  read back, Trash, restore, lock, quit. While locked the outbox and
  `secrets.json` must hold no canary in any encoding. After shutdown none
  may be in the whole throwaway profile: config, secrets, outbox, WebView
  data and caches, GPU shader cache, temp, the keyring and
  `XDG_RUNTIME_DIR` (the test points it into the profile for the app, its
  D-Bus bus, the keyring and the portal and accessibility services the bus
  starts). None may be in new files in the system temp folders or the
  caller's own `XDG_RUNTIME_DIR`, the captured tauri-driver and app output,
  or any raw bucket object. Every file in the profile must have been
  readable; unreadable files in the shared temp folders (other users'
  `systemd-private-*`) are only counted. A positive control (a build that
  copied each staged text into `localStorage`) failed it with
  UTF-16LE hits in WebKit's localstorage file. Linux only: tauri-driver has
  no macOS backend, and on Windows the app's config folder cannot be
  redirected. It runs the debug build, the only one that accepts a loopback
  `http://` endpoint (the fake S3 is in the test, `tests/leak/fake-s3.mjs`).
  The app stores the secrets file's master key in a Secret Service, so the
  test starts its own D-Bus session bus and gnome-keyring (with a password,
  so the login collection exists) inside the profile and waits for the name
  before asking for it (asking earlier starts a second, passwordless keyring
  through D-Bus activation); the app never reaches a developer's real
  keychain. `tests/e2e/driver.mjs` holds the tauri-driver session code that
  the smoke test and this test share.
- **Size budgets.** `scripts/check-budgets.mjs` (`npm run check:budgets`,
  Linux CI after the build): main JS 808,000 B, boot chunk 10,200 B, CSS
  77,600 B, `dist/` 896,500 B, the overhaul's sizes plus about 10%; any
  other file in `dist/` (a worker, font, source map or extra chunk) or a
  `new Worker`, `importScripts` or service worker registration in the JS
  fails it.
- **S3 request budgets** (`src-tauri/tests/s3_budget.rs`) run in every
  CI `cargo test` on all three OSes.
- **No typing or scrolling metric in CI.** Hosted runners render WebKitGTK
  in software under Xvfb on shared CPUs; frame times there vary more than
  the regressions worth catching (typing p95 is 17–20 ms on a Mac), so a
  budget loose enough not to flake would catch nothing. They are measured
  with a scratch macOS build.

## Web version (`web/`, 2026-10-11)

A minimal, mobile-first static site that opens the same workspaces as the
desktop app (web/README.md). The desktop's `index.html`, `src/boot.ts`,
`src-tauri/` and existing modules are unchanged; the site imports them.

- **Structure**: `web/` has its own `index.html`, entry and Vite config
  (`npm run build:web` → `dist-web/`, `npm run dev:web`). No server code.
- **Codec**: `web/src/codec.ts` ports `compat/notebook_v1.rs` (PBKDF2 via
  WebCrypto, Rust `str::trim` semantics, strict base64url). AES-256-GCM-SIV
  comes from `@noble/ciphers` 2.4.0 (pinned): independently audited (Cure53,
  2024, on 1.0.0), no dependencies, small, and WebCrypto has no GCM-SIV. Compatibility
  is proven both ways by committed vectors (`tests/web/fixtures/`, written by
  each codec and checked by the other: `tests/web/codec.test.mjs`,
  `src-tauri/tests/web_compat.rs`, which compiles the real codec file with
  `#[path]` so `src-tauri/src` stays untouched) and by the MinIO run.
- **Markdown**: `marked` 18.0.14 + `DOMPurify` 3.4.16 (pinned; DOMPurify was
  already vetted for the Monaco build) configured to `preview.rs`'s allowlist,
  with the desktop's `vault-links.ts` hrefs and `h-<slug>` ids. pulldown-cmark
  is not available in the browser; differences (footnotes, bare-URL
  autolinks) are listed in web/README.md.
- **S3**: a ~150-line SigV4 header signer (WebCrypto HMAC) instead of the
  AWS SDK, checked against AWS's signing test suite and S3's documented
  examples. Conditional PUTs as on the desktop; a conflict keeps the user's
  text as `Name (conflict <ms>).md` (desktop `conflict_path`), never
  overwrites. The bucket needs a CORS rule exposing `ETag`.
- **Config**: localStorage holds the desktop `config.json` v2 object and a
  `secrets.json`-shaped object whose values are AES-GCM-sealed under a
  non-extractable IndexedDB key, AAD = the desktop's secrets context. It
  protects copies of the profile, not same-origin script (documented threat
  model). "Remember" off stores no secret. One workspace per browser.
- **Editor**: loaded with a dynamic import on the first Edit: the reading
  bundle is ~158 KB (54 KB gzip), CodeMirror ~552 KB (192 KB gzip) on demand.
- **CSP**: `<meta>` policy built by `web/vite.config.ts` (`connect-src` =
  `'self'`, AWS and `NOTEBOOK_WEB_CONNECT_SRC`), repeated with
  `frame-ancestors` in a generated `dist-web/_headers`; nginx sample in
  `web/deploy/`. `style-src 'unsafe-inline'` as on the desktop (CodeMirror).
- **Not included**: Trash, rename, move, delete, import, image paste,
  workspace manager, settings UI, auto-lock, outline, offline outbox.
- **Tests**: `npm run test:web` (Node), `npm run test:web:browser`
  (Playwright, sanitizer corpus), `npm run test:web:e2e` (MinIO in Docker,
  Chromium and WebKit at three sizes, desktop codec on both ends).
  `playwright-core` 1.59.1 is a dev dependency (matches the cached
  Chromium 1217); browsers are installed with `npx playwright-core install`.
