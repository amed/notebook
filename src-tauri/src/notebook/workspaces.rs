//! Workspaces: named S3 locations (bucket, region, prefix, endpoint) the user
//! switches between. `config.json` holds them with the global preferences and
//! no secrets; each workspace's S3 credentials and, when remembered, its
//! encryption phrase are sealed in `secrets.json` under its id (see
//! `crate::secrets`), and only the random master key of that file lives in
//! the OS keychain.
//!
//! Configs written before workspaces held one connection and kept its S3
//! credentials in a keychain entry of their own. Loading such a config turns
//! it into one active workspace; its credentials move into `secrets.json` on
//! first use, and the old keychain entry is deleted only once the new file is
//! durably written.

use super::*;
use crate::secrets::{
    self, Field, KEY_LEN, MASTER_SERVICE, MASTER_USER, SecretsError, SecretsFile,
};
use std::sync::MutexGuard;

const CONFIG_VERSION: u32 = 2;
const MAX_NAME_CHARS: usize = 64;
const DEFAULT_NAME: &str = "Workspace";
const MAX_PHRASE_BYTES: usize = 4_096;
const MAX_ACCESS_KEY_BYTES: usize = 256;
const MAX_SECRET_KEY_BYTES: usize = 1_024;
const MAX_SESSION_TOKEN_BYTES: usize = 8_192;

// ---------------------------------------------------------------------------
// config.json

/// One workspace as `config.json` stores it. Nothing in it is secret.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct WorkspaceConfig {
    pub(super) id: String,
    pub(super) name: String,
    pub(super) bucket: String,
    pub(super) region: String,
    #[serde(default)]
    pub(super) prefix: String,
    #[serde(default)]
    pub(super) endpoint: Option<String>,
    /// For display only, e.g. "••••MPLE".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) masked_access_key_id: Option<String>,
    /// The keychain account that still holds this workspace's S3 credentials
    /// from a build before workspaces. Cleared once they moved and the old
    /// entry is gone.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) legacy_keychain_user: Option<String>,
    /// The user last chose not to remember the phrase (Remember unchecked):
    /// the unlock screen then offers Remember unchecked. Not secret.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub(super) remember_declined: bool,
}

impl WorkspaceConfig {
    pub(super) fn location(&self) -> VaultConfig {
        VaultConfig {
            bucket: self.bucket.clone(),
            region: self.region.clone(),
            prefix: self.prefix.clone(),
            endpoint: self.endpoint.clone(),
        }
    }
}

/// `config.json`: global preferences, the workspaces and the active one.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub(super) struct AppConfig {
    pub(super) version: u32,
    pub(super) auto_lock_minutes: u32,
    pub(super) theme: String,
    pub(super) accent: String,
    /// Pane sizes (`layout_set`); see `layout.rs`.
    pub(super) layout: PanelLayout,
    pub(super) active_workspace: Option<String>,
    pub(super) workspaces: Vec<WorkspaceConfig>,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            version: CONFIG_VERSION,
            auto_lock_minutes: 15,
            theme: "System".into(),
            accent: default_accent(),
            layout: PanelLayout::default(),
            active_workspace: None,
            workspaces: Vec::new(),
        }
    }
}

impl AppConfig {
    fn get(&self, id: &str) -> Option<&WorkspaceConfig> {
        self.workspaces.iter().find(|workspace| workspace.id == id)
    }

    fn active(&self) -> Option<&WorkspaceConfig> {
        self.get(self.active_workspace.as_deref()?)
    }

    /// The first workspace in list (name) order.
    fn first_by_name(&self) -> Option<String> {
        self.workspaces
            .iter()
            .min_by(|left, right| name_order(&left.name, &right.name))
            .map(|workspace| workspace.id.clone())
    }
}

/// Every shape `config.json` has had. Version 1 (no `version` field) held
/// one connection at the top level.
#[derive(Deserialize)]
struct RawConfig {
    #[serde(default)]
    version: u32,
    #[serde(default = "default_auto_lock")]
    auto_lock_minutes: u32,
    #[serde(default = "default_theme")]
    theme: String,
    #[serde(default = "default_accent")]
    accent: String,
    /// Read leniently by `layout::parse_layout`.
    #[serde(default)]
    layout: Option<serde_json::Value>,
    #[serde(default)]
    active_workspace: Option<String>,
    #[serde(default)]
    workspaces: Vec<WorkspaceConfig>,
    #[serde(default)]
    bucket: String,
    #[serde(default = "default_region")]
    region: String,
    #[serde(default)]
    prefix: String,
    #[serde(default)]
    endpoint: Option<String>,
    #[serde(default)]
    credentials_stored: bool,
    #[serde(default)]
    masked_access_key_id: Option<String>,
}

fn default_auto_lock() -> u32 {
    15
}
fn default_theme() -> String {
    "System".into()
}
fn default_region() -> String {
    VaultConfig::default().region
}

fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// Parses `config.json` of any version. Returns the config and whether it
/// differs from the file (migrated or repaired) and should be written back,
/// or `None` for a file this build cannot read. Pure; running it on its own
/// output changes nothing.
fn parse_config(bytes: &[u8]) -> Option<(AppConfig, bool)> {
    let raw: RawConfig = serde_json::from_slice(bytes).ok()?;
    if raw.version > CONFIG_VERSION {
        return None;
    }
    let (layout, layout_repaired) = layout::parse_layout(raw.layout.as_ref());
    let mut changed = raw.version != CONFIG_VERSION || layout_repaired;
    let mut app = AppConfig {
        version: CONFIG_VERSION,
        auto_lock_minutes: raw.auto_lock_minutes,
        theme: raw.theme,
        accent: raw.accent,
        layout,
        active_workspace: raw.active_workspace,
        workspaces: Vec::with_capacity(raw.workspaces.len()),
    };
    if validate_auto_lock(app.auto_lock_minutes).is_err() {
        app.auto_lock_minutes = default_auto_lock();
        changed = true;
    }
    if validate_theme(&app.theme).is_err() {
        app.theme = default_theme();
        changed = true;
    }
    if validate_accent(&app.accent).is_err() {
        app.accent = default_accent();
        changed = true;
    }
    // A workspace is addressed by its id; a hand-edited duplicate gets its own.
    let mut seen = HashSet::new();
    for mut workspace in raw.workspaces {
        if workspace.id.is_empty() || !seen.insert(workspace.id.clone()) {
            workspace.id = new_id();
            seen.insert(workspace.id.clone());
            changed = true;
        }
        app.workspaces.push(workspace);
    }
    if app.workspaces.is_empty() && !raw.bucket.trim().is_empty() {
        let legacy = VaultConfig {
            bucket: raw.bucket,
            region: raw.region,
            prefix: raw.prefix,
            endpoint: raw.endpoint,
        };
        let workspace = WorkspaceConfig {
            id: new_id(),
            name: default_name(&legacy.bucket),
            bucket: legacy.bucket.trim().to_owned(),
            region: legacy.region.trim().to_owned(),
            prefix: normalized_prefix(&legacy.prefix),
            endpoint: legacy
                .endpoint
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_owned),
            masked_access_key_id: raw.masked_access_key_id.filter(|_| raw.credentials_stored),
            // Derived exactly as the old build derived it from the same values.
            legacy_keychain_user: raw.credentials_stored.then(|| keychain_user(&legacy)),
            remember_declined: false,
        };
        app.active_workspace = Some(workspace.id.clone());
        app.workspaces.push(workspace);
        changed = true;
    }
    if app
        .active_workspace
        .as_deref()
        .is_some_and(|id| app.get(id).is_none())
    {
        app.active_workspace = None;
        changed = true;
    }
    if app.active_workspace.is_none() && !app.workspaces.is_empty() {
        app.active_workspace = app.first_by_name();
        changed = true;
    }
    Some((app, changed))
}

/// A file as read at launch.
pub(super) enum Loaded<T> {
    /// Its content, or the default when there is no file (or it was set
    /// aside because this build cannot parse it).
    Value(T),
    /// It exists but reading it failed (permissions, I/O, a sharing
    /// violation): the app runs without it and never replaces it this run,
    /// so the next launch reads it again.
    Unreadable,
}

/// The bytes of `path`; `None` when there is no such file.
fn read_file(path: &Path) -> Result<Option<Vec<u8>>, ()> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(()),
    }
}

/// Reads `config.json`. A file this build cannot parse is set aside (never
/// overwritten) and the app starts as on a fresh profile.
pub(super) fn read_config(path: &Path) -> Loaded<(AppConfig, bool)> {
    let bytes = match read_file(path) {
        Ok(Some(bytes)) => bytes,
        Ok(None) => return Loaded::Value((AppConfig::default(), false)),
        Err(()) => return Loaded::Unreadable,
    };
    match parse_config(&bytes) {
        Some(parsed) => Loaded::Value(parsed),
        None if set_aside(path) => Loaded::Value((AppConfig::default(), false)),
        None => Loaded::Unreadable,
    }
}

/// Reads `secrets.json`; a file this build cannot parse is set aside, never
/// overwritten.
pub(super) fn read_secrets(path: &Path) -> Loaded<SecretsFile> {
    let bytes = match read_file(path) {
        Ok(Some(bytes)) => bytes,
        Ok(None) => return Loaded::Value(SecretsFile::default()),
        Err(()) => return Loaded::Unreadable,
    };
    match SecretsFile::parse(&bytes) {
        Ok(file) => Loaded::Value(file),
        Err(_) if set_aside(path) => Loaded::Value(SecretsFile::default()),
        Err(_) => Loaded::Unreadable,
    }
}

/// Files `secrets.json` was set aside as. Their values are sealed with the
/// master key, so the key stays while any of them exists.
fn set_aside_secrets(secrets_path: &Path) -> bool {
    let Some(folder) = secrets_path.parent() else {
        return false;
    };
    let Ok(entries) = std::fs::read_dir(folder) else {
        // Unknown: keep the key.
        return true;
    };
    entries.flatten().any(|entry| {
        entry
            .file_name()
            .to_str()
            .is_some_and(|name| name.starts_with("secrets.unreadable-"))
    })
}

/// How [`lock_profile`] went.
pub(super) enum ProfileLock {
    /// This process owns the profile until it exits.
    Held(std::fs::File),
    /// Another process owns it.
    InUse,
    /// The lock file could not be created or locked (no such support).
    Unsupported,
}

/// Takes the profile's lock file (`notebook.lock` beside `config.json`). The
/// OS releases it when the process exits, also after a crash.
pub(super) fn lock_profile(config_dir: &Path) -> ProfileLock {
    if create_private_dir(config_dir).is_err() {
        return ProfileLock::Unsupported;
    }
    let file = match std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(config_dir.join("notebook.lock"))
    {
        Ok(file) => file,
        Err(_) => return ProfileLock::Unsupported,
    };
    match file.try_lock() {
        Ok(()) => ProfileLock::Held(file),
        Err(std::fs::TryLockError::WouldBlock) => ProfileLock::InUse,
        Err(std::fs::TryLockError::Error(_)) => ProfileLock::Unsupported,
    }
}

/// Renames `name.json` to `name.unreadable-<ms>.json` next to it; false when
/// that failed (the file then stays and is never replaced this run).
fn set_aside(path: &Path) -> bool {
    let stem = path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("file");
    std::fs::rename(
        path,
        path.with_file_name(format!("{stem}.unreadable-{}.json", now_ms())),
    )
    .is_ok()
}

/// Writes through a private temporary file and a rename, then syncs the
/// folder, so the file is either the old or the new one, and durable.
pub(super) fn write_durably(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| std::io::Error::other("no parent folder"))?;
    create_private_dir(parent)?;
    let temporary = path.with_extension("json.tmp");
    write_private_file(&temporary, bytes)?;
    std::fs::rename(&temporary, path)?;
    #[cfg(unix)]
    std::fs::File::open(parent)?.sync_all()?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Keychain

/// The OS keychain, behind a trait so tests never reach the real one.
pub(crate) trait Keychain: Send + Sync {
    /// `None` when there is no such entry.
    fn get(&self, service: &str, user: &str) -> Result<Option<Zeroizing<Vec<u8>>>, keyring::Error>;
    fn set(&self, service: &str, user: &str, secret: &[u8]) -> Result<(), keyring::Error>;
    /// Deleting a missing entry succeeds.
    fn delete(&self, service: &str, user: &str) -> Result<(), keyring::Error>;
}

pub(crate) struct OsKeychain;

