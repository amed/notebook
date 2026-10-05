//! Notebook-compatible encrypted S3 workspace and Tauri command surface.
//!
//! Object names and bodies are byte-compatible with `amed/notebook`. The
//! configured prefix is intentionally plaintext; every following path segment
//! and every object body is encrypted before the HTTP request is created.

use crate::compat::notebook_v1::{DIRECTORY_MARKER, NotebookV1Codec};
use crate::deleted_items::{self, BinEntry};
use base64::Engine as _;
use reqwest::header::{ETAG, IF_MATCH, IF_NONE_MATCH};
use reqwest::{Client, RequestBuilder, StatusCode};
use rusty_s3::actions::ObjectIdentifier;
use rusty_s3::{Bucket, Credentials as S3Credentials, S3Action, UrlStyle};
use secrecy::SecretString;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{Manager as _, State};
use url::Url;
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

mod layout;
mod workspaces;
use layout::PanelLayout;
use workspaces::{AppConfig, Keychain};

const ROOT_ID: &str = "00000000-0000-0000-0000-000000000001";
const TRASH_ID: &str = "00000000-0000-0000-0000-000000000002";
const KEYCHAIN_SERVICE: &str = "com.securemd.vault.s3";
const SIGNED_URL_TTL: Duration = Duration::from_secs(300);
const MAX_DOCUMENT_BYTES: usize = 20 * 1024 * 1024;
const MAX_EDIT_BYTES: usize = 16 * 1024 * 1024;
const MAX_LIST_RESPONSE_BYTES: usize = 8 * 1024 * 1024;
const MAX_REPLY_BYTES: usize = 64 * 1024;
const MAX_OBJECTS: usize = 100_000;
/// Two tries per call; the frontend schedules any further retry (backoff).
const MAX_S3_ATTEMPTS: usize = 2;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
/// Time to the response headers, plus one second per MiB sent or received.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

/// The S3 location of one workspace: what every S3 request, stored key and
/// outbox folder of its session is derived from. Preferences and secrets live
/// elsewhere (`AppConfig`, `secrets.json`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VaultConfig {
    pub bucket: String,
    pub region: String,
    pub prefix: String,
    pub endpoint: Option<String>,
}

impl Default for VaultConfig {
    fn default() -> Self {
        Self {
            bucket: String::new(),
            region: "eu-central-1".into(),
            prefix: String::new(),
            endpoint: None,
        }
    }
}

/// S3 credentials as sealed in `secrets.json` (UTF-8 JSON). Never `Debug`-
/// printed with their values.
#[derive(Clone, Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
struct StoredCredentials {
    access_key_id: String,
    secret_access_key: String,
    #[serde(default)]
    session_token: Option<String>,
}

impl std::fmt::Debug for StoredCredentials {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("StoredCredentials(<redacted>)")
    }
}

/// One S3 object of the vault: its stored (encrypted) key and its ETag.
#[derive(Clone, PartialEq, Eq)]
struct Object {
    key: String,
    /// Empty only when S3 answered a write without an ETag.
    etag: String,
}

/// A change to the object map: the object now at a logical path, or `None`
/// when the path is gone.
type Write = (String, Option<Object>);

#[derive(Clone)]
struct NodeRecord {
    id: String,
    parent: Option<String>,
    name: String,
    kind: &'static str,
    logical_path: String,
}

/// Session ids and tree versions come from one counter, so a delta of an
/// earlier session never matches a later tree.
static NEXT_VERSION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

fn next_version() -> u64 {
    NEXT_VERSION.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
}

/// The unlocked vault. `objects` is the source of truth after unlock: every
/// change updates it from the keys and ETags it wrote, and only unlock and
/// the Refresh button list S3 again (folder operations list their prefix).
struct Session {
    id: u64,
    /// The S3 location the session was unlocked for. Editing the workspace's
    /// location ends the session, so this never goes stale.
    config: VaultConfig,
    codec: NotebookV1Codec,
    /// One HTTP client (and connection pool) per unlocked session.
    remote: Arc<S3Remote>,
    /// Every decrypted object, Trash and folder markers included, by path.
    objects: BTreeMap<String, Object>,
    /// The visible tree, derived from `objects`.
    nodes: HashMap<String, NodeRecord>,
    /// The tree the frontend holds (version `version`), for deltas.
    view: HashMap<String, TreeNode>,
    version: u64,
    /// Writes made while a refresh lists S3; they are re-applied to its result.
    recording: Option<Vec<Write>>,
    /// Decrypted texts of recently opened or saved documents.
    cache: DocCache,
}

impl Session {
    fn new(
        config: VaultConfig,
        codec: NotebookV1Codec,
        remote: Arc<S3Remote>,
        objects: BTreeMap<String, Object>,
    ) -> Self {
        let mut session = Self {
            id: next_version(),
            config,
            codec,
            remote,
            objects,
            nodes: HashMap::new(),
            view: HashMap::new(),
            version: 0,
            recording: None,
            cache: DocCache::default(),
        };
        session.rebuild();
        session
    }

    /// Applies writes to the object map (and to a refresh that is running).
    fn apply(&mut self, writes: impl IntoIterator<Item = Write>) {
        for (path, object) in writes {
            if let Some(recording) = self.recording.as_mut() {
                recording.push((path.clone(), object.clone()));
            }
            match object {
                Some(object) => self.objects.insert(path, object),
                None => self.objects.remove(&path),
            };
        }
    }

    /// Re-derives the tree from `objects`; the delta takes the frontend's
    /// tree from the previous version to the new one.
    fn rebuild(&mut self) -> TreeDelta {
        self.nodes = build_nodes(&self.objects);
        let view = tree_view(&self.nodes, &self.objects);
        let from = self.version;
        let mut upsert = view
            .values()
            .filter(|node| self.view.get(&node.id) != Some(*node))
            .cloned()
            .collect::<Vec<_>>();
        let mut remove = self
            .view
            .keys()
            .filter(|id| !view.contains_key(*id))
            .cloned()
            .collect::<Vec<_>>();
        upsert.sort_by(|a, b| a.id.cmp(&b.id));
        remove.sort();
        if from == 0 || !upsert.is_empty() || !remove.is_empty() {
            self.version = next_version();
        }
        self.view = view;
        TreeDelta {
            from,
            to: self.version,
            upsert,
            remove,
        }
    }

    fn paths(&self) -> Vec<&str> {
        self.objects.keys().map(String::as_str).collect()
    }

    /// The objects at or below `path`.
    fn subtree<'a>(&'a self, path: &'a str) -> impl Iterator<Item = (&'a String, &'a Object)> {
        self.objects
            .range::<str, _>((std::ops::Bound::Included(path), std::ops::Bound::Unbounded))
            .take_while(move |(candidate, _)| candidate.starts_with(path))
            .filter(move |(candidate, _)| is_at_or_below(candidate, path))
    }

    /// The visible node at `path`, if any.
    fn node_at(&self, path: &str) -> Option<&NodeRecord> {
        let kind = if self.objects.contains_key(path) && !is_marker_path(path) {
            "document"
        } else {
            "folder"
        };
        self.nodes.get(&stable_id(kind, path))
    }
}

fn is_at_or_below(candidate: &str, path: &str) -> bool {
    candidate
        .strip_prefix(path)
        .is_some_and(|rest| rest.is_empty() || rest.starts_with('/'))
}

fn is_marker_path(path: &str) -> bool {
    file_name(path) == DIRECTORY_MARKER
}

const CACHE_DOCUMENTS: usize = 32;
const CACHE_BYTES: usize = 32 * 1024 * 1024;

/// Decrypted texts by S3 key, each valid for one ETag: a document opened or
/// saved before opens again without a request while S3 holds that version.
/// At most 32 documents or 32 MiB; wiped with the session.
#[derive(Default)]
struct DocCache {
    entries: HashMap<String, Cached>,
    clock: u64,
}

struct Cached {
    etag: String,
    text: Arc<Zeroizing<String>>,
    sha: [u8; 32],
    used: u64,
}

impl DocCache {
    fn get(&mut self, key: &str, etag: &str) -> Option<(Arc<Zeroizing<String>>, [u8; 32])> {
        self.clock += 1;
        let clock = self.clock;
        let entry = self
            .entries
            .get_mut(key)
            .filter(|entry| !etag.is_empty() && same_etag(&entry.etag, etag))?;
        entry.used = clock;
        Some((entry.text.clone(), entry.sha))
    }

    fn insert(&mut self, key: &str, etag: &str, text: Arc<Zeroizing<String>>, sha: [u8; 32]) {
        if etag.is_empty() || text.len() > CACHE_BYTES {
            self.entries.remove(key);
            return;
        }
        self.clock += 1;
        let used = self.clock;
        self.entries.insert(
            key.to_owned(),
            Cached {
                etag: etag.to_owned(),
                text,
                sha,
                used,
            },
        );
        while self.entries.len() > CACHE_DOCUMENTS
            || self
                .entries
                .values()
                .map(|entry| entry.text.len())
                .sum::<usize>()
                > CACHE_BYTES
        {
            let Some(oldest) = self
                .entries
                .iter()
                .min_by_key(|(_, entry)| entry.used)
                .map(|(key, _)| key.clone())
            else {
                break;
            };
            self.entries.remove(&oldest);
        }
    }

    /// A server-side copy: same text under a new key and ETag.
    fn moved(&mut self, from: &str, to: &str, etag: &str) {
        if let Some(entry) = self.entries.remove(from) {
            self.insert(to, etag, entry.text, entry.sha);
        }
    }
}

/// ETags compare without quotes or a weak prefix, as providers differ.
fn same_etag(left: &str, right: &str) -> bool {
    let bare = |value: &str| {
        value
            .trim()
            .trim_start_matches("W/")
            .trim_matches('"')
            .to_owned()
    };
    bare(left) == bare(right)
}

struct Inner {
    /// `config.json`: preferences and the workspaces (no secrets).
    app: AppConfig,
    /// `secrets.json` as on disk: sealed values only, no plaintext.
    secrets: crate::secrets::SecretsFile,
    /// Opened S3 credentials of one workspace (by id), so the master key is
    /// read from the keychain once per workspace and run.
    credentials: Option<(String, StoredCredentials)>,
    /// Belongs to the active workspace: selecting another one ends it.
    session: Option<Session>,
    last_activity: Instant,
    idle_notified: bool,
}

/// Edits written to the encrypted outbox and not yet uploaded, by S3 key.
/// An edit is durable once its outbox file is written (`doc_stage`) and
/// synced once S3 holds it (`doc_commit`).
///
/// The journal belongs to one session at a time (`session`, 0: none). An
/// upload, open or stage that started in an earlier session finds it given
/// to another and leaves it alone: two workspaces with the same phrase and
/// prefix share S3 keys, so a late answer from one must never re-base or
/// stage anything of the other. Its outbox file stays for the next unlock.
#[derive(Default)]
struct Journal {
    /// Never reset, so a generation of an earlier session is never reused.
    next_gen: u64,
    session: u64,
    keys: HashMap<String, KeyJournal>,
}

impl Journal {
    /// Gives the journal to a newly installed session.
    fn adopt(&mut self, session: &Session) {
        self.keys.clear();
        self.session = session.id;
    }
}

#[derive(Default)]
struct KeyJournal {
    /// The newest edit in the outbox file, still to be uploaded.
    staged: Option<Staged>,
    /// The S3 version the edits are based on: its ETag (the `If-Match` of the
    /// upload) and the SHA-256 of its text.
    base: Option<(String, [u8; 32])>,
    /// An upload of this key is running, so a stage never shortcuts to clean.
    committing: bool,
}

struct Staged {
    generation: u64,
    sha: [u8; 32],
    text: Arc<Zeroizing<String>>,
    body: Arc<Vec<u8>>,
    /// The `If-Match` of its upload, as in its outbox file.
    expected: String,
}

pub struct NotebookState {
    config_path: PathBuf,
    secrets_path: PathBuf,
    outbox_dir: PathBuf,
    /// Held for the life of the process: one process per profile, so no
    /// process overwrites `config.json` or `secrets.json` from a stale copy.
    _profile_lock: Option<std::fs::File>,
    /// Another process holds the profile: every command that reads or writes
    /// the workspaces is refused (`PROFILE_IN_USE`).
    in_use: bool,
    /// A file that exists but could not be read (not a format problem, which
    /// sets it aside): it is never replaced during this run.
    config_unreadable: bool,
    secrets_unreadable: bool,
    /// The OS keychain (a memory map in tests): the master key of
    /// `secrets.json` and the S3 credentials of builds before workspaces.
    keychain: Arc<dyn Keychain>,
    /// The master key once read. Lock order: `master` before `inner`; it is
    /// held across every change of `secrets.json`, so the key cannot be
    /// deleted while another change seals a value with it.
    master: Mutex<Option<Zeroizing<[u8; crate::secrets::KEY_LEN]>>>,
    inner: Mutex<Inner>,
    /// Lock order: `journal` before `inner`, never the other way round.
    journal: Mutex<Journal>,
    /// Serialises the uploads of one key, so two never race on one ETag.
    uploads: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    /// One refresh (full listing) at a time.
    refreshing: tokio::sync::Mutex<()>,
}

impl NotebookState {
    /// The outbox lives in the local (non-roaming) data folder: on Windows a
    /// roaming profile would otherwise replay stale ciphertext on another PC.
    ///
    /// A second process on the same profile (Windows and Linux start one per
    /// launch; a dev build shares the installed app's identifier) reads and
    /// writes nothing: it reports `PROFILE_IN_USE` and the page says so.
    pub fn load(config_dir: PathBuf, local_data_dir: PathBuf) -> Self {
        let keychain: Arc<dyn Keychain> = Arc::new(workspaces::OsKeychain);
        match workspaces::lock_profile(&config_dir) {
            workspaces::ProfileLock::Held(file) => {
                let mut state = Self::load_with(config_dir, local_data_dir, keychain);
                state._profile_lock = Some(file);
                state
            }
            workspaces::ProfileLock::InUse => Self::in_use(config_dir, local_data_dir, keychain),
            // A file system without locks: run unguarded rather than not at all.
            workspaces::ProfileLock::Unsupported => {
                Self::load_with(config_dir, local_data_dir, keychain)
            }
        }
    }

    /// Reads (and if needed migrates) `config.json` and reads `secrets.json`.
    /// Neither touches the keychain: the master key is read on first use.
    fn load_with(
        config_dir: PathBuf,
        local_data_dir: PathBuf,
        keychain: Arc<dyn Keychain>,
    ) -> Self {
        let config_path = config_dir.join("config.json");
        let secrets_path = config_dir.join("secrets.json");
        let (app, migrated, config_unreadable) = match workspaces::read_config(&config_path) {
            workspaces::Loaded::Value((app, migrated)) => (app, migrated, false),
            workspaces::Loaded::Unreadable => (AppConfig::default(), false, true),
        };
        let (secrets, secrets_unreadable) = match workspaces::read_secrets(&secrets_path) {
            workspaces::Loaded::Value(secrets) => (secrets, false),
            workspaces::Loaded::Unreadable => (crate::secrets::SecretsFile::default(), true),
        };
        let state = Self::with_files(
            config_path,
            secrets_path,
            local_data_dir.join("outbox"),
            keychain,
            app,
            secrets,
        );
        let state = Self {
            config_unreadable,
            secrets_unreadable,
            ..state
        };
        if migrated {
            // Best effort: a migrated legacy credential moves only once this
            // file is written (see `workspaces::migrate_legacy_credentials`).
            if let Ok(inner) = state.inner.lock() {
                let _ = state.save_config(&inner.app);
            }
        }
        state
    }

    /// The state of a process that found the profile locked by another one:
    /// it reads no file and refuses every workspace command.
    fn in_use(config_dir: PathBuf, local_data_dir: PathBuf, keychain: Arc<dyn Keychain>) -> Self {
        Self {
            in_use: true,
            ..Self::with_files(
                config_dir.join("config.json"),
                config_dir.join("secrets.json"),
                local_data_dir.join("outbox"),
                keychain,
                AppConfig::default(),
                crate::secrets::SecretsFile::default(),
            )
        }
    }

    fn with_files(
        config_path: PathBuf,
        secrets_path: PathBuf,
        outbox_dir: PathBuf,
        keychain: Arc<dyn Keychain>,
        app: AppConfig,
        secrets: crate::secrets::SecretsFile,
    ) -> Self {
        Self {
            config_path,
            secrets_path,
            outbox_dir,
            _profile_lock: None,
            in_use: false,
            config_unreadable: false,
            secrets_unreadable: false,
            keychain,
            master: Mutex::new(None),
            inner: Mutex::new(Inner {
                app,
                secrets,
                credentials: None,
                session: None,
                last_activity: Instant::now(),
                idle_notified: false,
            }),
            journal: Mutex::new(Journal::default()),
            uploads: Mutex::new(HashMap::new()),
            refreshing: tokio::sync::Mutex::new(()),
        }
    }

    /// Forgets the in-memory journal. Its outbox files stay on disk and are
    /// uploaded by the next unlock of the same vault.
    fn forget_journal(&self) {
        if let Ok(mut journal) = self.journal.lock() {
            journal.keys.clear();
            journal.session = 0;
        }
    }

    /// Durable: secrets are filed under workspace ids, so the ids must not
    /// be lost to a crash after a migration moved credentials under them.
    fn save_config(&self, config: &AppConfig) -> Result<(), IpcError> {
        if self.in_use {
            return Err(workspaces::profile_in_use());
        }
        if self.config_unreadable {
            return Err(workspaces::config_unreadable());
        }
        let bytes =
            serde_json::to_vec_pretty(config).map_err(|_| IpcError::internal("CONFIG_WRITE"))?;
        workspaces::write_durably(&self.config_path, &bytes)
            .map_err(|_| IpcError::internal("CONFIG_WRITE"))
    }

    fn outbox_dir(&self) -> &Path {
        &self.outbox_dir
    }

    /// Drops the unlocked session (codec keys, decrypted names, S3 client).
    pub fn end_session(&self) {
        self.forget_journal();
        if let Ok(mut inner) = self.inner.lock() {
            inner.session = None;
            inner.idle_notified = false;
        }
    }

    pub fn check_idle_session(&self) -> IdleAction {
        let Ok(mut inner) = self.inner.lock() else {
            return IdleAction::None;
        };
        let minutes = inner.app.auto_lock_minutes;
        // A remembered phrase reopens the workspace without the user, so
        // locking it on idle would protect nothing (see DECISIONS.md).
        if minutes == 0 || inner.session.is_none() || inner.phrase_remembered() {
            inner.idle_notified = false;
            return IdleAction::None;
        }
        let timeout = Duration::from_secs(u64::from(minutes) * 60);
        let elapsed = inner.last_activity.elapsed();
        if elapsed < timeout {
            inner.idle_notified = false;
            return IdleAction::None;
        }
        // Give the frontend one minute to flush its debounced edit and call
        // vault_lock. If it is hung, the backend still destroys the keys.
        if elapsed >= timeout + Duration::from_secs(60) {
            inner.session = None;
            inner.idle_notified = false;
            drop(inner);
            self.forget_journal();
            return IdleAction::Forced;
        }
        if !inner.idle_notified {
            inner.idle_notified = true;
            return IdleAction::Notify;
        }
        IdleAction::None
    }

