# Secure Markdown Vault — Build Specification

Oct 1, 2026

## 1. Purpose and scope

Build a small desktop Markdown editor (Tauri 2, Rust, Monaco) that encrypts every document, image and piece of metadata on the device before it reaches a user-owned AWS S3 bucket. S3 stores only ciphertext under opaque UUID keys. The passphrase and all keys never leave the device.

When goals conflict, resolve them in this order:

1. **Security.** Zero-knowledge storage, authenticated encryption, no intentional plaintext on disk.
2. **Data safety.** Never replace a valid object with a broken one. The index never points to a missing object.
3. **Few S3 requests.** No LIST, no HEAD, lazy loading, debounced writes, batched deletes.
4. **Small footprint.** Few dependencies, trimmed Monaco, no background services.
5. **Simplicity.** The smallest feature set that supports the core workflow.

### In scope for v1

- Create a vault, unlock it, lock it (manually and after idle time).
- Folder tree: create, rename, move, delete to Trash, restore, delete permanently.
- Markdown editing in Monaco with a toggleable preview. It should edit and show HTML type files.
- Image drag-and-drop and clipboard paste.
- Autosave with four visible states: Saving, Saved, Offline, Save failed.
- Title search over the index.
- Passphrase change.
- Settings: bucket, region, prefix, endpoint override, credentials, auto-lock timeout config (auto lock could be disabled).

### Out of scope for v1

Plugins, extensions, terminal, Git, sync folders, full-text search across unopened documents, collaboration, sharing links, mobile or web versions, SVG images, remote images in the preview, automatic Trash purging, application auto-update and multipart uploads.

### Accepted metadata leakage

A person with bucket access can see the number of objects, their sizes, upload times, request patterns and which object is the index. They cannot see names, folder structure, content, image content, or which items are in Trash. Size padding is not implemented in v1; document this in the README.

## 2. Technology stack

Use the latest stable release of each item at project start, then pin it: commit `Cargo.lock` and `package-lock.json`. Turn off default features wherever a crate allows it.

| Layer | Choice | Reason |
| --- | --- | --- |
| Desktop shell | Tauri 2 | Uses the system WebView instead of bundling Chromium |
| Frontend build | Vite + TypeScript, no UI framework | The UI is a sidebar, an editor and a status bar; a framework adds weight |
| Editor | `monaco-editor`, ESM build, `editor.api` entry only | Required by the project; trimmed in section 10 |
| S3 client | `rusty-s3` (request signing) + `reqwest` with `rustls-tls` | Only four operations are needed; the official AWS SDK is much heavier |
| Async runtime | `tokio` (already used by Tauri) | No extra runtime |
| Encryption | `aes-gcm` (AES-256-GCM) | Audited RustCrypto crate |
| Key derivation | `argon2` (Argon2id) | Password hardening |
| Subkeys and image hashing | `hkdf`, `hmac`, `sha2` | Separate keys per purpose |
| Randomness | `getrandom` (OS source) | Nonces, salts, vault key |
| Secret hygiene | `zeroize`, `secrecy` | Wipe keys and plaintext buffers on drop |
| IDs | `uuid` (v4) | Opaque object names |
| Serialization | `serde`, `serde_json` | Index and envelope payloads |
| Markdown preview | `pulldown-cmark` | Rendered in Rust |
| HTML sanitizing | `ammonia` | Blocks scripts in rendered Markdown |
| Credentials | `keyring` | OS keychain on all three platforms |
| Errors and logs | `thiserror`, `tracing` | Typed errors, filtered logging |
| Tests | `proptest`, `criterion`, MinIO in Docker | Property, benchmark and S3 integration tests |
| Supply chain | `cargo-audit`, `cargo-deny`, `npm audit` | Run in CI on every build |

Rule for the code agent: do not add a dependency outside this table without writing down why in the pull request. Never implement a cryptographic primitive by hand.

## 3. Architecture and trust boundaries

The WebView only displays and edits; Rust holds every key, every plaintext buffer and the only route to the network and disk. Only the `store` module talks to S3, and it only ever sends ciphertext.

```text
+---------------------------------------------------------------------+
| WebView (TypeScript): UI only, no keys, credentials or file access  |
|   Monaco editor        Sidebar and Trash        Preview             |
|   in-memory models     tree, search, restore    sanitized HTML      |
+---------------------------------------------------------------------+
        |  IPC: allowlisted commands               ^  secure-img:// images
        v                                          |
+---------------------------------------------------------------------+
| Rust core: keys, plaintext, network and disk access                 |
|   commands        validate every input, errors as safe codes        |
|   session         keys and index in memory, idle lock, wipe on lock |
|   vault           index, folders, name rules, Trash + .origin       |
|   crypto          Argon2id, HKDF subkeys, AES-256-GCM envelopes     |
|   sync scheduler  debounce, write ordering, conflicts, retries      |
|   render          pulldown-cmark + ammonia, secure-img scheme       |
|   store           GetObject, conditional PutObject, DeleteObjects   |
+---------------------------------------------------------------------+
        |  outbox, keychain                        |  HTTPS, ciphertext only
        v                                          v
+-------------------------------+   +---------------------------------+
| Local disk (on device)        |   | Your S3 bucket (outside device) |
|   OS keychain: credentials    |   |   index    KDF header + index   |
|   Encrypted outbox            |   |   o/<uuid>.enc  docs + images   |
|   Config file (no secrets)    |   |   Sees count, sizes, timing;    |
|                               |   |   never names, content, Trash   |
+-------------------------------+   +---------------------------------+
```

The WebView reaches Rust only through allowlisted IPC commands and gets images back through the in-memory `secure-img` scheme. Section 15 maps each box to its source file.

## 4. Cryptography

A random vault key encrypts everything; the passphrase only wraps that key. Changing the passphrase therefore rewrites one small header, not every object.

### Key hierarchy

```text
passphrase (UTF-8, normalized to NFC)
  └─ Argon2id(salt, params) ──────────────► KEK (32 bytes, never stored)
                                              └─ unwraps ─► VK (vault key, 32 random bytes)
VK ─ HKDF-SHA256(salt = vault_id, info = "content-v1") ─► CK  (encrypts index body, docs, images)
VK ─ HKDF-SHA256(salt = vault_id, info = "dedupe-v1")  ─► DK  (HMAC key for image deduplication)
```

- Normalize the passphrase to Unicode NFC so the same passphrase works on Windows, macOS and Linux.
- Argon2id defaults: memory 128 MiB, 3 iterations, 1 lane, 16-byte random salt. At vault creation, calibrate toward 0.5–1.0 s on the current machine. Never go below 64 MiB and 3 iterations.
- On unlock, reject parameters outside these bounds before running the KDF: memory 64 MiB to 2 GiB, iterations 3 to 10, lanes 1 to 8. This stops a tampered header from freezing the app.
- VK is wrapped with AES-256-GCM under KEK. The wrap's associated data is the full plaintext index header, so editing any header field makes unlock fail.

### Encrypted object envelope

Every object, including the index body, uses this byte layout:

```text
offset  size  field
0       4     magic "SMDV"
4       1     format version (0x01)
5       12    nonce (random, from the OS)
17      n+16  AES-256-GCM ciphertext followed by its 16-byte tag
```

