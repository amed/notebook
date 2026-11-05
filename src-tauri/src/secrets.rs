//! Secrets kept the way the original Notebook app keeps them: one encrypted
//! `secrets.json` next to `config.json`, and only a random 32-byte master key
//! in the OS keychain. Each value is sealed with AES-256-GCM-SIV under a
//! context that binds the format version, the workspace and the field, so a
//! value copied to another workspace or field fails to open.

use aes_gcm_siv::aead::{Aead, KeyInit, Payload};
use aes_gcm_siv::{Aes256GcmSiv, Nonce};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use zeroize::Zeroizing;

const FORMAT: u32 = 1;
const NONCE_LEN: usize = 12;
pub const KEY_LEN: usize = 32;

/// Where the master key lives in the OS keychain.
pub const MASTER_SERVICE: &str = "com.securemd.vault";
pub const MASTER_USER: &str = "secrets-master-key";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Field {
    S3,
    Phrase,
}

impl Field {
    fn name(self) -> &'static str {
        match self {
            Field::S3 => "s3",
            Field::Phrase => "phrase",
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum SecretsError {
    /// The file is not a secrets file of a known version.
    Format,
    /// Wrong key, wrong context or modified bytes.
    Open,
    Random,
}

#[derive(Clone, Default, Serialize, Deserialize)]
struct Entry {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    s3: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    phrase: Option<String>,
}

impl Entry {
    fn slot(&mut self, field: Field) -> &mut Option<String> {
        match field {
            Field::S3 => &mut self.s3,
            Field::Phrase => &mut self.phrase,
        }
    }
}

/// The parsed file: sealed values per workspace. It holds no plaintext.
#[derive(Clone, Serialize, Deserialize)]
pub struct SecretsFile {
    version: u32,
    #[serde(default)]
    workspaces: BTreeMap<String, Entry>,
}

impl Default for SecretsFile {
    fn default() -> Self {
        Self {
            version: FORMAT,
            workspaces: BTreeMap::new(),
        }
    }
}

impl std::fmt::Debug for SecretsFile {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SecretsFile")
            .field("workspaces", &self.workspaces.len())
            .finish()
    }
}

impl SecretsFile {
    pub fn parse(bytes: &[u8]) -> Result<Self, SecretsError> {
        let file: Self = serde_json::from_slice(bytes).map_err(|_| SecretsError::Format)?;
        if file.version != FORMAT {
            return Err(SecretsError::Format);
        }
        Ok(file)
    }

    pub fn to_bytes(&self) -> Vec<u8> {
        serde_json::to_vec_pretty(self).unwrap_or_default()
    }

    pub fn has(&self, workspace: &str, field: Field) -> bool {
        self.get(workspace, field).is_some()
    }

    pub fn is_empty(&self) -> bool {
        self.workspaces.is_empty()
    }

    fn get(&self, workspace: &str, field: Field) -> Option<&str> {
        let entry = self.workspaces.get(workspace)?;
        match field {
            Field::S3 => entry.s3.as_deref(),
            Field::Phrase => entry.phrase.as_deref(),
        }
    }

    pub fn seal(
        &mut self,
        key: &[u8; KEY_LEN],
        workspace: &str,
        field: Field,
        plaintext: &[u8],
    ) -> Result<(), SecretsError> {
        let mut nonce = [0_u8; NONCE_LEN];
        getrandom::fill(&mut nonce).map_err(|_| SecretsError::Random)?;
        let cipher = Aes256GcmSiv::new_from_slice(key).map_err(|_| SecretsError::Open)?;
        let context = context(workspace, field);
        let sealed = cipher
            .encrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: plaintext,
                    aad: &context,
                },
            )
            .map_err(|_| SecretsError::Open)?;
        let mut bytes = nonce.to_vec();
        bytes.extend_from_slice(&sealed);
        *self
            .workspaces
            .entry(workspace.to_owned())
            .or_default()
            .slot(field) = Some(STANDARD.encode(bytes));
        Ok(())
    }

    /// The plaintext of `field`, or `None` when it is not stored.
    pub fn open(
        &self,
        key: &[u8; KEY_LEN],
        workspace: &str,
        field: Field,
    ) -> Result<Option<Zeroizing<Vec<u8>>>, SecretsError> {
        let Some(sealed) = self.get(workspace, field) else {
            return Ok(None);
        };
        let bytes = STANDARD.decode(sealed).map_err(|_| SecretsError::Open)?;
        if bytes.len() < NONCE_LEN {
            return Err(SecretsError::Open);
        }
        let (nonce, ciphertext) = bytes.split_at(NONCE_LEN);
        let cipher = Aes256GcmSiv::new_from_slice(key).map_err(|_| SecretsError::Open)?;
        let context = context(workspace, field);
        cipher
            .decrypt(
                Nonce::from_slice(nonce),
                Payload {
                    msg: ciphertext,
                    aad: &context,
                },
            )
            .map(|plaintext| Some(Zeroizing::new(plaintext)))
            .map_err(|_| SecretsError::Open)
    }

    /// Removes one field; a workspace with nothing left is removed too.
    pub fn remove(&mut self, workspace: &str, field: Field) {
        if let Some(entry) = self.workspaces.get_mut(workspace) {
            *entry.slot(field) = None;
            if entry.s3.is_none() && entry.phrase.is_none() {
                self.workspaces.remove(workspace);
            }
        }
    }

    pub fn remove_workspace(&mut self, workspace: &str) {
        self.workspaces.remove(workspace);
    }
}