    pub fn is_unlocked(&self) -> bool {
        self.inner
            .lock()
            .map(|inner| inner.session.is_some())
            .unwrap_or(false)
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum IdleAction {
    None,
    Notify,
    Forced,
}

/// Owner-only on Unix; Windows profile folders are already private to the user.
fn create_private_dir(path: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

fn write_private_file(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    // The creation mode does not apply to a leftover file from an earlier run.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
    }
    file.write_all(bytes)?;
    file.sync_all()
}

#[derive(Clone, Copy, Debug, Serialize)]
pub struct IpcError {
    code: &'static str,
    message: &'static str,
}

impl IpcError {
    pub(crate) fn new(code: &'static str, message: &'static str) -> Self {
        Self { code, message }
    }
    pub(crate) fn internal(code: &'static str) -> Self {
        Self::new(code, "The operation could not be completed.")
    }
    fn locked() -> Self {
        Self::new("LOCKED", "Unlock the workspace first.")
    }
    pub(crate) fn invalid(message: &'static str) -> Self {
        Self::new("INVALID_INPUT", message)
    }
    pub fn code(&self) -> &'static str {
        self.code
    }
    fn no_credentials(message: &'static str) -> Self {
        Self::new("NO_CREDENTIALS", message)
    }
}

/// A tree node as the frontend holds it. Ids derive from kind and path, so a
/// renamed or moved item is a new node.
#[derive(Clone, PartialEq, Serialize)]
pub struct TreeNode {
    id: String,
    parent: Option<String>,
    name: String,
    kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    origin: Option<OriginSummary>,
    #[serde(skip_serializing_if = "Option::is_none")]
    trash_entry_id: Option<String>,
}

/// A Trash entry as Notebook lists it: name, original location, item count
/// for folders and deletion time (Unix ms, unknown for legacy entries).
#[derive(Clone, PartialEq, Serialize)]
pub struct OriginSummary {
    name: String,
    original_path: String,
    location: String,
    deleted_at: Option<u64>,
    item_kind: &'static str,
    item_count: u32,
    doc_count: u32,
    folder_count: u32,
    image_count: u32,
    legacy: bool,
}

impl From<&BinEntry> for OriginSummary {
    fn from(entry: &BinEntry) -> Self {
        let count = |value: usize| u32::try_from(value).unwrap_or(u32::MAX);
        Self {
            name: entry.name.clone(),
            original_path: entry.original_path.clone(),
            location: entry.original_parent.clone(),
            deleted_at: entry.deleted_at_ms,
            item_kind: if entry.is_folder {
                "Folder"
            } else {
                "Document"
            },
            item_count: count(entry.item_count),
            doc_count: count(entry.documents),
            folder_count: count(entry.folders),
            image_count: 0,
            legacy: entry.legacy,
        }
    }
}

#[derive(Serialize)]
pub struct TreeSnapshot {
    nodes: Vec<TreeNode>,
    root_id: &'static str,
    trash_id: &'static str,
    version: u64,
}

/// What a change did to the tree: version `from` becomes `to` after removing
/// `remove` and inserting or replacing `upsert`. `from == to`: no change.
#[derive(Default, Serialize)]
pub struct TreeDelta {
    from: u64,
    to: u64,
    upsert: Vec<TreeNode>,
    remove: Vec<String>,
}

#[derive(Serialize)]
pub struct CreatedNode {
    id: String,
    final_name: String,
    tree: TreeDelta,
}

#[derive(Serialize)]
pub struct TrashResult {
    entry_id: String,
    tree: TreeDelta,
}

#[derive(Serialize)]
pub struct OpenDocument {
    text: String,
    rev: u64,
    read_only: bool,
    rollback_warning: bool,
    /// The text is an edit from the outbox that S3 does not hold yet.
    dirty: bool,
}

#[derive(Serialize)]
pub struct SaveResult {
    status: &'static str,
    document_id: Option<String>,
    /// A conflict copy was added to the tree.
    #[serde(skip_serializing_if = "Option::is_none")]
    tree: Option<TreeDelta>,
}

#[derive(Default, Serialize)]
pub struct PurgeResult {
    documents: u32,
    folders: u32,
    images: u32,
    tree: TreeDelta,
}

#[derive(Serialize)]
pub struct PassphraseChangeResult {
    cleanup_pending: bool,
}

#[derive(Serialize)]
pub struct RestoreResult {
    restored_id: String,
    final_name: String,
    final_path: String,
    tree: TreeDelta,
}

#[derive(Deserialize)]
#[serde(untagged)]
pub enum RestoreMode {
    Named(String),
    To {
        #[serde(rename = "To")]
        to: String,
    },
}

struct S3Remote {
    bucket: Bucket,
    credentials: S3Credentials,
    client: Client,
}

/// A complete S3 response: status, ETag and the whole body.
struct Reply {
    status: StatusCode,
    etag: Option<String>,
    body: Vec<u8>,
}

fn unreachable_error() -> IpcError {
    IpcError::new("UNREACHABLE", "S3 could not be reached.")
}

/// 15 s to the response headers, plus one second per MiB of the transfer.
fn transfer_timeout(bytes: u64) -> Duration {
    REQUEST_TIMEOUT + Duration::from_secs(bytes.div_ceil(1024 * 1024))
}

/// The bucket of an S3 location: the endpoint (HTTPS only, except a local
/// one in debug builds), its URL style and the bucket name, validated.
fn s3_bucket(config: &VaultConfig) -> Result<Bucket, IpcError> {
    let (endpoint, style) = match config
        .endpoint
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        Some(value) => {
            let url =
                Url::parse(value).map_err(|_| IpcError::invalid("The S3 endpoint is invalid."))?;
            if url.scheme() != "https"
                && !(cfg!(debug_assertions)
                    && matches!(url.host_str(), Some("localhost" | "127.0.0.1")))
            {
                return Err(IpcError::invalid("The S3 endpoint must use HTTPS."));
            }
            (url, UrlStyle::Path)
        }
        None => {
            let value = format!("https://s3.{}.amazonaws.com", config.region);
            (
                Url::parse(&value).map_err(|_| IpcError::invalid("The AWS region is invalid."))?,
                if config.bucket.contains('.') {
                    UrlStyle::Path
                } else {
                    UrlStyle::VirtualHost
                },
            )
        }
    };
    Bucket::new(
        endpoint,
        style,
        config.bucket.clone(),
        config.region.clone(),
    )
    .map_err(|_| IpcError::invalid("The bucket name or endpoint is invalid."))
}

impl S3Remote {
    fn new(config: &VaultConfig, credentials: &StoredCredentials) -> Result<Self, IpcError> {
        let bucket = s3_bucket(config)?;
        let https_only = bucket.base_url().scheme() == "https";
        let credentials = match credentials
            .session_token
            .as_deref()
            .filter(|v| !v.is_empty())
        {
            Some(token) => S3Credentials::new_with_token(
                credentials.access_key_id.clone(),
                credentials.secret_access_key.clone(),
                token.to_owned(),
            ),
            None => S3Credentials::new(
                credentials.access_key_id.clone(),
                credentials.secret_access_key.clone(),
            ),
        };
        // Built once per unlocked session: later requests reuse its pooled
        // connections instead of paying a TCP and TLS handshake each.
        let client = Client::builder()
            .https_only(https_only)
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(CONNECT_TIMEOUT)
            .pool_idle_timeout(Duration::from_secs(90))
            .pool_max_idle_per_host(8)
            .tcp_keepalive(Duration::from_secs(30))
            .build()
            .map_err(|_| IpcError::internal("HTTP_CLIENT"))?;
        Ok(Self {
            bucket,
            credentials,
            client,
        })
    }

    /// Sends a request, built and signed afresh for each attempt, and reads
    /// its whole body (which also returns the connection to the pool). Busy
    /// (429, 5xx) and network failures are tried twice; each attempt has its
    /// own timeout, so a network that silently drops traffic fails in about
    /// 31 s instead of hanging. A body over `limit` fails with `too_large`.
    async fn send(
        &self,
        build: impl Fn() -> RequestBuilder,
        upload: usize,
        limit: usize,
        too_large: IpcError,
    ) -> Result<Reply, IpcError> {
        for attempt in 0..MAX_S3_ATTEMPTS {
            let last = attempt + 1 == MAX_S3_ATTEMPTS;
            let sent = tokio::time::timeout(transfer_timeout(upload as u64), build().send()).await;
            let Ok(Ok(response)) = sent else {
                if last {
                    return Err(unreachable_error());
                }
                retry_pause(attempt).await;
                continue;
            };
            let status = response.status();
            if retryable_status(status) && !last {
                retry_pause(attempt).await;
                continue;
            }
            let expected = response.content_length();
            if expected.is_some_and(|size| size > limit as u64) {
                return Err(too_large);
            }
            let etag = response
                .headers()
                .get(ETAG)
                .and_then(|value| value.to_str().ok())
                .map(str::to_owned);
            let read = expected.unwrap_or(limit as u64);
            match tokio::time::timeout(transfer_timeout(read), response.bytes()).await {
                Ok(Ok(body)) if body.len() > limit => return Err(too_large),
                Ok(Ok(body)) => {
                    return Ok(Reply {
                        status,
                        etag,
                        body: body.to_vec(),
                    });
                }
                _ if last => return Err(unreachable_error()),
                _ => retry_pause(attempt).await,
            }
        }
        Err(IpcError::internal("S3_RETRY"))
    }

    async fn list(&self, prefix: Option<&str>) -> Result<Vec<ListedObject>, IpcError> {
        let too_large = IpcError::new(
            "WORKSPACE_TOO_LARGE",
            "The S3 listing response is too large.",
        );
        let mut all = Vec::new();
        let mut continuation: Option<String> = None;
        loop {
            let build = || {
                let mut action = self.bucket.list_objects_v2(Some(&self.credentials));
                if let Some(prefix) = prefix.filter(|v| !v.is_empty()) {
                    action.with_prefix(prefix.to_owned());
                }
                if let Some(token) = continuation.as_deref() {
                    action.with_continuation_token(token.to_owned());
                }
                self.client.get(action.sign(SIGNED_URL_TTL))
            };
            let reply = self
                .send(build, 0, MAX_LIST_RESPONSE_BYTES, too_large)
                .await?;
            check_status(reply.status)?;
            let body =
                std::str::from_utf8(&reply.body).map_err(|_| IpcError::internal("S3_RESPONSE"))?;
            let parsed = rusty_s3::actions::ListObjectsV2::parse_response(body)
                .map_err(|_| IpcError::internal("S3_RESPONSE"))?;
            all.extend(parsed.contents.into_iter().map(|value| ListedObject {
                key: value.key,
                etag: value.etag,
            }));
            if all.len() > MAX_OBJECTS {
                return Err(IpcError::new(
                    "WORKSPACE_TOO_LARGE",
                    "This workspace contains too many S3 objects.",
                ));
            }
            continuation = parsed.next_continuation_token;
            if continuation.is_none() {
                break;
            }
        }
        Ok(all)
    }

    async fn get(&self, key: &str) -> Result<ObjectBody, IpcError> {
        let too_large = IpcError::new(
            "DOCUMENT_TOO_LARGE",
            "The encrypted document is too large to open safely.",
        );
        let build = || {
            let action = self.bucket.get_object(Some(&self.credentials), key);
            self.client.get(action.sign(SIGNED_URL_TTL))
        };
        let reply = self.send(build, 0, MAX_DOCUMENT_BYTES, too_large).await?;
        if reply.status == StatusCode::NOT_FOUND {
            return Err(IpcError::new(
                "NOT_FOUND",
                "The S3 object no longer exists.",
            ));
        }
        check_status(reply.status)?;
        Ok(ObjectBody {
            bytes: reply.body,
            etag: reply.etag,
        })
    }

    async fn put(
        &self,
        key: &str,
        body: &[u8],
        condition: PutCondition<'_>,
    ) -> Result<Option<String>, IpcError> {
        let build = || {
            let mut action = self.bucket.put_object(Some(&self.credentials), key);
            match condition {
                PutCondition::IfMatch(etag) => action.headers_mut().insert("if-match", etag),
                PutCondition::IfNoneMatch => action.headers_mut().insert("if-none-match", "*"),
            };
            let request = self
                .client
                .put(action.sign(SIGNED_URL_TTL))
                .header("content-type", "application/octet-stream");
            match condition {
                PutCondition::IfMatch(etag) => request.header(IF_MATCH, etag),
                PutCondition::IfNoneMatch => request.header(IF_NONE_MATCH, "*"),
            }
            .body(body.to_vec())
        };
        let reply = self
            .send(
                build,
                body.len(),
                MAX_REPLY_BYTES,
                IpcError::internal("S3_RESPONSE"),
            )
            .await?;
        check_status(reply.status)?;
        Ok(reply.etag)
    }

    async fn delete(&self, key: &str, etag: Option<&str>) -> Result<(), IpcError> {
        let build = || {
            let mut action = self.bucket.delete_object(Some(&self.credentials), key);
            if let Some(etag) = etag {
                action.headers_mut().insert("if-match", etag);
            }
            let request = self.client.delete(action.sign(SIGNED_URL_TTL));
            match etag {
                Some(etag) => request.header(IF_MATCH, etag),
                None => request,
            }
        };
        let reply = self
            .send(build, 0, MAX_REPLY_BYTES, IpcError::internal("S3_RESPONSE"))
            .await?;
        check_status(reply.status)
    }

    /// CopyObject: S3 copies `source` (only while its ETag is `etag`) to
    /// `destination`, so the body never travels through this app. Notebook's
    /// bodies do not depend on the path, and Notebook renames the same way.
    /// The copy headers are signed, as presigned requests require for every
    /// `x-amz-*` header. Returns the new object's ETag.
    async fn copy(&self, source: &str, etag: &str, destination: &str) -> Result<String, IpcError> {
        let copy_source = format!("{}/{}", self.bucket.name(), encode_copy_source(source));
        let build = || {
            let mut action = self.bucket.put_object(Some(&self.credentials), destination);
            let headers = action.headers_mut();
            headers.insert("x-amz-copy-source", copy_source.as_str());
            headers.insert("x-amz-copy-source-if-match", etag);
            self.client
                .put(action.sign(SIGNED_URL_TTL))
                .header("x-amz-copy-source", copy_source.as_str())
                .header("x-amz-copy-source-if-match", etag)
        };
        let reply = self
            .send(build, 0, MAX_REPLY_BYTES, IpcError::internal("S3_RESPONSE"))
            .await?;
        if reply.status == StatusCode::NOT_FOUND {
            return Err(IpcError::new(
                "NOT_FOUND",
                "The S3 object no longer exists.",
            ));
        }
        check_status(reply.status)?;
        // CopyObject can fail after answering 200: the error is in the body.
        let body = String::from_utf8_lossy(&reply.body);
        if body.contains("<Error>") {
            return Err(IpcError::new(
                "S3_UNAVAILABLE",
                "S3 is temporarily unavailable.",
            ));
        }
        xml_text(&body, "ETag").ok_or_else(|| IpcError::internal("S3_RESPONSE"))
    }

    /// DeleteObjects in quiet mode: one request for up to 1,000 keys, without
    /// per-object conditions (used only for Trash contents). Returns the keys
    /// S3 reported as not deleted.
    async fn delete_batch(&self, keys: &[String]) -> Result<Vec<String>, IpcError> {
        let objects = keys
            .iter()
            .map(|key| ObjectIdentifier::new(key.clone()))
            .collect::<Vec<_>>();
        let build = || {
            let mut action = self
                .bucket
                .delete_objects(Some(&self.credentials), objects.iter());
            action.set_quiet(true);
            let url = action.sign(SIGNED_URL_TTL);
            let (body, md5) = action.body_with_md5();
            self.client
                .post(url)
                .header("content-md5", md5)
                .header("content-type", "application/xml")
                .body(body)
        };
        let reply = self
            .send(
                build,
                keys.iter().map(|key| key.len() + 32).sum(),
                MAX_LIST_RESPONSE_BYTES,
                IpcError::internal("S3_RESPONSE"),
            )
            .await?;
        check_status(reply.status)?;
        let body = String::from_utf8_lossy(&reply.body);
        Ok(body
            .split("<Error>")
            .skip(1)
            .filter_map(|error| xml_text(error.split("</Error>").next()?, "Key"))
            .collect())
    }
}