Associated data (authenticated, not stored) is `magic ‖ version ‖ vault_id ‖ object_id ‖ object_kind`, where `object_kind` is 1 = index body, 2 = document, 3 = image. The reader always knows the expected ID and kind from the index. This binding means an attacker cannot swap one object for another, put an image where a document belongs, or replay an object from a different vault.

### Plaintext payloads (inside the envelope)

- **Document:** JSON `{"v":1,"rev":<u64>,"modified":<unix ms>,"text":"…"}`. `rev` goes up by one on every save.
- **Image:** 1 byte payload version, 1 byte MIME code (1 PNG, 2 JPEG, 3 GIF, 4 WebP), then the raw image bytes.
- **Index body:** JSON of the index structure in section 6.

### Nonces

Each encryption takes a fresh 96-bit nonce from the OS random source. Random nonces are safe far beyond this app's volume (the limit is about 2³² encryptions per key). Never derive a nonce from a counter, timestamp or object ID.

### Rollback detection (best effort)

- The index stores each document's last known `rev`. When a document loads with a lower `rev`, show a warning that it may have been rolled back.
- The app stores the last seen index revision number in its local config (a number, not sensitive). A downloaded index with a lower revision triggers the same warning.

### Unlock and error messages

1. GET the index object (one request).
2. Parse the header and check the KDF bounds.
3. Run Argon2id and unwrap VK. A failure here shows **"Incorrect passphrase."**
4. Derive CK and DK, then decrypt the index body. A failure here shows **"The vault index is damaged."**

Never show which internal check failed beyond these two messages.

### Passphrase change and its limit

Passphrase change creates a new salt, derives a new KEK, re-wraps the same VK and rewrites the index. If bucket versioning is on, older index versions still hold VK wrapped under the old passphrase. A user who changes the passphrase because it leaked therefore needs a full re-key (new VK, every object re-encrypted). That is out of scope for v1; the settings screen must state this plainly.

## 5. S3 layout and request budget

The app uses exactly three S3 operations: GetObject, PutObject (with conditional headers) and DeleteObjects. It never calls ListObjects, HeadObject, CopyObject or multipart uploads. The `ObjectStore` trait (section 15) exposes only these three, so no other call can be added by accident.

### Bucket layout

```text
<bucket>/<prefix>/
  index              plaintext header + encrypted index body
  o/<uuid>.enc       documents and images, same prefix, same envelope
```

Documents and images share one prefix so their type is not visible from the key.

### Index object layout

```text
offset  size  field
0       4     magic "SMDI"
4       1     format version (0x01)
5       4     header length H (u32, little-endian)
9       H     header JSON: vault_id, created, kdf {alg, m_kib, t, p, salt}, wrap {nonce, ciphertext}
9+H     ...   index body in the standard envelope (section 4)
```

### Requests per action

| Action | S3 requests | Notes |
| --- | --- | --- |
| Unlock | 1 GET | Header and encrypted index in one object |
| Browse tree, title search | 0 | Served from the in-memory index |
| Open a document, first time this session | 1 GET | Kept in memory until lock |
| Open it again | 0 | |
| Typing | 0 | Debounced (section 8) |
| Save document content | 1 PUT | Conditional on the last known ETag |
| Create document | 1 PUT + index flush | Empty encrypted document written first |
| Create folder, rename, move | 0 + index flush | Index-only change |
| Delete to Trash, restore | 0 + index flush | Index-only change (section 7) |
| Insert a new image | 1 PUT + index flush | |
| Insert a duplicate image | 0 + index flush | Deduplicated by keyed hash |
| Show an image, first time this session | 1 GET | Kept in memory |
| Empty Trash or delete permanently | 1 DeleteObjects per 1,000 objects + index flush | Never automatic |
| Change passphrase | 1 PUT | Index only |
| Lock or close | Pending PUTs + at most 1 index PUT | Flush before wiping memory |

An "index flush" is one conditional PUT of the index, debounced so many changes share one upload (section 8). A typical hour of work is about 1 GET to unlock, 1 GET per opened document, 20–60 document PUTs and a handful of index PUTs.

### S3 behaviors the code must handle

- **Conditional writes.** AWS S3 supports `If-Match` and `If-None-Match: *` on PutObject. A mismatch returns HTTP 412. Check that the local test server supports them too; if it does not, run the conflict tests only against a real AWS test bucket.
- **ETags are opaque.** Store them as strings and compare them exactly. Do not assume they are MD5 hashes (they are not with KMS encryption).
- **Missing objects can return 403.** Without the `s3:ListBucket` permission (which this app does not need), a GET for a missing key returns 403 instead of 404. Treat both as "object missing or not permitted" and report it as a damaged-vault condition, not a crash.
- **Size limits.** Reject documents over 50 MB and images over 20 MB before encrypting. Both stay far below the 5 GB single-PUT limit, so multipart is never needed.
- **HTTPS only.** Refuse plain `http://` endpoints, except in test builds with an explicit flag for the local S3 server.
- **Retries.** Retry GET and PUT on network errors, 500, 503 and throttling (SlowDown), with exponential backoff and jitter (0.5 s, 1 s, 2 s, 4 s, capped at 30 s). Never retry a 412 automatically; it means a conflict.

### Request-budget tests

The in-memory `ObjectStore` counts calls by type. Tests assert the counts in the table above for each scenario, so any change that adds requests fails CI.

## 6. Vault index and virtual filesystem

The encrypted index is the only source of truth for names, folders and Trash. All filesystem operations are pure functions on the in-memory index; S3 work happens afterwards, in the save pipeline.

### Schema

```rust
pub const ROOT_ID: Uuid  = uuid!("00000000-0000-0000-0000-000000000001");
pub const TRASH_ID: Uuid = uuid!("00000000-0000-0000-0000-000000000002");

pub struct Index {
    pub format: u32,                          // 1
    pub revision: u64,                        // +1 on every index upload
    pub nodes: BTreeMap<Uuid, Node>,
    pub images: BTreeMap<Uuid, ImageMeta>,
    pub image_dedupe: BTreeMap<String, Uuid>, // hex HMAC-SHA256(DK, image bytes) -> image id
    pub pending_purge: Vec<Uuid>,             // object ids waiting for DeleteObjects
}

pub struct Node {
    pub id: Uuid,              // for documents, also the S3 object id
    pub parent: Option<Uuid>,  // None only for ROOT and TRASH
    pub name: String,
    pub created: i64,          // unix ms
    pub modified: i64,
    pub kind: NodeKind,
}

pub enum NodeKind {
    Folder,
    Document { size: u64, rev: u64, images: Vec<Uuid> },
    TrashEntry,                // container made by one delete (section 7)
    TrashOrigin(Origin),       // the tandem metadata file (section 7)
}

pub struct ImageMeta { pub mime: u8, pub size: u64, pub original_name: String, pub created: i64 }
```

### Name rules