impl OsKeychain {
    fn entry(service: &str, user: &str) -> Result<keyring::Entry, keyring::Error> {
        // Unit tests that reach this type use keyring's mock store.
        #[cfg(test)]
        {
            static MOCK: std::sync::Once = std::sync::Once::new();
            MOCK.call_once(|| {
                keyring::set_default_credential_builder(keyring::mock::default_credential_builder());
            });
        }
        keyring::Entry::new(service, user)
    }
}

/// Values are stored as bytes: `set_password` would store UTF-16 on Windows.
impl Keychain for OsKeychain {
    fn get(&self, service: &str, user: &str) -> Result<Option<Zeroizing<Vec<u8>>>, keyring::Error> {
        match Self::entry(service, user)?.get_secret() {
            Ok(secret) => Ok(Some(Zeroizing::new(secret))),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(error),
        }
    }

    fn set(&self, service: &str, user: &str, secret: &[u8]) -> Result<(), keyring::Error> {
        Self::entry(service, user)?.set_secret(secret)
    }

    fn delete(&self, service: &str, user: &str) -> Result<(), keyring::Error> {
        match Self::entry(service, user)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(error),
        }
    }
}

/// Keychain entries by (service, user).
type Entries = HashMap<(String, String), Zeroizing<Vec<u8>>>;

/// A keychain in memory, for tests and the S3 compatibility harness.
#[derive(Default)]
pub(crate) struct MemoryKeychain {
    entries: Mutex<Entries>,
    /// Every call fails as a locked or missing OS keychain would.
    unavailable: std::sync::atomic::AtomicBool,
}

impl MemoryKeychain {
    fn check(&self) -> Result<(), keyring::Error> {
        if self.unavailable.load(std::sync::atomic::Ordering::Relaxed) {
            return Err(keyring::Error::NoStorageAccess(Box::new(
                std::io::Error::other("keychain locked"),
            )));
        }
        Ok(())
    }

    fn entries(&self) -> Result<MutexGuard<'_, Entries>, keyring::Error> {
        self.check()?;
        self.entries
            .lock()
            .map_err(|_| keyring::Error::PlatformFailure(Box::new(std::io::Error::other("lock"))))
    }
}

impl Keychain for MemoryKeychain {
    fn get(&self, service: &str, user: &str) -> Result<Option<Zeroizing<Vec<u8>>>, keyring::Error> {
        Ok(self
            .entries()?
            .get(&(service.to_owned(), user.to_owned()))
            .cloned())
    }

    fn set(&self, service: &str, user: &str, secret: &[u8]) -> Result<(), keyring::Error> {
        self.entries()?.insert(
            (service.to_owned(), user.to_owned()),
            Zeroizing::new(secret.to_vec()),
        );
        Ok(())
    }

    fn delete(&self, service: &str, user: &str) -> Result<(), keyring::Error> {
        self.entries()?
            .remove(&(service.to_owned(), user.to_owned()));
        Ok(())
    }
}

/// The master key of `secrets.json`, with its lock held: while one change
/// seals a value with the key, no other change can delete it.
pub(super) struct MasterKey<'a> {
    slot: MutexGuard<'a, Option<Zeroizing<[u8; KEY_LEN]>>>,
    keychain: &'a dyn Keychain,
    /// `secrets.json` became empty: the key leaves the keychain when this
    /// guard drops, after the caller released `inner`.
    forget: bool,
}

impl MasterKey<'_> {
    /// The stored key, or `None` when the keychain has no usable one.
    fn existing(&mut self) -> Result<Option<Zeroizing<[u8; KEY_LEN]>>, IpcError> {
        if let Some(key) = self.slot.as_ref() {
            return Ok(Some(key.clone()));
        }
        let Some(bytes) = self
            .keychain
            .get(MASTER_SERVICE, MASTER_USER)
            .map_err(keychain_error)?
        else {
            return Ok(None);
        };
        let Ok(array) = <[u8; KEY_LEN]>::try_from(bytes.as_slice()) else {
            return Ok(None);
        };
        let key = Zeroizing::new(array);
        *self.slot = Some(key.clone());
        Ok(Some(key))
    }

    /// The stored key, or a new random one stored in the keychain. A keychain
    /// error is returned as is: a locked keychain never gets a new key.
    fn key(&mut self) -> Result<Zeroizing<[u8; KEY_LEN]>, IpcError> {
        if let Some(key) = self.existing()? {
            self.forget = false;
            return Ok(key);
        }
        let key = secrets::new_master_key().map_err(|_| IpcError::internal("RANDOM"))?;
        self.keychain
            .set(MASTER_SERVICE, MASTER_USER, key.as_slice())
            .map_err(keychain_error)?;
        *self.slot = Some(key.clone());
        self.forget = false;
        Ok(key)
    }
}

impl Drop for MasterKey<'_> {
    fn drop(&mut self) {
        if self.forget {
            *self.slot = None;
            let _ = self.keychain.delete(MASTER_SERVICE, MASTER_USER);
        }
    }
}

// ---------------------------------------------------------------------------
// State helpers

impl NotebookState {
    /// `inner` for the workspace commands: refused while another process
    /// holds the profile.
    pub(super) fn lock_inner(&self) -> Result<MutexGuard<'_, Inner>, IpcError> {
        if self.in_use {
            return Err(profile_in_use());
        }
        self.inner.lock().map_err(|_| IpcError::internal("STATE"))
    }

    /// The workspaces as the page may see them: refused while another process
    /// holds the profile or `config.json` could not be read.
    fn readable_inner(&self) -> Result<MutexGuard<'_, Inner>, IpcError> {
        if self.config_unreadable {
            return Err(config_unreadable());
        }
        if self.secrets_unreadable {
            return Err(secrets_unreadable());
        }
        self.lock_inner()
    }

    /// Take before `inner`, never while holding it. Refused while another
    /// process holds the profile, so it never creates or deletes the key.
    fn master(&self) -> Result<MasterKey<'_>, IpcError> {
        if self.in_use {
            return Err(profile_in_use());
        }
        Ok(MasterKey {
            slot: self
                .master
                .lock()
                .map_err(|_| IpcError::internal("STATE"))?,
            keychain: self.keychain.as_ref(),
            forget: false,
        })
    }

    /// Writes `secrets.json` durably; with nothing left in it, the file is
    /// deleted and the master key leaves the keychain when `master` drops,
    /// unless a set-aside copy of the file still needs it.
    fn write_secrets(
        &self,
        file: &SecretsFile,
        master: &mut MasterKey<'_>,
    ) -> Result<(), IpcError> {
        if self.secrets_unreadable {
            return Err(secrets_unreadable());
        }
        if file.is_empty() {
            match std::fs::remove_file(&self.secrets_path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => return Err(IpcError::internal("SECRETS_WRITE")),
            }
            master.forget = !set_aside_secrets(&self.secrets_path);
            return Ok(());
        }
        write_durably(&self.secrets_path, &file.to_bytes())
            .map_err(|_| IpcError::internal("SECRETS_WRITE"))
    }
}

impl Inner {
    pub(super) fn active_id(&self) -> Option<&str> {
        self.app.active_workspace.as_deref()
    }

    pub(super) fn active_config(&self) -> Option<VaultConfig> {
        self.app.active().map(WorkspaceConfig::location)
    }

    /// The active workspace's phrase is stored on this device.
    pub(super) fn phrase_remembered(&self) -> bool {
        self.active_id()
            .is_some_and(|id| self.secrets.has(id, Field::Phrase))
    }

    fn summary(&self, workspace: &WorkspaceConfig) -> WorkspaceSummary {
        WorkspaceSummary {
            id: workspace.id.clone(),
            name: workspace.name.clone(),
            bucket: workspace.bucket.clone(),
            region: workspace.region.clone(),
            prefix: workspace.prefix.clone(),
            endpoint: workspace.endpoint.clone(),
            credentials_stored: self.secrets.has(&workspace.id, Field::S3)
                || workspace.legacy_keychain_user.is_some(),
            phrase_stored: self.secrets.has(&workspace.id, Field::Phrase),
            remember_declined: workspace.remember_declined,
            masked_access_key_id: workspace.masked_access_key_id.clone(),
        }
    }

    pub(super) fn list(&self) -> WorkspaceList {
        let mut workspaces = self
            .app
            .workspaces
            .iter()
            .map(|workspace| self.summary(workspace))
            .collect::<Vec<_>>();
        workspaces.sort_by(|left, right| {
            name_order(&left.name, &right.name).then_with(|| left.id.cmp(&right.id))
        });
        WorkspaceList {
            workspaces,
            active: self.app.active_workspace.clone(),
        }
    }
}

// ---------------------------------------------------------------------------
// Errors

pub(super) fn profile_in_use() -> IpcError {
    IpcError::new(
        "PROFILE_IN_USE",
        "Notebook is already open on this device. Switch to that window, or quit it and open Notebook again.",
    )
}

pub(super) fn config_unreadable() -> IpcError {
    IpcError::new(
        "CONFIG_UNREADABLE",
        "Notebook could not read its settings on this device. Nothing was changed; quit Notebook and open it again.",
    )
}

fn secrets_unreadable() -> IpcError {
    IpcError::new(
        "SECRETS_UNREADABLE",
        "Notebook could not read the stored workspace secrets on this device. Nothing was changed; quit Notebook and open it again.",
    )
}

fn no_workspace() -> IpcError {
    IpcError::new("NO_WORKSPACE", "Set up a workspace first.")
}

pub(super) fn workspace_changed() -> IpcError {
    IpcError::new(
        "WORKSPACE_CHANGED",
        "The workspace was switched or edited meanwhile. Try again.",
    )
}

fn missing_workspace() -> IpcError {
    IpcError::invalid("This workspace no longer exists.")
}

fn no_stored_credentials() -> IpcError {
    IpcError::no_credentials(
        "S3 credentials are not stored for this workspace. Edit the workspace to enter them.",
    )
}

fn unreadable_credentials() -> IpcError {
    IpcError::no_credentials(
        "The stored S3 credentials cannot be read on this device. Enter them again.",
    )
}

fn no_stored_phrase() -> IpcError {
    IpcError::new(
        "NO_STORED_PHRASE",
        "No encryption phrase is remembered for this workspace.",
    )
}

fn unreadable_phrase() -> IpcError {
    IpcError::new(
        "NO_STORED_PHRASE",
        "The remembered encryption phrase cannot be read on this device. Enter it again.",
    )
}

fn seal_error(error: SecretsError) -> IpcError {
    match error {
        SecretsError::Random => IpcError::internal("RANDOM"),
        SecretsError::Format | SecretsError::Open => IpcError::internal("SECRETS_WRITE"),
    }
}

// ---------------------------------------------------------------------------
// Secrets of the active workspace

enum Opened {
    Missing,
    Value(Zeroizing<Vec<u8>>),
    Unreadable,
}

fn open_secret(state: &NotebookState, id: &str, field: Field) -> Result<Opened, IpcError> {
    let mut master = state.master()?;
    if !state.lock_inner()?.secrets.has(id, field) {
        return Ok(Opened::Missing);
    }
    // A missing master key is reported as unreadable values, never replaced
    // here: values sealed under it could not be opened with a new one either.
    let Some(key) = master.existing()? else {
        return Ok(Opened::Unreadable);
    };
    Ok(match state.lock_inner()?.secrets.open(&key, id, field) {
        Ok(Some(value)) => Opened::Value(value),
        Ok(None) => Opened::Missing,
        Err(_) => Opened::Unreadable,
    })
}

/// The id, location and S3 credentials of the active workspace. Credentials
/// stored by a build before workspaces move into `secrets.json` here.
pub(super) fn active_credentials(
    state: &NotebookState,
) -> Result<(String, VaultConfig, StoredCredentials), IpcError> {
    let (id, config, legacy) = {
        let inner = state.lock_inner()?;
        let workspace = inner.app.active().ok_or_else(no_workspace)?;
        if let Some((cached, credentials)) = &inner.credentials
            && *cached == workspace.id
        {
            return Ok((
                workspace.id.clone(),
                workspace.location(),
                credentials.clone(),
            ));
        }
        let stored = inner.secrets.has(&workspace.id, Field::S3);
        if !stored && workspace.legacy_keychain_user.is_none() {
            return Err(no_stored_credentials());
        }
        // Also with credentials in secrets.json: an old entry whose delete
        // failed (or was interrupted) is deleted on a later use.
        (
            workspace.id.clone(),
            workspace.location(),
            workspace.legacy_keychain_user.as_ref().map(|_| stored),
        )
    };
    if let Some(stored) = legacy {
        let moved = migrate_legacy_credentials(state, &id);
        // With the credentials already in secrets.json, removing the old
        // entry is best effort: a keychain that refuses it (a locked item, a
        // denied prompt) never keeps the workspace closed.
        if !stored {
            moved?;
        }
    }
    let credentials = match open_secret(state, &id, Field::S3)? {
        Opened::Value(bytes) => serde_json::from_slice::<StoredCredentials>(&bytes)
            .map_err(|_| unreadable_credentials())?,
        Opened::Missing => return Err(no_stored_credentials()),
        Opened::Unreadable => return Err(unreadable_credentials()),
    };
    let mut inner = state.lock_inner()?;
    if inner.active_id() != Some(id.as_str()) || inner.active_config().as_ref() != Some(&config) {
        return Err(workspace_changed());
    }
    inner.credentials = Some((id.clone(), credentials.clone()));
    Ok((id, config, credentials))
}