/// Percent-encodes a key for `x-amz-copy-source`, as Notebook does.
fn encode_copy_source(key: &str) -> String {
    let mut encoded = String::with_capacity(key.len());
    for byte in key.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~' | b'/') {
            encoded.push(char::from(byte));
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

/// The unescaped text of the first `<tag>` element in `xml`.
fn xml_text(xml: &str, tag: &str) -> Option<String> {
    let start = xml.find(&format!("<{tag}>"))? + tag.len() + 2;
    let end = start + xml[start..].find(&format!("</{tag}>"))?;
    Some(
        xml[start..end]
            .replace("&quot;", "\"")
            .replace("&#34;", "\"")
            .replace("&apos;", "'")
            .replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&amp;", "&"),
    )
}

/// Requests run at most this many at a time.
const PARALLEL: usize = 8;

/// Runs `jobs` at most `PARALLEL` at a time; the results keep their order.
async fn parallel<T, F>(jobs: Vec<F>) -> Vec<T>
where
    F: std::future::Future<Output = T> + Send + 'static,
    T: Send + 'static,
{
    let mut results = Vec::with_capacity(jobs.len());
    results.resize_with(jobs.len(), || None);
    let mut waiting = jobs.into_iter().enumerate();
    let mut running = tokio::task::JoinSet::new();
    loop {
        while running.len() < PARALLEL
            && let Some((index, job)) = waiting.next()
        {
            running.spawn(async move { (index, job.await) });
        }
        let Some(done) = running.join_next().await else {
            break;
        };
        match done {
            Ok((index, value)) => results[index] = Some(value),
            Err(error) => std::panic::resume_unwind(error.into_panic()),
        }
    }
    results.into_iter().flatten().collect()
}

struct ObjectBody {
    bytes: Vec<u8>,
    etag: Option<String>,
}

#[derive(Clone, Copy)]
enum PutCondition<'a> {
    IfMatch(&'a str),
    IfNoneMatch,
}

struct ListedObject {
    key: String,
    etag: String,
}

fn retryable_status(status: StatusCode) -> bool {
    status == StatusCode::TOO_MANY_REQUESTS || status.is_server_error()
}

async fn retry_pause(attempt: usize) {
    let base_ms = 500_u64.saturating_mul(1_u64 << attempt.min(5));
    let mut random = [0_u8; 2];
    let _ = getrandom::fill(&mut random);
    let jitter_ms = u64::from(u16::from_le_bytes(random)) % 250;
    tokio::time::sleep(Duration::from_millis((base_ms + jitter_ms).min(30_000))).await;
}

fn check_status(status: StatusCode) -> Result<(), IpcError> {
    match status.as_u16() {
        200..=299 => Ok(()),
        401 | 403 => Err(IpcError::new(
            "ACCESS_DENIED",
            "S3 denied access. Check the credentials and bucket permissions.",
        )),
        404 => Err(IpcError::new(
            "NOT_FOUND",
            "The bucket or object was not found.",
        )),
        412 => Err(IpcError::new(
            "CONFLICT",
            "This item changed in S3. Your edit was preserved as a conflict copy.",
        )),
        429 => Err(IpcError::new(
            "THROTTLED",
            "S3 is throttling requests. Try again shortly.",
        )),
        500..=599 => Err(IpcError::new(
            "S3_UNAVAILABLE",
            "S3 is temporarily unavailable.",
        )),
        _ => Err(IpcError::internal("S3_REQUEST")),
    }
}

fn normalized_prefix(value: &str) -> String {
    value.trim().trim_matches('/').to_owned()
}
fn list_prefix(config: &VaultConfig) -> Option<String> {
    let prefix = normalized_prefix(&config.prefix);
    (!prefix.is_empty()).then(|| format!("{prefix}/"))
}
fn stored_key(
    config: &VaultConfig,
    codec: &NotebookV1Codec,
    logical_path: &str,
) -> Result<String, IpcError> {
    let encoded = codec
        .encode_path(logical_path)
        .map_err(|_| IpcError::internal("ENCRYPT_PATH"))?;
    let prefix = normalized_prefix(&config.prefix);
    Ok(if prefix.is_empty() {
        encoded
    } else {
        format!("{prefix}/{encoded}")
    })
}
// The `secure-md-vault::` hash tags predate the rename to Notebook and stay
// fixed: pending outbox files on disk are named by them.
fn stable_id(kind: &str, path: &str) -> String {
    let mut hash = Sha256::new();
    hash.update(b"secure-md-vault::node::");
    hash.update(kind.as_bytes());
    hash.update([0]);
    hash.update(path.as_bytes());
    format!("n-{}", hex::encode(hash.finalize()))
}

/// Each vault (endpoint, bucket and prefix) has its own outbox folder, so
/// edits queued for one vault are never replayed into another.
fn vault_outbox_dir(state: &NotebookState, config: &VaultConfig) -> PathBuf {
    let endpoint = config.endpoint.as_deref().map_or("", str::trim);
    let prefix = normalized_prefix(&config.prefix);
    let mut hash = Sha256::new();
    hash.update(b"notebook::outbox-vault::");
    for part in [endpoint, config.bucket.as_str(), prefix.as_str()] {
        hash.update(part.as_bytes());
        hash.update([0]);
    }
    state.outbox_dir().join(hex::encode(&hash.finalize()[..12]))
}

fn outbox_file_name(key: &str) -> String {
    let mut hash = Sha256::new();
    hash.update(b"secure-md-vault::outbox::");
    hash.update(key.as_bytes());
    format!("{}.pending", hex::encode(hash.finalize()))
}

fn outbox_path(state: &NotebookState, config: &VaultConfig, key: &str) -> PathBuf {
    vault_outbox_dir(state, config).join(outbox_file_name(key))
}

fn create_vault_outbox(state: &NotebookState, config: &VaultConfig) -> Result<(), IpcError> {
    create_private_dir(state.outbox_dir())
        .and_then(|()| create_private_dir(&vault_outbox_dir(state, config)))
        .map_err(|_| IpcError::internal("OUTBOX_WRITE"))
}

fn persist_outbox(
    state: &NotebookState,
    config: &VaultConfig,
    key: &str,
    body: &[u8],
    expected_etag: Option<&str>,
) -> Result<(), IpcError> {
    create_vault_outbox(state, config)?;
    let payload = outbox_payload(key, body, expected_etag)?;
    let target = outbox_path(state, config, key);
    let temporary = target.with_extension("pending.tmp");
    write_private_file(&temporary, &payload).map_err(|_| IpcError::internal("OUTBOX_WRITE"))?;
    std::fs::rename(temporary, target).map_err(|_| IpcError::internal("OUTBOX_WRITE"))
}

fn remove_outbox(state: &NotebookState, config: &VaultConfig, key: &str) {
    let _ = std::fs::remove_file(outbox_path(state, config, key));
}

#[derive(Clone, Serialize, Deserialize)]
struct CleanupEntry {
    key: String,
    etag: String,
}

fn cleanup_path(state: &NotebookState, config: &VaultConfig) -> PathBuf {
    vault_outbox_dir(state, config).join("passphrase-cleanup.json")
}

/// The queued edits (`*.pending` files) filed for the location `config`.
fn pending_files(state: &NotebookState, config: &VaultConfig) -> Vec<PathBuf> {
    std::fs::read_dir(vault_outbox_dir(state, config)).map_or_else(
        |_| Vec::new(),
        |entries| {
            entries
                .flatten()
                .map(|entry| entry.path())
                .filter(|path| is_pending_file(path))
                .collect()
        },
    )
}

/// Files the queued edits (and an unfinished phrase-change cleanup) of `from`
/// under `to`, a new endpoint of the same bucket and prefix whose own folder
/// holds no queued edits. A file that cannot move stays where it was.
fn carry_outbox(state: &NotebookState, from: &VaultConfig, to: &VaultConfig) {
    if create_vault_outbox(state, to).is_err() {
        tracing::warn!("queued uploads could not follow the workspace's new endpoint");
        return;
    }
    let target = vault_outbox_dir(state, to);
    let mut files = pending_files(state, from);
    let cleanup = cleanup_path(state, from);
    if cleanup.is_file() && !cleanup_path(state, to).exists() {
        files.push(cleanup);
    }
    let mut left = 0_usize;
    for file in files {
        let moved = file
            .file_name()
            .is_some_and(|name| std::fs::rename(&file, target.join(name)).is_ok());
        if !moved {
            left += 1;
        }
    }
    if left > 0 {
        tracing::warn!(
            left,
            "queued uploads could not follow the workspace's new endpoint"
        );
    }
}

fn persist_cleanup(
    state: &NotebookState,
    config: &VaultConfig,
    entries: &[CleanupEntry],
) -> Result<(), IpcError> {
    let path = cleanup_path(state, config);
    if entries.is_empty() {
        let _ = std::fs::remove_file(path);
        return Ok(());
    }
    create_vault_outbox(state, config)?;
    let bytes = serde_json::to_vec(entries).map_err(|_| IpcError::internal("OUTBOX_WRITE"))?;
    let temporary = path.with_extension("json.tmp");
    write_private_file(&temporary, &bytes).map_err(|_| IpcError::internal("OUTBOX_WRITE"))?;
    std::fs::rename(temporary, path).map_err(|_| IpcError::internal("OUTBOX_WRITE"))
}

/// Finishes deletion of old-key objects after a completed phrase migration.
/// ETag preconditions ensure a concurrently changed old object is preserved.
async fn replay_cleanup(
    state: &NotebookState,
    config: &VaultConfig,
    remote: &S3Remote,
) -> Result<bool, IpcError> {
    let path = cleanup_path(state, config);
    let Ok(bytes) = std::fs::read(&path) else {
        return Ok(false);
    };
    let entries: Vec<CleanupEntry> =
        serde_json::from_slice(&bytes).map_err(|_| IpcError::internal("OUTBOX_DAMAGED"))?;
    let mut remaining = Vec::new();
    let mut first_error = None;
    for entry in entries {
        match remote.delete(&entry.key, Some(&entry.etag)).await {
            Ok(()) => {}
            Err(error) if error.code() == "NOT_FOUND" => {}
            Err(error) => {
                if first_error.is_none() {
                    first_error = Some(error);
                }
                remaining.push(entry);
            }
        }
    }
    persist_cleanup(state, config, &remaining)?;
    if let Some(error) = first_error {
        tracing::warn!(
            code = error.code(),
            "old passphrase objects remain queued for cleanup"
        );
    }
    Ok(!remaining.is_empty())
}

const OUTBOX_MAGIC: &[u8; 4] = b"NBO1";

/// Versioned outbox entry: opaque S3 key, expected ETag and ciphertext. The
/// ETag makes replay conditional, so an offline edit cannot overwrite a newer
/// copy written by Notebook on another device.
fn outbox_payload(
    key: &str,
    body: &[u8],
    expected_etag: Option<&str>,
) -> Result<Vec<u8>, IpcError> {
    let key_bytes = key.as_bytes();
    let etag_bytes = expected_etag.unwrap_or_default().as_bytes();
    let key_length =
        u32::try_from(key_bytes.len()).map_err(|_| IpcError::internal("OUTBOX_WRITE"))?;
    let etag_length =
        u32::try_from(etag_bytes.len()).map_err(|_| IpcError::internal("OUTBOX_WRITE"))?;
    let mut payload = Vec::with_capacity(13 + key_bytes.len() + etag_bytes.len() + body.len());
    payload.extend_from_slice(OUTBOX_MAGIC);
    payload.push(u8::from(expected_etag.is_some()));
    payload.extend_from_slice(&key_length.to_le_bytes());
    payload.extend_from_slice(&etag_length.to_le_bytes());
    payload.extend_from_slice(key_bytes);
    payload.extend_from_slice(etag_bytes);
    payload.extend_from_slice(body);
    Ok(payload)
}

enum PendingCondition {
    IfMatch(String),
    IfNoneMatch,
    Legacy,
}

struct PendingUpload {
    key: String,
    body: Vec<u8>,
    condition: PendingCondition,
}

fn parse_outbox(payload: &[u8]) -> Result<PendingUpload, IpcError> {
    let damaged = || IpcError::internal("OUTBOX_DAMAGED");
    if payload.starts_with(OUTBOX_MAGIC) {
        if payload.len() < 13 {
            return Err(damaged());
        }
        let has_etag = payload[4] != 0;
        let key_length =
            u32::from_le_bytes(payload[5..9].try_into().map_err(|_| damaged())?) as usize;
        let etag_length =
            u32::from_le_bytes(payload[9..13].try_into().map_err(|_| damaged())?) as usize;
        let header = 13_usize;
        let body_start = header
            .checked_add(key_length)
            .and_then(|value| value.checked_add(etag_length))
            .ok_or_else(damaged)?;
        if key_length == 0
            || key_length > 4_096
            || etag_length > 1_024
            || payload.len() < body_start
        {
            return Err(damaged());
        }
        let key = std::str::from_utf8(&payload[header..header + key_length])
            .map_err(|_| damaged())?
            .to_owned();
        let etag = std::str::from_utf8(&payload[header + key_length..body_start])
            .map_err(|_| damaged())?
            .to_owned();
        let condition = if has_etag {
            if etag.is_empty() {
                return Err(damaged());
            }
            PendingCondition::IfMatch(etag)
        } else {
            PendingCondition::IfNoneMatch
        };
        return Ok(PendingUpload {
            key,
            body: payload[body_start..].to_vec(),
            condition,
        });
    }

    // Compatibility with encrypted outbox files written by earlier builds.
    let length = payload.first_chunk::<4>().ok_or_else(damaged)?;
    let key_length = u32::from_le_bytes(*length) as usize;
    if key_length == 0 || key_length > 4_096 || payload.len() < 4 + key_length {
        return Err(damaged());
    }
    let key = std::str::from_utf8(&payload[4..4 + key_length])
        .map_err(|_| damaged())?
        .to_owned();
    Ok(PendingUpload {
        key,
        body: payload[4 + key_length..].to_vec(),
        condition: PendingCondition::Legacy,
    })
}

fn key_in_vault(config: &VaultConfig, key: &str) -> bool {
    list_prefix(config).is_none_or(|prefix| key.starts_with(&prefix))
}

fn is_pending_file(path: &Path) -> bool {
    path.is_file() && path.extension().and_then(|value| value.to_str()) == Some("pending")
}

/// Earlier builds kept one flat outbox for every vault. A flat entry moves
/// into this vault's folder only when its key is under this vault's prefix and
/// its name and body decrypt with this vault's phrase; anything else stays
/// where it is. Returns how many flat entries were left.
fn adopt_flat_outbox(
    state: &NotebookState,
    config: &VaultConfig,
    codec: &NotebookV1Codec,
) -> usize {
    let Ok(entries) = std::fs::read_dir(state.outbox_dir()) else {
        return 0;
    };
    let prefix = list_prefix(config).unwrap_or_default();
    let mut left = 0;
    for path in entries.flatten().map(|entry| entry.path()) {
        if !is_pending_file(&path) {
            continue;
        }
        let Ok(payload) = std::fs::read(&path) else {
            left += 1;
            continue;
        };
        let ours = parse_outbox(&payload).is_ok_and(|pending| {
            pending
                .key
                .strip_prefix(prefix.as_str())
                .is_some_and(|relative| codec.decode_path(relative).is_ok())
                && codec.decode_content(&pending.body).is_ok()
        });
        let target = parse_outbox(&payload).map(|pending| outbox_path(state, config, &pending.key));
        let (true, Ok(target)) = (ours, target) else {
            left += 1;
            continue;
        };
        // As when the same object is saved again, the newer queued body wins.
        let modified = |path: &Path| std::fs::metadata(path).and_then(|meta| meta.modified());
        let moved = match (modified(&target), modified(&path)) {
            (Ok(existing), Ok(flat)) if existing >= flat => std::fs::remove_file(&path).is_ok(),
            _ => {
                create_vault_outbox(state, config).is_ok()
                    && std::fs::rename(&path, &target).is_ok()
            }
        };
        if !moved {
            left += 1;
        }
    }
    left
}

/// Uploads this vault's queued edits, except those this session staged: their
/// uploads go through `commit_key`, which keeps the journal consistent.
/// `codec` is the unlocked vault's codec, needed to adopt entries from the
/// flat outbox of earlier builds.
async fn replay_outbox(
    state: &NotebookState,
    config: &VaultConfig,
    remote: &S3Remote,
    codec: Option<&NotebookV1Codec>,
) -> Result<(), IpcError> {
    if let Some(codec) = codec {
        let left = adopt_flat_outbox(state, config, codec);
        if left > 0 {
            tracing::warn!(
                left,
                "queued uploads of another vault or phrase were left in the outbox"
            );
        }
    }
    let Ok(entries) = std::fs::read_dir(vault_outbox_dir(state, config)) else {
        return Ok(());
    };
    let staged = staged_keys(state)
        .into_iter()
        .map(|key| outbox_file_name(&key))
        .collect::<HashSet<_>>();
    let pending = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| is_pending_file(path))
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_none_or(|name| !staged.contains(name))
        })
        .collect::<Vec<_>>();
    if cleanup_path(state, config).is_file() {
        let _ = replay_cleanup(state, config, remote).await?;
    }
    for path in pending {
        let payload = std::fs::read(&path).map_err(|_| IpcError::internal("OUTBOX_READ"))?;
        let pending = parse_outbox(&payload)?;
        if !key_in_vault(config, &pending.key) {
            continue;
        }
        replay_pending(remote, config, codec, &pending).await?;
        std::fs::remove_file(path).map_err(|_| IpcError::internal("OUTBOX_WRITE"))?;
    }
    Ok(())
}

/// Replays one durable edit without ever replacing an object that changed on
/// another device. A matching plaintext means a previous PUT succeeded but
/// its response was lost; a different plaintext, or an object deleted or
/// moved meanwhile, gets the edit written as a conflict copy.
async fn replay_pending(
    remote: &S3Remote,
    config: &VaultConfig,
    codec: Option<&NotebookV1Codec>,
    pending: &PendingUpload,
) -> Result<(), IpcError> {
    let condition = match &pending.condition {
        PendingCondition::IfMatch(etag) => PutCondition::IfMatch(etag),
        PendingCondition::IfNoneMatch | PendingCondition::Legacy => PutCondition::IfNoneMatch,
    };
    match remote.put(&pending.key, &pending.body, condition).await {
        Ok(_) => return Ok(()),
        Err(error) if !is_changed_error(&error) => return Err(error),
        Err(_) => {}
    }

    let codec = codec.ok_or_else(|| {
        IpcError::new(
            "UNLOCK_REQUIRED",
            "Unlock the workspace to safely replay an edit that conflicts with S3.",
        )
    })?;
    if let Some(current) = current_object(remote, &pending.key).await?
        && same_plaintext(codec, &current.bytes, &pending.body)
    {
        return Ok(());
    }
    let logical_path = logical_path_from_key(config, codec, &pending.key)?;
    upload_conflict_copy(remote, config, codec, &logical_path, &pending.body)
        .await
        .map(drop)
}

/// A conditional upload found another version, or no object at all.
fn is_changed_error(error: &IpcError) -> bool {
    matches!(error.code(), "CONFLICT" | "NOT_FOUND")
}

/// The object now stored under `key`, or `None` when it is gone.
async fn current_object(remote: &S3Remote, key: &str) -> Result<Option<ObjectBody>, IpcError> {
    match remote.get(key).await {
        Ok(object) => Ok(Some(object)),
        Err(error) if error.code() == "NOT_FOUND" => Ok(None),
        Err(error) => Err(error),
    }
}

fn logical_path_from_key(
    config: &VaultConfig,
    codec: &NotebookV1Codec,
    key: &str,
) -> Result<String, IpcError> {
    let prefix = list_prefix(config).unwrap_or_default();
    let relative = key
        .strip_prefix(prefix.as_str())
        .ok_or_else(|| IpcError::internal("OUTBOX_DAMAGED"))?;
    codec
        .decode_path(relative)
        .map_err(|_| IpcError::internal("OUTBOX_DAMAGED"))
}

fn same_plaintext(codec: &NotebookV1Codec, left: &[u8], right: &[u8]) -> bool {
    if left == right {
        return true;
    }
    match (codec.decode_content(left), codec.decode_content(right)) {
        (Ok(left), Ok(right)) => left.as_str() == right.as_str(),
        _ => false,
    }
}

fn conflict_path(original: &str, timestamp: u64, sequence: usize) -> String {
    let parent = parent_path(original);
    let name = file_name(original);
    let dot = name
        .rfind('.')
        .filter(|index| *index > 0)
        .unwrap_or(name.len());
    let (stem, extension) = name.split_at(dot);
    let suffix = if sequence == 0 {
        format!(" (conflict {timestamp})")
    } else {
        format!(" (conflict {timestamp}-{sequence})")
    };
    join_path(parent, &format!("{stem}{suffix}{extension}"))
}

/// Stores an already-encrypted body under a new Notebook-compatible path.
/// The conditional create and bounded name loop make the operation safe even
/// when several devices discover the same conflict simultaneously.
async fn upload_conflict_copy(
    remote: &S3Remote,
    config: &VaultConfig,
    codec: &NotebookV1Codec,
    original_path: &str,
    body: &[u8],
) -> Result<(String, String, Option<String>), IpcError> {
    let timestamp = now_ms();
    for sequence in 0..100 {
        let logical_path = conflict_path(original_path, timestamp, sequence);
        let key = stored_key(config, codec, &logical_path)?;
        match remote.put(&key, body, PutCondition::IfNoneMatch).await {
            Ok(etag) => return Ok((logical_path, key, etag)),
            Err(error) if error.code() == "CONFLICT" => {
                // A timed-out create may already have succeeded. Only an
                // exact ciphertext match proves that this is our PUT.
                if let Ok(existing) = remote.get(&key).await
                    && existing.bytes == body
                {
                    return Ok((logical_path, key, existing.etag));
                }
                continue;
            }
            Err(error) => return Err(error),
        }
    }
    Err(IpcError::new(
        "CONFLICT",
        "A unique conflict-copy name could not be created.",
    ))
}
fn now_ms() -> u64 {
    let elapsed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX)
}
fn join_path(parent: &str, name: &str) -> String {
    if parent.is_empty() {
        name.to_owned()
    } else {
        format!("{parent}/{name}")
    }
}
fn parent_path(path: &str) -> &str {
    path.rsplit_once('/').map_or("", |(parent, _)| parent)
}
fn file_name(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}
fn validate_name(name: &str) -> Result<String, IpcError> {
    let value = name.trim();
    if value.is_empty() || value.len() > 255 {
        return Err(IpcError::invalid("Names must contain 1 to 255 characters."));
    }
    if deleted_items::is_reserved_name(value) {
        return Err(IpcError::invalid(
            "That name is reserved for deleted items.",
        ));
    }
    if value.contains(['/', '\\', '\0']) || matches!(value, "." | ".." | DIRECTORY_MARKER) {
        return Err(IpcError::invalid(
            "That name is reserved or contains an invalid character.",
        ));
    }
    Ok(value.to_owned())
}

async fn load_session(
    config: &VaultConfig,
    remote: Arc<S3Remote>,
    codec: NotebookV1Codec,
) -> Result<Session, IpcError> {
    let listed = remote.list(list_prefix(config).as_deref()).await?;
    build_session(config, codec, listed, remote)
}

fn build_session(
    config: &VaultConfig,
    codec: NotebookV1Codec,
    listed: Vec<ListedObject>,
    remote: Arc<S3Remote>,
) -> Result<Session, IpcError> {
    let objects = decode_listing(config, &codec, listed)?;
    Ok(Session::new(config.clone(), codec, remote, objects))
}

/// Decrypts listed keys into logical paths. A listing in which nothing
/// decrypts, but something does not, belongs to another phrase.
fn decode_listing(
    config: &VaultConfig,
    codec: &NotebookV1Codec,
    listed: Vec<ListedObject>,
) -> Result<BTreeMap<String, Object>, IpcError> {
    let prefix = list_prefix(config);
    let mut objects = BTreeMap::new();
    let mut undecodable = 0;
    for object in listed {
        let relative = match prefix.as_deref() {
            Some(prefix) => match object.key.strip_prefix(prefix) {
                Some(value) => value,
                None => continue,
            },
            None => object.key.trim_matches('/'),
        };
        if relative.is_empty() {
            continue;
        }
        match codec.decode_path(relative) {
            Ok(path) => {
                objects.insert(
                    path,
                    Object {
                        key: object.key,
                        etag: object.etag,
                    },
                );
            }
            Err(_) => undecodable += 1,
        }
    }
    if objects.is_empty() && undecodable > 0 {
        return Err(IpcError::new(
            "WRONG_PHRASE",
            "The encryption phrase does not match this workspace.",
        ));
    }
    Ok(objects)
}

fn build_nodes(objects: &BTreeMap<String, Object>) -> HashMap<String, NodeRecord> {
    let mut folder_paths = BTreeSet::new();
    let mut docs = Vec::new();
    for path in objects.keys() {
        if deleted_items::is_hidden_path(path) {
            continue;
        }
        let marker = is_marker_path(path);
        let visible = if marker { parent_path(path) } else { path };
        let mut parent = parent_path(visible);
        while !parent.is_empty() && folder_paths.insert(parent.to_owned()) {
            parent = parent_path(parent);
        }
        if marker && !visible.is_empty() {
            folder_paths.insert(visible.to_owned());
        } else if !marker {
            docs.push(path.as_str());
        }
    }
    let record = |kind: &'static str, path: &str| {
        let parent = parent_path(path);
        NodeRecord {
            id: node_id(kind, path),
            parent: Some(if parent.is_empty() {
                ROOT_ID.into()
            } else {
                stable_id("folder", parent)
            }),
            name: file_name(path).into(),
            kind,
            logical_path: path.to_owned(),
        }
    };
    folder_paths
        .iter()
        .map(|path| record("Folder", path))
        .chain(docs.into_iter().map(|path| record("Document", path)))
        .map(|node| (node.id.clone(), node))
        .collect()
}

fn fixed_node(id: &str, name: &str, kind: &'static str) -> TreeNode {
    TreeNode {
        id: id.into(),
        parent: None,
        name: name.into(),
        kind,
        origin: None,
        trash_entry_id: None,
    }
}

fn tree_node(record: &NodeRecord) -> TreeNode {
    TreeNode {
        id: record.id.clone(),
        parent: record.parent.clone(),
        name: record.name.clone(),
        kind: record.kind,
        origin: None,
        trash_entry_id: None,
    }
}

fn trash_entry_node(entry: BinEntry) -> TreeNode {
    TreeNode {
        id: format!("trash-{}", entry.key),
        parent: Some(TRASH_ID.into()),
        name: entry.name.clone(),
        kind: "TrashEntry",
        origin: Some(OriginSummary::from(&entry)),
        trash_entry_id: Some(entry.key),
    }
}