fn context(workspace: &str, field: Field) -> Vec<u8> {
    format!(
        "notebook::secrets::v{FORMAT}::{workspace}::{}",
        field.name()
    )
    .into_bytes()
}

pub fn new_master_key() -> Result<Zeroizing<[u8; KEY_LEN]>, SecretsError> {
    let mut key = Zeroizing::new([0_u8; KEY_LEN]);
    getrandom::fill(key.as_mut()).map_err(|_| SecretsError::Random)?;
    Ok(key)
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: [u8; KEY_LEN] = [7; KEY_LEN];

    #[test]
    fn values_round_trip_through_the_file_format() {
        let mut file = SecretsFile::default();
        file.seal(&KEY, "ws1", Field::S3, b"{\"access\":\"A\"}")
            .unwrap();
        file.seal(&KEY, "ws1", Field::Phrase, b"correct horse")
            .unwrap();
        let parsed = SecretsFile::parse(&file.to_bytes()).unwrap();
        assert_eq!(
            parsed
                .open(&KEY, "ws1", Field::Phrase)
                .unwrap()
                .unwrap()
                .as_slice(),
            b"correct horse"
        );
        assert!(parsed.has("ws1", Field::S3));
        assert_eq!(parsed.open(&KEY, "ws2", Field::S3).unwrap(), None);
    }

    #[test]
    fn plaintext_never_appears_in_the_file() {
        let mut file = SecretsFile::default();
        file.seal(&KEY, "ws", Field::Phrase, b"canary-phrase-123")
            .unwrap();
        let text = String::from_utf8(file.to_bytes()).unwrap();
        assert!(!text.contains("canary-phrase-123"));
        assert!(!format!("{file:?}").contains("canary"));
    }

    #[test]
    fn wrong_key_context_or_tampering_fail_to_open() {
        let mut file = SecretsFile::default();
        file.seal(&KEY, "ws", Field::Phrase, b"phrase").unwrap();
        assert_eq!(
            file.open(&[8; KEY_LEN], "ws", Field::Phrase).unwrap_err(),
            SecretsError::Open
        );
        // A value moved to another workspace or field does not open there.
        let sealed = file.get("ws", Field::Phrase).unwrap().to_owned();
        file.workspaces.entry("other".into()).or_default().phrase = Some(sealed.clone());
        file.workspaces.entry("ws".into()).or_default().s3 = Some(sealed.clone());
        assert_eq!(
            file.open(&KEY, "other", Field::Phrase).unwrap_err(),
            SecretsError::Open
        );
        assert_eq!(
            file.open(&KEY, "ws", Field::S3).unwrap_err(),
            SecretsError::Open
        );
        let mut bytes = STANDARD.decode(&sealed).unwrap();
        let last = bytes.len() - 1;
        bytes[last] ^= 1;
        file.workspaces.entry("ws".into()).or_default().phrase = Some(STANDARD.encode(bytes));
        assert_eq!(
            file.open(&KEY, "ws", Field::Phrase).unwrap_err(),
            SecretsError::Open
        );
    }

    #[test]
    fn removing_the_last_field_removes_the_workspace() {
        let mut file = SecretsFile::default();
        file.seal(&KEY, "ws", Field::S3, b"s3").unwrap();
        file.seal(&KEY, "ws", Field::Phrase, b"p").unwrap();
        file.remove("ws", Field::Phrase);
        assert!(file.has("ws", Field::S3) && !file.has("ws", Field::Phrase));
        file.remove("ws", Field::S3);
        assert!(file.is_empty());
    }

    #[test]
    fn unknown_versions_and_garbage_are_rejected() {
        assert_eq!(
            SecretsFile::parse(b"{\"version\":2}").unwrap_err(),
            SecretsError::Format
        );
        assert_eq!(
            SecretsFile::parse(b"not json").unwrap_err(),
            SecretsError::Format
        );
    }
}