- Names are NFC-normalized, trimmed, 1–255 characters, with no `/` and no control characters.
- Names are unique within a folder, compared case-insensitively, so behavior matches Windows and macOS.
- New items get the first free name: "Untitled", "Untitled 2", "Untitled 3".
- Renaming to a taken name is rejected with a clear message.
- Moving or restoring into a folder that already has that name adds " (2)", " (3)" and so on, and tells the user.
- Items inside Trash are exempt from these rules, because each deletion gets its own container (section 7).

### Operations

Each operation is a variant of an `Op` enum. It validates its input, changes the index, and returns the S3 work it needs (objects to upload or delete). Applied operations are kept in an in-memory log until the next successful index upload, so they can be replayed after a conflict (section 8).

| Op | Index change | S3 work |
| --- | --- | --- |
| `CreateFolder(parent, name)` | Add folder node | None |
| `CreateDocument(parent, name)` | Add document node | PUT empty document (`If-None-Match: *`) before the index flush |
| `Rename(id, name)` | Change name | None |
| `Move(id, new_parent)` | Change parent | None |
| `Trash(id)` | Section 7 | None |
| `Restore(entry_id)` | Section 7 | None |
| `Purge(entry_id)` / `EmptyTrash` | Section 7 | DeleteObjects after the index flush |
| `AddImage(bytes, name)` | Add image (or reuse a duplicate) | PUT image before the index flush |
| `DocSaved(id, size, rev, images)` | Update size, rev, modified and image list | None (low-priority flush) |

Move rules: a folder cannot move into itself or its own subfolders; nothing moves into or out of Trash with `Move` (use `Trash` and `Restore`); items inside Trash are read-only.

Image references: on every save, scan the text for `secure-img://<uuid>` and store the IDs on the document node. Permanent deletion uses this list to know which images are still in use.

### Invariants

`Index::validate()` runs after every load and, in debug builds, after every operation. Property tests generate random operation sequences and check it every step.

1. ROOT and TRASH exist exactly once.
2. Every other node's parent exists, and there are no cycles.
3. Folders and documents live under ROOT or inside a Trash entry.
4. TRASH contains only `TrashEntry` nodes.
5. Each `TrashEntry` holds exactly two children: one item (folder or document) and one `TrashOrigin`.
6. `TrashOrigin` appears only inside a `TrashEntry`.
7. Names are unique per folder (case-insensitive) everywhere outside Trash.
8. Every image a document references exists in `images`.
9. No ID in `pending_purge` appears in `nodes` or `images`.

## 7. Trash

Deleting moves the item into Trash, inside a new entry folder of its own, next to a tandem `.origin` file that records where it came from. Every deletion gets its own entry, so two deleted items with the same name never conflict. Nothing moves in S3: Trash exists only in the encrypted index, so a bucket observer cannot tell what is in it. Trash is never emptied automatically.

### Structure

```text
Trash/
├─ entry 7f3a…            TrashEntry, one per delete
│  ├─ notes.md            the deleted document
│  └─ .origin             from /Projects/Titan, deleted 2026-10-01 14:02
├─ entry 91c0…
│  ├─ notes.md            a different notes.md, no conflict
│  └─ .origin             from /Personal
└─ entry b44e…
   ├─ Titan/              a deleted folder, subtree unchanged
   │  ├─ plan.md
   │  └─ Research/…
   └─ .origin             from /Projects
```

### The tandem origin file

```rust
pub struct Origin {
    pub item_id: Uuid,          // the trashed folder or document
    pub parent_id: Uuid,        // the folder it was in when deleted
    pub path: Vec<String>,      // folder names from root to that parent, captured at deletion
    pub name: String,           // the item's name at deletion
    pub deleted_at: i64,        // unix ms
    pub item_kind: ItemKind,    // Folder | Document
    pub doc_count: u32,         // summary for the Trash view and the purge dialog
    pub folder_count: u32,
    pub image_count: u32,
}
```

The `.origin` file is a real node in the virtual filesystem, but its small content is stored inline in the index rather than as its own S3 object. Deleting therefore costs no extra requests, and the origin can never be separated from its entry. If a later version needs the tandem as a separate encrypted object, the node shape stays the same.

### Delete to Trash: `Trash(id)`

1. Reject ROOT, TRASH and anything already inside Trash. (Inside Trash, Delete means permanent delete; see below.)
2. Flush pending saves for every open document in the item's subtree, then close those editors. The latest text must reach S3 before it becomes read-only.
3. Create a `TrashEntry` node with a new UUID under TRASH. Its name is that UUID; users never see it.
4. Build the `Origin`: parent ID, folder-name path, item name, time and counts.
5. Move the item into the entry. Its subtree, names and document IDs do not change.
6. Create the `TrashOrigin` node named `.origin` in the same entry.
7. Log the operation and schedule a high-priority index flush. S3 requests: 0, plus the index flush.

### Trash view

- A flat list of entries, newest first. Each row shows the item's name and icon, "from /Projects/Titan", the deletion date and, for folders, the counts.
- Expanding a folder entry shows its subtree, read-only.
- Opening a document in Trash shows it read-only with a banner: "In Trash. Restore to edit."
- The `.origin` file appears as the "from" line and in an Info panel, never as an editable file.
- Title search excludes Trash unless the user turns on "Include Trash".

### Restore: `Restore(entry_id, mode)`

Pick the destination with the first rule that applies:

1. **Original folder still live** (under ROOT, not in Trash): restore there. This follows any rename or move of that folder since the deletion.
2. **Original folder is itself in Trash:** ask the user. "Restore the folder too" restores that folder's entry first, then puts this item inside it. "Recreate the path" falls through to rule 3. The API takes `mode` so tests and scripts need no dialog.
3. **Original folder is gone, or the user chose to recreate:** walk `path` from ROOT. Reuse a live folder with each name (case-insensitive) or create it, then restore into the last one.

Then:

4. If the destination already has an item with that name, add " (2)", " (3)" and so on, and tell the user.
5. Move the item to the destination, then remove the `.origin` node and the entry node.
6. Log the operation and schedule a high-priority index flush. S3 requests: 0, plus the index flush.

"Restore to…" with a folder picker is a secondary action that skips the rules above.

### Permanent delete: `Purge(entry_id)` and `EmptyTrash`

Only the user starts this, from "Delete permanently" on an entry or "Empty Trash". A confirmation dialog shows the counts and says this cannot be undone in the app. Pressing Delete on anything inside Trash purges its whole entry; deleting part of a trashed folder is not supported in v1.

1. Collect every document ID in the chosen entries.
2. Collect the images those documents reference. An image is kept if any other document, live or in another Trash entry, still references it. The rest are orphaned.
3. Remove the entry nodes, orphaned images and their dedupe records from the index. Add the document IDs and orphaned image IDs to `pending_purge`.
4. Upload the index (conditional PUT). Continue only if this succeeds.
5. Call DeleteObjects on `pending_purge` in batches of 1,000. Remove each key S3 reports as deleted (a key that was already missing counts as deleted).
6. Record the shorter `pending_purge` in the next index flush. If anything remains, retry in the background after the next unlock.

This order means a failure can leave unused ciphertext in S3, but the index never points to a missing object.

### Bucket versioning and permanent delete

With versioning on, DeleteObjects hides the current version; older versions stay until the bucket's own lifecycle rule removes them (section 12). Erasing all versions would need list permissions and extra requests, so it is out of scope for v1. The confirmation dialog states this when versioning is enabled. This is separate from Trash, which never expires.