fn trash_entries(objects: &BTreeMap<String, Object>) -> Vec<BinEntry> {
    deleted_items::catalog(&objects.keys().map(String::as_str).collect::<Vec<_>>())
}

/// The frontend's tree: Vault and Trash, every folder and document, and the
/// Trash entries, by id.
fn tree_view(
    nodes: &HashMap<String, NodeRecord>,
    objects: &BTreeMap<String, Object>,
) -> HashMap<String, TreeNode> {
    [
        fixed_node(ROOT_ID, "Vault", "Root"),
        fixed_node(TRASH_ID, "Trash", "Trash"),
    ]
    .into_iter()
    .chain(nodes.values().map(tree_node))
    .chain(trash_entries(objects).into_iter().map(trash_entry_node))
    .map(|node| (node.id.clone(), node))
    .collect()
}

/// The whole tree: Vault and Trash, nodes by path, then the Trash entries in
/// Notebook's order.
fn snapshot(session: &Session) -> TreeSnapshot {
    let mut records = session.nodes.values().collect::<Vec<_>>();
    records.sort_by(|a, b| a.logical_path.cmp(&b.logical_path));
    let nodes = [
        fixed_node(ROOT_ID, "Vault", "Root"),
        fixed_node(TRASH_ID, "Trash", "Trash"),
    ]
    .into_iter()
    .chain(records.into_iter().map(tree_node))
    .chain(
        trash_entries(&session.objects)
            .into_iter()
            .map(trash_entry_node),
    )
    .collect();
    TreeSnapshot {
        nodes,
        root_id: ROOT_ID,
        trash_id: TRASH_ID,
        version: session.version,
    }
}

/// The keychain account under which builds before workspaces stored the S3
/// credentials of one bucket and prefix. Only the migration still reads it.
fn keychain_user(config: &VaultConfig) -> String {
    let mut hash = Sha256::new();
    hash.update(config.bucket.as_bytes());
    hash.update([0]);
    hash.update(normalized_prefix(&config.prefix).as_bytes());
    format!("s3-{}", hex::encode(&hash.finalize()[..12]))
}

#[cfg(target_os = "macos")]
const KEYCHAIN_UNAVAILABLE: &str =
    "The macOS keychain could not be used. Unlock it and allow access when asked.";
#[cfg(windows)]
const KEYCHAIN_UNAVAILABLE: &str = "Windows Credential Manager is not available in this session.";
#[cfg(not(any(target_os = "macos", windows)))]
const KEYCHAIN_UNAVAILABLE: &str = "No OS keychain is available. Install and unlock GNOME Keyring or KWallet (Secret Service), then try again.";

fn keychain_error(error: keyring::Error) -> IpcError {
    match error {
        keyring::Error::NoEntry => IpcError::no_credentials(
            "S3 credentials are not stored for this workspace. Edit the workspace to enter them.",
        ),
        keyring::Error::TooLong(..) => IpcError::new(
            "KEYCHAIN_TOO_LONG",
            "This value is too long for the OS credential store.",
        ),
        keyring::Error::NoStorageAccess(_) | keyring::Error::PlatformFailure(_) => {
            IpcError::new("KEYCHAIN_UNAVAILABLE", KEYCHAIN_UNAVAILABLE)
        }
        _ => IpcError::new("KEYCHAIN", "The OS keychain could not be used."),
    }
}

/// The accent palette in src/theme.css; orange is the app icon's colour.
const ACCENTS: [&str; 9] = [
    "orange", "red", "pink", "purple", "blue", "teal", "green", "yellow", "graphite",
];

fn default_accent() -> String {
    ACCENTS[0].into()
}

fn validate_accent(accent: &str) -> Result<(), IpcError> {
    if ACCENTS.contains(&accent) {
        Ok(())
    } else {
        Err(IpcError::invalid("The selected accent colour is invalid."))
    }
}

fn validate_theme(theme: &str) -> Result<(), IpcError> {
    if matches!(theme, "System" | "Light" | "Dark") {
        Ok(())
    } else {
        Err(IpcError::invalid("The selected theme is invalid."))
    }
}

fn validate_auto_lock(minutes: u32) -> Result<(), IpcError> {
    if minutes > 1440 {
        return Err(IpcError::invalid(
            "Auto-lock must be between 0 and 1440 minutes.",
        ));
    }
    Ok(())
}

/// Updates the global preferences. It never touches a workspace, its
/// credentials or the unlocked session.
#[tauri::command]
pub fn settings_set(
    state: State<'_, NotebookState>,
    auto_lock_minutes: u32,
    theme: String,
    accent: String,
) -> Result<(), IpcError> {
    validate_auto_lock(auto_lock_minutes)?;
    validate_theme(&theme)?;
    validate_accent(&accent)?;
    let mut inner = state
        .inner
        .lock()
        .map_err(|_| IpcError::internal("STATE"))?;
    let mut app = inner.app.clone();
    app.auto_lock_minutes = auto_lock_minutes;
    app.theme = theme;
    app.accent = accent;
    state.save_config(&app)?;
    inner.app = app;
    inner.last_activity = Instant::now();
    inner.idle_notified = false;
    Ok(())
}

/// Access key IDs are printable ASCII. A pasted zero-width space or other
/// invisible character is refused before anything is stored.
fn validate_access_key_id(value: &str) -> Result<(), IpcError> {
    if value.bytes().all(|byte| byte.is_ascii_graphic()) {
        Ok(())
    } else {
        Err(IpcError::invalid(
            "The access key ID may contain only printable ASCII characters.",
        ))
    }
}

fn masked_access_key_id(value: &str) -> String {
    let count = value.chars().count();
    let tail = value
        .chars()
        .skip(count.saturating_sub(4))
        .collect::<String>();
    if count > 4 {
        format!("••••{tail}")
    } else {
        "••••".into()
    }
}

#[tauri::command]
pub async fn connection_test(state: State<'_, NotebookState>) -> Result<&'static str, IpcError> {
    let (_, config, credentials) = workspaces::active_credentials(&state)?;
    let found = !S3Remote::new(&config, &credentials)?
        .list(list_prefix(&config).as_deref())
        .await?
        .is_empty();
    Ok(if found { "VaultFound" } else { "NoVault" })
}

/// Unlocks the active workspace. Without `passphrase` the remembered phrase is
/// used (`NO_STORED_PHRASE` when there is none). After a successful unlock,
/// `remember: true` stores the typed phrase and `remember: false` forgets the
/// stored one; without `remember` the stored phrase is left as it is. A wrong
/// phrase fails before anything is stored, so it never replaces a stored one.
#[tauri::command]
pub async fn vault_unlock(
    state: State<'_, NotebookState>,
    passphrase: Option<String>,
    remember: Option<bool>,
) -> Result<TreeSnapshot, IpcError> {
    unlock(&state, passphrase, remember).await
}

async fn unlock(
    state: &NotebookState,
    passphrase: Option<String>,
    remember: Option<bool>,
) -> Result<TreeSnapshot, IpcError> {
    // Missing credentials are reported before the phrase is looked at, so the
    // frontend can send the user to setup instead of claiming a wrong phrase.
    let (workspace, config, credentials) = workspaces::active_credentials(state)?;
    let typed = passphrase.is_some();
    let phrase = match passphrase {
        Some(phrase) => Zeroizing::new(phrase),
        None => workspaces::stored_phrase(state, &workspace)?,
    };
    let codec = NotebookV1Codec::new(SecretString::from(phrase.as_str().to_owned()))
        .map_err(|_| IpcError::new("WRONG_PHRASE", "Enter a non-empty encryption phrase."))?;
    // Every queued edit, also those of an earlier session, is replayed below.
    state.forget_journal();
    let remote = Arc::new(S3Remote::new(&config, &credentials)?);
    replay_outbox(state, &config, &remote, Some(&codec)).await?;
    // A wrong phrase fails here, before the stored phrase is changed below.
    let session = load_session(&config, remote, codec).await?;
    // Only for the location the phrase just opened: a workspace moved while
    // S3 answered is WORKSPACE_CHANGED and keeps what it stores.
    match remember {
        Some(true) if typed => {
            workspaces::remember_phrase(state, &workspace, &config, Some(&phrase))?;
        }
        Some(false) => workspaces::remember_phrase(state, &workspace, &config, None)?,
        _ => {}
    }
    let result = snapshot(&session);
    let mut journal = lock_journal(state)?;
    let mut inner = state
        .inner
        .lock()
        .map_err(|_| IpcError::internal("STATE"))?;
    // Another workspace may have been selected, or this one edited, while S3
    // answered: a session never belongs to anything but the active workspace.
    if inner.active_id() != Some(workspace.as_str()) || inner.active_config() != Some(config) {
        return Err(workspaces::workspace_changed());
    }
    journal.adopt(&session);
    inner.session = Some(session);
    inner.last_activity = Instant::now();
    inner.idle_notified = false;
    Ok(result)
}

#[tauri::command]
pub fn vault_lock(state: State<'_, NotebookState>) -> Result<(), IpcError> {
    state.forget_journal();
    let mut inner = state
        .inner
        .lock()
        .map_err(|_| IpcError::internal("STATE"))?;
    inner.session = None;
    inner.idle_notified = false;
    Ok(())
}

#[tauri::command]
pub fn activity_ping(state: State<'_, NotebookState>) -> Result<(), IpcError> {
    let mut inner = state
        .inner
        .lock()
        .map_err(|_| IpcError::internal("STATE"))?;
    if inner.session.is_some() {
        inner.last_activity = Instant::now();
        inner.idle_notified = false;
    }
    Ok(())
}

/// The tree: with `relist`, S3 is listed again (the Refresh button: changes
/// made on other devices appear); without, the session's own tree is
/// returned without a request (the frontend resynchronising after an error).
#[tauri::command]
pub async fn tree_get(
    state: State<'_, NotebookState>,
    relist: bool,
) -> Result<TreeSnapshot, IpcError> {
    if relist {
        refresh(&state).await
    } else {
        with_session(&state, |session| snapshot(session))
    }
}

/// Uploads queued edits of earlier sessions, then lists S3 and replaces the
/// object map. Writes this session made while the listing ran are applied
/// again on top, so a save racing the refresh keeps its new ETag.
async fn refresh(state: &NotebookState) -> Result<TreeSnapshot, IpcError> {
    let _one = state.refreshing.lock().await;
    let live = unlocked(state)?;
    with_live_session(state, &live, |session| session.recording = Some(Vec::new()))?;
    let listed = async {
        replay_outbox(state, &live.config, &live.remote, Some(&live.codec)).await?;
        live.remote.list(list_prefix(&live.config).as_deref()).await
    }
    .await;
    let mut inner = state
        .inner
        .lock()
        .map_err(|_| IpcError::internal("STATE"))?;
    inner.last_activity = Instant::now();
    inner.idle_notified = false;
    let session = inner
        .session
        .as_mut()
        .filter(|session| session.id == live.session)
        .ok_or_else(IpcError::locked)?;
    let writes = session.recording.take().unwrap_or_default();
    session.objects = decode_listing(&live.config, &live.codec, listed?)?;
    session.apply(writes);
    session.rebuild();
    Ok(snapshot(session))
}

/// Runs `read` on the unlocked session.
fn with_session<T>(
    state: &NotebookState,
    read: impl FnOnce(&mut Session) -> T,
) -> Result<T, IpcError> {
    let mut inner = state
        .inner
        .lock()
        .map_err(|_| IpcError::internal("STATE"))?;
    Ok(read(inner.session.as_mut().ok_or_else(IpcError::locked)?))
}

/// Runs `change` on the session `live` was read from; after a lock (or a
/// new unlock) there is nothing to change.
fn with_live_session<T>(
    state: &NotebookState,
    live: &Live,
    change: impl FnOnce(&mut Session) -> T,
) -> Result<T, IpcError> {
    let mut inner = state
        .inner
        .lock()
        .map_err(|_| IpcError::internal("STATE"))?;
    let session = inner
        .session
        .as_mut()
        .filter(|session| session.id == live.session)
        .ok_or_else(IpcError::locked)?;
    Ok(change(session))
}

/// Applies a change's writes and returns the tree delta for the frontend.
fn apply_writes(
    state: &NotebookState,
    live: &Live,
    writes: Vec<Write>,
) -> Result<TreeDelta, IpcError> {
    with_live_session(state, live, |session| {
        session.apply(writes);
        session.rebuild()
    })
}

/// Lists the objects at or below the folder `path` and puts them in the
/// map, so a folder operation also takes what another device added.
async fn list_folder(state: &NotebookState, live: &Live, path: &str) -> Result<(), IpcError> {
    let prefix = format!("{}/", stored_key(&live.config, &live.codec, path)?);
    let listed = live.remote.list(Some(&prefix)).await?;
    let mut found = BTreeMap::new();
    for object in listed {
        if let Ok(logical) = logical_path_from_key(&live.config, &live.codec, &object.key)
            && is_at_or_below(&logical, path)
        {
            found.insert(
                logical,
                Object {
                    key: object.key,
                    etag: object.etag,
                },
            );
        }
    }
    with_live_session(state, live, |session| {
        let gone = session
            .subtree(path)
            .map(|(logical, _)| logical.clone())
            .filter(|logical| logical != path && !found.contains_key(logical))
            .collect::<Vec<_>>();
        session.apply(gone.into_iter().map(|logical| (logical, None)));
        session.apply(
            found
                .into_iter()
                .map(|(logical, object)| (logical, Some(object))),
        );
    })
}

fn parent_logical(session: &Session, id: &str) -> Result<String, IpcError> {
    if id == ROOT_ID {
        return Ok(String::new());
    }
    session
        .nodes
        .get(id)
        .filter(|node| node.kind == "Folder")
        .map(|node| node.logical_path.clone())
        .ok_or_else(|| IpcError::invalid("The destination folder does not exist."))
}

fn unique_name(session: &Session, parent: &str, wanted: &str, except: Option<&str>) -> String {
    let taken = session
        .nodes
        .values()
        .filter(|node| {
            parent_path(&node.logical_path) == parent && except != Some(node.id.as_str())
        })
        .map(|node| node.name.to_lowercase())
        .collect::<BTreeSet<_>>();
    if !taken.contains(&wanted.to_lowercase()) {
        return wanted.to_owned();
    }
    let dot = wanted
        .rfind('.')
        .filter(|index| *index > 0)
        .unwrap_or(wanted.len());
    let (stem, extension) = wanted.split_at(dot);
    (2..)
        .map(|number| format!("{stem} {number}{extension}"))
        .find(|candidate| !taken.contains(&candidate.to_lowercase()))
        .unwrap()
}

/// Creates a document in `parent_id`, below the folders `folders` (created
/// when missing, matched without case otherwise), in one parallel round: the
/// document and the markers of new folders. Opening it next needs no request.
#[tauri::command]
pub async fn doc_create(
    state: State<'_, NotebookState>,
    parent_id: String,
    name: Option<String>,
    text: Option<String>,
    folders: Option<Vec<String>>,
) -> Result<CreatedNode, IpcError> {
    let text = text.unwrap_or_default();
    validate_document_size(&text)?;
    create_entry(
        &state,
        &parent_id,
        &folders.unwrap_or_default(),
        name.as_deref().unwrap_or("Untitled.md"),
        Some(text),
    )
    .await
}

#[tauri::command]
pub async fn folder_create(
    state: State<'_, NotebookState>,
    parent_id: String,
    name: Option<String>,
) -> Result<CreatedNode, IpcError> {
    create_entry(
        &state,
        &parent_id,
        &[],
        name.as_deref().unwrap_or("New folder"),
        None,
    )
    .await
}

/// A document with `text`, or a folder (its marker) for `None`. A name that
/// is taken gets a number (" 2"), as before; S3 refuses to overwrite.
async fn create_entry(
    state: &NotebookState,
    parent_id: &str,
    folders: &[String],
    name: &str,
    text: Option<String>,
) -> Result<CreatedNode, IpcError> {
    let base = validate_name(name)?;
    let folders = folders
        .iter()
        .map(|folder| validate_name(folder))
        .collect::<Result<Vec<_>, _>>()?;
    let live = unlocked(state)?;
    let (parent, markers) = with_live_session(state, &live, |session| {
        let mut parent = parent_logical(session, parent_id)?;
        let mut markers = Vec::new();
        for folder in &folders {
            let existing = markers
                .is_empty()
                .then(|| child_named(session, &parent, folder))
                .flatten();
            match existing {
                Some(node) if node.kind == "Folder" => parent = node.logical_path.clone(),
                Some(_) => {
                    return Err(IpcError::invalid(
                        "A file has the name of a folder in this path.",
                    ));
                }
                None => {
                    parent = join_path(&parent, folder);
                    markers.push(join_path(&parent, DIRECTORY_MARKER));
                }
            }
        }
        Ok((parent, markers))
    })??;
    let document = text.is_some();
    let text = Arc::new(Zeroizing::new(text.unwrap_or_default()));
    let body = live
        .codec
        .encode_content(&text)
        .map_err(|_| IpcError::internal("ENCRYPT_CONTENT"))?
        .to_vec();
    let mut writes = Vec::new();
    let mut new_folders = (!markers.is_empty()).then(|| put_markers(&live, markers));
    for _ in 0..100 {
        let final_name = with_live_session(state, &live, |session| {
            unique_name(session, &parent, &base, None)
        })?;
        let logical = join_path(&parent, &final_name);
        let object_path = if document {
            logical.clone()
        } else {
            join_path(&logical, DIRECTORY_MARKER)
        };
        let key = stored_key(&live.config, &live.codec, &object_path)?;
        // The new folders' markers and the item itself go in one round.
        let (created, folders) = match new_folders.take() {
            Some(markers) => {
                let (created, (marker_writes, marked)) =
                    tokio::join!(put_new(&live.remote, &key, &body), markers);
                (created, Some((marker_writes, marked)))
            }
            None => (put_new(&live.remote, &key, &body).await, None),
        };
        if let Some((marker_writes, marked)) = folders {
            writes.extend(marker_writes);
            if let Err(error) = marked {
                apply_writes(state, &live, writes)?;
                return Err(error);
            }
        }
        let etag = match created {
            Ok(New::Created(etag)) => etag,
            // A timed-out create may already have succeeded.
            Ok(New::Exists(existing)) if existing.bytes == body => {
                existing.etag.unwrap_or_default()
            }
            // Taken by an item this session did not know: try the next name.
            Ok(New::Exists(existing)) => {
                let etag = existing.etag.unwrap_or_default();
                writes.push((object_path, Some(Object { key, etag })));
                apply_writes(state, &live, std::mem::take(&mut writes))?;
                continue;
            }
            Err(error) => {
                apply_writes(state, &live, writes)?;
                return Err(error);
            }
        };
        // An earlier object at this path may have left journal state.
        forget_keys(state, live.session, std::slice::from_ref(&key));
        writes.push((
            object_path,
            Some(Object {
                key: key.clone(),
                etag: etag.clone(),
            }),
        ));
        let tree = with_live_session(state, &live, |session| {
            if document {
                session
                    .cache
                    .insert(&key, &etag, text.clone(), text_digest(&text));
            }
            session.apply(writes);
            session.rebuild()
        })?;
        if document
            && !etag.is_empty()
            && let Some(mut journal) = journal_of(state, live.session)?
        {
            journal.keys.entry(key).or_default().base = Some((etag, text_digest(&text)));
        }
        return Ok(CreatedNode {
            id: node_id(if document { "Document" } else { "Folder" }, &logical),
            final_name,
            tree,
        });
    }
    Err(IpcError::new(
        "CONFLICT",
        "A unique name could not be reserved in S3.",
    ))
}

/// The item in folder `parent` whose name matches `name` without case.
fn child_named<'a>(session: &'a Session, parent: &str, name: &str) -> Option<&'a NodeRecord> {
    let wanted = name.to_lowercase();
    session.nodes.values().find(|node| {
        parent_path(&node.logical_path) == parent && node.name.to_lowercase() == wanted
    })
}

/// What a document command needs, read under one lock.
struct DocTarget {
    /// The session it was read from: the journal is used only while it is
    /// still that session's.
    session: u64,
    config: VaultConfig,
    codec: NotebookV1Codec,
    remote: Arc<S3Remote>,
    key: String,
    etag: String,
}