/// Moves the S3 credentials a build before workspaces kept in a keychain
/// entry of their own into `secrets.json`. Idempotent: every step can be
/// interrupted and the next call carries on.
fn migrate_legacy_credentials(state: &NotebookState, id: &str) -> Result<(), IpcError> {
    let mut master = state.master()?;
    let Some(user) = state
        .lock_inner()?
        .app
        .get(id)
        .and_then(|workspace| workspace.legacy_keychain_user.clone())
    else {
        return Ok(());
    };
    let legacy = state
        .keychain
        .get(KEYCHAIN_SERVICE, &user)
        .map_err(keychain_error)?;
    // An entry that does not parse is left in place: nothing is deleted
    // that was not copied.
    let credentials = legacy
        .as_deref()
        .and_then(|bytes| serde_json::from_slice::<StoredCredentials>(bytes).ok());
    if let Some(credentials) = &credentials {
        // With a value already filed, a missing master key is never replaced
        // here (the value may come back with the keychain): the old entry
        // stays until the user enters the credentials again.
        let key = if state.lock_inner()?.secrets.has(id, Field::S3) {
            match master.existing()? {
                Some(key) => key,
                None => return Ok(()),
            }
        } else {
            master.key()?
        };
        let mut inner = state.lock_inner()?;
        if inner.app.get(id).is_none() {
            return Ok(());
        }
        // The id the value is filed under must be on disk before it moves.
        state.save_config(&inner.app)?;
        // The old entry is deleted only once secrets.json holds a copy that
        // opens with the current key.
        if !matches!(inner.secrets.open(&key, id, Field::S3), Ok(Some(_))) {
            let plain = Zeroizing::new(
                serde_json::to_vec(credentials).map_err(|_| IpcError::internal("SECRETS_WRITE"))?,
            );
            let mut secrets = inner.secrets.clone();
            secrets
                .seal(&key, id, Field::S3, &plain)
                .map_err(seal_error)?;
            state.write_secrets(&secrets, &mut master)?;
            inner.secrets = secrets;
        }
        drop(inner);
        // Only now that secrets.json is durable does the old entry go. If
        // that fails, the marker stays and the next use tries again.
        if state.keychain.delete(KEYCHAIN_SERVICE, &user).is_err() {
            return Ok(());
        }
    }
    let mut inner = state.lock_inner()?;
    let mut app = inner.app.clone();
    let Some(workspace) = app
        .workspaces
        .iter_mut()
        .find(|workspace| workspace.id == id)
    else {
        return Ok(());
    };
    workspace.legacy_keychain_user = None;
    if let Some(credentials) = &credentials
        && workspace.masked_access_key_id.is_none()
    {
        workspace.masked_access_key_id = Some(masked_access_key_id(&credentials.access_key_id));
    }
    state.save_config(&app)?;
    inner.app = app;
    Ok(())
}

/// The remembered phrase of a workspace.
pub(super) fn stored_phrase(
    state: &NotebookState,
    id: &str,
) -> Result<Zeroizing<String>, IpcError> {
    match open_secret(state, id, Field::Phrase)? {
        Opened::Value(bytes) => std::str::from_utf8(&bytes)
            .map(|text| Zeroizing::new(text.to_owned()))
            .map_err(|_| unreadable_phrase()),
        Opened::Missing => Err(no_stored_phrase()),
        Opened::Unreadable => Err(unreadable_phrase()),
    }
}

pub(super) fn phrase_is_remembered(state: &NotebookState, id: &str) -> Result<bool, IpcError> {
    Ok(state.lock_inner()?.secrets.has(id, Field::Phrase))
}

/// Stores (`Some`) or forgets (`None`) the phrase of a workspace, and
/// records the choice for the unlock screen. `expected` is the location the
/// phrase was proven for: a workspace moved meanwhile is `WORKSPACE_CHANGED`.
pub(super) fn remember_phrase(
    state: &NotebookState,
    id: &str,
    expected: &VaultConfig,
    phrase: Option<&str>,
) -> Result<(), IpcError> {
    let mut master = state.master()?;
    let key = match phrase {
        Some(_) => Some(master.key()?),
        None => None,
    };
    let mut inner = state.lock_inner()?;
    if inner.app.get(id).map(WorkspaceConfig::location).as_ref() != Some(expected) {
        return Err(workspace_changed());
    }
    let mut secrets = inner.secrets.clone();
    let changed = match (phrase, key) {
        (Some(phrase), Some(key)) => {
            secrets
                .seal(&key, id, Field::Phrase, phrase.as_bytes())
                .map_err(seal_error)?;
            true
        }
        _ if secrets.has(id, Field::Phrase) => {
            secrets.remove(id, Field::Phrase);
            true
        }
        _ => false,
    };
    if changed {
        state.write_secrets(&secrets, &mut master)?;
        inner.secrets = secrets;
    }
    let declined = phrase.is_none();
    if inner
        .app
        .get(id)
        .is_some_and(|workspace| workspace.remember_declined != declined)
    {
        let mut app = inner.app.clone();
        if let Some(workspace) = app.workspaces.iter_mut().find(|slot| slot.id == id) {
            workspace.remember_declined = declined;
        }
        state.save_config(&app)?;
        inner.app = app;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Validation

fn name_order(left: &str, right: &str) -> std::cmp::Ordering {
    left.to_lowercase()
        .cmp(&right.to_lowercase())
        .then_with(|| left.cmp(right))
}

fn same_name(left: &str, right: &str) -> bool {
    left.to_lowercase() == right.to_lowercase()
}

fn validate_workspace_name(name: &str) -> Result<String, IpcError> {
    let name = name.trim();
    let count = name.chars().count();
    if count == 0 || count > MAX_NAME_CHARS {
        return Err(IpcError::invalid(
            "Enter a workspace name of 1 to 64 characters.",
        ));
    }
    if name.chars().any(char::is_control) {
        return Err(IpcError::invalid(
            "The workspace name cannot contain control characters.",
        ));
    }
    Ok(name.to_owned())
}

/// The name a workspace gets from its bucket (at most 64 characters).
fn default_name(bucket: &str) -> String {
    let name = bucket
        .trim()
        .chars()
        .filter(|character| !character.is_control())
        .take(MAX_NAME_CHARS)
        .collect::<String>();
    if name.trim().is_empty() {
        DEFAULT_NAME.into()
    } else {
        name.trim().to_owned()
    }
}

/// `base`, or `base 2`, `base 3`… when another workspace has that name.
fn unique_name(base: &str, app: &AppConfig) -> String {
    let taken = |name: &str| {
        app.workspaces
            .iter()
            .any(|workspace| same_name(&workspace.name, name))
    };
    if !taken(base) {
        return base.to_owned();
    }
    (2..)
        .map(|number| {
            let suffix = format!(" {number}");
            let room = MAX_NAME_CHARS - suffix.chars().count();
            let stem = base.chars().take(room).collect::<String>();
            format!("{}{suffix}", stem.trim_end())
        })
        .find(|name| !taken(name))
        .unwrap_or_else(|| DEFAULT_NAME.into())
}

/// A validated, normalised S3 location: the same rules the S3 client applies.
fn validate_location(
    bucket: &str,
    region: &str,
    prefix: &str,
    endpoint: Option<&str>,
) -> Result<VaultConfig, IpcError> {
    let bucket = bucket.trim();
    let region = region.trim();
    if bucket.is_empty()
        || bucket.len() > 255
        || bucket
            .chars()
            .any(|character| character.is_control() || character.is_whitespace())
    {
        return Err(IpcError::invalid("A valid bucket name is required."));
    }
    if region.is_empty()
        || region.len() > 64
        || !region
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "-_.".contains(character))
    {
        return Err(IpcError::invalid("A valid AWS region is required."));
    }
    if prefix.len() > 1_024 || prefix.chars().any(char::is_control) {
        return Err(IpcError::invalid(
            "The S3 prefix is too long or contains control characters.",
        ));
    }
    let config = VaultConfig {
        bucket: bucket.to_owned(),
        region: region.to_owned(),
        prefix: normalized_prefix(prefix),
        endpoint: endpoint
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned),
    };
    s3_bucket(&config)?;
    Ok(config)
}

fn validate_credentials(credentials: &StoredCredentials) -> Result<StoredCredentials, IpcError> {
    let access_key_id = credentials.access_key_id.trim();
    if access_key_id.is_empty() || credentials.secret_access_key.is_empty() {
        return Err(IpcError::invalid("Both S3 access-key fields are required."));
    }
    validate_access_key_id(access_key_id)?;
    let session_token = credentials
        .session_token
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if access_key_id.len() > MAX_ACCESS_KEY_BYTES
        || credentials.secret_access_key.len() > MAX_SECRET_KEY_BYTES
        || session_token.is_some_and(|token| token.len() > MAX_SESSION_TOKEN_BYTES)
    {
        return Err(IpcError::invalid("These S3 credentials are too long."));
    }
    Ok(StoredCredentials {
        access_key_id: access_key_id.to_owned(),
        secret_access_key: credentials.secret_access_key.clone(),
        session_token: session_token.map(str::to_owned),
    })
}