## 8. Save pipeline, conflicts and offline

Rust owns all saving. The frontend only reports text changes; a scheduler in Rust decides when to encrypt and upload, enforces write ordering and resolves conflicts.

### Timings

| Setting | Value |
| --- | --- |
| Frontend to Rust text update | 500 ms after the last keystroke |
| Document upload | 2 s after the last update |
| Document upload while typing non-stop | At least every 30 s |
| Index flush after a structural change | 1.5 s after the last change |
| Index flush for metadata only (`DocSaved`) | Within 60 s, or with the next structural flush, or on lock and close |
| Parallel uploads | 4 at most, 1 per object |
| Retry backoff | 0.5 s doubling to 30 s; offline check every 60 s |

Window blur, document switch, lock and close trigger an immediate flush of everything pending.

### Document save

1. The frontend calls `doc_update(id, text)`. Rust stores the text in a zeroizing buffer and marks the document dirty.
2. When its timer fires, Rust increments `rev`, builds the payload, encrypts it and PUTs it with `If-Match: <last ETag>` (`If-None-Match: *` for a new document).
3. On success, Rust stores the new ETag and applies `DocSaved` to the index (low-priority flush).
4. Edits during an upload mark the document dirty again; the next upload starts after the current one ends.

### Write-ordering rules

1. A new document or image object is uploaded and confirmed before any index that references it is uploaded. The index flush waits for those PUTs.
2. An object is deleted only after an index without it has been uploaded (section 7).
3. Saving document content never waits for the index.

Together these keep the stored index from ever pointing to a missing object.

### Conflicts (same user, several devices)

- **Document returns 412.** GET the remote copy and decrypt it, then show: "This document changed on another device." Options: *Keep mine* (PUT with the new ETag), *Keep theirs* (load the remote text), *Keep both* (save mine as "name (conflict 2026-10-01 14:02)" in the same folder). Autosave for that document pauses until the user chooses.
- **Document no longer exists** (purged on another device): save the local text as a new document "name (recovered)" in the vault root. Typed text is never discarded.
- **Index returns 412.** GET the latest index, decrypt it and replay the local operation log on top of it. Drop any operation that no longer applies (for example, renaming an item that was purged elsewhere) and report it in a notice. Then PUT again with the new ETag. After 3 failed rounds, show Save failed.
- **Metadata merges:** for `DocSaved`, the higher `rev` wins.

### Offline outbox

- After retries fail with network errors, the state becomes Offline. Uploads keep retrying in the background.
- While Offline, or after any failed upload, pending envelopes are also written to an encrypted outbox on disk: `<app data>/outbox/<vault_id>/`. Each file is the exact ciphertext that would go to S3. A manifest (object ID, kind, expected ETag) is encrypted with CK too.
- Files are written atomically: temporary file, flush to disk, then rename.
- After the next unlock, the outbox uploads first, following the conflict rules. Each file is deleted once its PUT succeeds.
- When online, the outbox is not used. A crash during normal online work can lose at most the text typed since the last upload (2–30 s). This is a deliberate trade-off to avoid constant disk writes.

### Status indicator

| State | Meaning |
| --- | --- |
| Saving | An upload is running or a change is waiting for its timer |
| Saved | Every document and the index are uploaded |
| Offline | S3 is unreachable; changes are kept in memory and the encrypted outbox |
| Save failed | A non-retryable error (permissions, unresolved conflict, size limit); clicking shows a safe description and a Retry button |

### Lock and close

Flush everything with a 10 s limit. If uploads are still pending, ask: *Wait* or *Lock anyway*. Lock anyway writes the pending envelopes to the encrypted outbox, then wipes memory (section 14).

## 9. Images and Markdown preview

Images travel as bytes from the WebView to Rust, are encrypted there, and come back to the preview through a custom URI scheme served from memory. No image file path crosses the IPC boundary and no decrypted image touches the disk.

### Adding an image

1. Sources: drag-and-drop onto the editor, and clipboard paste. Set the window's `dragDropEnabled` to `false` so the WebView receives standard HTML5 drop events with the file bytes. The frontend needs no filesystem permission.
2. The frontend sends the bytes to `image_add` as a raw binary IPC body, with the original filename in a request header.
3. Rust rejects anything over 20 MB, then checks the magic bytes: PNG `89 50 4E 47`, JPEG `FF D8 FF`, GIF `47 49 46 38`, WebP `RIFF….WEBP`. Everything else is rejected, including SVG, which can carry scripts.
4. Rust computes HMAC-SHA256(DK, bytes). If that hash is already in `image_dedupe`, it reuses the existing image ID: no upload.
5. Otherwise Rust creates a UUID, encrypts the image (kind 3), queues a PUT with `If-None-Match: *`, records the `AddImage` operation and keeps the plaintext bytes in the image cache.
6. Rust returns `![<name>](secure-img://<uuid>)`. The alt text is the filename without its extension, with `[` and `]` removed, or "image" if empty. The frontend inserts it at the drop point or cursor.

The Markdown can be inserted before the PUT finishes, because the index flush waits for that PUT (section 8).

### Image cache

Decrypted images live in an in-memory LRU cache capped at 256 MB. It is wiped on lock. A cache miss costs one GET.

### Preview rendering

- Modes: off, side by side, preview only. The preview re-renders 300 ms after a text update, and only while visible.
- `render_preview(doc_id)` renders the text Rust already holds; the frontend does not resend it.
- `pulldown-cmark` options: tables, strikethrough, task lists, footnotes. Raw HTML in the Markdown is shown as plain text, never passed through.
- `ammonia` allowlist: `p h1–h6 ul ol li blockquote pre code em strong del a img table thead tbody tr th td hr br sup section input`. Attributes: `href` on links; `src alt title` on images; `align` on table cells; `type checked disabled` on task-list checkboxes. Links get `rel="noopener noreferrer"`.
- Allowed link schemes: `https`, `http`, `mailto`. Allowed image source: `secure-img` only.

### Image URLs in the preview

- While rendering, rewrite each image whose URL is `secure-img://<uuid>` and whose UUID is in `images` to the platform form of the custom scheme.
- Any other image (remote URLs, missing IDs) becomes a "blocked image" placeholder. Loading a remote image would tell a third party that the document was opened.
- Register `secure-img` as an asynchronous Tauri URI scheme. On macOS and Linux the WebView loads `secure-img://localhost/<uuid>`; on Windows (WebView2) it loads `http://secure-img.localhost/<uuid>`. Compute the form per platform in one helper and test it on all three.
- The handler checks that the vault is unlocked and the ID exists, takes the bytes from the cache (or GETs and decrypts them) and responds with the right `Content-Type` and `Cache-Control: no-store`, so the WebView does not write the image to its disk cache. The leakage tests (section 16) verify this.

### Links in the preview

The frontend intercepts every click. External links open in the system browser through the opener plugin, after a dialog shows the full URL. The WebView itself never navigates away from the app.

Not in v1: links between vault documents, Mermaid diagrams, math rendering.

## 10. Frontend and Monaco