fn document_target(state: &NotebookState, id: &str) -> Result<DocTarget, IpcError> {
    let inner = state
        .inner
        .lock()
        .map_err(|_| IpcError::internal("STATE"))?;
    let session = inner.session.as_ref().ok_or_else(IpcError::locked)?;
    let object = session
        .nodes
        .get(id)
        .filter(|node| node.kind == "Document")
        .and_then(|node| session.objects.get(&node.logical_path))
        .ok_or_else(|| IpcError::invalid("The document does not exist."))?;
    if object.etag.is_empty() {
        return Err(IpcError::internal("MISSING_ETAG"));
    }
    Ok(DocTarget {
        session: session.id,
        config: session.config.clone(),
        codec: session.codec.clone(),
        remote: session.remote.clone(),
        key: object.key.clone(),
        etag: object.etag.clone(),
    })
}

fn decrypt_document(codec: &NotebookV1Codec, body: &[u8]) -> Result<String, IpcError> {
    codec
        .decode_content(body)
        .map(|text| text.to_string())
        .map_err(|_| {
            IpcError::new(
                "DECRYPT_FAILED",
                "The document is damaged or uses another encryption phrase.",
            )
        })
}

fn text_digest(text: &str) -> [u8; 32] {
    Sha256::digest(text.as_bytes()).into()
}

fn lock_journal(state: &NotebookState) -> Result<std::sync::MutexGuard<'_, Journal>, IpcError> {
    state
        .journal
        .lock()
        .map_err(|_| IpcError::internal("STATE"))
}

/// The journal while it belongs to session `session`; `None` once that
/// session ended (lock, switch, another unlock).
fn journal_of(
    state: &NotebookState,
    session: u64,
) -> Result<Option<std::sync::MutexGuard<'_, Journal>>, IpcError> {
    let journal = lock_journal(state)?;
    Ok((journal.session == session).then_some(journal))
}

/// S3 holds `text` under `key` with `etag` now (opened, uploaded or created
/// here): the map gets the ETag and the cache the text.
fn record_version(
    state: &NotebookState,
    session_id: u64,
    key: &str,
    etag: &str,
    text: Arc<Zeroizing<String>>,
    sha: [u8; 32],
) {
    let Ok(mut guard) = state.inner.lock() else {
        return;
    };
    let inner = &mut *guard;
    let Some(session) = inner
        .session
        .as_mut()
        .filter(|session| session.id == session_id)
    else {
        return;
    };
    if let Ok(path) = logical_path_from_key(&session.config, &session.codec, key)
        && session
            .objects
            .get(&path)
            .is_some_and(|object| object.key == key)
    {
        let object = Object {
            key: key.to_owned(),
            etag: etag.to_owned(),
        };
        session.apply([(path, Some(object))]);
    }
    session.cache.insert(key, etag, text, sha);
}

/// Keys whose newest edit is staged and not uploaded yet.
fn staged_keys(state: &NotebookState) -> Vec<String> {
    state.journal.lock().map_or_else(
        |_| Vec::new(),
        |journal| {
            journal
                .keys
                .iter()
                .filter(|(_, entry)| entry.staged.is_some())
                .map(|(key, _)| key.clone())
                .collect()
        },
    )
}

/// Drops the journal state of keys that session `session` created or deleted.
fn forget_keys(state: &NotebookState, session: u64, keys: &[String]) {
    if let Ok(Some(mut journal)) = journal_of(state, session) {
        for key in keys {
            journal.keys.remove(key);
        }
    }
}

#[tauri::command]
pub async fn doc_open(
    state: State<'_, NotebookState>,
    id: String,
) -> Result<OpenDocument, IpcError> {
    open_document(&state, &id).await
}

/// Answers without a request when it can: a staged edit (dirty), then the
/// cached text of the version the map holds; otherwise S3's version is
/// downloaded. The version returned becomes the base of the next edits.
async fn open_document(state: &NotebookState, id: &str) -> Result<OpenDocument, IpcError> {
    let target = document_target(state, id)?;
    let opened = |text: String, dirty: bool| OpenDocument {
        text,
        rev: 1,
        read_only: false,
        rollback_warning: false,
        dirty,
    };
    {
        let mut journal = journal_of(state, target.session)?.ok_or_else(IpcError::locked)?;
        let entry = journal.keys.entry(target.key.clone()).or_default();
        if let Some(staged) = entry.staged.as_ref() {
            return Ok(opened(staged.text.as_str().to_owned(), true));
        }
        let cached = state
            .inner
            .lock()
            .map_err(|_| IpcError::internal("STATE"))?
            .session
            .as_mut()
            .filter(|session| session.id == target.session)
            .and_then(|session| session.cache.get(&target.key, &target.etag));
        if let Some((text, sha)) = cached {
            if !entry.committing {
                entry.base = Some((target.etag.clone(), sha));
            }
            return Ok(opened(text.as_str().to_owned(), false));
        }
    }
    let object = target.remote.get(&target.key).await?;
    let text = decrypt_document(&target.codec, &object.bytes)?;
    if let Some(etag) = object.etag {
        let shared = Arc::new(Zeroizing::new(text.clone()));
        let sha = text_digest(&text);
        // A session that ended while S3 answered gets nothing of this one.
        let mut journal = journal_of(state, target.session)?.ok_or_else(IpcError::locked)?;
        let entry = journal.keys.entry(target.key.clone()).or_default();
        if entry.staged.is_none() && !entry.committing {
            entry.base = Some((etag.clone(), sha));
            record_version(state, target.session, &target.key, &etag, shared, sha);
        }
    }
    Ok(opened(text, false))
}

#[tauri::command]
pub async fn doc_stage(
    app: tauri::AppHandle,
    id: String,
    text: String,
) -> Result<&'static str, IpcError> {
    // Encrypting and fsyncing take milliseconds, off the async workers.
    tauri::async_runtime::spawn_blocking(move || {
        stage_document(&app.state::<NotebookState>(), &id, text)
    })
    .await
    .map_err(|_| IpcError::internal("STAGE"))?
}

/// Writes `text` to the encrypted outbox (fsynced) as the newest edit of
/// `id`, without any S3 request. "Clean" when the text equals the version it
/// is based on (any queued edit is dropped), otherwise "Staged".
fn stage_document(state: &NotebookState, id: &str, text: String) -> Result<&'static str, IpcError> {
    let text = Zeroizing::new(text);
    validate_document_size(&text)?;
    let target = document_target(state, id)?;
    let sha = text_digest(&text);
    {
        let mut journal = journal_of(state, target.session)?.ok_or_else(IpcError::locked)?;
        let entry = journal.keys.entry(target.key.clone()).or_default();
        if entry
            .staged
            .as_ref()
            .is_some_and(|staged| staged.sha == sha)
        {
            return Ok("Staged");
        }
        if !entry.committing && entry.base.as_ref().is_some_and(|(_, base)| *base == sha) {
            if entry.staged.take().is_some() {
                remove_outbox(state, &target.config, &target.key);
            }
            return Ok("Clean");
        }
    }
    let body = target
        .codec
        .encode_content(&text)
        .map_err(|_| IpcError::internal("ENCRYPT_CONTENT"))?
        .to_vec();
    let mut journal = journal_of(state, target.session)?.ok_or_else(IpcError::locked)?;
    journal.next_gen += 1;
    let generation = journal.next_gen;
    let entry = journal.keys.entry(target.key.clone()).or_default();
    let expected = entry
        .base
        .as_ref()
        .map_or(target.etag, |(etag, _)| etag.clone());
    persist_outbox(state, &target.config, &target.key, &body, Some(&expected))?;
    entry.staged = Some(Staged {
        generation,
        sha,
        text: Arc::new(text),
        body: Arc::new(body),
        expected,
    });
    Ok("Staged")
}

#[tauri::command]
pub async fn doc_commit(
    state: State<'_, NotebookState>,
    id: String,
) -> Result<SaveResult, IpcError> {
    let target = document_target(&state, &id)?;
    commit_key(&state, target.session, &target.key).await
}

fn save_result(status: &'static str) -> SaveResult {
    SaveResult {
        status,
        document_id: None,
        tree: None,
    }
}

fn upload_lock(state: &NotebookState, key: &str) -> Result<Arc<tokio::sync::Mutex<()>>, IpcError> {
    let mut uploads = state
        .uploads
        .lock()
        .map_err(|_| IpcError::internal("STATE"))?;
    Ok(uploads.entry(key.to_owned()).or_default().clone())
}

/// Clears `committing` however an upload ends, also when it is cancelled.
struct Committing<'a> {
    state: &'a NotebookState,
    session: u64,
    key: &'a str,
}

impl Drop for Committing<'_> {
    fn drop(&mut self) {
        if let Ok(Some(mut journal)) = journal_of(self.state, self.session)
            && let Some(entry) = journal.keys.get_mut(self.key)
        {
            entry.committing = false;
        }
    }
}

/// The staged edit being uploaded.
struct Upload {
    generation: u64,
    sha: [u8; 32],
    text: Arc<Zeroizing<String>>,
    body: Arc<Vec<u8>>,
    expected: String,
}

/// Uploads the staged edit of `key` with `If-Match` on the version it is
/// based on; with nothing staged this is "Saved" without a request. An edit
/// staged during the upload stays queued, re-based on the new ETag. When
/// another device changed the object, the edit is kept as a conflict copy
/// beside it, which the tree gains without a listing. A network failure
/// keeps the outbox entry: "Offline".
///
/// `session` is the session the caller read `key` from: once it ended, the
/// journal is another session's and the upload is refused (`LOCKED`).
async fn commit_key(
    state: &NotebookState,
    session: u64,
    key: &str,
) -> Result<SaveResult, IpcError> {
    let live = unlocked(state)?;
    if live.session != session {
        return Err(IpcError::locked());
    }
    let serial = upload_lock(state, key)?;
    let _serial = serial.lock().await;
    let upload = {
        let mut journal = journal_of(state, live.session)?.ok_or_else(IpcError::locked)?;
        let Some(entry) = journal.keys.get_mut(key) else {
            return Ok(save_result("Saved"));
        };
        let Some(staged) = entry.staged.as_ref() else {
            return Ok(save_result("Saved"));
        };
        let upload = Upload {
            generation: staged.generation,
            sha: staged.sha,
            text: staged.text.clone(),
            body: staged.body.clone(),
            expected: staged.expected.clone(),
        };
        entry.committing = true;
        upload
    };
    let _committing = Committing {
        state,
        session: live.session,
        key,
    };
    let put = live
        .remote
        .put(key, &upload.body, PutCondition::IfMatch(&upload.expected))
        .await;
    match put {
        Ok(etag) => {
            finish_upload(state, &live, key, &upload, etag)?;
            Ok(save_result("Saved"))
        }
        Err(error) if is_changed_error(&error) => {
            let current = match current_object(&live.remote, key).await {
                Ok(current) => current,
                Err(error) if is_offline_error(&error) => return Ok(save_result("Offline")),
                Err(error) => return Err(error),
            };
            // An earlier upload of this edit succeeded but its answer was lost.
            if let Some(current) = current.as_ref()
                && same_plaintext(&live.codec, &current.bytes, &upload.body)
            {
                finish_upload(state, &live, key, &upload, current.etag.clone())?;
                return Ok(save_result("Saved"));
            }
            let logical_path = logical_path_from_key(&live.config, &live.codec, key)?;
            let copy = upload_conflict_copy(
                &live.remote,
                &live.config,
                &live.codec,
                &logical_path,
                &upload.body,
            )
            .await;
            let (copy_path, copy_key, copy_etag) = match copy {
                Ok(copy) => copy,
                Err(error) if is_offline_error(&error) => return Ok(save_result("Offline")),
                Err(error) => return Err(error),
            };
            finish_conflict(state, &live, key, upload.generation)?;
            let copy_etag = copy_etag.unwrap_or_default();
            // S3 now holds the other device's version (or nothing) at `key`.
            let theirs = current.as_ref().and_then(|current| {
                let etag = current.etag.clone()?;
                let text = live.codec.decode_content(&current.bytes).ok()?;
                Some((etag, Arc::new(Zeroizing::new(text.to_string()))))
            });
            let original = current.map(|current| Object {
                key: key.to_owned(),
                etag: current.etag.unwrap_or_default(),
            });
            let tree = with_live_session(state, &live, |session| {
                session
                    .cache
                    .insert(&copy_key, &copy_etag, upload.text.clone(), upload.sha);
                match theirs {
                    Some((etag, text)) => {
                        let sha = text_digest(&text);
                        session.cache.insert(key, &etag, text, sha);
                    }
                    None => drop(session.cache.entries.remove(key)),
                }
                let copy = Object {
                    key: copy_key,
                    etag: copy_etag,
                };
                session.apply([(logical_path, original), (copy_path.clone(), Some(copy))]);
                session.rebuild()
            })?;
            Ok(SaveResult {
                status: "ConflictCopy",
                document_id: Some(node_id("Document", &copy_path)),
                tree: Some(tree),
            })
        }
        Err(error) if is_offline_error(&error) => Ok(save_result("Offline")),
        Err(error) => Err(error),
    }
}

/// Records the upload of `upload`: S3 now holds that version under `etag`.
/// The outbox entry goes, unless a newer edit was staged meanwhile, which is
/// re-based on the new ETag (or its replay would find a false conflict).
/// After a lock or switch the journal is another session's (or none): the
/// outbox file stays, and the next unlock of this location settles it (S3
/// already holds the same text).
fn finish_upload(
    state: &NotebookState,
    live: &Live,
    key: &str,
    upload: &Upload,
    etag: Option<String>,
) -> Result<(), IpcError> {
    let config = &live.config;
    let Some(mut journal) = journal_of(state, live.session)? else {
        return Ok(());
    };
    let Some(entry) = journal.keys.get_mut(key) else {
        return Ok(());
    };
    if entry
        .staged
        .as_ref()
        .is_some_and(|staged| staged.generation == upload.generation)
    {
        entry.staged = None;
        remove_outbox(state, config, key);
    }
    let Some(etag) = etag else {
        return Ok(());
    };
    record_version(
        state,
        live.session,
        key,
        &etag,
        upload.text.clone(),
        upload.sha,
    );
    if let Some(newer) = entry.staged.as_mut() {
        persist_outbox(state, config, key, &newer.body, Some(&etag))?;
        newer.expected.clone_from(&etag);
    }
    entry.base = Some((etag, upload.sha));
    Ok(())
}

/// A conflict copy of generation `generation` was written: S3 holds another
/// device's version, so the old base ETag stays and any later edit of this
/// key can only become a conflict copy too, never overwrite it.
fn finish_conflict(
    state: &NotebookState,
    live: &Live,
    key: &str,
    generation: u64,
) -> Result<(), IpcError> {
    let config = &live.config;
    let Some(mut journal) = journal_of(state, live.session)? else {
        return Ok(());
    };
    let Some(entry) = journal.keys.get_mut(key) else {
        return Ok(());
    };
    if entry
        .staged
        .as_ref()
        .is_some_and(|staged| staged.generation == generation)
    {
        entry.staged = None;
        remove_outbox(state, config, key);
    }
    if let Some((_, sha)) = entry.base.as_mut() {
        *sha = [0; 32];
    }
    Ok(())
}

/// Uploads every staged edit; the first one S3 cannot take ends the run.
async fn commit_all(state: &NotebookState) -> Result<(), IpcError> {
    let session = unlocked(state)?.session;
    for key in staged_keys(state) {
        if commit_key(state, session, &key).await?.status == "Offline" {
            return Err(unreachable_error());
        }
    }
    Ok(())
}

/// Uploads the staged edits of the documents at or below `path` before they
/// move, so no outbox entry ever points at a key that is gone.
async fn commit_subtree(state: &NotebookState, path: &str) -> Result<(), IpcError> {
    let session_id = unlocked(state)?.session;
    let keys = {
        let journal = journal_of(state, session_id)?.ok_or_else(IpcError::locked)?;
        let inner = state
            .inner
            .lock()
            .map_err(|_| IpcError::internal("STATE"))?;
        let session = inner
            .session
            .as_ref()
            .filter(|session| session.id == session_id)
            .ok_or_else(IpcError::locked)?;
        session
            .subtree(path)
            .map(|(_, object)| object.key.clone())
            .filter(|key| {
                journal
                    .keys
                    .get(key)
                    .is_some_and(|entry| entry.staged.is_some())
            })
            .collect::<Vec<_>>()
    };
    for key in keys {
        if commit_key(state, session_id, &key).await?.status == "Offline" {
            return Err(IpcError::new(
                "UNSYNCED",
                "An edit in this item is not uploaded yet. Try again when S3 is reachable.",
            ));
        }
    }
    Ok(())
}

fn validate_document_size(text: &str) -> Result<(), IpcError> {
    if text.len() > MAX_EDIT_BYTES {
        return Err(IpcError::invalid("Documents are limited to 16 MiB."));
    }
    Ok(())
}

fn is_offline_error(error: &IpcError) -> bool {
    matches!(
        error.code(),
        "UNREACHABLE" | "THROTTLED" | "S3_UNAVAILABLE" | "S3_RETRY"
    )
}

/// What a command needs from the unlocked session, read under one lock.
struct Live {
    config: VaultConfig,
    codec: NotebookV1Codec,
    remote: Arc<S3Remote>,
    /// The session's id: writes apply only to the session they were made in.
    session: u64,
}

fn unlocked(state: &NotebookState) -> Result<Live, IpcError> {
    let inner = state
        .inner
        .lock()
        .map_err(|_| IpcError::internal("STATE"))?;
    let session = inner.session.as_ref().ok_or_else(IpcError::locked)?;
    Ok(Live {
        config: session.config.clone(),
        codec: session.codec.clone(),
        remote: session.remote.clone(),
        session: session.id,
    })
}

/// One object of a rename, move, trash or restore.
struct ObjectMove {
    from: String,
    key: String,
    etag: String,
    to: String,
    new_key: String,
}

/// Every object at or below `source`, with its path below `destination`.
fn plan_moves(
    session: &Session,
    live: &Live,
    source: &str,
    destination: &str,
) -> Result<Vec<ObjectMove>, IpcError> {
    session
        .subtree(source)
        .map(|(path, object)| {
            let to = format!("{destination}{}", &path[source.len()..]);
            Ok(ObjectMove {
                new_key: stored_key(&live.config, &live.codec, &to)?,
                from: path.clone(),
                key: object.key.clone(),
                etag: object.etag.clone(),
                to,
            })
        })
        .collect()
}

fn changed_while_moving() -> IpcError {
    IpcError::new(
        "CONFLICT",
        "An item changed in S3 while it was being moved. Nothing was overwritten. Refresh and try again.",
    )
}

/// A conditional request found another version, or no object.
fn moving_error(error: IpcError) -> IpcError {
    if is_changed_error(&error) {
        changed_while_moving()
    } else {
        error
    }
}

/// Copies every object server side, 8 at a time, each only while its ETag is
/// unchanged. If one copy fails, the copies made are deleted again.
async fn copy_objects(
    remote: &Arc<S3Remote>,
    moves: &[ObjectMove],
) -> Result<Vec<String>, IpcError> {
    let jobs = moves
        .iter()
        .map(|movement| {
            let remote = remote.clone();
            let (key, etag, new_key) = (
                movement.key.clone(),
                movement.etag.clone(),
                movement.new_key.clone(),
            );
            async move { remote.copy(&key, &etag, &new_key).await }
        })
        .collect();
    let results = parallel(jobs).await;
    let Some(failed) = results
        .iter()
        .find_map(|result| result.as_ref().err().copied())
    else {
        return Ok(results.into_iter().flatten().collect());
    };
    let made = moves
        .iter()
        .zip(&results)
        .filter_map(|(movement, result)| {
            let etag = result.as_ref().ok()?;
            Some((movement.new_key.clone(), etag.clone()))
        })
        .collect();
    let _ = delete_objects(remote, made).await;
    Err(moving_error(failed))
}

/// Deletes `(key, etag)` objects with If-Match, 8 at a time. Returns which
/// are gone (already gone counts) and the first error.
async fn delete_objects(
    remote: &Arc<S3Remote>,
    objects: Vec<(String, String)>,
) -> (Vec<bool>, Result<(), IpcError>) {
    let jobs = objects
        .into_iter()
        .map(|(key, etag)| {
            let remote = remote.clone();
            async move {
                match remote.delete(&key, Some(&etag)).await {
                    Err(error) if error.code() == "NOT_FOUND" => Ok(()),
                    other => other,
                }
            }
        })
        .collect();
    let results = parallel(jobs).await;
    let first = results
        .iter()
        .find_map(|result| result.as_ref().err().copied());
    (
        results.iter().map(Result::is_ok).collect(),
        first.map_or(Ok(()), |error| Err(moving_error(error))),
    )
}