fn validate_phrase(phrase: &str) -> Result<(), IpcError> {
    if phrase.is_empty() {
        return Err(IpcError::invalid("The encryption phrase cannot be empty."));
    }
    if phrase.len() > MAX_PHRASE_BYTES {
        return Err(IpcError::invalid("The encryption phrase is too long."));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Commands

/// A workspace as the frontend sees it. Secrets are reported only as stored
/// or not.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct WorkspaceSummary {
    pub id: String,
    pub name: String,
    pub bucket: String,
    pub region: String,
    pub prefix: String,
    pub endpoint: Option<String>,
    pub credentials_stored: bool,
    pub phrase_stored: bool,
    /// Remember was last unchecked for this workspace.
    pub remember_declined: bool,
    pub masked_access_key_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct WorkspaceList {
    /// In name order.
    pub workspaces: Vec<WorkspaceSummary>,
    pub active: Option<String>,
}

/// `workspace_save`: without `id` a workspace is created. An absent secret
/// keeps what is stored; `remember_phrase: false` forgets the stored phrase
/// (and ignores `phrase`).
#[derive(Deserialize)]
pub struct WorkspaceInput {
    #[serde(default)]
    id: Option<String>,
    name: String,
    bucket: String,
    region: String,
    #[serde(default)]
    prefix: String,
    #[serde(default)]
    endpoint: Option<String>,
    #[serde(default)]
    credentials: Option<StoredCredentials>,
    #[serde(default)]
    phrase: Option<Zeroizing<String>>,
    #[serde(default)]
    remember_phrase: Option<bool>,
    /// Save a new location although edits queued at the old one are not
    /// uploaded yet (they stay on this device, see `OUTBOX_PENDING`).
    #[serde(default)]
    leave_pending: Option<bool>,
}

impl std::fmt::Debug for WorkspaceInput {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WorkspaceInput")
            .field("id", &self.id)
            .field(
                "credentials",
                &self.credentials.as_ref().map(|_| "<redacted>"),
            )
            .field("phrase", &self.phrase.as_ref().map(|_| "<redacted>"))
            .field("remember_phrase", &self.remember_phrase)
            .field("leave_pending", &self.leave_pending)
            .finish_non_exhaustive()
    }
}

/// The non-secret configuration of the active workspace plus the global
/// preferences, in the shape the frontend read before workspaces existed.
#[derive(Debug, Serialize)]
pub struct ConfigView {
    workspace_id: Option<String>,
    workspace_name: Option<String>,
    bucket: String,
    region: String,
    prefix: String,
    endpoint: Option<String>,
    auto_lock_minutes: u32,
    theme: String,
    accent: String,
    layout: PanelLayout,
    credentials_stored: bool,
    phrase_stored: bool,
    masked_access_key_id: Option<String>,
}

pub(super) fn config_view(inner: &Inner) -> ConfigView {
    let active = inner.app.active().map(|workspace| inner.summary(workspace));
    let location = inner.active_config().unwrap_or_default();
    ConfigView {
        workspace_id: active.as_ref().map(|summary| summary.id.clone()),
        workspace_name: active.as_ref().map(|summary| summary.name.clone()),
        bucket: location.bucket,
        region: location.region,
        prefix: location.prefix,
        endpoint: location.endpoint,
        auto_lock_minutes: inner.app.auto_lock_minutes,
        theme: inner.app.theme.clone(),
        accent: inner.app.accent.clone(),
        layout: inner.app.layout,
        credentials_stored: active
            .as_ref()
            .is_some_and(|summary| summary.credentials_stored),
        phrase_stored: active.as_ref().is_some_and(|summary| summary.phrase_stored),
        masked_access_key_id: active.and_then(|summary| summary.masked_access_key_id),
    }
}

#[tauri::command]
pub fn config_get(state: State<'_, NotebookState>) -> Result<ConfigView, IpcError> {
    Ok(config_view(&*state.readable_inner()?))
}

#[tauri::command]
pub fn workspaces_list(state: State<'_, NotebookState>) -> Result<WorkspaceList, IpcError> {
    Ok(state.readable_inner()?.list())
}

#[tauri::command]
pub async fn workspace_save(
    state: State<'_, NotebookState>,
    workspace: WorkspaceInput,
) -> Result<WorkspaceSummary, IpcError> {
    save_workspace(&state, workspace)
}

/// `leave_pending`: delete although edits queued for its location are not
/// uploaded yet (they stay on this device); otherwise `OUTBOX_PENDING`.
#[tauri::command]
pub async fn workspace_delete(
    state: State<'_, NotebookState>,
    id: String,
    leave_pending: Option<bool>,
) -> Result<WorkspaceList, IpcError> {
    delete_workspace(&state, &id, leave_pending.unwrap_or(false))
}

/// Ends the current session (the frontend flushes first) and makes `id` the
/// active workspace. Selecting the active workspace changes nothing.
#[tauri::command]
pub async fn workspace_select(
    state: State<'_, NotebookState>,
    id: String,
) -> Result<WorkspaceSummary, IpcError> {
    select_workspace(&state, &id)
}

/// Seals S3 credentials for the active workspace (tests of the validation).
#[cfg(test)]
pub(super) fn store_credentials(
    state: &NotebookState,
    credentials: StoredCredentials,
) -> Result<(), IpcError> {
    let workspace = state
        .lock_inner()?
        .app
        .active()
        .cloned()
        .ok_or_else(no_workspace)?;
    save_workspace(
        state,
        WorkspaceInput {
            id: Some(workspace.id),
            name: workspace.name,
            bucket: workspace.bucket,
            region: workspace.region,
            prefix: workspace.prefix,
            endpoint: workspace.endpoint,
            credentials: Some(credentials),
            phrase: None,
            remember_phrase: None,
            leave_pending: None,
        },
    )
    .map(drop)
}

/// Creates or edits a workspace. Everything is validated before anything is
/// written; `secrets.json` is written before `config.json`. Editing the
/// location (bucket, region, prefix or endpoint) of the active workspace ends
/// its session; new credentials of the unlocked workspace take effect at once.
fn save_workspace(
    state: &NotebookState,
    input: WorkspaceInput,
) -> Result<WorkspaceSummary, IpcError> {
    let name = validate_workspace_name(&input.name)?;
    let location = validate_location(
        &input.bucket,
        &input.region,
        &input.prefix,
        input.endpoint.as_deref(),
    )?;
    let credentials = input
        .credentials
        .as_ref()
        .map(validate_credentials)
        .transpose()?;
    let forget_phrase = input.remember_phrase == Some(false);
    let phrase = input.phrase.filter(|_| !forget_phrase);
    if let Some(phrase) = &phrase {
        validate_phrase(phrase)?;
    }

    let mut master = state.master()?;
    // Checked before the keychain is touched (a first secret creates the
    // master key), and again once `inner` is held for good.
    target(&state.lock_inner()?.app, input.id.as_deref(), &name)?;
    let key = if credentials.is_some() || phrase.is_some() {
        Some(master.key()?)
    } else {
        None
    };
    let mut inner = state.lock_inner()?;
    let existing = target(&inner.app, input.id.as_deref(), &name)?;
    let id = existing
        .as_ref()
        .map_or_else(new_id, |workspace| workspace.id.clone());
    let is_active = inner.active_id() == Some(id.as_str());
    let moved = existing
        .as_ref()
        .is_some_and(|workspace| workspace.location() != location);
    let end_session = is_active && moved && inner.session.is_some();
    // Queued edits are filed by location: moving to another bucket or prefix
    // would leave them behind, unless the user said so; a new endpoint for the
    // same bucket and prefix takes them along.
    let mut carry = None;
    if let Some(existing) = &existing {
        let before = existing.location();
        if stranded_edits(state, &inner.app, &id, &before, Some(&location)) {
            let same_objects = before.bucket == location.bucket && before.prefix == location.prefix;
            if same_objects && pending_files(state, &location).is_empty() {
                carry = Some(before);
            } else if input.leave_pending != Some(true) {
                return Err(outbox_pending());
            }
        }
    }
    // The unlocked session switches to a client signing with the new keys.
    let new_remote = match &credentials {
        Some(credentials) if is_active && !end_session && inner.session.is_some() => {
            Some(Arc::new(S3Remote::new(&location, credentials)?))
        }
        _ => None,
    };

    let mut secrets = inner.secrets.clone();
    let mut secrets_changed = false;
    if let (Some(credentials), Some(key)) = (&credentials, &key) {
        let plain = Zeroizing::new(
            serde_json::to_vec(credentials).map_err(|_| IpcError::internal("SECRETS_WRITE"))?,
        );
        secrets
            .seal(key, &id, Field::S3, &plain)
            .map_err(seal_error)?;
        secrets_changed = true;
    }
    if let (Some(phrase), Some(key)) = (&phrase, &key) {
        secrets
            .seal(key, &id, Field::Phrase, phrase.as_bytes())
            .map_err(seal_error)?;
        secrets_changed = true;
    }
    if forget_phrase && secrets.has(&id, Field::Phrase) {
        secrets.remove(&id, Field::Phrase);
        secrets_changed = true;
    }

    let mut workspace = existing.clone().unwrap_or_else(|| WorkspaceConfig {
        id: id.clone(),
        name: String::new(),
        bucket: String::new(),
        region: String::new(),
        prefix: String::new(),
        endpoint: None,
        masked_access_key_id: None,
        legacy_keychain_user: None,
        remember_declined: false,
    });
    workspace.name = name;
    if let Some(remember) = input.remember_phrase {
        workspace.remember_declined = !remember;
    }
    workspace.bucket = location.bucket.clone();
    workspace.region = location.region.clone();
    workspace.prefix = location.prefix.clone();
    workspace.endpoint = location.endpoint.clone();
    // New credentials replace those a build before workspaces stored.
    let mut legacy_user = None;
    if let Some(credentials) = &credentials {
        workspace.masked_access_key_id = Some(masked_access_key_id(&credentials.access_key_id));
        legacy_user = workspace.legacy_keychain_user.take();
    }
    let mut app = inner.app.clone();
    match app.workspaces.iter_mut().find(|slot| slot.id == id) {
        Some(slot) => *slot = workspace.clone(),
        None => app.workspaces.push(workspace.clone()),
    }
    if app.active_workspace.is_none() {
        app.active_workspace = Some(id.clone());
    }

    if secrets_changed {
        state.write_secrets(&secrets, &mut master)?;
        inner.secrets = secrets;
    }
    if let Err(error) = state.save_config(&app) {
        // A workspace that was not created leaves no sealed values behind.
        if existing.is_none() && secrets_changed {
            let mut cleaned = inner.secrets.clone();
            cleaned.remove_workspace(&id);
            if state.write_secrets(&cleaned, &mut master).is_ok() {
                inner.secrets = cleaned;
            }
        }
        return Err(error);
    }
    inner.app = app;
    if let Some(credentials) = credentials {
        inner.credentials = if is_active {
            Some((id.clone(), credentials))
        } else {
            inner.credentials.take().filter(|(cached, _)| *cached != id)
        };
    }
    if let (Some(remote), Some(session)) = (new_remote, inner.session.as_mut()) {
        session.remote = remote;
    }
    if end_session {
        inner.session = None;
        inner.idle_notified = false;
    }
    let summary = inner.summary(&workspace);
    drop(inner);
    if end_session {
        // After this no write of the ended session reaches its outbox.
        state.forget_journal();
    }
    if let Some(before) = carry {
        carry_outbox(state, &before, &location);
    }
    if let Some(user) = legacy_user
        && state.keychain.delete(KEYCHAIN_SERVICE, &user).is_err()
    {
        // The old entry stays on record, so a later use deletes it.
        keep_legacy_marker(state, &id, user);
    }
    Ok(summary)
}

/// Records `user` again as the old keychain entry of workspace `id`.
fn keep_legacy_marker(state: &NotebookState, id: &str, user: String) {
    let Ok(mut inner) = state.lock_inner() else {
        return;
    };
    let mut app = inner.app.clone();
    let Some(workspace) = app
        .workspaces
        .iter_mut()
        .find(|workspace| workspace.id == id && workspace.legacy_keychain_user.is_none())
    else {
        return;
    };
    workspace.legacy_keychain_user = Some(user);
    if state.save_config(&app).is_ok() {
        inner.app = app;
    }
}

fn outbox_pending() -> IpcError {
    IpcError::new(
        "OUTBOX_PENDING",
        "Some edits of this workspace are saved on this device but not uploaded yet.",
    )
}

/// Whether edits queued at `before` would be left where no workspace reads
/// them once workspace `id` is at `after` (`None`: deleted).
fn stranded_edits(
    state: &NotebookState,
    app: &AppConfig,
    id: &str,
    before: &VaultConfig,
    after: Option<&VaultConfig>,
) -> bool {
    let folder = vault_outbox_dir(state, before);
    after.is_none_or(|after| folder != vault_outbox_dir(state, after))
        && !app.workspaces.iter().any(|workspace| {
            workspace.id != id && vault_outbox_dir(state, &workspace.location()) == folder
        })
        && !pending_files(state, before).is_empty()
}

/// The workspace `id` names (`None`: a new one), when `name` is free for it.
fn target(
    app: &AppConfig,
    id: Option<&str>,
    name: &str,
) -> Result<Option<WorkspaceConfig>, IpcError> {
    let existing = match id {
        Some(id) => Some(app.get(id).cloned().ok_or_else(missing_workspace)?),
        None => None,
    };
    if app
        .workspaces
        .iter()
        .any(|workspace| Some(workspace.id.as_str()) != id && same_name(&workspace.name, name))
    {
        return Err(IpcError::invalid(
            "Another workspace already uses this name.",
        ));
    }
    Ok(existing)
}

pub(super) fn select_workspace(
    state: &NotebookState,
    id: &str,
) -> Result<WorkspaceSummary, IpcError> {
    let mut inner = state.lock_inner()?;
    let workspace = inner.app.get(id).cloned().ok_or_else(missing_workspace)?;
    if inner.active_id() == Some(id) {
        return Ok(inner.summary(&workspace));
    }
    let mut app = inner.app.clone();
    app.active_workspace = Some(id.to_owned());
    state.save_config(&app)?;
    inner.app = app;
    inner.session = None;
    inner.idle_notified = false;
    inner.credentials = None;
    let summary = inner.summary(&workspace);
    drop(inner);
    // Staged edits stay in this workspace's outbox for its next unlock.
    state.forget_journal();
    Ok(summary)
}

/// Removes a workspace and its sealed secrets. Its S3 objects and queued
/// outbox files stay where they are: with edits queued that no other
/// workspace would upload, only when `leave_pending` says so.
fn delete_workspace(
    state: &NotebookState,
    id: &str,
    leave_pending: bool,
) -> Result<WorkspaceList, IpcError> {
    // Checked before the keychain is touched, and again once `inner` is held.
    let legacy_user = deletable(state, &*state.lock_inner()?, id, leave_pending)?;
    // An old keychain entry goes first: if the keychain refuses, nothing is
    // deleted and the user can try again, so no secret is left untracked.
    if let Some(user) = &legacy_user {
        state
            .keychain
            .delete(KEYCHAIN_SERVICE, user)
            .map_err(keychain_error)?;
    }
    let mut master = state.master()?;
    let mut inner = state.lock_inner()?;
    deletable(state, &inner, id, leave_pending)?;
    let index = inner
        .app
        .workspaces
        .iter()
        .position(|workspace| workspace.id == id)
        .ok_or_else(missing_workspace)?;
    let active = inner.active_id() == Some(id);
    if inner.secrets.has(id, Field::S3) || inner.secrets.has(id, Field::Phrase) {
        let mut secrets = inner.secrets.clone();
        secrets.remove_workspace(id);
        state.write_secrets(&secrets, &mut master)?;
        inner.secrets = secrets;
    }
    let mut app = inner.app.clone();
    app.workspaces.remove(index);
    if active {
        app.active_workspace = app.first_by_name();
    }
    state.save_config(&app)?;
    inner.app = app;
    if inner
        .credentials
        .as_ref()
        .is_some_and(|(cached, _)| cached == id)
    {
        inner.credentials = None;
    }
    Ok(inner.list())
}

/// Workspace `id` may be deleted now; returns its old keychain account.
fn deletable(
    state: &NotebookState,
    inner: &Inner,
    id: &str,
    leave_pending: bool,
) -> Result<Option<String>, IpcError> {
    let workspace = inner.app.get(id).ok_or_else(missing_workspace)?;
    if inner.active_id() == Some(id) && inner.session.is_some() {
        return Err(IpcError::new(
            "WORKSPACE_UNLOCKED",
            "Lock this workspace or switch to another one before deleting it.",
        ));
    }
    if !leave_pending && stranded_edits(state, &inner.app, id, &workspace.location(), None) {
        return Err(outbox_pending());
    }
    Ok(workspace.legacy_keychain_user.clone())
}

/// Adds an active workspace without secrets (the S3 compatibility harness).
pub(super) fn add_test_workspace(app: &mut AppConfig, location: VaultConfig) -> String {
    let id = new_id();
    app.workspaces.push(WorkspaceConfig {
        id: id.clone(),
        name: unique_name(&default_name(&location.bucket), app),
        bucket: location.bucket,
        region: location.region,
        prefix: location.prefix,
        endpoint: location.endpoint,
        masked_access_key_id: None,
        legacy_keychain_user: None,
        remember_declined: false,
    });
    app.active_workspace = Some(id.clone());
    id
}

#[cfg(test)]
impl MemoryKeychain {
    fn contains(&self, service: &str, user: &str) -> bool {
        self.entries
            .lock()
            .unwrap()
            .contains_key(&(service.to_owned(), user.to_owned()))
    }

    fn set_unavailable(&self, unavailable: bool) {
        self.unavailable
            .store(unavailable, std::sync::atomic::Ordering::Relaxed);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read as _;

    const LEGACY: &str = r#"{"vault_id":null,"bucket":"legacy-bucket","region":"eu-west-1","prefix":"notes","endpoint":null,"auto_lock_minutes":5,"theme":"Dark","credentials_stored":true,"masked_access_key_id":"••••MPLE","versioning_enabled":false}"#;

    fn state_in(directory: &Path, keychain: &Arc<MemoryKeychain>) -> NotebookState {
        NotebookState::load_with(
            directory.join("config"),
            directory.join("local"),
            keychain.clone(),
        )
    }

    fn fresh() -> (tempfile::TempDir, NotebookState, Arc<MemoryKeychain>) {
        let directory = tempfile::tempdir().unwrap();
        let keychain = Arc::new(MemoryKeychain::default());
        let state = state_in(directory.path(), &keychain);
        (directory, state, keychain)
    }

    fn input(name: &str, bucket: &str) -> WorkspaceInput {
        WorkspaceInput {
            id: None,
            name: name.into(),
            bucket: bucket.into(),
            region: "eu-central-1".into(),
            prefix: String::new(),
            endpoint: None,
            credentials: None,
            phrase: None,
            remember_phrase: None,
            leave_pending: None,
        }
    }

    fn edit(id: &str, name: &str, bucket: &str) -> WorkspaceInput {
        WorkspaceInput {
            id: Some(id.into()),
            ..input(name, bucket)
        }
    }

    fn credentials(access: &str) -> StoredCredentials {
        StoredCredentials {
            access_key_id: access.into(),
            secret_access_key: format!("secret-of-{access}"),
            session_token: None,
        }
    }

    fn phrase(text: &str) -> Option<Zeroizing<String>> {
        Some(Zeroizing::new(text.into()))
    }

    fn legacy_location() -> VaultConfig {
        VaultConfig {
            bucket: "legacy-bucket".into(),
            prefix: "notes".into(),
            ..VaultConfig::default()
        }
    }

    /// An unlocked session of the active workspace, built without S3.
    fn unlock_in_memory(state: &NotebookState) {
        let config = state.lock_inner().unwrap().active_config().unwrap();
        let codec = NotebookV1Codec::new(SecretString::from("correct horse".to_owned())).unwrap();
        let local = VaultConfig {
            endpoint: Some("http://127.0.0.1:9".into()),
            ..config.clone()
        };
        let remote = Arc::new(S3Remote::new(&local, &credentials("AKIALOCAL")).unwrap());
        let session = build_session(&config, codec, Vec::new(), remote).unwrap();
        state.journal.lock().unwrap().adopt(&session);
        state.lock_inner().unwrap().session = Some(session);
    }

    fn file(directory: &Path, name: &str) -> PathBuf {
        directory.join("config").join(name)
    }

    #[test]
    fn a_legacy_config_becomes_one_active_workspace_and_migrating_again_changes_nothing() {
        let (app, changed) = parse_config(LEGACY.as_bytes()).unwrap();
        assert!(changed);
        assert_eq!(app.version, CONFIG_VERSION);
        assert_eq!(
            (
                app.auto_lock_minutes,
                app.theme.as_str(),
                app.accent.as_str()
            ),
            (5, "Dark", "orange")
        );
        let [workspace] = app.workspaces.as_slice() else {
            panic!("one workspace expected");
        };
        assert_eq!(workspace.name, "legacy-bucket");
        assert_eq!(
            workspace.location(),
            VaultConfig {
                region: "eu-west-1".into(),
                ..legacy_location()
            }
        );
        assert_eq!(app.active_workspace.as_deref(), Some(workspace.id.as_str()));
        assert_eq!(
            workspace.legacy_keychain_user,
            Some(keychain_user(&legacy_location()))
        );
        assert_eq!(workspace.masked_access_key_id.as_deref(), Some("••••MPLE"));

        let written = serde_json::to_vec_pretty(&app).unwrap();
        let text = String::from_utf8(written.clone()).unwrap();
        assert!(!text.contains("credentials_stored") && !text.contains("vault_id"));
        let (again, changed) = parse_config(&written).unwrap();
        assert!(!changed);
        assert_eq!(again, app);

        // Setup never finished: no workspace. Without stored credentials
        // nothing waits in the keychain.
        let (empty, _) = parse_config(
            br#"{"bucket":"","region":"eu-central-1","prefix":"","endpoint":null,"auto_lock_minutes":15,"theme":"System","credentials_stored":false}"#,
        )
        .unwrap();
        assert!(empty.workspaces.is_empty() && empty.active_workspace.is_none());
        let no_credentials = LEGACY.replace(
            r#""credentials_stored":true"#,
            r#""credentials_stored":false"#,
        );
        let (app, _) = parse_config(no_credentials.as_bytes()).unwrap();
        assert_eq!(app.workspaces[0].legacy_keychain_user, None);
        assert_eq!(app.workspaces[0].masked_access_key_id, None);

        // A newer or broken file is not read (and so never overwritten).
        assert!(parse_config(br#"{"version":3}"#).is_none());
        assert!(parse_config(b"{not json").is_none());
    }

    #[test]
    fn repaired_configs_keep_every_workspace() {
        let (app, changed) = parse_config(
            br#"{"version":2,"auto_lock_minutes":99999,"theme":"Neon","accent":"lime","active_workspace":"gone","workspaces":[
                {"id":"same","name":"B","bucket":"b","region":"r"},
                {"id":"same","name":"A","bucket":"a","region":"r"}]}"#,
        )
        .unwrap();
        assert!(changed);
        assert_eq!(
            (
                app.auto_lock_minutes,
                app.theme.as_str(),
                app.accent.as_str()
            ),
            (15, "System", "orange")
        );
        assert_eq!(app.workspaces.len(), 2);
        assert_ne!(app.workspaces[0].id, app.workspaces[1].id);
        // The active one is gone: the first by name takes over.
        assert_eq!(app.active().unwrap().name, "A");
    }

    #[test]
    fn legacy_credentials_move_into_secrets_json_before_the_old_entry_is_deleted() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(directory.path().join("config")).unwrap();
        std::fs::write(file(directory.path(), "config.json"), LEGACY).unwrap();
        let keychain = Arc::new(MemoryKeychain::default());
        let user = keychain_user(&legacy_location());
        let legacy = br#"{"access_key_id":"AKIAOLDEXAMPLE","secret_access_key":"old-secret-value","session_token":null}"#;
        keychain.set(KEYCHAIN_SERVICE, &user, legacy).unwrap();

        // Loading rewrites config.json at once; the keychain is not touched.
        keychain.set_unavailable(true);
        let state = state_in(directory.path(), &keychain);
        let saved = std::fs::read_to_string(file(directory.path(), "config.json")).unwrap();
        assert!(saved.contains("\"workspaces\"") && saved.contains("legacy_keychain_user"));
        assert!(state.lock_inner().unwrap().list().workspaces[0].credentials_stored);

        // A locked keychain moves nothing and loses nothing.
        assert_eq!(
            active_credentials(&state).unwrap_err().code(),
            "KEYCHAIN_UNAVAILABLE"
        );
        keychain.set_unavailable(false);
        assert!(keychain.contains(KEYCHAIN_SERVICE, &user));
        assert!(!file(directory.path(), "secrets.json").exists());

        let (id, config, moved) = active_credentials(&state).unwrap();
        assert_eq!(config.bucket, "legacy-bucket");
        assert_eq!(moved.access_key_id, "AKIAOLDEXAMPLE");
        assert!(!keychain.contains(KEYCHAIN_SERVICE, &user));
        assert!(keychain.contains(MASTER_SERVICE, MASTER_USER));
        let secrets = std::fs::read_to_string(file(directory.path(), "secrets.json")).unwrap();
        assert!(!secrets.contains("old-secret-value") && !secrets.contains("AKIAOLD"));
        let saved = std::fs::read_to_string(file(directory.path(), "config.json")).unwrap();
        assert!(!saved.contains("legacy_keychain_user"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(file(directory.path(), "secrets.json"))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }

        // The next run opens them from secrets.json with the same id.
        drop(state);
        let state = state_in(directory.path(), &keychain);
        let (again, _, credentials) = active_credentials(&state).unwrap();
        assert_eq!(again, id);
        assert_eq!(credentials.secret_access_key, "old-secret-value");
    }

    #[test]
    fn the_legacy_entry_stays_when_secrets_json_cannot_be_written() {
        let directory = tempfile::tempdir().unwrap();
        let config_dir = directory.path().join("config");
        std::fs::create_dir_all(&config_dir).unwrap();
        std::fs::write(config_dir.join("config.json"), LEGACY).unwrap();
        let keychain = Arc::new(MemoryKeychain::default());
        let user = keychain_user(&legacy_location());
        keychain
            .set(
                KEYCHAIN_SERVICE,
                &user,
                br#"{"access_key_id":"AKIAOLD","secret_access_key":"s"}"#,
            )
            .unwrap();
        let state = state_in(directory.path(), &keychain);
        // A folder where the temporary file goes: the write fails.
        let blocker = config_dir.join("secrets.json.tmp");
        std::fs::create_dir(&blocker).unwrap();
        assert_eq!(
            active_credentials(&state).unwrap_err().code(),
            "SECRETS_WRITE"
        );
        assert!(keychain.contains(KEYCHAIN_SERVICE, &user));
        assert!(!config_dir.join("secrets.json").exists());
        std::fs::remove_dir(&blocker).unwrap();
        let (_, _, moved) = active_credentials(&state).unwrap();
        assert_eq!(moved.access_key_id, "AKIAOLD");
        assert!(!keychain.contains(KEYCHAIN_SERVICE, &user));
    }

    #[test]
    fn workspaces_are_validated_before_anything_is_written() {
        let (directory, state, keychain) = fresh();
        let long = "n".repeat(MAX_NAME_CHARS + 1);
        let bad = [
            input("", "bucket"),
            input("   ", "bucket"),
            input(&long, "bucket"),
            input("Tab\tName", "bucket"),
            input("Name", ""),
            input("Name", "has space"),
            WorkspaceInput {
                region: "eu central".into(),
                ..input("Name", "bucket")
            },
            WorkspaceInput {
                prefix: "a\u{7}".into(),
                ..input("Name", "bucket")
            },
            WorkspaceInput {
                endpoint: Some("http://s3.example.com".into()),
                ..input("Name", "bucket")
            },
            WorkspaceInput {
                endpoint: Some("not a url".into()),
                ..input("Name", "bucket")
            },
            WorkspaceInput {
                credentials: Some(credentials("AKIA\u{200B}PASTED")),
                ..input("Name", "bucket")
            },
            WorkspaceInput {
                credentials: Some(StoredCredentials {
                    access_key_id: "AKIAHALF".into(),
                    secret_access_key: String::new(),
                    session_token: None,
                }),
                ..input("Name", "bucket")
            },
            WorkspaceInput {
                phrase: phrase(""),
                ..input("Name", "bucket")
            },
            edit("no-such-id", "Name", "bucket"),
        ];
        for workspace in bad {
            assert_eq!(
                save_workspace(&state, workspace).unwrap_err().code(),
                "INVALID_INPUT"
            );
        }
        assert!(!directory.path().join("config").exists());
        assert!(!keychain.contains(MASTER_SERVICE, MASTER_USER));
        assert!(state.lock_inner().unwrap().list().workspaces.is_empty());

        // A taken name is refused before a first secret creates the master key.
        save_workspace(&state, input("Taken", "bucket")).unwrap();
        let duplicate = WorkspaceInput {
            credentials: Some(credentials("AKIADUPLICATE")),
            ..input("TAKEN", "other")
        };
        assert_eq!(
            save_workspace(&state, duplicate).unwrap_err().code(),
            "INVALID_INPUT"
        );
        assert!(!keychain.contains(MASTER_SERVICE, MASTER_USER));
        assert!(!directory.path().join("config/secrets.json").exists());
    }

    #[test]
    fn workspaces_are_created_renamed_and_keep_absent_secrets() {
        let (directory, state, keychain) = fresh();
        let first = save_workspace(
            &state,
            WorkspaceInput {
                credentials: Some(credentials("AKIAFIRST0001")),
                phrase: phrase("first phrase"),
                prefix: " /notes/ ".into(),
                ..input("Personal", "bucket-a")
            },
        )
        .unwrap();
        assert!(first.credentials_stored && first.phrase_stored);
        assert_eq!(first.masked_access_key_id.as_deref(), Some("••••0001"));
        assert_eq!(first.prefix, "notes");
        // The first workspace becomes the active one; later ones do not.
        let second = save_workspace(&state, input("Work", "bucket-b")).unwrap();
        assert!(!second.credentials_stored && !second.phrase_stored);
        let list = state.lock_inner().unwrap().list();
        assert_eq!(list.active.as_deref(), Some(first.id.as_str()));
        assert_eq!(
            list.workspaces
                .iter()
                .map(|workspace| workspace.name.as_str())
                .collect::<Vec<_>>(),
            ["Personal", "Work"]
        );

        // Names are unique, ignoring case.
        assert_eq!(
            save_workspace(&state, input("  personal ", "bucket-c"))
                .unwrap_err()
                .code(),
            "INVALID_INPUT"
        );
        assert_eq!(
            save_workspace(&state, edit(&second.id, "PERSONAL", "bucket-b"))
                .unwrap_err()
                .code(),
            "INVALID_INPUT"
        );

        // Renaming keeps the id and every absent secret.
        let renamed = save_workspace(&state, edit(&first.id, "Private", "bucket-a")).unwrap();
        assert_eq!(renamed.id, first.id);
        assert!(renamed.credentials_stored && renamed.phrase_stored);
        assert_eq!(renamed.masked_access_key_id.as_deref(), Some("••••0001"));
        assert_eq!(renamed.prefix, "", "the prefix is what the form sends");
        save_workspace(&state, edit(&first.id, "PRIVATE", "bucket-a")).unwrap();
        assert_eq!(
            stored_phrase(&state, &first.id).unwrap().as_str(),
            "first phrase"
        );

        // `remember_phrase: false` forgets the phrase and ignores a new one.
        let forgot = save_workspace(
            &state,
            WorkspaceInput {
                remember_phrase: Some(false),
                phrase: phrase("ignored"),
                ..edit(&first.id, "PRIVATE", "bucket-a")
            },
        )
        .unwrap();
        assert!(forgot.credentials_stored && !forgot.phrase_stored);

        // Another run reads the same workspaces.
        let before = state.lock_inner().unwrap().list();
        drop(state);
        let state = state_in(directory.path(), &keychain);
        assert_eq!(state.lock_inner().unwrap().list(), before);
        let (_, _, opened) = active_credentials(&state).unwrap();
        assert_eq!(opened.secret_access_key, "secret-of-AKIAFIRST0001");
    }

    #[test]
    fn editing_the_active_workspace_keeps_its_credentials_and_config_get_shows_it() {
        let (_directory, state, _keychain) = fresh();
        let created = save_workspace(&state, input("my-bucket", "my-bucket")).unwrap();
        store_credentials(&state, credentials("AKIAFORM0001")).unwrap();
        save_workspace(
            &state,
            WorkspaceInput {
                prefix: "notes".into(),
                ..edit(&created.id, "my-bucket", "my-bucket")
            },
        )
        .unwrap();
        let list = state.lock_inner().unwrap().list();
        let [workspace] = list.workspaces.as_slice() else {
            panic!("one workspace expected");
        };
        assert_eq!(
            (workspace.name.as_str(), workspace.prefix.as_str()),
            ("my-bucket", "notes")
        );
        assert!(
            workspace.credentials_stored,
            "editing never wipes credentials"
        );
        let inner = state.lock_inner().unwrap();
        let view = config_view(&inner);
        assert_eq!(view.workspace_name.as_deref(), Some("my-bucket"));
        assert!(view.credentials_stored && !view.phrase_stored);
    }

    #[test]
    fn editing_the_active_location_ends_its_session_but_renaming_does_not() {
        let (_directory, state, _keychain) = fresh();
        let workspace = save_workspace(
            &state,
            WorkspaceInput {
                credentials: Some(credentials("AKIAOLD00001")),
                ..input("A", "bucket-a")
            },
        )
        .unwrap();
        active_credentials(&state).unwrap();
        unlock_in_memory(&state);
        save_workspace(&state, edit(&workspace.id, "Renamed", "bucket-a")).unwrap();
        assert!(state.is_unlocked());
        // New keys apply to the unlocked session at once.
        save_workspace(
            &state,
            WorkspaceInput {
                credentials: Some(credentials("AKIANEW00002")),
                ..edit(&workspace.id, "Renamed", "bucket-a")
            },
        )
        .unwrap();
        assert!(state.is_unlocked());
        let (_, _, cached) = active_credentials(&state).unwrap();
        assert_eq!(cached.access_key_id, "AKIANEW00002");
        // Another bucket: the session ends, the credentials stay.
        let moved = save_workspace(&state, edit(&workspace.id, "Renamed", "bucket-b")).unwrap();
        assert!(!state.is_unlocked());
        assert!(moved.credentials_stored);
    }

    #[test]
    fn selecting_a_workspace_ends_the_session_and_is_saved() {
        let (directory, state, keychain) = fresh();
        let first = save_workspace(
            &state,
            WorkspaceInput {
                credentials: Some(credentials("AKIAFIRST0001")),
                ..input("First", "bucket-a")
            },
        )
        .unwrap();
        let second = save_workspace(&state, input("Second", "bucket-b")).unwrap();
        active_credentials(&state).unwrap();
        unlock_in_memory(&state);
        assert_eq!(select_workspace(&state, &second.id).unwrap(), second);
        assert!(!state.is_unlocked());
        assert!(state.lock_inner().unwrap().credentials.is_none());
        // Selecting the active workspace changes nothing.
        unlock_in_memory(&state);
        select_workspace(&state, &second.id).unwrap();
        assert!(state.is_unlocked());
        assert_eq!(
            select_workspace(&state, "unknown").unwrap_err().code(),
            "INVALID_INPUT"
        );
        drop(state);
        let state = state_in(directory.path(), &keychain);
        assert_eq!(
            state.lock_inner().unwrap().active_id(),
            Some(second.id.as_str())
        );
        assert_eq!(
            active_credentials(&state).unwrap_err().code(),
            "NO_CREDENTIALS"
        );
        select_workspace(&state, &first.id).unwrap();
        active_credentials(&state).unwrap();
    }

    #[test]
    fn deleting_removes_secrets_and_the_master_key_goes_with_the_last_one() {
        let (directory, state, keychain) = fresh();
        let first = save_workspace(
            &state,
            WorkspaceInput {
                credentials: Some(credentials("AKIAFIRST0001")),
                phrase: phrase("first phrase"),
                ..input("First", "bucket-a")
            },
        )
        .unwrap();
        let second = save_workspace(
            &state,
            WorkspaceInput {
                credentials: Some(credentials("AKIASECOND002")),
                ..input("Second", "bucket-b")
            },
        )
        .unwrap();
        unlock_in_memory(&state);
        assert_eq!(
            delete_workspace(&state, &first.id, false)
                .unwrap_err()
                .code(),
            "WORKSPACE_UNLOCKED"
        );
        state.end_session();

        // Queued edits that no other workspace would upload: deleting needs
        // the user's word (OUTBOX_PENDING), and they stay on disk.
        let outbox = |bucket: &str| {
            let location = VaultConfig {
                bucket: bucket.into(),
                ..VaultConfig::default()
            };
            vault_outbox_dir(&state, &location).join("queued.pending")
        };
        for bucket in ["bucket-a", "bucket-b"] {
            std::fs::create_dir_all(outbox(bucket).parent().unwrap()).unwrap();
            std::fs::write(outbox(bucket), b"ciphertext").unwrap();
        }

        assert_eq!(
            delete_workspace(&state, &first.id, false)
                .unwrap_err()
                .code(),
            "OUTBOX_PENDING"
        );
        assert!(
            state
                .lock_inner()
                .unwrap()
                .secrets
                .has(&first.id, Field::S3)
        );
        let list = delete_workspace(&state, &first.id, true).unwrap();
        assert_eq!(list.workspaces.len(), 1);
        assert_eq!(list.active.as_deref(), Some(second.id.as_str()));
        {
            let inner = state.lock_inner().unwrap();
            assert!(!inner.secrets.has(&first.id, Field::S3));
            assert!(!inner.secrets.has(&first.id, Field::Phrase));
        }
        assert!(file(directory.path(), "secrets.json").exists());
        assert!(keychain.contains(MASTER_SERVICE, MASTER_USER));
        let (_, _, opened) = active_credentials(&state).unwrap();
        assert_eq!(opened.access_key_id, "AKIASECOND002");
        assert!(outbox("bucket-a").is_file() && outbox("bucket-b").is_file());

        let list = delete_workspace(&state, &second.id, true).unwrap();
        assert!(list.workspaces.is_empty() && list.active.is_none());
        assert!(!file(directory.path(), "secrets.json").exists());
        assert!(!keychain.contains(MASTER_SERVICE, MASTER_USER));
        assert!(state.lock_inner().unwrap().credentials.is_none());
        let saved = std::fs::read_to_string(file(directory.path(), "config.json")).unwrap();
        assert!(!saved.contains("bucket-a") && !saved.contains("bucket-b"));
        assert_eq!(
            delete_workspace(&state, &second.id, false)
                .unwrap_err()
                .code(),
            "INVALID_INPUT"
        );
    }

    #[test]
    fn secrets_never_reach_config_json_lists_or_debug_output() {
        let (directory, state, _keychain) = fresh();
        let canaries = [
            "AKIACANARY0042",
            "SECRET-CANARY-1",
            "TOKEN-CANARY-2",
            "PHRASE-CANARY-3",
        ];
        let clean = |text: &str| canaries.iter().all(|canary| !text.contains(canary));
        // The shape the frontend sends.
        let workspace: WorkspaceInput = serde_json::from_str(
            r#"{"name":"Canary","bucket":"canary-bucket","region":"eu-central-1","prefix":"",
                "credentials":{"access_key_id":"AKIACANARY0042","secret_access_key":"SECRET-CANARY-1","session_token":"TOKEN-CANARY-2"},
                "phrase":"PHRASE-CANARY-3","remember_phrase":true}"#,
        )
        .unwrap();
        assert!(clean(&format!("{workspace:?}")));
        let summary = save_workspace(&state, workspace).unwrap();
        assert!(clean(&serde_json::to_string(&summary).unwrap()));
        assert_eq!(summary.masked_access_key_id.as_deref(), Some("••••0042"));
        for name in ["config.json", "secrets.json"] {
            assert!(clean(
                &std::fs::read_to_string(file(directory.path(), name)).unwrap()
            ));
        }
        let (_, _, opened) = active_credentials(&state).unwrap();
        assert_eq!(opened.session_token.as_deref(), Some("TOKEN-CANARY-2"));
        assert!(clean(&format!("{opened:?}")));
        let inner = state.lock_inner().unwrap();
        assert!(clean(&format!("{:?} {:?}", inner.app, inner.secrets)));
        assert!(clean(&format!("{:?}", inner.list())));
        assert!(clean(&serde_json::to_string(&config_view(&inner)).unwrap()));
    }

    #[test]
    fn a_missing_or_locked_master_key_is_reported_and_never_replaced() {
        let (directory, state, keychain) = fresh();
        let workspace = save_workspace(
            &state,
            WorkspaceInput {
                credentials: Some(credentials("AKIAKEPT0001")),
                phrase: phrase("kept phrase"),
                ..input("Kept", "bucket")
            },
        )
        .unwrap();
        let sealed = std::fs::read(file(directory.path(), "secrets.json")).unwrap();
        drop(state);

        keychain.set_unavailable(true);
        let state = state_in(directory.path(), &keychain);
        assert_eq!(
            active_credentials(&state).unwrap_err().code(),
            "KEYCHAIN_UNAVAILABLE"
        );
        let new_keys = WorkspaceInput {
            credentials: Some(credentials("AKIANEW00002")),
            ..edit(&workspace.id, "Kept", "bucket")
        };
        assert_eq!(
            save_workspace(&state, new_keys).unwrap_err().code(),
            "KEYCHAIN_UNAVAILABLE"
        );
        keychain.set_unavailable(false);
        assert_eq!(
            std::fs::read(file(directory.path(), "secrets.json")).unwrap(),
            sealed
        );

        // The keychain lost the key: the values are unreadable, and reading
        // them never creates a new key or removes them.
        keychain.delete(MASTER_SERVICE, MASTER_USER).unwrap();
        drop(state);
        let state = state_in(directory.path(), &keychain);
        assert_eq!(
            active_credentials(&state).unwrap_err().code(),
            "NO_CREDENTIALS"
        );
        assert_eq!(
            stored_phrase(&state, &workspace.id).unwrap_err().code(),
            "NO_STORED_PHRASE"
        );
        assert!(!keychain.contains(MASTER_SERVICE, MASTER_USER));
        assert_eq!(
            std::fs::read(file(directory.path(), "secrets.json")).unwrap(),
            sealed
        );
    }

    #[test]
    fn unreadable_files_are_set_aside_never_overwritten() {
        let directory = tempfile::tempdir().unwrap();
        let config_dir = directory.path().join("config");
        std::fs::create_dir_all(&config_dir).unwrap();
        std::fs::write(config_dir.join("config.json"), b"{broken").unwrap();
        std::fs::write(config_dir.join("secrets.json"), br#"{"version":9}"#).unwrap();
        let keychain = Arc::new(MemoryKeychain::default());
        let state = state_in(directory.path(), &keychain);
        assert!(state.lock_inner().unwrap().list().workspaces.is_empty());
        let mut kept = std::fs::read_dir(&config_dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect::<Vec<_>>();
        kept.sort();
        assert_eq!(kept.len(), 2);
        assert!(kept[0].starts_with("config.unreadable-"));
        assert!(kept[1].starts_with("secrets.unreadable-"));
        assert_eq!(
            std::fs::read(config_dir.join(&kept[0])).unwrap(),
            b"{broken"
        );
    }

    #[test]
    fn the_idle_lock_is_skipped_while_the_phrase_is_remembered() {
        let (_directory, state, _keychain) = fresh();
        let workspace = save_workspace(
            &state,
            WorkspaceInput {
                phrase: phrase("remembered"),
                ..input("Idle", "bucket")
            },
        )
        .unwrap();
        unlock_in_memory(&state);
        let idle_for = |seconds| {
            let mut inner = state.lock_inner().unwrap();
            inner.app.auto_lock_minutes = 1;
            inner.last_activity = Instant::now() - Duration::from_secs(seconds);
        };
        idle_for(3_600);
        assert!(matches!(state.check_idle_session(), IdleAction::None));
        assert!(state.is_unlocked());
        let location = state.lock_inner().unwrap().active_config().unwrap();
        remember_phrase(&state, &workspace.id, &location, None).unwrap();
        idle_for(61);
        assert!(matches!(state.check_idle_session(), IdleAction::Notify));
        idle_for(121);
        assert!(matches!(state.check_idle_session(), IdleAction::Forced));
        assert!(!state.is_unlocked());
    }

    #[test]
    fn names_come_from_buckets_and_stay_unique() {
        assert_eq!(default_name("  my-bucket "), "my-bucket");
        assert_eq!(default_name(""), DEFAULT_NAME);
        assert_eq!(
            default_name(&"b".repeat(80)).chars().count(),
            MAX_NAME_CHARS
        );
        let mut app = AppConfig::default();
        add_test_workspace(
            &mut app,
            VaultConfig {
                bucket: "notes".into(),
                ..VaultConfig::default()
            },
        );
        add_test_workspace(
            &mut app,
            VaultConfig {
                bucket: "NOTES".into(),
                ..VaultConfig::default()
            },
        );
        assert_eq!(app.workspaces[1].name, "NOTES 2");
        let long = "x".repeat(MAX_NAME_CHARS);
        app.workspaces[0].name = long.clone();
        let unique = unique_name(&long, &app);
        assert_eq!(unique.chars().count(), MAX_NAME_CHARS);
        assert!(unique.ends_with(" 2"));
    }

    #[test]
    fn the_os_keychain_adapter_treats_missing_entries_as_absent() {
        // `cfg(test)` routes OsKeychain to keyring's mock store, in which
        // every Entry has its own storage: nothing reaches the OS keychain.
        let keychain = OsKeychain;
        assert!(
            keychain
                .get("com.securemd.vault.test", "nobody")
                .unwrap()
                .is_none()
        );
        keychain
            .delete("com.securemd.vault.test", "nobody")
            .unwrap();
        keychain
            .set("com.securemd.vault.test", "nobody", b"x")
            .unwrap();
    }

    /// Answers every request with `listing` (a ListObjectsV2 result).
    fn fake_s3(listing: String) -> String {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { break };
                let mut request = Vec::new();
                let mut buffer = [0_u8; 4096];
                while !request.windows(4).any(|part| part == b"\r\n\r\n") {
                    let count = stream.read(&mut buffer).unwrap_or(0);
                    if count == 0 {
                        break;
                    }
                    request.extend_from_slice(&buffer[..count]);
                }
                let _ = write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Type: application/xml\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{listing}",
                    listing.len()
                );
            }
        });
        format!("http://{address}")
    }

    #[tokio::test]
    async fn the_remembered_phrase_unlocks_and_a_wrong_phrase_never_replaces_it() {
        let codec = NotebookV1Codec::new(SecretString::from("correct horse".to_owned())).unwrap();
        let key = codec.encode_path("a.md").unwrap();
        let endpoint = fake_s3(format!(
            r#"<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>test-bucket</Name><Prefix></Prefix><KeyCount>1</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated><Contents><Key>{key}</Key><LastModified>2026-01-01T00:00:00.000Z</LastModified><ETag>&quot;x&quot;</ETag><Size>31</Size><StorageClass>STANDARD</StorageClass></Contents></ListBucketResult>"#
        ));
        let (_directory, state, _keychain) = fresh();
        let workspace = save_workspace(
            &state,
            WorkspaceInput {
                region: "us-east-1".into(),
                endpoint: Some(endpoint),
                credentials: Some(credentials("AKIAREMOTE01")),
                phrase: phrase("correct horse"),
                ..input("Remote", "test-bucket")
            },
        )
        .unwrap();
        let id = workspace.id.as_str();

        // No phrase given: the remembered one opens the workspace.
        let tree = unlock(&state, None, None).await.unwrap();
        assert!(tree.nodes.iter().any(|node| node.name == "a.md"));
        state.end_session();

        // A wrong phrase fails and leaves the remembered one in place.
        let wrong = unlock(&state, Some("wrong horse".into()), Some(true))
            .await
            .map(drop)
            .unwrap_err();
        assert_eq!(wrong.code(), "WRONG_PHRASE");
        assert!(!state.is_unlocked());
        assert_eq!(stored_phrase(&state, id).unwrap().as_str(), "correct horse");

        // `remember: false` forgets it once the unlock succeeded.
        unlock(&state, Some("correct horse".into()), Some(false))
            .await
            .unwrap();
        assert!(!phrase_is_remembered(&state, id).unwrap());
        let declined = |state: &NotebookState| {
            state.lock_inner().unwrap().list().workspaces[0].remember_declined
        };
        assert!(
            declined(&state),
            "the unlock screen offers Remember unchecked"
        );
        state.end_session();
        assert_eq!(
            unlock(&state, None, None)
                .await
                .map(drop)
                .unwrap_err()
                .code(),
            "NO_STORED_PHRASE"
        );

        // `remember: true` stores the typed phrase; no `remember` keeps it.
        unlock(&state, Some("correct horse".into()), Some(true))
            .await
            .unwrap();
        assert_eq!(stored_phrase(&state, id).unwrap().as_str(), "correct horse");
        assert!(!declined(&state));
        state.end_session();
        let _ = unlock(&state, Some("wrong horse".into()), None).await;
        unlock(&state, None, None).await.unwrap();
        assert!(state.is_unlocked());
    }

    /// Fails deleting (and with `.1`, also reading) the S3 credentials
    /// entries of builds before workspaces, as a denied keychain prompt does.
    struct NoLegacyDelete(Arc<MemoryKeychain>, bool);

    impl Keychain for NoLegacyDelete {
        fn get(
            &self,
            service: &str,
            user: &str,
        ) -> Result<Option<Zeroizing<Vec<u8>>>, keyring::Error> {
            if self.1 && service == KEYCHAIN_SERVICE {
                return Err(keyring::Error::NoStorageAccess(Box::new(
                    std::io::Error::other("denied"),
                )));
            }
            self.0.get(service, user)
        }

        fn set(&self, service: &str, user: &str, secret: &[u8]) -> Result<(), keyring::Error> {
            self.0.set(service, user, secret)
        }

        fn delete(&self, service: &str, user: &str) -> Result<(), keyring::Error> {
            if service == KEYCHAIN_SERVICE {
                return Err(keyring::Error::NoStorageAccess(Box::new(
                    std::io::Error::other("denied"),
                )));
            }
            self.0.delete(service, user)
        }
    }

    fn legacy_profile() -> (tempfile::TempDir, Arc<MemoryKeychain>, String) {
        let directory = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(directory.path().join("config")).unwrap();
        std::fs::write(file(directory.path(), "config.json"), LEGACY).unwrap();
        let memory = Arc::new(MemoryKeychain::default());
        let user = keychain_user(&legacy_location());
        memory
            .set(
                KEYCHAIN_SERVICE,
                &user,
                br#"{"access_key_id":"AKIAOLDEXAMPLE","secret_access_key":"old-secret-value"}"#,
            )
            .unwrap();
        (directory, memory, user)
    }

    fn denying_state(directory: &Path, memory: &Arc<MemoryKeychain>) -> NotebookState {
        NotebookState::load_with(
            directory.join("config"),
            directory.join("local"),
            Arc::new(NoLegacyDelete(memory.clone(), false)),
        )
    }

    #[test]
    fn an_old_keychain_entry_whose_delete_failed_is_deleted_on_a_later_use() {
        let (directory, memory, user) = legacy_profile();
        let state = denying_state(directory.path(), &memory);
        active_credentials(&state).unwrap();
        assert!(file(directory.path(), "secrets.json").exists());
        assert!(
            memory.contains(KEYCHAIN_SERVICE, &user),
            "the delete was denied"
        );
        drop(state);

        // The next run, with a working keychain, finishes the move.
        let state = state_in(directory.path(), &memory);
        let (_, _, opened) = active_credentials(&state).unwrap();
        assert_eq!(opened.access_key_id, "AKIAOLDEXAMPLE");
        assert!(!memory.contains(KEYCHAIN_SERVICE, &user));
        let config = std::fs::read_to_string(file(directory.path(), "config.json")).unwrap();
        assert!(!config.contains("legacy_keychain_user"));
    }

    #[test]
    fn a_refused_old_entry_never_keeps_a_migrated_workspace_closed() {
        let (directory, memory, user) = legacy_profile();
        let state = denying_state(directory.path(), &memory);
        active_credentials(&state).unwrap();
        drop(state);
        // The keychain now refuses the old entry altogether.
        let state = NotebookState::load_with(
            directory.path().join("config"),
            directory.path().join("local"),
            Arc::new(NoLegacyDelete(memory.clone(), true)),
        );
        let (_, _, opened) = active_credentials(&state).unwrap();
        assert_eq!(opened.access_key_id, "AKIAOLDEXAMPLE");
        assert!(
            memory.contains(KEYCHAIN_SERVICE, &user),
            "retried on a later use"
        );
    }

    #[test]
    fn new_credentials_keep_the_old_entry_on_record_until_it_is_deleted() {
        let (directory, memory, user) = legacy_profile();
        let state = denying_state(directory.path(), &memory);
        let id = state.lock_inner().unwrap().app.workspaces[0].id.clone();
        save_workspace(
            &state,
            WorkspaceInput {
                credentials: Some(credentials("AKIANEWVALUE1")),
                ..edit(&id, "legacy-bucket", "legacy-bucket")
            },
        )
        .unwrap();
        assert!(memory.contains(KEYCHAIN_SERVICE, &user));
        let config = std::fs::read_to_string(file(directory.path(), "config.json")).unwrap();
        assert!(config.contains("legacy_keychain_user"), "kept on record");
        drop(state);

        // A later use deletes the old entry and keeps the new credentials.
        let state = state_in(directory.path(), &memory);
        let (_, _, opened) = active_credentials(&state).unwrap();
        assert_eq!(opened.access_key_id, "AKIANEWVALUE1");
        assert!(!memory.contains(KEYCHAIN_SERVICE, &user));
    }

    #[test]
    fn deleting_a_workspace_whose_old_entry_cannot_go_changes_nothing() {
        let (directory, memory, user) = legacy_profile();
        let state = denying_state(directory.path(), &memory);
        let id = state.lock_inner().unwrap().app.workspaces[0].id.clone();
        let before = std::fs::read(file(directory.path(), "config.json")).unwrap();
        assert_eq!(
            delete_workspace(&state, &id, false).unwrap_err().code(),
            "KEYCHAIN_UNAVAILABLE"
        );
        assert_eq!(
            std::fs::read(file(directory.path(), "config.json")).unwrap(),
            before
        );
        assert!(memory.contains(KEYCHAIN_SERVICE, &user));
        drop(state);
        let state = state_in(directory.path(), &memory);
        delete_workspace(&state, &id, false).unwrap();
        assert!(!memory.contains(KEYCHAIN_SERVICE, &user));
    }

    #[test]
    fn a_second_process_on_the_same_profile_reads_and_writes_nothing() {
        let directory = tempfile::tempdir().unwrap();
        let config_dir = directory.path().join("config");
        let ProfileLock::Held(held) = lock_profile(&config_dir) else {
            panic!("the first process takes the profile");
        };
        assert!(matches!(lock_profile(&config_dir), ProfileLock::InUse));

        let keychain = Arc::new(MemoryKeychain::default());
        let second = NotebookState::in_use(
            config_dir.clone(),
            directory.path().join("local"),
            keychain.clone(),
        );
        assert_eq!(
            second.readable_inner().err().unwrap().code(),
            "PROFILE_IN_USE"
        );
        let saved = save_workspace(
            &second,
            WorkspaceInput {
                credentials: Some(credentials("AKIASECOND002")),
                phrase: phrase("second"),
                ..input("Two", "bucket-two")
            },
        );
        assert_eq!(saved.unwrap_err().code(), "PROFILE_IN_USE");
        assert!(
            second.check_idle_session() == IdleAction::None,
            "no session"
        );
        assert!(!config_dir.join("config.json").exists());
        assert!(!config_dir.join("secrets.json").exists());
        assert!(!keychain.contains(MASTER_SERVICE, MASTER_USER));

        // The OS releases the lock with the first process.
        drop(held);
        assert!(matches!(lock_profile(&config_dir), ProfileLock::Held(_)));
    }

    #[test]
    fn a_set_aside_secrets_file_keeps_its_master_key() {
        let (directory, state, keychain) = fresh();
        save_workspace(
            &state,
            WorkspaceInput {
                credentials: Some(credentials("AKIAKEEP0001")),
                ..input("Keep", "bucket-keep")
            },
        )
        .unwrap();
        drop(state);
        // A newer build's secrets.json is set aside at load.
        let path = file(directory.path(), "secrets.json");
        let text =
            std::fs::read_to_string(&path)
                .unwrap()
                .replacen("\"version\": 1", "\"version\": 2", 1);
        std::fs::write(&path, text).unwrap();
        let state = state_in(directory.path(), &keychain);
        assert!(set_aside_secrets(&path));
        let temp = save_workspace(
            &state,
            WorkspaceInput {
                credentials: Some(credentials("AKIATEMP0002")),
                ..input("Temp", "bucket-temp")
            },
        )
        .unwrap();
        delete_workspace(&state, &temp.id, false).unwrap();
        assert!(!path.exists());
        assert!(
            keychain.contains(MASTER_SERVICE, MASTER_USER),
            "the set-aside file still needs its key"
        );
    }

    #[cfg(unix)]
    #[test]
    fn files_that_cannot_be_read_are_never_replaced() {
        use std::os::unix::fs::PermissionsExt;
        let (directory, state, keychain) = fresh();
        save_workspace(
            &state,
            WorkspaceInput {
                credentials: Some(credentials("AKIAKEPT0001")),
                ..input("Kept one", "kept-bucket")
            },
        )
        .unwrap();
        drop(state);
        for name in ["config.json", "secrets.json"] {
            let path = file(directory.path(), name);
            let before = std::fs::read(&path).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o000)).unwrap();
            if std::fs::read(&path).is_ok() {
                // Running as root: permissions do not apply.
                std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
                return;
            }
            let state = state_in(directory.path(), &keychain);
            let expected = if name == "config.json" {
                "CONFIG_UNREADABLE"
            } else {
                "SECRETS_UNREADABLE"
            };
            assert_eq!(state.readable_inner().err().unwrap().code(), expected);
            let saved = save_workspace(
                &state,
                WorkspaceInput {
                    credentials: Some(credentials("AKIANEW00001")),
                    ..input("New", "new-bucket")
                },
            );
            assert_eq!(saved.unwrap_err().code(), expected);
            drop(state);
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
            assert_eq!(std::fs::read(&path).unwrap(), before, "{name} was replaced");
        }
        let state = state_in(directory.path(), &keychain);
        assert_eq!(state.readable_inner().unwrap().list().workspaces.len(), 1);
        active_credentials(&state).unwrap();
    }

    #[test]
    fn a_phrase_is_remembered_only_for_the_location_it_opened() {
        let (_directory, state, _keychain) = fresh();
        let workspace = save_workspace(
            &state,
            WorkspaceInput {
                credentials: Some(credentials("AKIAMOVED001")),
                ..input("Moved", "bucket-old")
            },
        )
        .unwrap();
        let old = state.lock_inner().unwrap().active_config().unwrap();
        save_workspace(&state, edit(&workspace.id, "Moved", "bucket-new")).unwrap();
        assert_eq!(
            remember_phrase(&state, &workspace.id, &old, Some("old place"))
                .unwrap_err()
                .code(),
            "WORKSPACE_CHANGED"
        );
        assert!(!phrase_is_remembered(&state, &workspace.id).unwrap());
        let new = state.lock_inner().unwrap().active_config().unwrap();
        remember_phrase(&state, &workspace.id, &new, Some("new place")).unwrap();
        assert_eq!(
            remember_phrase(&state, &workspace.id, &old, None)
                .unwrap_err()
                .code(),
            "WORKSPACE_CHANGED"
        );
        assert_eq!(
            stored_phrase(&state, &workspace.id).unwrap().as_str(),
            "new place"
        );
    }

    #[test]
    fn unchecking_remember_is_kept_until_it_is_checked_again() {
        let (directory, state, keychain) = fresh();
        let workspace = save_workspace(
            &state,
            WorkspaceInput {
                phrase: phrase("kept"),
                ..input("Choice", "bucket")
            },
        )
        .unwrap();
        assert!(!workspace.remember_declined && workspace.phrase_stored);
        let unchecked = save_workspace(
            &state,
            WorkspaceInput {
                remember_phrase: Some(false),
                ..edit(&workspace.id, "Choice", "bucket")
            },
        )
        .unwrap();
        assert!(unchecked.remember_declined && !unchecked.phrase_stored);
        // An edit that does not mention Remember keeps the choice.
        let renamed = save_workspace(&state, edit(&workspace.id, "Renamed", "bucket")).unwrap();
        assert!(renamed.remember_declined);
        drop(state);
        let state = state_in(directory.path(), &keychain);
        assert!(state.lock_inner().unwrap().list().workspaces[0].remember_declined);
        let checked = save_workspace(
            &state,
            WorkspaceInput {
                remember_phrase: Some(true),
                ..edit(&workspace.id, "Renamed", "bucket")
            },
        )
        .unwrap();
        assert!(!checked.remember_declined);
    }

    #[test]
    fn moving_a_workspace_with_queued_edits_needs_the_users_word() {
        let (_directory, state, _keychain) = fresh();
        let workspace = save_workspace(
            &state,
            WorkspaceInput {
                credentials: Some(credentials("AKIAQUEUED01")),
                ..input("Queued", "bucket-q")
            },
        )
        .unwrap();
        let queued = |location: &VaultConfig| pending_files(&state, location).len();
        let at = |bucket: &str, endpoint: Option<&str>| VaultConfig {
            bucket: bucket.into(),
            region: "eu-central-1".into(),
            prefix: String::new(),
            endpoint: endpoint.map(str::to_owned),
        };
        let old = at("bucket-q", None);
        create_vault_outbox(&state, &old).unwrap();
        std::fs::write(vault_outbox_dir(&state, &old).join("edit.pending"), b"x").unwrap();
        std::fs::write(cleanup_path(&state, &old), b"[]").unwrap();

        // Another bucket: refused, nothing changes.
        let moved = |bucket: &str, endpoint: Option<&str>, leave: Option<bool>| {
            save_workspace(
                &state,
                WorkspaceInput {
                    endpoint: endpoint.map(str::to_owned),
                    leave_pending: leave,
                    ..edit(&workspace.id, "Queued", bucket)
                },
            )
        };
        assert_eq!(
            moved("bucket-other", None, None).unwrap_err().code(),
            "OUTBOX_PENDING"
        );
        assert_eq!(
            state.lock_inner().unwrap().active_config(),
            Some(old.clone())
        );

        // A new endpoint for the same bucket and prefix takes them along.
        let endpoint = Some("https://s3.example.com");
        moved("bucket-q", endpoint, None).unwrap();
        let new = at("bucket-q", endpoint);
        assert_eq!((queued(&old), queued(&new)), (0, 1));
        assert!(cleanup_path(&state, &new).is_file());

        // Another workspace at that location still uploads them.
        let twin = save_workspace(
            &state,
            WorkspaceInput {
                endpoint: endpoint.map(str::to_owned),
                ..input("Twin", "bucket-q")
            },
        )
        .unwrap();
        moved("bucket-other", None, None).unwrap();
        assert_eq!(queued(&new), 1);

        // The last one needs `leave_pending`; the edits stay on disk.
        assert_eq!(
            delete_workspace(&state, &twin.id, false)
                .unwrap_err()
                .code(),
            "OUTBOX_PENDING"
        );
        delete_workspace(&state, &twin.id, true).unwrap();
        assert_eq!(queued(&new), 1);
    }
}