The frontend is plain TypeScript with five views and one Monaco instance. It holds no credentials, no keys and no filesystem access; it only calls the IPC commands in section 13.

### Views

1. **Setup** (first run): bucket, region, prefix, optional endpoint, access key ID and secret. "Test connection" GETs the index key. Found: go to Unlock. Missing: offer "Create vault" with passphrase, confirmation, a minimum of 12 characters, and the warning "If you forget this passphrase, your documents cannot be recovered."
2. **Unlock:** a passphrase field and a progress indicator. Rust runs Argon2id on a blocking thread so the window stays responsive. The field is cleared immediately after the call.
3. **Main:** sidebar on the left (title search box, folder tree, Trash at the bottom), one editor in the center, optional preview on the right, status bar at the bottom (sync state, word count, lock button).
4. **Trash:** the sidebar section described in section 7.
5. **Settings:** connection details, auto-lock timeout, passphrase change, theme (follow system, light, dark).

One document is visible at a time; there are no editor tabs in v1. Quick open (title search) switches documents. Monaco keeps models for the 10 most recently opened documents so switching back is instant and needs no GET.

### Sidebar

- Tree with keyboard navigation and ARIA `tree` / `treeitem` roles.
- Drag to move items between folders. This is in-page dragging and works with native file drop turned off.
- Custom HTML context menu: New document, New folder, Rename, Delete. In Trash: Restore, Restore to…, Delete permanently. The default WebView context menu is disabled in release builds.
- Delete moves to Trash with no confirmation, because it can be undone. Only permanent deletion asks.

### Keyboard shortcuts (Cmd on macOS, Ctrl elsewhere)

| Shortcut | Action |
| --- | --- |
| Mod+N | New document |
| Mod+Shift+N | New folder |
| Mod+P | Quick open by title |
| Mod+F / Mod+H (Cmd+Option+F on macOS) | Find / replace (Monaco) |
| Mod+S | Save now (flush) |
| Mod+Shift+V | Cycle preview mode |
| Mod+L | Lock vault |
| F2 | Rename selected item |
| Delete / Backspace in the tree | Move to Trash |

### Monaco: load only what is needed

```ts
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import 'monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution';
// Then import only these editor contributions (paths differ by version; check the pinned one):
// find, multicursor, wordOperations, linesOperations, clipboard, cursorUndo,
// caretOperations, dnd (text drag inside the editor), contextmenu, readOnlyMessage.
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
self.MonacoEnvironment = { getWorker: () => new EditorWorker() };
```

Do not import the JSON, CSS, HTML or TypeScript workers or any language service.

### Monaco options

```ts
{
  language: 'markdown',
  automaticLayout: true,
  wordWrap: 'on',
  lineNumbers: 'off',
  glyphMargin: false,
  folding: false,
  minimap: { enabled: false },
  quickSuggestions: false,
  suggestOnTriggerCharacters: false,
  wordBasedSuggestions: 'off',
  parameterHints: { enabled: false },
  hover: { enabled: false },
  codeLens: false,
  links: false,
  occurrencesHighlight: 'off',
  dropIntoEditor: { enabled: false },   // file drops go to the image handler
  pasteAs: { enabled: false },          // image paste goes to the image handler
  dragAndDrop: true,                    // moving selected text
  accessibilitySupport: 'auto',
  unicodeHighlight: { invisibleCharacters: true, ambiguousCharacters: true },
}
```

Some option names and value types changed between Monaco versions. TypeScript will flag them; match the pinned version's typings.

### Models and URIs

- Every document model uses `secure-vault://document/<uuid>`. Monaco never sees a filesystem path.
- Models are created when a document opens and disposed when evicted or when the vault locks.
- In Trash, models are opened with `readOnly: true`.

### Lock in the frontend

On lock, dispose every model, clear the preview, search box and tree, then reload the WebView. Reloading drops every JavaScript reference to plaintext in one step.

## 11. Tauri hardening

The WebView gets the app's own IPC commands, event listening and the URL opener, and nothing else. No filesystem, shell, HTTP or dialog plugin is installed.

### Capabilities

- Declare every custom command in an app manifest (`tauri_build::Attributes::new().app_manifest(...)` in `build.rs`). Each command then has its own `allow-<command>` permission, and the main window's capability lists them one by one.
- Core permissions: only event listening and the window actions the UI uses (close, minimize, maximize). Do not grant the path, resources, menu or tray permissions.
- Plugin: `tauri-plugin-opener` only, scoped to `https://*`, `http://*` and `mailto:*`.
- Confirmation dialogs are HTML modals, so no dialog plugin is needed.

### tauri.conf.json

- `app.withGlobalTauri: false` and `app.security.freezePrototype: true`.
- Window `dragDropEnabled: false` (section 9).
- No remote URL is ever loaded and no remote domain gets IPC access.
- Block navigation away from the app origin with an `on_navigation` handler, and deny every new-window request.
- The `devtools` feature is never enabled in release builds.

Content Security Policy:

```text
default-src 'self';
script-src 'self';
style-src 'self' 'unsafe-inline';
img-src 'self' secure-img: http://secure-img.localhost;
font-src 'self';
worker-src 'self' blob:;
connect-src ipc: http://ipc.localhost;
object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none';
```

Monaco injects styles at runtime, so styles need `'unsafe-inline'`; scripts stay strict. If a CSP violation appears in testing, add only the specific source needed and note why in the config.

### IPC input rules

- Every command checks that the vault is unlocked (except setup and unlock), parses UUIDs strictly and enforces sizes: text up to 50 MB, images up to 20 MB, names up to 255 characters.
- Errors cross the boundary as a code plus a safe message, never with document text, names, keys or credentials.

### Release build profile

```toml
[profile.release]
opt-level = "s"
lto = true
codegen-units = 1
strip = true
panic = "abort"

[profile.release.package.argon2]
opt-level = 3
[profile.release.package.aes-gcm]
opt-level = 3
```

The app stays small, while the crypto crates keep full speed.

### Process hygiene (best effort)

- Install a panic hook that logs only the source location, never the panic message, which could contain data.
- On Linux and macOS, set the core-dump size limit to 0 at startup in release builds. On Linux, also mark the process non-dumpable.
- Turn off spellcheck on every text input. Monaco's input already does this.
- The app never uses localStorage, sessionStorage, IndexedDB or cookies. The leakage tests also scan the WebView's data folder.

Outside the app's control, and to be documented in the README: OS swap and hibernation files, OS crash reporters, clipboard contents and screen capture.

## 12. Credentials, IAM and bucket setup

AWS keys live in the OS keychain and are used only by Rust. The IAM policy grants three object actions on one prefix and nothing else.

### Credentials

- v1 supports a static access key ID and secret, with an optional session token. AWS profiles and SSO are out of scope.
- Store them with `keyring` under the service name `secure-md-vault`, keyed by the vault ID.
- The frontend sends them once, during setup or in Settings. After that it only ever shows a masked key ID (first 4 and last 4 characters).
- Recommend one IAM user per device, so a lost laptop's key can be revoked without touching the others.
- If S3 starts returning 403 for every call, show Save failed with "S3 denied access. Check your credentials in Settings." Pending changes stay in the encrypted outbox.

### Local config file (plaintext, no secrets)