/// Deletes `(path, key)` objects without conditions, 1,000 per DeleteObjects
/// request: only for Trash contents. Returns the paths that are gone.
async fn delete_in_batches(
    remote: &S3Remote,
    objects: Vec<(String, String)>,
) -> (Vec<String>, Result<(), IpcError>) {
    let mut gone = Vec::new();
    let mut result = Ok(());
    for batch in objects.chunks(1_000) {
        let keys = batch.iter().map(|(_, key)| key.clone()).collect::<Vec<_>>();
        match remote.delete_batch(&keys).await {
            Ok(failed) => {
                let failed = failed.into_iter().collect::<HashSet<_>>();
                gone.extend(
                    batch
                        .iter()
                        .filter(|(_, key)| !failed.contains(key))
                        .map(|(path, _)| path.clone()),
                );
                if !failed.is_empty() && result.is_ok() {
                    result = Err(IpcError::new(
                        "S3_UNAVAILABLE",
                        "S3 did not delete every object. Try again.",
                    ));
                }
            }
            Err(error) => {
                if result.is_ok() {
                    result = Err(error);
                }
            }
        }
    }
    (gone, result)
}

/// Moves objects server side: every copy first, then the sources go, each
/// with If-Match. A failed delete can leave a duplicate, but never loses the
/// only copy. Returns the writes made and the outcome.
async fn move_objects(
    remote: &Arc<S3Remote>,
    moves: &[ObjectMove],
) -> (Vec<Write>, Result<(), IpcError>) {
    let etags = match copy_objects(remote, moves).await {
        Ok(etags) => etags,
        Err(error) => return (Vec::new(), Err(error)),
    };
    let mut writes = copied(moves, etags);
    let sources = moves
        .iter()
        .map(|movement| (movement.key.clone(), movement.etag.clone()))
        .collect();
    let (gone, deleted) = delete_objects(remote, sources).await;
    writes.extend(
        moves
            .iter()
            .zip(gone)
            .filter(|(_, gone)| *gone)
            .map(|(movement, _)| (movement.from.clone(), None)),
    );
    (writes, deleted)
}

fn copied(moves: &[ObjectMove], etags: Vec<String>) -> Vec<Write> {
    moves
        .iter()
        .zip(etags)
        .map(|(movement, etag)| {
            let object = Object {
                key: movement.new_key.clone(),
                etag,
            };
            (movement.to.clone(), Some(object))
        })
        .collect()
}

/// An object written only if the key is free, or what is there already.
enum New {
    Created(String),
    Exists(ObjectBody),
}

async fn put_new(remote: &S3Remote, key: &str, body: &[u8]) -> Result<New, IpcError> {
    match remote.put(key, body, PutCondition::IfNoneMatch).await {
        Ok(etag) => Ok(New::Created(etag.unwrap_or_default())),
        Err(error) if error.code() == "CONFLICT" => Ok(New::Exists(remote.get(key).await?)),
        Err(error) => Err(error),
    }
}

/// Writes the folder markers at `paths`, in parallel. A marker that is
/// already there (an empty document) counts as written.
async fn put_markers(live: &Live, paths: Vec<String>) -> (Vec<Write>, Result<(), IpcError>) {
    let mut jobs = Vec::new();
    for path in &paths {
        let prepared = stored_key(&live.config, &live.codec, path).and_then(|key| {
            let body = live
                .codec
                .encode_content("")
                .map_err(|_| IpcError::internal("ENCRYPT_CONTENT"))?
                .to_vec();
            Ok((key, body))
        });
        let (remote, codec) = (live.remote.clone(), live.codec.clone());
        jobs.push(async move {
            let (key, body) = prepared?;
            let etag = match put_new(&remote, &key, &body).await? {
                New::Created(etag) => etag,
                New::Exists(existing)
                    if codec
                        .decode_content(&existing.bytes)
                        .is_ok_and(|text| text.is_empty()) =>
                {
                    existing.etag.unwrap_or_default()
                }
                New::Exists(_) => {
                    return Err(IpcError::new(
                        "CONFLICT",
                        "A folder marker path is occupied by another object.",
                    ));
                }
            };
            Ok(Object { key, etag })
        });
    }
    let results = parallel(jobs).await;
    let first = results
        .iter()
        .find_map(|result| result.as_ref().err().copied());
    let writes = paths
        .into_iter()
        .zip(results)
        .filter_map(|(path, result)| Some((path, Some(result.ok()?))))
        .collect();
    (writes, first.map_or(Ok(()), Err))
}

/// Applies the writes of a move. The journal and the cached texts follow
/// the objects to their new keys (the text is the same).
fn finish_moves(
    state: &NotebookState,
    live: &Live,
    moves: &[ObjectMove],
    writes: Vec<Write>,
) -> Result<TreeDelta, IpcError> {
    let by_destination = moves
        .iter()
        .map(|movement| (movement.to.as_str(), movement))
        .collect::<HashMap<_, _>>();
    let mut journal = journal_of(state, live.session)?.ok_or_else(IpcError::locked)?;
    for movement in moves {
        let old = journal.keys.remove(&movement.key);
        journal.keys.remove(&movement.new_key);
        // An uploaded edit's base moves with it: typing back to it is clean.
        let base = old
            .filter(|entry| entry.staged.is_none() && !entry.committing)
            .and_then(|entry| entry.base);
        let copy = writes
            .iter()
            .find_map(|(path, object)| (path == &movement.to).then_some(object.as_ref()).flatten());
        if let (Some((_, sha)), Some(copy)) = (base, copy) {
            journal
                .keys
                .entry(movement.new_key.clone())
                .or_default()
                .base = Some((copy.etag.clone(), sha));
        }
    }
    with_live_session(state, live, |session| {
        for (path, object) in &writes {
            if let (Some(object), Some(movement)) = (object, by_destination.get(path.as_str())) {
                session
                    .cache
                    .moved(&movement.key, &object.key, &object.etag);
            }
        }
        session.apply(writes);
        session.rebuild()
    })
}

/// Node ids are derived from kind and path, so a renamed or moved item gets a
/// new id, which is returned to the frontend.
fn node_id(kind: &str, path: &str) -> String {
    stable_id(
        if kind == "Folder" {
            "folder"
        } else {
            "document"
        },
        path,
    )
}

/// A planned rename or move: current and new path, the kind and final name.
struct Relocation {
    source: String,
    destination: String,
    kind: &'static str,
    final_name: String,
}

fn plan_rename(session: &Session, id: &str, wanted: &str) -> Result<Relocation, IpcError> {
    let node = session
        .nodes
        .get(id)
        .ok_or_else(|| IpcError::invalid("The selected item does not exist."))?;
    let parent = parent_path(&node.logical_path);
    let final_name = unique_name(session, parent, wanted, Some(id));
    Ok(Relocation {
        source: node.logical_path.clone(),
        destination: join_path(parent, &final_name),
        kind: node.kind,
        final_name,
    })
}

#[tauri::command]
pub async fn node_rename(
    state: State<'_, NotebookState>,
    id: String,
    name: String,
) -> Result<CreatedNode, IpcError> {
    rename_node(&state, &id, &name).await
}

async fn rename_node(state: &NotebookState, id: &str, name: &str) -> Result<CreatedNode, IpcError> {
    let wanted = validate_name(name)?;
    let plan = with_session(state, |session| plan_rename(session, id, &wanted))??;
    relocate(state, plan).await
}

#[tauri::command]
pub async fn node_move(
    state: State<'_, NotebookState>,
    id: String,
    new_parent_id: String,
) -> Result<CreatedNode, IpcError> {
    move_node(&state, &id, &new_parent_id).await
}

async fn move_node(
    state: &NotebookState,
    id: &str,
    new_parent_id: &str,
) -> Result<CreatedNode, IpcError> {
    let plan = with_session(state, |session| {
        let node = session
            .nodes
            .get(id)
            .ok_or_else(|| IpcError::invalid("The selected item does not exist."))?;
        let parent = parent_logical(session, new_parent_id)?;
        if node.kind == "Folder" && is_at_or_below(&parent, &node.logical_path) {
            return Err(IpcError::invalid("A folder cannot be moved inside itself."));
        }
        let final_name = unique_name(session, &parent, &node.name, Some(id));
        Ok(Relocation {
            source: node.logical_path.clone(),
            destination: join_path(&parent, &final_name),
            kind: node.kind,
            final_name,
        })
    })??;
    relocate(state, plan).await
}

/// Renames or moves an item: staged edits inside it are uploaded first, a
/// folder's prefix is listed (to take along what another device added), then
/// S3 copies every object and the originals are deleted.
async fn relocate(state: &NotebookState, plan: Relocation) -> Result<CreatedNode, IpcError> {
    let Relocation {
        source,
        destination,
        kind,
        final_name,
    } = plan;
    let id = node_id(kind, &destination);
    if source == destination {
        return Ok(CreatedNode {
            id,
            final_name,
            tree: TreeDelta::default(),
        });
    }
    commit_subtree(state, &source).await?;
    let live = unlocked(state)?;
    if kind == "Folder" {
        list_folder(state, &live, &source).await?;
    }
    let moves = with_live_session(state, &live, |session| {
        if session.subtree(&destination).next().is_some() {
            return Err(IpcError::new(
                "CONFLICT",
                "An item with this name already exists. Refresh and try again.",
            ));
        }
        plan_moves(session, &live, &source, &destination)
    })??;
    if moves.is_empty() {
        return Err(IpcError::invalid("The selected item does not exist."));
    }
    let (writes, moved) = move_objects(&live.remote, &moves).await;
    let tree = finish_moves(state, &live, &moves, writes)?;
    moved?;
    Ok(CreatedNode {
        id,
        final_name,
        tree,
    })
}

#[tauri::command]
pub async fn node_trash(
    state: State<'_, NotebookState>,
    id: String,
) -> Result<TrashResult, IpcError> {
    trash_node(&state, &id).await
}

/// Notebook's delete: the item moves into its own container under
/// `_deleted/items/` after the container and original-parent markers exist.
async fn trash_node(state: &NotebookState, id: &str) -> Result<TrashResult, IpcError> {
    let (source, kind) = with_session(state, |session| {
        session
            .nodes
            .get(id)
            .map(|node| (node.logical_path.clone(), node.kind))
    })?
    .ok_or_else(|| IpcError::invalid("The selected item does not exist."))?;
    commit_subtree(state, &source).await?;
    let live = unlocked(state)?;
    if kind == "Folder" {
        list_folder(state, &live, &source).await?;
    }
    let (plan, markers, moves) = with_live_session(state, &live, |session| {
        let plan = deleted_items::plan_delete(&session.paths(), &source, now_ms());
        let markers = plan
            .markers
            .iter()
            .filter(|marker| !session.objects.contains_key(*marker))
            .cloned()
            .collect::<Vec<_>>();
        let moves = plan_moves(session, &live, &source, &plan.destination)?;
        Ok::<_, IpcError>((plan, markers, moves))
    })??;
    if moves.is_empty() {
        return Err(IpcError::invalid("The selected item does not exist."));
    }
    let (mut writes, marked) = put_markers(&live, markers).await;
    let moved = match marked {
        Ok(()) => {
            let (more, moved) = move_objects(&live.remote, &moves).await;
            writes.extend(more);
            moved
        }
        Err(error) => Err(error),
    };
    let tree = finish_moves(state, &live, &moves, writes)?;
    moved?;
    Ok(TrashResult {
        entry_id: plan.key,
        tree,
    })
}

#[tauri::command]
pub async fn trash_restore(
    state: State<'_, NotebookState>,
    entry_id: String,
    mode: RestoreMode,
    name: Option<String>,
) -> Result<RestoreResult, IpcError> {
    restore_entry(&state, &entry_id, &mode, name.as_deref()).await
}

fn missing_entry() -> IpcError {
    IpcError::invalid("The Trash entry does not exist.")
}

/// Notebook's restore: back to the original path, refused when something is
/// there (never renamed or overwritten); `RestoreMode::To` picks a folder and
/// optionally a new name. The entry's container is listed first; after the
/// copies, its objects (sources and markers) go in one batch delete.
async fn restore_entry(
    state: &NotebookState,
    key: &str,
    mode: &RestoreMode,
    name: Option<&str>,
) -> Result<RestoreResult, IpcError> {
    let live = unlocked(state)?;
    let container = with_live_session(state, &live, |session| {
        deleted_items::find(&session.paths(), key).map(|entry| entry.storage_prefix)
    })?
    .ok_or_else(missing_entry)?;
    let container = container.trim_end_matches('/').to_owned();
    list_folder(state, &live, &container).await?;
    let (entry, destination, parent_marker, moves, contents) =
        with_live_session(state, &live, |session| {
            let entry = deleted_items::find(&session.paths(), key).ok_or_else(missing_entry)?;
            let destination = match mode {
                RestoreMode::To { to } => join_path(
                    &parent_logical(session, to)?,
                    &validate_name(name.unwrap_or(&entry.name))?,
                ),
                RestoreMode::Named(_) => entry.original_path.clone(),
            };
            let chosen = matches!(mode, RestoreMode::To { .. });
            let marker = check_restore_target(session, &destination, chosen)?;
            let moves = plan_moves(session, &live, &entry.root_path, &destination)?;
            let contents = session
                .subtree(&container)
                .map(|(path, object)| (path.clone(), object.key.clone()))
                .collect::<Vec<_>>();
            Ok::<_, IpcError>((entry, destination, marker, moves, contents))
        })??;
    if moves.is_empty() {
        return Err(missing_entry());
    }
    let mut writes = Vec::new();
    let mut restored = Ok(());
    if parent_marker {
        let parent = join_path(parent_path(&destination), DIRECTORY_MARKER);
        let (marker, marked) = put_markers(&live, vec![parent]).await;
        writes.extend(marker);
        restored = marked;
    }
    if restored.is_ok() {
        restored = match copy_objects(&live.remote, &moves).await {
            Ok(etags) => {
                writes.extend(copied(&moves, etags));
                // Trash contents: the sources and the container's markers.
                let (gone, deleted) = delete_in_batches(&live.remote, contents).await;
                writes.extend(gone.into_iter().map(|path| (path, None)));
                deleted
            }
            Err(error) => Err(error),
        };
    }
    let tree = finish_moves(state, &live, &moves, writes)?;
    restored?;
    Ok(RestoreResult {
        restored_id: node_id(
            if entry.is_folder {
                "Folder"
            } else {
                "Document"
            },
            &destination,
        ),
        final_name: file_name(&destination).into(),
        final_path: destination,
        tree,
    })
}

/// Whether the restore target is free; `Ok(true)` when its parent folder must
/// be created first, as Notebook does with a directory marker.
fn check_restore_target(
    session: &Session,
    destination: &str,
    chosen: bool,
) -> Result<bool, IpcError> {
    if deleted_items::has_reserved_segment(destination) {
        return Err(IpcError::invalid(
            "The original location uses a name reserved for deleted items. Restore it to another folder.",
        ));
    }
    let node_at = |path: &str| session.node_at(path);
    if node_at(destination).is_some() {
        return Err(IpcError::new(
            "RESTORE_CONFLICT",
            if chosen {
                "An item with this name already exists in that folder."
            } else {
                "Something already exists at the original location. Restore it to another folder or under another name."
            },
        ));
    }
    let parent = parent_path(destination);
    let mut ancestor = parent;
    while !ancestor.is_empty() {
        if node_at(ancestor).is_some_and(|node| node.kind == "Document") {
            return Err(IpcError::new(
                "RESTORE_CONFLICT",
                "A document now uses the name of the original folder. Restore it to another folder.",
            ));
        }
        ancestor = parent_path(ancestor);
    }
    Ok(!parent.is_empty() && node_at(parent).is_none())
}

#[tauri::command]
pub async fn trash_purge(
    state: State<'_, NotebookState>,
    entry_ids: Vec<String>,
) -> Result<PurgeResult, IpcError> {
    purge_entries(&state, Some(&entry_ids)).await
}

#[tauri::command]
pub async fn trash_empty(state: State<'_, NotebookState>) -> Result<PurgeResult, IpcError> {
    purge_entries(&state, None).await
}

/// Deletes the objects of the given bin entries (every entry for `None`)
/// and nothing else, 1,000 per DeleteObjects request.
async fn purge_entries(
    state: &NotebookState,
    keys: Option<&[String]>,
) -> Result<PurgeResult, IpcError> {
    let live = unlocked(state)?;
    let (entries, objects) = with_live_session(state, &live, |session| {
        let entries = trash_entries(&session.objects)
            .into_iter()
            .filter(|entry| keys.is_none_or(|keys| keys.contains(&entry.key)))
            .collect::<Vec<_>>();
        let objects = entries
            .iter()
            .flat_map(|entry| {
                session
                    .subtree(entry.storage_prefix.trim_end_matches('/'))
                    .map(|(path, object)| (path.clone(), object.key.clone()))
            })
            .collect::<Vec<_>>();
        (entries, objects)
    })?;
    if entries.is_empty() && keys.is_some_and(|keys| !keys.is_empty()) {
        return Err(missing_entry());
    }
    let (gone, deleted) = delete_in_batches(&live.remote, objects).await;
    let tree = apply_writes(
        state,
        &live,
        gone.into_iter().map(|path| (path, None)).collect(),
    )?;
    deleted?;
    let total = |count: fn(&BinEntry) -> usize| {
        u32::try_from(entries.iter().map(count).sum::<usize>()).unwrap_or(u32::MAX)
    };
    Ok(PurgeResult {
        documents: total(|entry| entry.documents),
        folders: total(|entry| entry.folders),
        images: 0,
        tree,
    })
}

#[tauri::command]
pub fn search_titles(
    state: State<'_, NotebookState>,
    query: String,
    include_trash: bool,
) -> Result<Vec<String>, IpcError> {
    let query = query.trim().to_lowercase();
    let inner = state
        .inner
        .lock()
        .map_err(|_| IpcError::internal("STATE"))?;
    let session = inner.session.as_ref().ok_or_else(IpcError::locked)?;
    let mut matches = session
        .nodes
        .values()
        .filter(|node| node.name.to_lowercase().contains(&query))
        .map(|node| node.id.clone())
        .collect::<Vec<_>>();
    if include_trash {
        matches.extend(
            trash_entries(&session.objects)
                .into_iter()
                .filter(|entry| entry.name.to_lowercase().contains(&query))
                .map(|entry| format!("trash-{}", entry.key)),
        );
    }
    matches.sort();
    Ok(matches)
}

#[tauri::command]
pub async fn passphrase_change(
    state: State<'_, NotebookState>,
    old_passphrase: String,
    new_passphrase: String,
) -> Result<PassphraseChangeResult, IpcError> {
    let (workspace, config, old_codec, remote, old_session) = {
        let inner = state
            .inner
            .lock()
            .map_err(|_| IpcError::internal("STATE"))?;
        let session = inner.session.as_ref().ok_or_else(IpcError::locked)?;
        let workspace = inner.active_id().map(str::to_owned).unwrap_or_default();
        let supplied = NotebookV1Codec::new(SecretString::from(old_passphrase))
            .map_err(|_| IpcError::new("WRONG_PHRASE", "The current phrase is incorrect."))?;
        if supplied.key_reference() != session.codec.key_reference() {
            return Err(IpcError::new(
                "WRONG_PHRASE",
                "The current phrase is incorrect.",
            ));
        }
        (
            workspace,
            session.config.clone(),
            session.codec.clone(),
            session.remote.clone(),
            session.id,
        )
    };
    let new_phrase = Zeroizing::new(new_passphrase);
    let new_codec = NotebookV1Codec::new(SecretString::from(new_phrase.as_str().to_owned()))
        .map_err(|_| IpcError::invalid("The new phrase cannot be empty."))?;
    if new_codec.key_reference() == old_codec.key_reference() {
        return Ok(PassphraseChangeResult {
            cleanup_pending: false,
        });
    }
    // Every key changes, so no edit may stay queued under an old one.
    commit_all(&state).await.map_err(|error| {
        if is_offline_error(&error) {
            IpcError::new(
                "UNSYNCED",
                "Some edits are not uploaded yet. Try again when S3 is reachable.",
            )
        } else {
            error
        }
    })?;
    let _ = refresh(&state).await?;
    let objects = with_session(&state, |session| session.objects.clone())?;
    // Copy and verify the complete new-key workspace before deleting a single
    // old-key object. This phase is safely resumable after interruption.
    let mut migrated = BTreeMap::new();
    for (path, object) in &objects {
        let encrypted = remote.get(&object.key).await?;
        if encrypted
            .etag
            .as_deref()
            .is_some_and(|etag| etag != object.etag)
        {
            return Err(IpcError::new(
                "CONFLICT",
                "An object changed during phrase migration. No old object was deleted.",
            ));
        }
        let plain = old_codec.decode_content(&encrypted.bytes).map_err(|_| {
            IpcError::new(
                "DECRYPT_FAILED",
                "An object could not be decrypted; nothing was deleted.",
            )
        })?;
        let new_body = new_codec
            .encode_content(&plain)
            .map_err(|_| IpcError::internal("ENCRYPT_CONTENT"))?
            .to_vec();
        let new_key = stored_key(&config, &new_codec, path)?;
        let etag = match put_new(&remote, &new_key, &new_body).await? {
            New::Created(etag) => etag,
            New::Exists(existing) if same_plaintext(&new_codec, &existing.bytes, &new_body) => {
                existing.etag.unwrap_or_default()
            }
            New::Exists(_) => {
                return Err(IpcError::new(
                    "CONFLICT",
                    "A different object already occupies a migrated path. No old object was deleted.",
                ));
            }
        };
        migrated.insert(path.clone(), Object { key: new_key, etag });
    }

    // A remembered phrase follows the change before any old object is deleted,
    // so the next launch opens the workspace with the phrase that matches it.
    // Only while the workspace is still at the location that was migrated.
    if workspaces::phrase_is_remembered(&state, &workspace)? {
        workspaces::remember_phrase(&state, &workspace, &config, Some(&new_phrase))?;
    }
    // A durable opaque journal is committed before cleanup. The app can now
    // use the new phrase even if deletion is interrupted or S3 goes offline.
    let cleanup = objects
        .values()
        .map(|object| CleanupEntry {
            key: object.key.clone(),
            etag: object.etag.clone(),
        })
        .collect::<Vec<_>>();
    persist_cleanup(&state, &config, &cleanup)?;
    // The new session is the migrated objects, as written: no listing.
    let new_session = Session::new(config.clone(), new_codec, remote.clone(), migrated);
    {
        let mut journal = lock_journal(&state)?;
        let mut inner = state
            .inner
            .lock()
            .map_err(|_| IpcError::internal("STATE"))?;
        // Every key changed: no edit may stay queued under an old one.
        if journal.session == old_session {
            journal.keys.clear();
            journal.session = 0;
        }
        // The session is replaced only while its workspace is still active
        // at the location that was migrated (also after a lock and unlock
        // there); a session elsewhere is left alone.
        if inner.active_id() == Some(workspace.as_str())
            && inner
                .session
                .as_ref()
                .is_some_and(|session| session.config == config)
        {
            journal.adopt(&new_session);
            inner.session = Some(new_session);
        }
    }
    let cleanup_pending = replay_cleanup(&state, &config, &remote).await?;
    Ok(PassphraseChangeResult { cleanup_pending })
}

