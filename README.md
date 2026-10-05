# Notebook

A native Tauri Markdown and HTML workspace for an S3 bucket encrypted.
Point both apps at the same
bucket and prefix, then enter the same encryption phrase. The folder names, file
names and document bodies created by either app are readable by the other.
Both apps are called Notebook; below, "the original Notebook app" means
`amed/notebook`.

## Install

Download the installer for your system from this repository's GitHub Releases
page. Release file names use dots for spaces, for example
`Notebook.Vault_0.2.0_amd64.deb`; the commands below also match the
spaced names in workflow artifacts, where the installers are under
`release/bundle/<format>/` (macOS: `universal-apple-darwin/release/bundle/dmg/`)
inside the zip. Run the commands from the folder that holds the installer. To
check a download against the release's `SHA256SUMS.txt`:

```bash
shasum -a 256 --check --ignore-missing SHA256SUMS.txt   # macOS
sha256sum --check --ignore-missing SHA256SUMS.txt       # Linux
Get-FileHash .\Notebook_*_x64*   # Windows PowerShell: compare with SHA256SUMS.txt
```

### macOS

macOS 11 or later. The `_universal.dmg` runs natively on Apple silicon and Intel
Macs. Open it and drag **Notebook** to Applications. If an earlier build named
**Secure Markdown Vault** is in Applications, delete it: it is the same app
under its old name and shares its settings. The original Notebook app installs
to `~/Applications/Notebook.app`, so both can be installed side by side, and
Launchpad and Spotlight then list two apps named Notebook.