Stored in the app's config folder: vault ID, bucket, region, prefix, endpoint override, auto-lock minutes, theme and the last seen index revision. It never contains credentials, keys, document names or text.

### IAM policy for the app

Settings shows this policy with the bucket and prefix filled in, ready to copy:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "VaultObjects",
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::BUCKET/PREFIX/*"
    }
  ]
}
```

DeleteObjects (batch delete) is covered by `s3:DeleteObject`. No list permission is granted, which is why a missing object can return 403 (section 5).

### Bucket policy: refuse unencrypted connections

```json
{
  "Sid": "DenyInsecureTransport",
  "Effect": "Deny",
  "Principal": "*",
  "Action": "s3:*",
  "Resource": ["arn:aws:s3:::BUCKET", "arn:aws:s3:::BUCKET/*"],
  "Condition": { "Bool": { "aws:SecureTransport": "false" } }
}
```

### Bucket setup checklist

- [ ] Block Public Access: all four settings on.
- [ ] Default encryption SSE-S3, as defense in depth.
- [ ] Versioning on (recommended), so earlier versions of every object can be recovered.
- [ ] Lifecycle rule for old versions only: expire noncurrent versions after a period the user picks, and remove expired delete markers. This never affects Trash, which the app never empties automatically.
- [ ] A dedicated bucket, or at least a dedicated prefix, for each vault.
- [ ] The README walks through these steps in the AWS console.

## 13. IPC commands and events

The frontend talks to Rust only through these commands and events. Each command has its own permission in the app manifest (section 11). Anything not listed here does not exist.

### Commands

| Command | Input | Returns |
| --- | --- | --- |
| `config_get` | none | Non-secret config, whether credentials are stored |
| `config_set` | bucket, region, prefix, endpoint?, auto-lock minutes, theme | ok |
| `credentials_set` | key ID, secret, session token? | ok (stored in keychain) |
| `connection_test` | none | `VaultFound`, `NoVault`, `AccessDenied` or `Unreachable` |
| `vault_create` | passphrase | Tree snapshot (vault is unlocked) |
| `vault_unlock` | passphrase | Tree snapshot |
| `vault_lock` | none | ok, after flush and wipe |
| `passphrase_change` | old, new | ok |
| `activity_ping` | none | ok (resets the idle timer) |
| `tree_get` | none | Live and Trash nodes: id, parent, name, kind, modified, size, origin summary |
| `folder_create` | parent ID, name? | New ID and final name |
| `doc_create` | parent ID, name? | New ID and final name |
| `node_rename` | ID, name | ok, or a name-taken error |
| `node_move` | ID, new parent ID | Final name (may have a suffix) |
| `node_trash` | ID | Trash entry ID |
| `trash_restore` | entry ID, mode: `Auto`, `WithParent`, `RecreatePath` or `To(folder ID)` | Restored ID, final name, final path |
| `trash_purge` | entry IDs | Counts of documents, folders and images removed |
| `trash_empty` | none | Same counts |
| `search_titles` | query, include Trash | Matching IDs, best match first |
| `doc_open` | ID | Text, rev, read-only flag, rollback warning flag |
| `doc_update` | ID, text | ok |
| `flush_all` | none | ok once everything is uploaded, or a timeout error after 10 s |
| `conflict_resolve` | ID, `KeepMine`, `KeepTheirs` or `KeepBoth` | ok, plus the new document's ID for `KeepBoth` |
| `image_add` | raw bytes, filename header | Markdown snippet |
| `render_preview` | document ID | Sanitized HTML |

### Events (Rust to frontend)

| Event | Payload | When |
| --- | --- | --- |
| `sync-status` | state, pending count, last error code | Any change in save state |
| `doc-conflict` | document ID | A document PUT returned 412 |
| `notice` | code and safe arguments | Restore renamed an item, an operation was dropped after a conflict, a rollback warning |
| `tree-changed` | none | The tree changed after merging a newer remote index |
| `auto-lock` | none | The idle timer locked the vault |

### Idle lock

Rust cannot see keyboard or mouse input, so the frontend calls `activity_ping` at most once every 30 s while the user is active. Rust locks the vault when no ping arrives within the auto-lock time (default 15 minutes; 0 turns it off).

## 14. Logging, memory hygiene and lock

Sensitive values are wrapped in types that cannot be printed and are wiped when dropped. Release builds keep no log file.

### Logging

- `tracing` at `warn` in release and `debug` in debug builds, written to stderr only. No log file in v1.
- Allowed in logs: operation names, opaque object IDs, HTTP status codes, durations, byte counts.
- Never logged: document text, item names, paths, passphrases, keys, credentials, signed request URLs, S3 response bodies.
- Enforce it with newtypes. `Plaintext`, `Name`, `Passphrase` and key types implement `Debug` and `Display` as `[redacted]`, so an accidental `{:?}` prints nothing useful.
- The leakage tests capture all log output during a full workflow and search it for the canary strings.

### Memory

| Value | Type | Wiped when |
| --- | --- | --- |
| Passphrase | `SecretString` from the moment it arrives over IPC | Right after Argon2id |
| KEK | `SecretBox<[u8; 32]>` | Right after unwrapping VK |
| VK, CK, DK | `SecretBox<[u8; 32]>` | Lock |
| Document text | `Zeroizing<String>`, never cloned | Replaced by a newer version, or lock |
| Encryption buffers | `Zeroizing<Vec<u8>>`, encrypted in place | After the PUT is queued |
| Decrypted index | Structs deriving `Zeroize` and `ZeroizeOnDrop` | Lock |
| Image cache | `Zeroizing<Vec<u8>>` per entry | Eviction or lock |

JavaScript strings in the WebView cannot be wiped. The app limits their lifetime by disposing models and reloading the WebView on lock (section 10). Locking memory pages against swap is not in v1.

### Lock sequence

Triggers: the lock button or Mod+L, the idle timer, and closing the window.

1. Refuse every command except unlock, flush and status.
2. Flush everything (10 s limit); write anything still pending to the encrypted outbox.
3. Drop and wipe the keys, index, document buffers, image cache, operation log and ETag map.
4. Emit `auto-lock` (or return from `vault_lock`). The frontend disposes everything and reloads.

Closing the app runs the same sequence, then exits.

## 15. Repository layout

`crypto/` and `vault/` do no I/O at all, so they can be unit-tested exhaustively. Only `store/` touches the network or disk, and `commands.rs` contains no logic of its own.

```text
secure-md-vault/
├─ src-tauri/
│  ├─ Cargo.toml
│  ├─ build.rs                 app manifest: one permission per command
│  ├─ tauri.conf.json
│  ├─ capabilities/main.json
│  └─ src/
│     ├─ main.rs               setup, panic hook, process hygiene, scheme registration
│     ├─ commands.rs           validate input, call the core, map errors to safe codes
│     ├─ session.rs            unlocked state, idle timer, lock sequence
│     ├─ config.rs             local config file, keychain access
│     ├─ error.rs              error enum and safe codes
│     ├─ crypto/
│     │  ├─ kdf.rs             Argon2id, bounds, calibration
│     │  ├─ keys.rs            vault key wrap and unwrap, HKDF subkeys
│     │  └─ envelope.rs        seal and open, associated data
│     ├─ vault/
│     │  ├─ index.rs           schema, serialization, validate()
│     │  ├─ names.rs           normalization, uniqueness, suffixes
│     │  ├─ ops.rs             Op enum, apply(), operation log, replay after conflict
│     │  └─ trash.rs           Trash, Restore, Purge
│     ├─ store/
│     │  ├─ mod.rs             ObjectStore trait
│     │  ├─ s3.rs              rusty-s3 + reqwest implementation
│     │  ├─ memory.rs          in-memory implementation with request counters
│     │  ├─ faulty.rs          wrapper that injects failures
│     │  └─ outbox.rs          encrypted on-disk outbox
│     ├─ sync/scheduler.rs     timers, write ordering, retries, conflicts, status
│     └─ render/
│        ├─ markdown.rs        pulldown-cmark + ammonia
│        └─ images.rs          validation, dedupe, cache, secure-img scheme
├─ src/                        frontend (TypeScript)
│  ├─ main.ts
│  ├─ ipc.ts                   typed wrappers for every command and event
│  ├─ editor/monaco.ts         trimmed Monaco setup
│  └─ ui/                      setup, unlock, sidebar, trash, preview, status, settings, modal
├─ tests/                      Rust integration tests (local S3 server and AWS)
├─ scripts/leak-scan/          canary scan for Windows, macOS and Linux
├─ .github/workflows/ci.yml
└─ README.md
```

### The storage trait

```rust
pub enum PutCondition { IfNoneMatch, IfMatch(ETag) }

pub trait ObjectStore: Send + Sync {
    async fn get(&self, key: &ObjectKey) -> Result<(Bytes, ETag), StoreError>;
    async fn put(&self, key: &ObjectKey, body: Bytes, cond: PutCondition) -> Result<ETag, StoreError>;
    async fn delete_many(&self, keys: &[ObjectKey]) -> Result<DeleteReport, StoreError>;
}

pub enum StoreError {
    MissingOrDenied, Denied, PreconditionFailed,
    Network, Throttled, Server(u16), InvalidResponse,
}
```

Every PUT must carry a condition; there is no unconditional write. Use generics (`S: ObjectStore`) rather than `dyn`, so native async trait methods work without extra crates. The three implementations (S3, in-memory, fault-injecting) are swapped in tests.

## 16. Testing plan

Every testing objective from the original brief maps to an automated suite, except usability and parts of macOS checking, which are manual. CI runs the automated suites on Windows, macOS and Linux for every change.

### Coverage map

| Objective | Suite | Runs |
| --- | --- | --- |
| 12 Unit tests | `cargo test` in `crypto/`, `vault/`, `render/`, plus `proptest` | Every change, all 3 OS |
| 13 S3 integration | `tests/` against a local S3 server in Docker; the same suite against a real AWS test bucket | Linux every change; AWS nightly |
| 14 Bucket contains no readable data | Canary bucket scan | Every change (local server), nightly (AWS) |
| 15 Local plaintext leakage | `scripts/leak-scan/` after a full scripted session | Nightly, all 3 OS |
| 16 Cross-platform | CI matrix + end-to-end tests + manual checklist | Every change; manual per release |
| 17 Performance | `criterion` benchmarks + startup and memory measurements | Nightly, results stored as CI artifacts |
| 18 Reliability | Fault-injecting store scenarios | Every change |
| 19 Security | Audits, lints, sanitizer corpus, scheme and IPC fuzzing | Every change |
| 20 Usability | Moderated sessions | Before each release |

### Crypto unit tests

- `open(seal(x)) == x` for sizes 0, 1, 15, 16, 17 bytes, 1 KB, 1 MB, 10 MB and 50 MB, plus random sizes and contents with `proptest`.
- Each of these must return an error and never panic: wrong key, wrong passphrase, one flipped bit in the magic, version, nonce, ciphertext or tag, truncation at every length up to 40 bytes and at random lengths, extra bytes appended, and wrong vault ID, object ID or kind in the associated data.
- One million encryptions produce no repeated nonce.
- KDF parameters outside the bounds are rejected before Argon2id runs.
- The same passphrase typed in composed and decomposed Unicode unlocks the same vault.
- Changing any byte of the index header makes unlock fail.

### Virtual filesystem and Trash tests

- Random operation sequences (property tests) keep `Index::validate()` true at every step.
- Deleting two documents with the same name from the same folder creates two separate entries; both restore, and the second gets " (2)".
- Deleting a folder keeps its subtree identical (IDs, names, structure); restoring brings it back exactly as before.
- Restore after the original folder was renamed, or moved, lands in that folder at its new name or place.
- Original folder in Trash: `WithParent` restores the folder's entry and places the item inside; `RecreatePath` builds the path fresh.
- Original folder purged: the path is recreated, reusing existing folders by case-insensitive name.
- Trash and Restore make zero S3 calls apart from the index flush (request-budget test).
- Purge keeps images still used elsewhere and deletes orphans. The in-memory store's call log shows the index PUT before DeleteObjects.
- A failed DeleteObjects leaves IDs in `pending_purge`, and they are retried after the next unlock.
- `doc_update` on a document in Trash is refused.
- Advancing the clock by 10 years leaves every Trash entry in place.

### Integration tests (S3)

- Create, encrypt, upload, download, decrypt, compare: byte-for-byte equal.
- Updates, deletes, index updates, missing objects, invalid credentials, a policy without PutObject, network failures and an unexpected response (an HTML page with status 200).
- Two sessions on one vault produce 412 conflicts; each resolution option behaves as specified.
- A retried PUT whose first attempt actually succeeded gets 412. The app GETs the remote copy and, if it matches the local text, treats the save as done with no conflict dialog.
- If the local S3 server lacks conditional-write support, the conflict tests run only against AWS.

### Bucket inspection (canary)

A scripted session uses `CONFIDENTIAL_TEST_MARKER_493821` in document text, document names, folder names, image filenames and inside an image's metadata. Then the test downloads every object raw and searches it for the marker as UTF-8, UTF-16LE and base64. Every key must match `^<prefix>/(index|o/[0-9a-f-]{36}\.enc)$`. Any hit fails the build.

### Local leakage scan

After a full session and app shutdown, `scripts/leak-scan/` searches the app's data, cache, config and temp folders, the WebView's data folder, the outbox and captured logs for the canary in UTF-8 and UTF-16LE. Any hit is a security defect.

### Cross-platform

- CI matrix: latest Windows, macOS and Ubuntu runners. Build, unit tests and in-memory-store tests on all three; Docker-based S3 tests on Linux.
- End-to-end tests with `tauri-driver` (WebDriver) on Windows and Linux, which it supports. macOS follows a manual checklist.
- Core workflow on each OS: install, launch, unlock, create, edit, save, close, reopen, decrypt; plus delete to Trash and restore.
- Manual checklist per release: shortcuts, image drop and paste, image rendering, window behavior, high-DPI screens, dark mode, and Unicode in names and text (emoji, Chinese and Japanese, Arabic and Hebrew right-to-left text, combining accents).

### Performance (initial targets, to be confirmed in milestone 2)

| Metric | Target |
| --- | --- |
| Launch to unlock screen | Under 1 s |
| Unlock, excluding network time | 0.5–1.0 s (set by KDF calibration) |
| Memory after unlock, including WebView processes | Under 200 MB |
| Installer size | Under 20 MB |
| Open a cached 1 MB document | Under 100 ms |
| Encryption and decryption speed | Over 200 MB/s on CPUs with AES instructions |
| Preview render of a 100 KB document | Under 100 ms |

Also measured and recorded at 10 KB, 100 KB, 1 MB and 10 MB: open time, upload and download latency and image render latency. Typing must stay smooth during uploads.

### Reliability scenarios

Connection loss during a PUT, S3 timeout, app killed mid-upload (outbox recovers it), corrupted index ("damaged" message, nothing overwritten), corrupted document (clear error, other documents unaffected), wrong passphrase, missing bucket, revoked credentials, duplicate requests and an outdated version. After every scenario, the last valid object in S3 must still decrypt.

### Security checks

- `cargo audit`, `cargo deny` (advisories, licenses, banned crates), `npm audit`, `clippy -D warnings`, and `#![forbid(unsafe_code)]` in all app code.
- A malicious Markdown corpus (`<script>`, `javascript:` links, `onerror` attributes, data URLs, SVG, mixed HTML tricks) renders with no script or event handler left.
- Fuzz the `secure-img` handler (bad UUIDs, `../` paths, unknown IDs: all return 404) and every IPC command's inputs.
- An injected inline script in the preview is blocked by the CSP.
- The app works with exactly the section 12 policy and fails cleanly with less.
- Release builds contain no devtools and log at `warn`.

### Usability

Five people who have not seen the app attempt the core workflow plus delete and restore, without instructions. Record completion, time and errors. Fix anything that more than one person gets stuck on.

## 17. Milestones

Build in this order. Each milestone merges with its own tests, and CI must be green on all three platforms before the next one starts. Pure logic comes first, so the riskiest parts (crypto, Trash, ordering) are tested before any UI exists.

1. **Scaffold and CI.** Tauri 2 + Vite + TypeScript app, formatting and lint rules, `#![forbid(unsafe_code)]`, `cargo deny` and `cargo audit`, CI matrix on Windows, macOS and Linux.
    - Done when an empty window builds and CI is green on all three.
2. **Crypto core.** `kdf.rs`, `keys.rs`, `envelope.rs`, KDF calibration, all crypto unit tests, `criterion` benchmarks.
    - Done when every crypto test passes and the performance targets are confirmed or adjusted in writing.
3. **Index and virtual filesystem (no I/O).** Schema, name rules, `Op` and `apply()`, `validate()`, Trash, Restore, Purge, operation log and replay.
    - Done when the property tests and every Trash test in section 16 pass.
4. **Storage.** `ObjectStore` trait, in-memory store with counters, fault-injecting store, S3 implementation, local S3 server in CI.
    - Done when the integration suite and request-budget tests pass.
5. **Session.** Setup, keychain, vault creation, unlock, lock, idle lock, local config.
    - Done when a test harness can create, unlock and lock a vault, and both unlock error messages appear correctly.
6. **Editor UI.** Trimmed Monaco, sidebar tree, quick open, setup and unlock views, typed IPC wrappers.
    - Done when documents open and edit against the in-memory store and the frontend bundle size is recorded.
7. **Save pipeline.** Scheduler, timings, write ordering, conflicts, outbox, status indicator.
    - Done when every reliability scenario passes and all four status states show correctly.
8. **Images and preview.** `image_add`, deduplication, cache, the `secure-img` scheme on each platform, Markdown rendering and sanitizing, link handling.
    - Done when the sanitizer corpus passes and images render on all three platforms.
9. **Trash UI.** Trash list, read-only viewing, restore dialog, purge confirmation.
    - Done when the end-to-end delete-and-restore tests and the manual checklist pass.
10. **Hardening.** Capability manifest, CSP, navigation blocking, process hygiene, redacting newtypes, leakage scans, bucket canary scan.
    - Done when every security and leakage test passes on all three platforms.
11. **Release.** Installers (MSI or NSIS, DMG, AppImage and .deb), README with bucket setup, performance report, usability sessions.
    - Done when every acceptance criterion in section 18 is met.

## 18. Acceptance criteria and rules for the code agent

The project is done when every box below is checked on Windows, macOS and Linux.

### Acceptance criteria

- [ ] One codebase runs on Windows, macOS and Linux, built with Tauri 2 (no Electron).
- [ ] A trimmed Monaco is the editor; no part of the VS Code workbench is included.
- [ ] Documents and folders can be created, opened, edited, renamed, moved, deleted to Trash, restored and deleted permanently.
- [ ] Each deletion creates its own Trash entry holding the item and its `.origin` tandem file. Same-name deletions never conflict, folder contents keep their structure, and restore follows the rules in section 7.
- [ ] Trash is never emptied automatically.
- [ ] Images can be added by drag-and-drop and paste. They are encrypted before upload and deduplicated.
- [ ] Document text, images, names and folder structure are encrypted before upload. S3 keys are opaque.
- [ ] Keys are derived on the device. The passphrase and keys are never sent anywhere.
- [ ] A wrong passphrase cannot decrypt anything, and modified ciphertext fails authentication.
- [ ] The local leakage scan passes on all three platforms.
- [ ] The bucket canary scan passes.
- [ ] Only GetObject, conditional PutObject and DeleteObjects are used, and the request-budget tests pass.
- [ ] Saving is automatic with four visible states. No manual sync, Git, command line, sync app or custom server is needed.
- [ ] Unit, integration, reliability and security suites pass; performance targets are met or the gaps are documented.

### Rules for the code agent

1. Follow the milestones in order and keep CI green.
2. This document is the source of truth. Where it is silent or contradicts itself, pick the more secure option, record the choice in `DECISIONS.md` and continue.
3. No dependency outside section 2 without a written reason.
4. No hand-written cryptography, no `unsafe`, no unconditional PUT, no LIST or HEAD calls.
5. Never log, print or return in an error any document text, name, path, key, passphrase or credential.
6. Never loosen the CSP or capabilities to make something work. Find another way, or record the blocker.
7. Keep `crypto/` and `vault/` free of I/O.
8. This document states intent; the pinned versions decide syntax. Check Monaco import paths and option types, Tauri 2 config keys and the S3 library's API against their documentation.

### Verify before building on it

- [ ] `rusty-s3` can send `If-Match` and `If-None-Match` on PutObject. If it cannot, sign requests with the standalone `aws-sigv4` crate and send them with `reqwest`.
- [ ] The local S3 test server supports conditional writes (section 5).
- [ ] The `secure-img` scheme's URL form and `Cache-Control: no-store` behave as expected in WebView2, WKWebView and WebKitGTK.

### Open decisions for the project owner

- [ ] Code signing: macOS notarization and a Windows signing certificate are needed for smooth installs, and both cost money.
- [ ] Whether to officially support S3-compatible providers other than AWS. Each must support conditional writes.
- [ ] Whether to add object-size padding to hide document sizes (section 1).
- [ ] How long the bucket keeps old object versions (section 12).