/// Uploads every staged edit, then any outbox entry an earlier session left.
#[tauri::command]
pub async fn flush_all(state: State<'_, NotebookState>) -> Result<(), IpcError> {
    commit_all(&state).await?;
    let live = unlocked(&state)?;
    replay_outbox(&state, &live.config, &live.remote, Some(&live.codec)).await
}

#[tauri::command]
pub fn image_add(bytes: Vec<u8>, filename: String) -> Result<String, IpcError> {
    if bytes.is_empty() || bytes.len() > 8 * 1024 * 1024 {
        return Err(IpcError::invalid(
            "Images must be between 1 byte and 8 MiB.",
        ));
    }
    if filename.len() > 255 || filename.chars().any(char::is_control) {
        return Err(IpcError::invalid("The image filename is invalid."));
    }
    let mime = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        "image/png"
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        "image/jpeg"
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        "image/gif"
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        "image/webp"
    } else {
        return Err(IpcError::invalid(
            "Only PNG, JPEG, GIF, and WebP images are supported.",
        ));
    };
    Ok(format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

pub fn configure(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    builder.invoke_handler(tauri::generate_handler![
        workspaces::config_get,
        settings_set,
        layout::layout_set,
        workspaces::workspaces_list,
        workspaces::workspace_save,
        workspaces::workspace_delete,
        workspaces::workspace_select,
        connection_test,
        vault_unlock,
        vault_lock,
        passphrase_change,
        activity_ping,
        tree_get,
        folder_create,
        doc_create,
        node_rename,
        node_move,
        node_trash,
        trash_restore,
        trash_purge,
        trash_empty,
        search_titles,
        doc_open,
        doc_stage,
        doc_commit,
        flush_all,
        image_add,
        crate::preview::preview_render,
        crate::links::link_open,
        crate::window::close_after_flush,
        crate::window::cancel_close
    ])
}

/// Drives the command implementations without a Tauri runtime or keychain.
/// Used only by the MinIO compatibility test in `tests/notebook_bin_compat.rs`.
#[doc(hidden)]
pub mod testing {
    use super::*;

    #[derive(Debug)]
    pub struct TrashItem {
        pub key: String,
        pub name: String,
        pub original_path: String,
        pub location: String,
        pub deleted_at_ms: Option<u64>,
        pub is_folder: bool,
        pub item_count: usize,
        pub legacy: bool,
    }

    pub struct Workspace(NotebookState);

    impl Workspace {
        pub fn new(
            directory: &Path,
            endpoint: &str,
            bucket: &str,
            prefix: &str,
            access_key_id: &str,
            secret_access_key: &str,
        ) -> Self {
            // A memory keychain: the harness never reaches the OS keychain.
            let state = NotebookState::load_with(
                directory.join("config"),
                directory.join("local"),
                Arc::new(workspaces::MemoryKeychain::default()),
            );
            if let Ok(mut inner) = state.inner.lock() {
                let id = workspaces::add_test_workspace(
                    &mut inner.app,
                    VaultConfig {
                        bucket: bucket.into(),
                        region: "us-east-1".into(),
                        prefix: normalized_prefix(prefix),
                        endpoint: Some(endpoint.into()),
                    },
                );
                inner.credentials = Some((
                    id,
                    StoredCredentials {
                        access_key_id: access_key_id.into(),
                        secret_access_key: secret_access_key.into(),
                        session_token: None,
                    },
                ));
            }
            Self(state)
        }

        pub async fn unlock(&self, phrase: &str) -> Result<(), IpcError> {
            unlock(&self.0, Some(phrase.to_owned()), None)
                .await
                .map(drop)
        }

        /// The Refresh button: S3 is listed again.
        pub async fn refresh(&self) -> Result<(), IpcError> {
            refresh(&self.0).await.map(drop)
        }

        /// Whether the session's tree equals one built from a fresh listing:
        /// every change kept the map exact without listing.
        pub async fn matches_listing(&self) -> Result<bool, IpcError> {
            let live = unlocked(&self.0)?;
            let listed = live
                .remote
                .list(list_prefix(&live.config).as_deref())
                .await?;
            let fresh = decode_listing(&live.config, &live.codec, listed)?;
            self.with_session(|session| {
                let view =
                    |objects: &BTreeMap<String, Object>| tree_view(&build_nodes(objects), objects);
                Ok(session.objects == fresh && session.view == view(&fresh))
            })
        }

        /// The tree version the frontend would hold.
        pub fn version(&self) -> u64 {
            self.with_session(|session| session.version)
        }

        fn id_of(&self, path: &str) -> Result<String, IpcError> {
            if path.is_empty() {
                return Ok(ROOT_ID.into());
            }
            let inner = self
                .0
                .inner
                .lock()
                .map_err(|_| IpcError::internal("STATE"))?;
            let session = inner.session.as_ref().ok_or_else(IpcError::locked)?;
            session
                .nodes
                .values()
                .find(|node| node.logical_path == path)
                .map(|node| node.id.clone())
                .ok_or_else(|| IpcError::invalid("The selected item does not exist."))
        }

        pub async fn create_folder(&self, parent: &str, name: &str) -> Result<String, IpcError> {
            let parent = self.id_of(parent)?;
            create_entry(&self.0, &parent, &[], name, None)
                .await
                .map(|created| created.final_name)
        }

        pub async fn create_document(
            &self,
            parent: &str,
            name: &str,
            text: &str,
        ) -> Result<String, IpcError> {
            let parent_id = self.id_of(parent)?;
            validate_document_size(text)?;
            let created =
                create_entry(&self.0, &parent_id, &[], name, Some(text.to_owned())).await?;
            Ok(created.final_name)
        }

        /// `doc_create` with folders below `parent` (created when missing).
        pub async fn create_at(
            &self,
            parent: &str,
            folders: &[&str],
            name: &str,
            text: &str,
        ) -> Result<String, IpcError> {
            let parent_id = self.id_of(parent)?;
            let folders = folders
                .iter()
                .map(|&folder| folder.to_owned())
                .collect::<Vec<_>>();
            let created =
                create_entry(&self.0, &parent_id, &folders, name, Some(text.to_owned())).await?;
            Ok(created.final_name)
        }

        pub async fn read(&self, path: &str) -> Result<String, IpcError> {
            open_document(&self.0, &self.id_of(path)?)
                .await
                .map(|document| document.text)
        }

        pub async fn trash(&self, path: &str) -> Result<String, IpcError> {
            trash_node(&self.0, &self.id_of(path)?)
                .await
                .map(|result| result.entry_id)
        }

        pub async fn restore(&self, key: &str) -> Result<String, IpcError> {
            let mode = RestoreMode::Named("Original".into());
            restore_entry(&self.0, key, &mode, None)
                .await
                .map(|result| result.final_path)
        }

        pub async fn restore_to(
            &self,
            key: &str,
            folder: &str,
            name: Option<&str>,
        ) -> Result<String, IpcError> {
            let mode = RestoreMode::To {
                to: self.id_of(folder)?,
            };
            restore_entry(&self.0, key, &mode, name)
                .await
                .map(|result| result.final_path)
        }

        pub async fn purge(&self, key: &str) -> Result<(), IpcError> {
            purge_entries(&self.0, Some(&[key.to_owned()]))
                .await
                .map(drop)
        }

        pub async fn empty(&self) -> Result<(), IpcError> {
            purge_entries(&self.0, None).await.map(drop)
        }

        /// Writes an encrypted object at a raw logical path, bypassing every
        /// check (for example to stage legacy Trash entries).
        pub async fn put_raw(&self, path: &str, text: &str) -> Result<(), IpcError> {
            let live = unlocked(&self.0)?;
            let body = live
                .codec
                .encode_content(text)
                .map_err(|_| IpcError::internal("ENCRYPT_CONTENT"))?
                .to_vec();
            live.remote
                .put(
                    &stored_key(&live.config, &live.codec, path)?,
                    &body,
                    PutCondition::IfNoneMatch,
                )
                .await
                .map(drop)
        }

        /// `doc_open`: the text and whether it is a staged, unsynced edit.
        pub async fn open(&self, path: &str) -> Result<(String, bool), IpcError> {
            open_document(&self.0, &self.id_of(path)?)
                .await
                .map(|document| (document.text, document.dirty))
        }

        /// `doc_stage`: "Clean" or "Staged", without any S3 request.
        pub fn stage(&self, path: &str, text: &str) -> Result<&'static str, IpcError> {
            stage_document(&self.0, &self.id_of(path)?, text.to_owned())
        }

        /// `doc_commit`: "Saved", "Offline" or "ConflictCopy".
        pub async fn commit(&self, path: &str) -> Result<&'static str, IpcError> {
            let target = document_target(&self.0, &self.id_of(path)?)?;
            commit_key(&self.0, target.session, &target.key)
                .await
                .map(|result| result.status)
        }

        pub async fn flush_all(&self) -> Result<(), IpcError> {
            commit_all(&self.0).await?;
            let live = unlocked(&self.0)?;
            replay_outbox(&self.0, &live.config, &live.remote, Some(&live.codec)).await
        }

        pub async fn rename(&self, path: &str, name: &str) -> Result<(), IpcError> {
            rename_node(&self.0, &self.id_of(path)?, name)
                .await
                .map(drop)
        }

        pub async fn move_to(&self, path: &str, folder: &str) -> Result<(), IpcError> {
            move_node(&self.0, &self.id_of(path)?, &self.id_of(folder)?)
                .await
                .map(drop)
        }

        /// Adds another workspace (not made active) with the harness
        /// credentials; returns its id.
        pub fn add_workspace(&self, endpoint: &str, bucket: &str, prefix: &str) -> String {
            let mut inner = self.0.inner.lock().expect("state");
            let active = inner.app.active_workspace.clone();
            let id = workspaces::add_test_workspace(
                &mut inner.app,
                VaultConfig {
                    bucket: bucket.into(),
                    region: "us-east-1".into(),
                    prefix: normalized_prefix(prefix),
                    endpoint: Some(endpoint.into()),
                },
            );
            inner.app.active_workspace = active;
            id
        }

        pub fn active_id(&self) -> String {
            let inner = self.0.inner.lock().expect("state");
            inner.active_id().unwrap_or_default().to_owned()
        }

        /// `workspace_select`; the harness credentials serve every workspace.
        pub fn select(&self, id: &str) -> Result<(), IpcError> {
            let credentials = self.0.inner.lock().expect("state").credentials.clone();
            workspaces::select_workspace(&self.0, id)?;
            if let Some((_, credentials)) = credentials {
                self.0.inner.lock().expect("state").credentials =
                    Some((id.to_owned(), credentials));
            }
            Ok(())
        }

        /// Lock, close or reload: the session and the in-memory journal go.
        pub fn lock(&self) {
            self.0.end_session();
        }

        /// Queued uploads of this vault in the encrypted outbox.
        pub fn outbox_entries(&self) -> usize {
            let config = self
                .0
                .inner
                .lock()
                .expect("state")
                .active_config()
                .unwrap_or_default();
            std::fs::read_dir(vault_outbox_dir(&self.0, &config)).map_or(0, |entries| {
                entries
                    .flatten()
                    .filter(|entry| is_pending_file(&entry.path()))
                    .count()
            })
        }

        fn with_session<T>(&self, read: impl FnOnce(&Session) -> T) -> T {
            let inner = self.0.inner.lock().expect("state");
            read(inner.session.as_ref().expect("unlocked"))
        }

        /// Visible tree paths; folders end with `/`.
        pub fn paths(&self) -> Vec<String> {
            self.with_session(|session| {
                let mut paths = session
                    .nodes
                    .values()
                    .map(|node| match node.kind {
                        "Folder" => format!("{}/", node.logical_path),
                        _ => node.logical_path.clone(),
                    })
                    .collect::<Vec<_>>();
                paths.sort();
                paths
            })
        }

        /// Every decrypted object path, bin and markers included.
        pub fn objects(&self) -> Vec<String> {
            self.with_session(|session| session.objects.keys().cloned().collect())
        }

        /// The S3 keys as stored, prefix included.
        pub fn stored_keys(&self) -> Vec<String> {
            self.with_session(|session| {
                session
                    .objects
                    .values()
                    .map(|object| object.key.clone())
                    .collect()
            })
        }

        pub fn trash_items(&self) -> Vec<TrashItem> {
            self.with_session(|session| {
                trash_entries(&session.objects)
                    .into_iter()
                    .map(|entry| TrashItem {
                        key: entry.key,
                        name: entry.name,
                        original_path: entry.original_path,
                        location: entry.original_parent,
                        deleted_at_ms: entry.deleted_at_ms,
                        is_folder: entry.is_folder,
                        item_count: entry.item_count,
                        legacy: entry.legacy,
                    })
                    .collect()
            })
        }

        /// Ids, names and kinds of the snapshot the frontend receives.
        pub fn snapshot_summary(&self) -> Vec<(String, String, &'static str)> {
            self.with_session(|session| {
                snapshot(session)
                    .nodes
                    .into_iter()
                    .map(|node| (node.id, node.name, node.kind))
                    .collect()
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::mpsc;

    fn codec() -> NotebookV1Codec {
        NotebookV1Codec::new(SecretString::from("correct horse".to_owned())).unwrap()
    }

    /// A client for sessions built in memory; nothing listens on port 9.
    fn remote() -> Arc<S3Remote> {
        let config = local_config("http://127.0.0.1:9".into());
        Arc::new(S3Remote::new(&config, &local_credentials()).unwrap())
    }

    #[test]
    fn tree_reconstructs_folders_and_hides_storage_names() {
        let config = VaultConfig::default();
        let codec = codec();
        let paths = [
            ("Projects/alpha.md", 42),
            ("Projects/Empty/.notebook_dir", 28),
        ];
        let listed = paths
            .into_iter()
            .map(|(path, size)| ListedObject {
                key: codec.encode_path(path).unwrap(),
                etag: format!("etag-{size}"),
            })
            .collect();
        let session = build_session(&config, codec, listed, remote()).unwrap();
        assert!(
            session
                .nodes
                .values()
                .any(|node| node.name == "Projects" && node.kind == "Folder")
        );
        assert!(
            session
                .nodes
                .values()
                .any(|node| node.name == "alpha.md" && node.kind == "Document")
        );
        assert!(
            session
                .nodes
                .values()
                .any(|node| node.name == "Empty" && node.kind == "Folder")
        );
        assert!(
            session
                .nodes
                .values()
                .all(|node| !node.name.contains('_') || node.name != DIRECTORY_MARKER)
        );
    }

    #[test]
    fn another_phrase_cannot_build_a_misleading_tree() {
        let config = VaultConfig::default();
        let first = codec();
        let listed = vec![ListedObject {
            key: first.encode_path("private.md").unwrap(),
            etag: "etag-1".into(),
        }];
        let other = NotebookV1Codec::new(SecretString::from("wrong".to_owned())).unwrap();
        assert!(matches!(
            build_session(&config, other, listed, remote()),
            Err(IpcError {
                code: "WRONG_PHRASE",
                ..
            })
        ));
    }

    #[test]
    fn name_validation_protects_the_compatibility_namespace() {
        for invalid in [
            "",
            "../x",
            ".notebook_dir",
            ".secure-vault-trash",
            "_deleted",
            " _delete ",
            "a/b",
            "a\\b",
        ] {
            assert!(validate_name(invalid).is_err());
        }
        assert_eq!(validate_name("  Notes.md ").unwrap(), "Notes.md");
        assert_eq!(validate_name("_deleted notes").unwrap(), "_deleted notes");
    }

    #[test]
    fn bin_storage_is_hidden_and_listed_as_trash() {
        let config = VaultConfig::default();
        let codec = codec();
        let listed = [
            "notes/keep.md",
            "_deleted/items/.notebook_dir",
            "_deleted/items/1712000000123-todo-md/item/.notebook_dir",
            "_deleted/items/1712000000123-todo-md/parent/notes/.notebook_dir",
            "_deleted/items/1712000000123-todo-md/item/todo.md",
            "_delete/old.md",
            ".secure-vault-trash/3f2a/Inbox/x.md",
        ]
        .into_iter()
        .map(|path| ListedObject {
            key: codec.encode_path(path).unwrap(),
            etag: "etag-28".into(),
        })
        .collect();
        let session = build_session(&config, codec, listed, remote()).unwrap();
        let mut names = session
            .nodes
            .values()
            .map(|node| node.logical_path.as_str())
            .collect::<Vec<_>>();
        names.sort();
        assert_eq!(names, ["notes", "notes/keep.md"]);
        let tree = snapshot(&session);
        let trash = tree
            .nodes
            .iter()
            .filter(|node| node.kind == "TrashEntry")
            .collect::<Vec<_>>();
        assert_eq!(trash.len(), 2);
        assert_eq!(
            trash[0].trash_entry_id.as_deref(),
            Some("bin:1712000000123-todo-md")
        );
        let origin = trash[0].origin.as_ref().unwrap();
        assert_eq!(origin.original_path, "notes/todo.md");
        assert_eq!(origin.location, "notes");
        assert_eq!(origin.deleted_at, Some(1_712_000_000_123));
        assert_eq!(trash[1].trash_entry_id.as_deref(), Some("legacy:3f2a"));
    }

    #[test]
    fn restore_never_overwrites_and_recreates_a_missing_parent() {
        let codec = codec();
        let listed = ["docs.md", "Projects/x.md"]
            .into_iter()
            .map(|path| ListedObject {
                key: codec.encode_path(path).unwrap(),
                etag: "etag-28".into(),
            })
            .collect();
        let session = build_session(&VaultConfig::default(), codec, listed, remote()).unwrap();
        let code = |path: &str| check_restore_target(&session, path, false).map_err(|e| e.code);
        assert_eq!(code("Projects/x.md"), Err("RESTORE_CONFLICT"));
        assert_eq!(code("Projects"), Err("RESTORE_CONFLICT"));
        assert_eq!(code("docs.md/inner.md"), Err("RESTORE_CONFLICT"));
        assert_eq!(code("_deleted/x.md"), Err("INVALID_INPUT"));
        assert_eq!(code("Projects/y.md"), Ok(false));
        assert_eq!(code("y.md"), Ok(false));
        assert_eq!(code("Gone/Deeper/y.md"), Ok(true));
    }

    /// A state with a memory keychain: no test reaches the OS keychain.
    fn temporary_state() -> (tempfile::TempDir, NotebookState) {
        let directory = tempfile::tempdir().unwrap();
        let state = NotebookState::load_with(
            directory.path().join("config"),
            directory.path().join("local"),
            Arc::new(workspaces::MemoryKeychain::default()),
        );
        (directory, state)
    }

    #[test]
    fn offline_outbox_contains_only_opaque_key_and_ciphertext() {
        let (directory, state) = temporary_state();
        let config = VaultConfig::default();
        let codec = codec();
        let name = "OUTBOX_PRIVATE_NAME_493821.md";
        let text = "OUTBOX_PRIVATE_BODY_493821";
        let key = codec.encode_path(name).unwrap();
        let body = codec.encode_content(text).unwrap();
        persist_outbox(&state, &config, &key, &body, Some("etag-before")).unwrap();
        let path = outbox_path(&state, &config, &key);
        assert!(path.starts_with(directory.path().join("local").join("outbox")));
        assert!(path.starts_with(vault_outbox_dir(&state, &config)));
        assert!(!directory.path().join("config").exists());
        let saved = std::fs::read(path).unwrap();
        assert!(
            !saved
                .windows(name.len())
                .any(|part| part == name.as_bytes())
        );
        assert!(
            !saved
                .windows(text.len())
                .any(|part| part == text.as_bytes())
        );
        assert!(saved.windows(key.len()).any(|part| part == key.as_bytes()));
        let parsed = parse_outbox(&saved).unwrap();
        assert!(
            matches!(parsed.condition, PendingCondition::IfMatch(ref value) if value == "etag-before")
        );
        assert_eq!(parsed.body, body.as_slice());
    }

    #[cfg(unix)]
    #[test]
    fn config_and_outbox_are_private_to_the_user() {
        use std::os::unix::fs::PermissionsExt;
        let (directory, state) = temporary_state();
        state.save_config(&AppConfig::default()).unwrap();
        // A leftover temporary file keeps its old mode unless it is reset.
        let leftover = state.outbox_dir().join("leftover.pending.tmp");
        std::fs::create_dir_all(state.outbox_dir()).unwrap();
        std::fs::write(&leftover, b"x").unwrap();
        std::fs::set_permissions(&leftover, std::fs::Permissions::from_mode(0o644)).unwrap();
        write_private_file(&leftover, b"y").unwrap();
        let config = VaultConfig::default();
        persist_outbox(&state, &config, "opaque-key", b"ciphertext", None).unwrap();
        let mode = |path: &Path| std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&directory.path().join("config")), 0o700);
        assert_eq!(
            mode(&directory.path().join("config").join("config.json")),
            0o600
        );
        assert_eq!(mode(state.outbox_dir()), 0o700);
        assert_eq!(mode(&vault_outbox_dir(&state, &config)), 0o700);
        assert_eq!(mode(&outbox_path(&state, &config, "opaque-key")), 0o600);
        assert_eq!(mode(&leftover), 0o600);
    }

    #[test]
    fn unlock_without_stored_credentials_asks_for_setup() {
        let (_directory, state) = temporary_state();
        workspaces::add_test_workspace(
            &mut state.inner.lock().unwrap().app,
            vault("saved-bucket", "", None),
        );
        // Never reaches the keychain, and never reports a wrong phrase.
        assert!(matches!(
            workspaces::active_credentials(&state),
            Err(IpcError {
                code: "NO_CREDENTIALS",
                ..
            })
        ));
    }

    #[test]
    fn accent_is_validated_and_old_configs_default_to_orange() {
        for accent in ACCENTS {
            assert!(validate_accent(accent).is_ok());
        }
        for bad in ["Orange", "#ff8800", "", "orange; color:red"] {
            assert_eq!(validate_accent(bad).unwrap_err().code(), "INVALID_INPUT");
        }
        // Configs written before the accent setting: workspaces::tests.
    }

    #[test]
    fn keychain_errors_map_to_safe_codes() {
        let failure = || Box::new(std::io::Error::other("platform detail")) as _;
        for (error, code) in [
            (keyring::Error::NoEntry, "NO_CREDENTIALS"),
            (
                keyring::Error::TooLong("secret".into(), 2560),
                "KEYCHAIN_TOO_LONG",
            ),
            (
                keyring::Error::NoStorageAccess(failure()),
                "KEYCHAIN_UNAVAILABLE",
            ),
            (
                keyring::Error::PlatformFailure(failure()),
                "KEYCHAIN_UNAVAILABLE",
            ),
            (keyring::Error::BadEncoding(vec![0xff]), "KEYCHAIN"),
            (
                keyring::Error::Invalid("user".into(), "empty".into()),
                "KEYCHAIN",
            ),
        ] {
            let mapped = keychain_error(error);
            assert_eq!(mapped.code, code);
            assert!(!mapped.message.contains("platform detail"));
        }
        #[cfg(target_os = "linux")]
        assert!(KEYCHAIN_UNAVAILABLE.contains("GNOME Keyring or KWallet"));
    }

    #[test]
    fn stored_credentials_round_trip_as_utf8_json_bytes() {
        let credentials = StoredCredentials {
            access_key_id: "AKIDEXAMPLE".into(),
            secret_access_key: "secret/with+chars".into(),
            session_token: Some("t".repeat(2_000)),
        };
        let bytes = serde_json::to_vec(&credentials).unwrap();
        let decoded: StoredCredentials = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(decoded.session_token, credentials.session_token);
        assert!(!format!("{decoded:?}").contains("secret/with"));
        // A missing session token is optional.
        let short: StoredCredentials =
            serde_json::from_str(r#"{"access_key_id":"A","secret_access_key":"S"}"#).unwrap();
        assert_eq!(short.session_token, None);
    }

    fn vault(bucket: &str, prefix: &str, endpoint: Option<&str>) -> VaultConfig {
        VaultConfig {
            bucket: bucket.into(),
            prefix: prefix.into(),
            endpoint: endpoint.map(Into::into),
            ..VaultConfig::default()
        }
    }

    #[test]
    fn each_vault_has_its_own_outbox() {
        let (_directory, state) = temporary_state();
        let notes = vault("bucket", "notes", None);
        let dir = |config: &VaultConfig| vault_outbox_dir(&state, config);
        assert_eq!(dir(&notes), dir(&vault("bucket", " /notes/ ", None)));
        for other in [
            vault("bucket", "", None),
            vault("bucket", "notes/sub", None),
            vault("other", "notes", None),
            vault("bucket", "notes", Some("https://s3.example.com")),
            // The separators keep "a" + "b/c" apart from "ab" + "/c".
            vault("bucke", "tnotes", None),
        ] {
            assert_ne!(dir(&notes), dir(&other));
        }
        persist_outbox(&state, &notes, "notes/opaque", b"ciphertext", None).unwrap();
        assert!(outbox_path(&state, &notes, "notes/opaque").is_file());
        let other = vault("other", "notes", None);
        assert!(!outbox_path(&state, &other, "notes/opaque").exists());
    }

    fn write_flat(state: &NotebookState, name: &str, key: &str, body: &[u8]) -> PathBuf {
        std::fs::create_dir_all(state.outbox_dir()).unwrap();
        let path = state.outbox_dir().join(format!("{name}.pending"));
        std::fs::write(&path, outbox_payload(key, body, None).unwrap()).unwrap();
        path
    }

    fn set_modified(path: &Path, seconds_ago: u64) {
        let file = std::fs::File::options().write(true).open(path).unwrap();
        file.set_modified(SystemTime::now() - Duration::from_secs(seconds_ago))
            .unwrap();
    }

    #[test]
    fn flat_outbox_entries_move_only_into_their_own_vault() {
        let (_directory, state) = temporary_state();
        let config = vault("bucket", "notes", None);
        let ours = codec();
        let theirs = NotebookV1Codec::new(SecretString::from("other phrase".to_owned())).unwrap();
        let key = |codec: &NotebookV1Codec, path: &str| stored_key(&config, codec, path).unwrap();
        let body = |codec: &NotebookV1Codec| codec.encode_content("queued edit").unwrap().to_vec();

        let adopted_key = key(&ours, "Inbox/today.md");
        let adopted_body = body(&ours);
        let adopted = write_flat(&state, "adopted", &adopted_key, &adopted_body);
        let other_phrase = write_flat(&state, "phrase", &key(&theirs, "x.md"), &body(&theirs));
        let other_prefix = format!("elsewhere/{}", ours.encode_path("x.md").unwrap());
        let other_vault = write_flat(&state, "prefix", &other_prefix, &body(&ours));
        let other_body = write_flat(&state, "body", &key(&ours, "y.md"), &body(&theirs));
        let damaged = state.outbox_dir().join("damaged.pending");
        std::fs::write(&damaged, [9, 0, 0, 0, b'x']).unwrap();

        // An older flat copy of an already queued object is superseded; a newer
        // one replaces the queued body.
        let queued_key = key(&ours, "queued.md");
        persist_outbox(&state, &config, &queued_key, b"newer", None).unwrap();
        let stale = write_flat(&state, "stale", &queued_key, &body(&ours));
        set_modified(&stale, 60);
        let replaced_key = key(&ours, "replaced.md");
        persist_outbox(&state, &config, &replaced_key, b"older", None).unwrap();
        set_modified(&outbox_path(&state, &config, &replaced_key), 60);
        let fresh = write_flat(&state, "fresh", &replaced_key, &body(&ours));

        assert_eq!(adopt_flat_outbox(&state, &config, &ours), 4);
        for left in [&other_phrase, &other_vault, &other_body, &damaged] {
            assert!(left.is_file(), "{left:?}");
        }
        for gone in [&adopted, &stale, &fresh] {
            assert!(!gone.exists(), "{gone:?}");
        }
        let read = |key: &str| std::fs::read(outbox_path(&state, &config, key)).unwrap();
        assert_eq!(
            read(&adopted_key),
            outbox_payload(&adopted_key, &adopted_body, None).unwrap()
        );
        assert_eq!(
            read(&queued_key),
            outbox_payload(&queued_key, b"newer", None).unwrap()
        );
        assert_ne!(
            read(&replaced_key),
            outbox_payload(&replaced_key, b"older", None).unwrap()
        );
        // Nothing of another vault reaches this vault's folder.
        let queued = std::fs::read_dir(vault_outbox_dir(&state, &config))
            .unwrap()
            .count();
        assert_eq!(queued, 3);
    }

    #[tokio::test]
    async fn replay_uploads_only_this_vaults_entries() {
        let (endpoint, request) = fake_http_server(Vec::new());
        let (_directory, state) = temporary_state();
        let config = VaultConfig {
            prefix: "notes".into(),
            ..local_config(endpoint)
        };
        let codec = codec();
        let key = stored_key(&config, &codec, "today.md").unwrap();
        persist_outbox(&state, &config, &key, b"ciphertext", None).unwrap();
        // Defence in depth: an entry outside the prefix is never sent.
        let foreign = vault_outbox_dir(&state, &config).join("foreign.pending");
        std::fs::write(
            &foreign,
            outbox_payload("elsewhere/key", b"x", None).unwrap(),
        )
        .unwrap();
        // The fake server answers one request; a second PUT would fail.
        let remote = S3Remote::new(&config, &local_credentials()).unwrap();
        replay_outbox(&state, &config, &remote, Some(&codec))
            .await
            .unwrap();
        let raw = request.recv_timeout(Duration::from_secs(5)).unwrap();
        let wire = String::from_utf8_lossy(&raw);
        assert!(
            wire.starts_with(&format!("PUT /test-bucket/{key}")),
            "{wire}"
        );
        assert!(!outbox_path(&state, &config, &key).exists());
        assert!(foreign.is_file());
    }

    #[test]
    fn rename_returns_the_id_the_refreshed_tree_uses() {
        let codec = codec();
        let paths = ["Projects/a.md", "Projects/b.md", "Projects/Drafts/c.md"];
        let listed = |paths: &[&str]| {
            paths
                .iter()
                .map(|path| ListedObject {
                    key: codec.encode_path(path).unwrap(),
                    etag: "etag-28".into(),
                })
                .collect::<Vec<_>>()
        };
        let config = VaultConfig::default();
        let session = build_session(&config, codec.clone(), listed(&paths), remote()).unwrap();
        let id = |path: &str, kind: &str| node_id(kind, path);

        let plan = plan_rename(&session, &id("Projects/a.md", "Document"), "B.md").unwrap();
        assert_eq!(plan.source, "Projects/a.md");
        assert_eq!(plan.destination, "Projects/B 2.md");
        assert_eq!(plan.final_name, "B 2.md");
        let after = ["Projects/B 2.md", "Projects/b.md", "Projects/Drafts/c.md"];
        let renamed = build_session(&config, codec.clone(), listed(&after), remote()).unwrap();
        assert_eq!(
            renamed.nodes[&node_id(plan.kind, &plan.destination)].logical_path,
            "Projects/B 2.md"
        );
        assert_ne!(
            node_id(plan.kind, &plan.destination),
            id("Projects/a.md", "Document")
        );

        let plan = plan_rename(&session, &id("Projects/Drafts", "Folder"), "Ideas").unwrap();
        let after = ["Projects/a.md", "Projects/b.md", "Projects/Ideas/c.md"];
        let renamed = build_session(&config, codec.clone(), listed(&after), remote()).unwrap();
        assert_eq!(
            renamed.nodes[&node_id(plan.kind, &plan.destination)].kind,
            "Folder"
        );
        assert!(
            renamed
                .nodes
                .contains_key(&id("Projects/Ideas/c.md", "Document"))
        );

        // Renaming to the same name keeps the id.
        let plan = plan_rename(&session, &id("Projects/b.md", "Document"), "b.md").unwrap();
        assert_eq!(
            node_id(plan.kind, &plan.destination),
            id("Projects/b.md", "Document")
        );
        assert!(plan_rename(&session, "n-missing", "x.md").is_err());
    }

    #[test]
    fn access_key_ids_are_printable_ascii_and_masked_safely() {
        let pasted = "AKIAIOSFODNN7EXAMPLE\u{200B}\u{200B}";
        for invalid in [pasted, "AKIA\u{2026}\u{2026}", "AKIA EXAMPLE", "AKIA\u{7f}"] {
            assert_eq!(
                validate_access_key_id(invalid).unwrap_err().code,
                "INVALID_INPUT"
            );
            // Masking never splits a character, whatever it is given.
            assert!(masked_access_key_id(invalid).starts_with("••••"));
        }
        assert_eq!(
            masked_access_key_id("AKIA\u{2026}\u{2026}"),
            "••••IA\u{2026}\u{2026}"
        );
        assert_eq!(masked_access_key_id("AKIAIOSFODNN7EXAMPLE"), "••••MPLE");
        assert_eq!(masked_access_key_id("ABCD"), "••••");

        let (directory, state) = temporary_state();
        workspaces::add_test_workspace(
            &mut state.inner.lock().unwrap().app,
            vault("bucket", "", None),
        );
        let credentials = |access: &str| StoredCredentials {
            access_key_id: access.into(),
            secret_access_key: "secret".into(),
            session_token: None,
        };
        let error = workspaces::store_credentials(&state, credentials(pasted)).unwrap_err();
        assert_eq!(error.code, "INVALID_INPUT");
        assert!(state.inner.lock().unwrap().secrets.is_empty());
        assert!(!directory.path().join("config").exists());

        workspaces::store_credentials(&state, credentials(" AKIAIOSFODNN7EXAMPLE ")).unwrap();
        let summary = state.inner.lock().unwrap().list().workspaces.remove(0);
        assert!(summary.credentials_stored);
        assert_eq!(summary.masked_access_key_id.as_deref(), Some("••••MPLE"));
        let (_, _, stored) = workspaces::active_credentials(&state).unwrap();
        assert_eq!(stored.access_key_id, "AKIAIOSFODNN7EXAMPLE");
        let config = directory.path().join("config");
        assert!(config.join("config.json").is_file());
        assert!(config.join("secrets.json").is_file());
    }

    #[test]
    fn ending_the_session_keeps_the_configuration() {
        let codec = codec();
        let (_directory, state) = temporary_state();
        let session = build_session(&VaultConfig::default(), codec, Vec::new(), remote()).unwrap();
        {
            let mut inner = state.inner.lock().unwrap();
            workspaces::add_test_workspace(&mut inner.app, vault("bucket", "notes", None));
            inner.session = Some(session);
        }
        assert!(state.is_unlocked());
        state.end_session();
        assert!(!state.is_unlocked());
        let config = state.inner.lock().unwrap().active_config().unwrap();
        assert_eq!(config.bucket, "bucket");
    }

    #[test]
    fn idle_lock_notifies_before_forcing_key_destruction() {
        let codec = codec();
        let (_directory, state) = temporary_state();
        let session = build_session(&VaultConfig::default(), codec, Vec::new(), remote()).unwrap();
        {
            let mut inner = state.inner.lock().unwrap();
            inner.app.auto_lock_minutes = 1;
            inner.session = Some(session);
            inner.last_activity = Instant::now() - Duration::from_secs(61);
        }
        assert!(matches!(state.check_idle_session(), IdleAction::Notify));
        assert!(state.is_unlocked());
        assert!(matches!(state.check_idle_session(), IdleAction::None));
        state.inner.lock().unwrap().last_activity = Instant::now() - Duration::from_secs(121);
        assert!(matches!(state.check_idle_session(), IdleAction::Forced));
        assert!(!state.is_unlocked());
    }

    fn fake_http_server(response_body: Vec<u8>) -> (String, mpsc::Receiver<Vec<u8>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let (sender, receiver) = mpsc::channel();
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut request = Vec::new();
            let mut buffer = [0_u8; 8192];
            let mut expected = None;
            loop {
                let count = stream.read(&mut buffer).unwrap_or(0);
                if count == 0 {
                    break;
                }
                request.extend_from_slice(&buffer[..count]);
                if expected.is_none()
                    && let Some(end) = request.windows(4).position(|part| part == b"\r\n\r\n")
                {
                    let headers = String::from_utf8_lossy(&request[..end]);
                    let length = headers
                        .lines()
                        .find_map(|line| {
                            line.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .map(str::trim)
                                .and_then(|value| value.parse::<usize>().ok())
                        })
                        .unwrap_or(0);
                    expected = Some(end + 4 + length);
                }
                if expected.is_some_and(|length| request.len() >= length) {
                    break;
                }
            }
            sender.send(request).unwrap();
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                response_body.len()
            )
            .unwrap();
            stream.write_all(&response_body).unwrap();
        });
        (format!("http://{address}"), receiver)
    }

    fn local_config(endpoint: String) -> VaultConfig {
        VaultConfig {
            bucket: "test-bucket".into(),
            region: "test".into(),
            endpoint: Some(endpoint),
            ..VaultConfig::default()
        }
    }

    fn local_credentials() -> StoredCredentials {
        StoredCredentials {
            access_key_id: "test-access".into(),
            secret_access_key: "test-secret".into(),
            session_token: None,
        }
    }

    #[tokio::test]
    async fn s3_put_boundary_contains_only_encrypted_name_and_body() {
        let (endpoint, request) = fake_http_server(Vec::new());
        let config = local_config(endpoint);
        let codec = codec();
        let logical_name = "CONFIDENTIAL_NAME_493821.md";
        let logical_text = "CONFIDENTIAL_BODY_493821";
        let key = stored_key(&config, &codec, logical_name).unwrap();
        let body = codec.encode_content(logical_text).unwrap().to_vec();
        S3Remote::new(&config, &local_credentials())
            .unwrap()
            .put(&key, &body, PutCondition::IfNoneMatch)
            .await
            .unwrap();
        let raw = request.recv_timeout(Duration::from_secs(5)).unwrap();
        let wire = String::from_utf8_lossy(&raw);
        assert!(!wire.contains(logical_name));
        assert!(!wire.contains(logical_text));
        assert!(wire.starts_with("PUT /test-bucket/"));
        assert!(wire.contains("X-Amz-Signature="));
        assert!(wire.to_ascii_lowercase().contains("if-none-match: *"));
    }

    #[tokio::test]
    async fn s3_list_response_is_parsed_without_exposing_a_signed_url() {
        let xml = br#"<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>test-bucket</Name><Prefix></Prefix><KeyCount>1</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated><Contents><Key>opaque-key</Key><LastModified>2026-01-01T00:00:00.000Z</LastModified><ETag>&quot;x&quot;</ETag><Size>31</Size><StorageClass>STANDARD</StorageClass></Contents></ListBucketResult>"#.to_vec();
        let (endpoint, request) = fake_http_server(xml);
        let remote = S3Remote::new(&local_config(endpoint), &local_credentials()).unwrap();
        let objects = remote.list(None).await.unwrap();
        assert_eq!(objects.len(), 1);
        assert_eq!(objects[0].key, "opaque-key");
        assert_eq!(objects[0].etag, "\"x\"");
        let raw = request.recv_timeout(Duration::from_secs(5)).unwrap();
        let wire = String::from_utf8_lossy(&raw);
        assert!(
            wire.starts_with("GET /test-bucket"),
            "unexpected request: {wire}"
        );
        assert!(wire.contains("list-type=2"));
    }
}