Unless a release was signed and notarized (all six secrets under
[Code signing](#code-signing-optional); the release notes say which), macOS
blocks the first launch. Try to open the app, close the warning, then open
**System Settings > Privacy & Security** and click **Open Anyway** (shown for
about an hour after the blocked attempt). If macOS says the app is damaged, or
Open Anyway does not appear, remove the quarantine flag instead:

```bash
xattr -dr com.apple.quarantine "/Applications/Notebook.app"
```

S3 credentials and remembered encryption phrases are sealed in `secrets.json`
in the app's config folder; only that file's random master key is in your
login keychain.

### Windows

Windows 10 or 11, x64. Use either installer:

- `_x64-setup.exe` installs for the current user without administrator rights.
- `_x64_en-US.msi` installs for all users and asks for administrator rights.

The `-setup.exe` puts its Start menu shortcut in a **Notebook Vault** folder, so
it does not replace the original Notebook app's own `Notebook` shortcut.

The installers are not code-signed, so SmartScreen may show "Windows protected
your PC". Click **More info**, then **Run anyway**. If the Microsoft Edge
WebView2 runtime is missing, the installer downloads and installs it, which
needs an internet connection. Windows 11 and current Windows 10 include it.

The master key of the sealed `secrets.json` is stored in Windows Credential
Manager. Both roam with roaming user profiles (the file lives in `%APPDATA%`),
so on a domain with roaming profiles the stored access keys and remembered
phrases follow you to every computer you sign in to.

### Linux

x64 packages. Use one of:

```bash
# AppImage (any distribution)
chmod +x Notebook*Vault_*_amd64.AppImage
./Notebook*Vault_*_amd64.AppImage

# Debian, Ubuntu
sudo apt install ./Notebook*Vault_*_amd64.deb

# Fedora
sudo dnf install ./Notebook*Vault-*.x86_64.rpm
```

On Linux the files, package, and command are named Notebook Vault
(`notebook-vault`), because the original Notebook app's packages already own the
package name `notebook` and `/usr/bin/notebook`. The launcher entry is still
called Notebook. Remove the package with `sudo apt remove notebook-vault` or
`sudo dnf remove notebook-vault`. The AppImage needs FUSE, which most
desktops include. If it reports that no fusermount binary was found, install
`fuse3` (`sudo apt install fuse3`), or run it with `--appimage-extract-and-run`.

apt and dnf sort a pre-release such as `0.2.0-1` after `0.2.0`, so moving from a
pre-release package to its final release is a downgrade. Use
`sudo apt install --allow-downgrades ./Notebook*Vault_*_amd64.deb` or
`sudo dnf downgrade ./Notebook*Vault-*.x86_64.rpm`, or remove the pre-release
first. The AppImage is not affected.

The master key of the sealed `secrets.json` is stored through the freedesktop
Secret Service, so a provider must be running and unlocked on the session D-Bus. The `.deb` and `.rpm`
recommend GNOME Keyring, which apt and dnf install by default. KWallet works
only with its Secret Service interface enabled. Most GNOME and KDE desktops
provide a provider; minimal window-manager setups and the AppImage may need one
installed and started by hand. Without one, the app says that no OS keychain is
available and shows the workspace's connect screen; it cannot save or read
credentials.

## Encryption compatibility

- PBKDF2-HMAC-SHA256 with 120,000 iterations and the original Notebook app's
  exact fixed, domain-separated salts.
- AES-256-GCM-SIV for every path segment and document body.
- Deterministic path nonces derived from the plaintext parent path, matching
  the original Notebook app exactly.
- Base64url without padding for encrypted S3 path segments.
- Document bodies are `12-byte random nonce || authenticated ciphertext`.
- Empty folders use the original Notebook app's encrypted `.notebook_dir`
  object.
- The configured S3 prefix is plaintext, exactly as it is in the original
  Notebook app.

S3 credentials, and the encryption phrase when you let the app remember it,
are sealed with AES-256-GCM-SIV in `secrets.json` next to `config.json`, each
value bound to its workspace and field; only a random 32-byte master key is in
the operating-system keychain (see [Install](#install)). `config.json` holds no
secrets. Derived keys are kept in process memory only and are dropped on lock.
Signed request URLs, plaintext paths, document text, keys, and credentials are
never logged.

## Use

1. Open the app and enter the same bucket, region, prefix, access key, secret,
   optional session token, and encryption phrase used by the original Notebook
   app. This creates your first workspace, named after the bucket (rename it
   if you like); "Remember encryption phrase on this device" is checked.
2. Existing encrypted objects are listed and decrypted locally. If objects are
   present but none can be decrypted, unlock fails instead of showing nonsense
   names. If this device has no stored credentials for the workspace, or no OS
   keychain is available, the app shows the workspace's connect screen and
   says so; nothing stored is removed.
3. Edit normally. Each edit is encrypted into a local outbox on this device
   a second after you pause, and uploaded to S3 when you press Cmd/Ctrl+S,
   switch documents, leave the window, close, lock, stop typing for 30 s or
   keep typing for 2 minutes. The dot in the status bar shows unsynced
   changes (accent), offline (amber) or a failed upload (red); click it to
   upload now. Refresh re-lists S3 so changes from the other app appear.

The app supports Markdown documents and HTML pages, path-aware creation,
rename, drag-to-move, encrypted document saving, preview, title filtering,
pasted or dropped inline images, document-file import, auto-lock, and
recoverable Trash. The Markdown outline
opens from the document header; its nested heading levels can be folded one at
a time or all together, and selecting a heading jumps to its source line.
**Word count** in the status bar shows words, characters, lines and the
selected words, counted once when you click it (HTML pages: the page text,
without tags). It does not update while you type; typing, Esc or a click
elsewhere closes it. Right-click an item in the sidebar to rename it, move it
to Trash or, on a folder, create a file or folder in it; double-click or F2
also renames.

The header above the document is one line: the document's place in the
vault as a breadcrumb (`Folder / Sub / name`; the full path is the tooltip),
then icon buttons for the outline, Edit / Split / Preview, Refresh, Settings
and Lock. The workspace picker and New file / New folder sit beside it at the
top of the sidebar.

Quick open has a clear button (×) while it holds text; Esc clears it too, and
a second Esc leaves the field. The outline has a close button (×) next to
Expand and Collapse; the header's outline button opens it again.

The sidebar, the outline and the editor / preview split are resizable: drag
the edge between two panes (the accent line shows), double-click it to reset
that pane, or focus it with Tab and use Left / Right (16 px, Shift 64 px),
Home and End. The sidebar takes 180 to 480 px, the outline 180 to 420 px, and
Split's editor 20 to 80 % with at least 240 px for the editor and the preview.
A narrower window shrinks panes without changing your sizes; below 851 px Split
stacks the editor above the preview, so there is no split edge to drag, and the
outline becomes a drawer that leaves 240 px of the editor visible. The
sizes are saved with the preferences in `config.json` (once per drag, never
sent to S3); browser mode keeps them until reload.

Keyboard shortcuts (Cmd on macOS, Ctrl on Windows and Linux):

| Shortcut | Action |
| --- | --- |
| Cmd/Ctrl+S | Upload the open document now |
| Cmd/Ctrl+N, Cmd/Ctrl+Shift+N | New file, new folder |
| Cmd/Ctrl+P | Quick open (title filter) |
| Cmd/Ctrl+Shift+V | Cycle Edit, Split and Preview |
| Cmd/Ctrl+L | Lock the workspace |
| Option+Z (macOS), Alt+Z | Toggle soft wrap, as in VS Code (the key printed Z, on any layout) |
| F2 | Rename the selected item |
| Delete / Backspace (sidebar) | Move the selected item to Trash |

Soft wrap is on by default and applies to every document until you toggle it
again (until the app quits); **Wrap** in the status bar shows the state and
also toggles it. Cmd/Ctrl+Z stays Undo. Option+Z still types its character in
text fields and dialogs.
Closing the window or quitting saves the open document first: the outbox write
takes milliseconds, and S3 gets at most 3 seconds, so closing never hangs on
the network. Edits not uploaded yet wait, encrypted, in the local outbox kept
per workspace (endpoint, bucket and prefix) and are sent on the next unlock of
that workspace only. An edit whose document changed or moved on another
device is kept as a conflict copy.

### Workspaces

The app keeps any number of named workspaces, each with its own bucket,
region, prefix, optional endpoint, S3 credentials and, if you choose,
remembered encryption phrase. Names are unique (ignoring case).

- **Switch** with the workspace picker at the top of the sidebar (or "Switch
  workspace" on the unlock screen). Switching saves the open document, locks
  the current workspace and opens the other one, with its remembered phrase if
  it has one, otherwise on its unlock screen.
- **Manage** from the picker's "Manage workspaces…" or Settings → Workspace:
  add, edit, switch to or delete workspaces; each row shows whether
  credentials are stored and the phrase is remembered. Settings → "Edit
  workspace…" (and "Edit workspace" on the unlock screen) edits the active
  one. Secret fields show "Stored — leave blank to keep": editing never
  removes stored credentials. Moving the open workspace to another bucket,
  region, prefix or endpoint asks first, saves the open document and reopens
  it at the new location. While the document is saved before a switch, lock
  or move, the editor is read-only, so nothing typed meanwhile is lost.
- **Edits not uploaded yet.** If a workspace still has edits waiting in its
  outbox (for example S3 was offline), moving it to another bucket or prefix,
  or deleting it, asks first: those edits stay on this device and are only
  uploaded when a workspace points at that location again. A new endpoint for
  the same bucket and prefix takes them along.
- **Remember encryption phrase on this device** (setup, unlock and edit
  forms): with it, the app opens straight into the active workspace at launch
  ("Opening <name>…") and the idle auto-lock does not apply to it; on the
  unlock screen a blank field uses the remembered phrase. Unchecking it
  forgets the phrase, and the box then stays unchecked for that workspace
  until you check it again. A phrase that no longer opens the workspace
  leaves the remembered one untouched and asks for the phrase.
- **Delete** asks first. It removes only the workspace's stored secrets, never
  S3 objects or queued edits; the open workspace is locked first.

A configuration from an earlier build becomes one workspace named after its
bucket, and its keychain credentials move into `secrets.json` on first use.

Only one Notebook process uses a profile at a time. A second one (another
launch on Windows or Linux, or a development build next to the installed
app) shows "Notebook is already open" and changes nothing.

### Trash

Trash is Notebook's deleted-items bin, so an item deleted in either app shows
in both and can be restored or deleted permanently from either.

- Deleting moves the item, a whole folder included, into its own container
  `_deleted/items/<id>/item/<name>`, and records the original folder as
  `_deleted/items/<id>/parent/<original folder>`. The id is the deletion time
  in Unix milliseconds plus the name, as in Notebook. Every path segment is
  encrypted like any other name, so S3 shows only opaque keys.
- Trash lists each item like Notebook: its name, original location, the item
  count for a folder, and when it was deleted.
- Restore puts the item back at its original path and recreates the original
  folder if it is gone. If something now uses that path, nothing is
  overwritten or renamed: the app says so and offers **Restore to…**, where
  you pick a folder and a name.
- **Delete permanently** and **Empty Trash** remove only the bin objects of the
  listed items. Nothing is emptied automatically.
- `_deleted`, `_delete` and `.secure-vault-trash` at the top of the workspace
  never show in the tree, quick open, search or counts. None of the three can
  be used as a name.
- Items deleted by earlier builds of this app (`.secure-vault-trash/...`) are
  still listed, restorable and purgeable; new deletions always use Notebook's
  bin. Notebook itself shows `.secure-vault-trash` as an ordinary folder until
  those items are restored or purged here.

### Preview

- The preview renders tables, task lists (as read-only checkboxes), and
  footnotes. Raw HTML in the Markdown is shown as text, never run.
- `.html` and `.htm` files use HTML syntax highlighting and render as complete
  pages in Split or Preview mode. The page is static: an isolated iframe and a
  deny-by-default content policy block scripts, forms, popups, downloads and
  all network requests. Inline CSS, inline SVG and inline raster data images
  render, `#section` links scroll inside the page, and web or mail links open
  only after you confirm them. A page that needs JavaScript shows "Scripts are
  off in the preview (N not run)." The preview keeps its scroll position while
  you edit, and long pages scroll with the wheel, trackpad or keyboard and
  show the app's scrollbar (dark on light pages, light on dark ones). The full
  HTML source is encrypted and stored in S3 exactly like a Markdown document.
- The preview and the outline update a moment after you stop typing, and only
  while they are shown; switching between Edit, Split and Preview, or opening
  and closing the outline, re-renders nothing that has not changed. For
  documents over 512 KB the preview pauses: it shows "Preview paused for large
  documents." and renders the current text when you click **Render**.
- **New file** starts with the current folder's root-relative path and selects
  only the extensionless filename. A name without an extension becomes `.md`;
  an explicit extension such as `.html` is preserved. You can edit the full
  path, and missing folders are created before the encrypted document.
- Drop UTF-8 Markdown, text, or HTML files onto a folder in the sidebar to
  import them there, or elsewhere in the workspace to use the current folder.
  Files are limited to 16 MiB and their initial content is encrypted in the
  same conditional S3 create—there is no temporary plaintext or empty remote
  document. Images dropped on the editor are still embedded in the open note.
- Pasted images, which are stored inside the document, are shown. Every other
  image, including remote `http(s)` images, is replaced by an "Image blocked"
  placeholder, so opening a document never contacts a third party.
- Clicking a `https:`, `http:`, or `mailto:` link shows a dialog with the full
  URL. After you confirm, it opens in your default browser or mail app. Other
  links, and links longer than 2048 characters, are not opened. The app window
  never navigates away from the app and never opens new windows.

### Network

S3 requests honor the system proxy settings: the `HTTPS_PROXY`, `HTTP_PROXY`,
`ALL_PROXY`, and `NO_PROXY` environment variables on every OS, plus the system
proxy configuration on macOS and Windows. TLS is verified against the Mozilla
root certificates bundled with the app, not the OS trust store, so proxies that
inspect TLS by re-signing certificates are not supported.

## What the app cannot protect

While the vault is unlocked, open documents and keys are in memory, and the
operating system or other software can copy them out of the app's control:

- **Swap and hibernation files.** The OS can write app memory to disk. Use
  full-disk encryption (FileVault, BitLocker, LUKS).
- **OS crash reporters.** Release builds disable core dumps on macOS and Linux,
  but system crash reporters, notably Windows Error Reporting, can still save
  memory dumps of a crashed process.
- **Clipboard.** Copied text can be read by other apps and kept by clipboard
  managers, Windows clipboard history, or Apple's Universal Clipboard.
- **Screen capture.** Screenshots, screen recording, screen sharing, and remote
  desktop tools see whatever is on screen.
- **Remembered phrases.** A remembered phrase and the stored S3 credentials
  open with the keychain's master key, which the OS releases to the app
  without asking once you are logged in. Anyone who can use your unlocked user
  account (or read `secrets.json` and your keychain) opens the workspace, and
  the idle auto-lock does not apply to it. Leave "remember" off for a
  workspace that must ask for its phrase.
- **Bucket metadata.** Anyone with bucket access can see the number of objects,
  their sizes (not padded), upload times, request patterns, the shape of the
  folder tree, and approximate name lengths, but not names or contents.

Malware running as your user can read everything the app shows.

## Minimum S3 permissions

Scope these actions to the chosen bucket and prefix:

- `s3:ListBucket` on the bucket, restricted to the prefix where possible
- `s3:GetObject`
- `s3:PutObject`
- `s3:DeleteObject`

The original Notebook app may additionally need `s3:HeadObject` (covered by
`GetObject`) and `s3:CopyObject` (covered by source `GetObject` plus destination
`PutObject`) for its own rename/move implementation. Require TLS in the bucket
policy and enable S3 versioning if recovery from accidental permanent deletion
is important.

With versioning on, add a lifecycle rule that expires noncurrent versions; 30–90
days is a reasonable range. Longer keeps overwritten and permanently deleted
documents recoverable for longer, as ciphertext that the encryption phrase still
opens, and costs more storage. Such a rule does not affect the app's Trash,
whose items are current objects.

## Development

Requirements: Node.js 22.12+, Rust 1.90+, and the
[platform prerequisites for Tauri 2](https://v2.tauri.app/start/prerequisites/).

```bash
npm ci
npm run build                               # type-check and bundle the frontend
npm run tauri -- dev                        # desktop app with hot reload
npm run tauri -- build --debug --no-bundle  # debug binary, no installers
```

`index.html` loads `src/boot.ts`, which imports `src/main.ts` dynamically so a
failure while loading the editor shows a startup error instead of a blank
window.

`npm run dev` serves the UI alone at `http://127.0.0.1:1420`. In a browser it
shows local sample workspaces kept in memory (`src/workspaces.ts`
`MemoryWorkspaces`, same rules as the Rust commands; the phrase `wrong` fails,
any other opens the sample tree; `?first-run` starts without workspaces),
because a browser cannot call the hardened Rust command layer; nothing
touches S3 or the keychain. `npm run tauri -- dev` runs
the real desktop app against that dev server.

## Testing

```bash
npm test
cargo test --manifest-path src-tauri/Cargo.toml
node --test "tests/unit/*.test.mjs"
```

`npm test` runs the strict TypeScript check and then the Rust suite;
`npm run build` also type-checks before bundling. `tests/unit/` checks without
a browser that an edit is always saved into the document it was typed in, also
when documents are switched quickly, an open fails, or an item is renamed, and
the save model's budgets (at most 16 uploads and 60 status changes in a
30-minute typing trace, nothing sent for Cmd/Ctrl+S without changes, close
within 3 s while S3 hangs); Node 22.18 or newer runs the TypeScript module
directly. `src-tauri/tests/s3_budget.rs` runs the commands against an
in-process fake S3 that counts requests and connections and can hang. The Rust suite covers
fixed-format compatibility, wrong-key authentication, tree reconstruction,
reserved-name validation, signed request parsing, and a wire-boundary canary
test proving that plaintext document names and contents do not occur in PUT
requests.

`scripts/notebook-compat.sh` proves that Trash works with Notebook's own code
(Docker, `rsync`, `openssl` and curl 7.75 or newer are required):

```bash
scripts/notebook-compat.sh /path/to/notebook-checkout
```

It copies the Notebook checkout to a scratch folder (the checkout is not
changed), adds the small harness in `src-tauri/tests/notebook-harness/` that
drives Notebook's delete, restore and permanent-delete commands, builds it,
starts a throwaway MinIO container on `127.0.0.1` with random fake credentials
and bucket, and runs `src-tauri/tests/notebook_bin_compat.rs`. The test deletes
items in Notebook and checks this app's Trash against Notebook's catalog
(names, locations, counts, times and order), restores and purges here and
checks Notebook's view, does the reverse, checks the restore conflict in both
apps, and covers legacy `.secure-vault-trash` entries. Without
`NOTEBOOK_MINIO_URL` the test is skipped, so plain `cargo test` never needs
Docker. MinIO no longer publishes images on Docker Hub or quay.io, so the
script runs Bitnami's legacy build of the MinIO server
(`bitnamilegacy/minio`); `NOTEBOOK_COMPAT_MINIO_IMAGE` picks another image
with a `minio` binary.

`npm run test:e2e` runs the `tauri-driver` WebDriver smoke test in `tests/e2e/`
against the release binary in a throwaway profile. It checks that the setup
screen renders from the embedded frontend, IPC works, the CSP blocks inline
scripts but allows the editor worker, links open only through the confirmation
dialog, the window never navigates away or opens another window, even when
page script bypasses the link handler, and page script cannot close, minimize
or maximize the window or listen to events. `tauri-driver` supports Linux and
Windows only; on macOS the test is skipped.

```bash
cargo install tauri-driver --locked
sudo apt install webkit2gtk-driver xvfb   # Debian, Ubuntu: WebKitWebDriver
npm run tauri -- build --no-bundle
npm run test:e2e   # headless: dbus-run-session -- xvfb-run -a npm run test:e2e
```

On Windows, install the Microsoft Edge Driver whose version exactly matches the
installed Edge and put `msedgedriver.exe` on `PATH`; a mismatch can make the
test hang. The Windows run refuses to start if
`%APPDATA%\com.securemd.vault\config.json` exists, because that folder cannot be
redirected, so use a clean profile. `NOTEBOOK_E2E_APP` overrides the app
binary (default `src-tauri/target/release/notebook-vault` on Linux and
`notebook.exe` on Windows), and `TAURI_DRIVER` and `TAURI_NATIVE_DRIVER`
override the `tauri-driver` and native driver paths.

Before each release, check by hand on every OS (on macOS this replaces the
end-to-end test): unlock, create, edit, save, close, reopen, Trash and restore;
shortcuts; outline folding and heading jumps; Word count (opens on click,
closes on typing, Esc and click-away); every sidebar context-menu item with
the mouse; HTML page rendering (styles,
SVG, a `#section` link, a web link, a page with a script); image paste
and rendering; preview links; window behavior; high-DPI screens; dark mode;
and Unicode in names and text (emoji, CJK, right-to-left, combining accents).

The **CI** workflow runs on pushes to `main`, pull requests, and manual
dispatch: build, format check, Clippy, and tests on Linux, macOS, and Windows;
the end-to-end test against a release build on Linux and Windows; and
supply-chain audits. The same checks locally:

```bash
cargo install cargo-audit cargo-deny --locked   # once
cargo fmt --manifest-path src-tauri/Cargo.toml --all --check
cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets -- -D warnings
npm audit --omit=dev
cargo audit --file src-tauri/Cargo.lock
cargo deny --manifest-path src-tauri/Cargo.toml --locked check
```

## Build installers locally

Installers cannot be cross-compiled: each OS builds its own. Install the
requirements from [Development](#development) first; outputs land under
`src-tauri/target/`.

### macOS

Requires Xcode or the Command Line Tools (`xcode-select --install`) and Rust
(rustup). One command builds a universal app for Apple silicon and Intel; it
finds Homebrew's rustup, adds both targets and installs npm packages if needed:

```bash
npm run build:mac
```

Add `-- --install` to replace `/Applications/Notebook.app` with the new build.

Output: `src-tauri/target/universal-apple-darwin/release/bundle/dmg/` (the
`.dmg`) and `.../bundle/macos/` (the `.app`). Without `--target`, the build
is for the current architecture only and lands in
`src-tauri/target/release/bundle/`.

### Windows

Requires:

- Visual Studio Build Tools with the **Desktop development with C++** workload
- Rust with the MSVC toolchain (`x86_64-pc-windows-msvc`) as the default
- The WebView2 runtime, already included in Windows 10 1803+ and Windows 11
- For the `.msi`, the VBSCRIPT optional Windows feature (on by default on most
  systems)

```bash
npm ci
npm run tauri -- build
```

Output: `src-tauri\target\release\bundle\msi\` (`.msi`) and
`src-tauri\target\release\bundle\nsis\` (`-setup.exe`).

### Linux

On Debian or Ubuntu:

```bash
sudo apt update
sudo apt install libwebkit2gtk-4.1-dev libxdo-dev libssl-dev \
  libayatana-appindicator3-dev librsvg2-dev libdbus-1-dev pkg-config \
  build-essential file curl xz-utils
npm ci
npm run tauri -- build
```

Output: `src-tauri/target/release/bundle/appimage/`, `.../bundle/deb/`, and
`.../bundle/rpm/`. Building the AppImage downloads `linuxdeploy` from GitHub.

## Release

The version lives in `package.json`, `package-lock.json`,
`src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, and `src-tauri/Cargo.lock`.
Set all of them at once, then commit, tag, and push:

```bash
npm run version:set -- 0.2.0
git commit -am "Release v0.2.0"
git tag v0.2.0 && git push origin main v0.2.0
```

Versions must be `major.minor.patch` or `major.minor.patch-N` with a numeric
`N`. Major and minor are at most 255, and patch and `N` at most 65535 (Windows
Installer limits). Build metadata (`+...`) is rejected so tags stay
unambiguous. `version:set` rejects other forms and writes nothing unless every
file has the expected layout; if a write fails partway, it restores the files
it already changed.

Pushing a `v*.*.*` tag starts the **Release** workflow. It fails early unless
the tag equals `v` plus the version in each of those files, then builds every
platform from the committed lockfiles (`npm ci`, `cargo --locked`) and uploads
the installers and a `SHA256SUMS.txt` to a **draft** GitHub release titled
"Notebook v0.2.0":

- macOS universal `.dmg`
- Windows x64 `.msi` and `-setup.exe`
- Linux x64 `.AppImage`, `.deb`, and `.rpm`

A `-N` version is marked as a pre-release; on Linux, apt and dnf treat the later
final release as a downgrade (see [Linux](#linux)). Review the draft on GitHub,
then publish it. Running the Release workflow manually (Actions > Release > Run
workflow) builds the same installers and attaches them to the workflow run as
artifacts only; no release is created.

## Code signing (optional)

macOS signing and notarization use these repository secrets (Settings > Secrets
and variables > Actions). The Release workflow passes each one to the build only
when it is non-empty. Without them, macOS builds are ad-hoc signed and not
notarized, and users see the first-launch warning described under
[Install](#macos).

| Secret | Value |
| --- | --- |
| `APPLE_CERTIFICATE` | Base64 of the exported `.p12` containing a **Developer ID Application** certificate and its private key (`openssl base64 -A -in certificate.p12`) |
| `APPLE_CERTIFICATE_PASSWORD` | Password chosen when exporting the `.p12` |
| `APPLE_SIGNING_IDENTITY` | The certificate's keychain name, as listed by `security find-identity -v -p codesigning`, for example `Developer ID Application: Name (TEAMID)` |
| `APPLE_ID` | Apple Account email used for notarization |
| `APPLE_PASSWORD` | An app-specific password for that Apple Account |
| `APPLE_TEAM_ID` | The 10-character Team ID from the Apple Developer membership page |

Set all three signing secrets or none. Notarization needs the three
notarization secrets as well as signing; the workflow fails on a partial set.
Both require a paid Apple Developer Program membership.

Windows code signing is not set up yet, so Windows installers are unsigned and
trigger SmartScreen.
