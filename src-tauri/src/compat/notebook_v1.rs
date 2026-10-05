//! Byte-compatible codec for <https://github.com/amed/notebook> remote
//! encryption as of commit `e0d626ee6a673ddd96ea9b72fa617b7b8d383fb8`.
//!
//! This format predates the SMDV envelope. It intentionally receives its own
//! module so its weaker metadata binding cannot be confused with native vault
//! objects.

use aes_gcm_siv::aead::{Aead, KeyInit};
use aes_gcm_siv::{Aes256GcmSiv, Nonce};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use pbkdf2::pbkdf2_hmac;
use secrecy::{ExposeSecret, SecretString};
use sha2::{Digest, Sha256};
use std::fmt;
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

const PBKDF2_ROUNDS: u32 = 120_000;
const NONCE_LEN: usize = 12;
const TAG_LEN: usize = 16;
pub const DIRECTORY_MARKER: &str = ".notebook_dir";

#[derive(Debug, thiserror::Error, Clone, Copy, PartialEq, Eq)]
pub enum LegacyCodecError {
    #[error("the legacy encryption phrase is empty")]
    EmptyPhrase,
    #[error("the encrypted path is malformed or uses another key")]
    InvalidPath,
    #[error("the encrypted document is malformed or uses another key")]
    InvalidContent,
    #[error("the decrypted value is not valid UTF-8")]
    InvalidUtf8,
    #[error("randomness is unavailable")]
    Randomness,
}

#[derive(Clone, Zeroize, ZeroizeOnDrop)]
struct LegacyKeys {
    path: [u8; 32],
    content: [u8; 32],
    reference: [u8; 8],
}

impl fmt::Debug for LegacyKeys {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("LegacyKeys([redacted])")
    }
}

/// Codec for the old application's encrypted S3 object names and bodies.
#[derive(Clone)]
pub struct NotebookV1Codec {
    keys: LegacyKeys,
}

impl fmt::Debug for NotebookV1Codec {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("NotebookV1Codec")
            .field("key_reference", &self.key_reference())
            .finish_non_exhaustive()
    }
}

impl NotebookV1Codec {
    /// The historical implementation applies `str::trim` and no Unicode
    /// normalization. Preserving that behavior is required for compatibility.
    pub fn new(phrase: SecretString) -> Result<Self, LegacyCodecError> {
        let trimmed = phrase.expose_secret().trim();
        if trimmed.is_empty() {
            return Err(LegacyCodecError::EmptyPhrase);
        }

        let bytes = Zeroizing::new(trimmed.as_bytes().to_vec());
        let reference_key = derive_key(b"reference", bytes.as_slice());
        let mut reference = [0_u8; 8];
        reference.copy_from_slice(&reference_key[..8]);
        Ok(Self {
            keys: LegacyKeys {
                path: derive_key(b"path", bytes.as_slice()),
                content: derive_key(b"content", bytes.as_slice()),
                reference,
            },
        })
    }

    pub fn key_reference(&self) -> String {
        hex::encode(self.keys.reference)
    }

    /// Encrypts every non-empty slash-delimited segment. The configured S3
    /// prefix is not passed to this function and therefore remains plaintext.
    pub fn encode_path(&self, logical_path: &str) -> Result<String, LegacyCodecError> {
        let cipher = Aes256GcmSiv::new_from_slice(&self.keys.path)
            .map_err(|_| LegacyCodecError::InvalidPath)?;
        let mut encoded = Vec::new();
        let mut parent = String::new();

        for segment in logical_path
            .split('/')
            .filter(|segment| !segment.is_empty())
        {
            let nonce = path_nonce(&parent);
            let encrypted = cipher
                .encrypt(Nonce::from_slice(&nonce), segment.as_bytes())
                .map_err(|_| LegacyCodecError::InvalidPath)?;
            encoded.push(URL_SAFE_NO_PAD.encode(encrypted));
            push_segment(&mut parent, segment);
        }

        Ok(encoded.join("/"))
    }

    pub fn decode_path(&self, stored_path: &str) -> Result<String, LegacyCodecError> {
        let cipher = Aes256GcmSiv::new_from_slice(&self.keys.path)
            .map_err(|_| LegacyCodecError::InvalidPath)?;
        let mut decoded = Vec::new();
        let mut parent = String::new();

        for segment in stored_path.split('/').filter(|segment| !segment.is_empty()) {
            let encrypted = URL_SAFE_NO_PAD
                .decode(segment)
                .map_err(|_| LegacyCodecError::InvalidPath)?;
            let nonce = path_nonce(&parent);
            let plaintext = Zeroizing::new(
                cipher
                    .decrypt(Nonce::from_slice(&nonce), encrypted.as_slice())
                    .map_err(|_| LegacyCodecError::InvalidPath)?,
            );
            let name = std::str::from_utf8(plaintext.as_slice())
                .map_err(|_| LegacyCodecError::InvalidUtf8)?
                .to_owned();
            push_segment(&mut parent, &name);
            decoded.push(name);
        }

        Ok(decoded.join("/"))
    }

    pub fn encode_content(&self, text: &str) -> Result<Zeroizing<Vec<u8>>, LegacyCodecError> {
        let mut nonce = [0_u8; NONCE_LEN];
        getrandom::fill(&mut nonce).map_err(|_| LegacyCodecError::Randomness)?;
        self.encode_content_with_nonce(text, nonce)
    }

    fn encode_content_with_nonce(
        &self,
        text: &str,
        nonce: [u8; NONCE_LEN],
    ) -> Result<Zeroizing<Vec<u8>>, LegacyCodecError> {
        let cipher = Aes256GcmSiv::new_from_slice(&self.keys.content)
            .map_err(|_| LegacyCodecError::InvalidContent)?;
        let encrypted = cipher
            .encrypt(Nonce::from_slice(&nonce), text.as_bytes())
            .map_err(|_| LegacyCodecError::InvalidContent)?;
        let mut payload = Zeroizing::new(Vec::with_capacity(NONCE_LEN + encrypted.len()));
        payload.extend_from_slice(&nonce);
        payload.extend_from_slice(&encrypted);
        Ok(payload)
    }

    pub fn decode_content(&self, payload: &[u8]) -> Result<Zeroizing<String>, LegacyCodecError> {
        if payload.len() < NONCE_LEN + TAG_LEN {
            return Err(LegacyCodecError::InvalidContent);
        }
        let (nonce, encrypted) = payload.split_at(NONCE_LEN);
        let cipher = Aes256GcmSiv::new_from_slice(&self.keys.content)
            .map_err(|_| LegacyCodecError::InvalidContent)?;
        let plaintext = Zeroizing::new(
            cipher
                .decrypt(Nonce::from_slice(nonce), encrypted)
                .map_err(|_| LegacyCodecError::InvalidContent)?,
        );
        let text =
            String::from_utf8(plaintext.to_vec()).map_err(|_| LegacyCodecError::InvalidUtf8)?;
        Ok(Zeroizing::new(text))
    }

    /// Decodes listed S3 keys while keeping the configured prefix out of the
    /// cipher. Keys encrypted with another phrase are reported but never shown
    /// as misleading plaintext names.
    pub fn decode_listing<'a>(
        &self,
        prefix: Option<&str>,
        keys: impl IntoIterator<Item = &'a str>,
    ) -> LegacyListing {
        let normalized_prefix = prefix
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| value.trim_matches('/'));
        let mut listing = LegacyListing::default();

        for stored_key in keys {
            let relative = match normalized_prefix {
                Some(prefix) => stored_key
                    .strip_prefix(prefix)
                    .and_then(|rest| rest.strip_prefix('/')),
                None => Some(stored_key.trim_matches('/')),
            };
            let Some(relative) = relative.filter(|value| !value.is_empty()) else {
                continue;
            };
            match self.decode_path(relative) {
                Ok(path)
                    if path.ends_with(&format!("/{DIRECTORY_MARKER}"))
                        || path == DIRECTORY_MARKER =>
                {
                    listing.directory_markers.push(path);
                }
                Ok(path) => listing.files.push(LegacyListedFile {
                    logical_path: path,
                    stored_key: stored_key.to_owned(),
                }),
                Err(_) => listing.undecodable += 1,
            }
        }
        listing
            .files
            .sort_by(|left, right| left.logical_path.cmp(&right.logical_path));
        listing.directory_markers.sort();
        listing
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LegacyListedFile {
    pub logical_path: String,
    pub stored_key: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LegacyListing {
    pub files: Vec<LegacyListedFile>,
    pub directory_markers: Vec<String>,
    pub undecodable: usize,
}

fn derive_key(label: &[u8], phrase: &[u8]) -> [u8; 32] {
    let mut salt = Zeroizing::new(b"notebook::remote-encryption::".to_vec());
    salt.extend_from_slice(label);
    let mut output = [0_u8; 32];
    pbkdf2_hmac::<Sha256>(phrase, salt.as_slice(), PBKDF2_ROUNDS, &mut output);
    output
}

fn path_nonce(parent_path: &str) -> [u8; NONCE_LEN] {
    let mut hasher = Sha256::new();
    hasher.update(b"notebook::path::");
    hasher.update(parent_path.as_bytes());
    let digest = hasher.finalize();
    let mut nonce = [0_u8; NONCE_LEN];
    nonce.copy_from_slice(&digest[..NONCE_LEN]);
    nonce
}

fn push_segment(parent: &mut String, segment: &str) {
    if !parent.is_empty() {
        parent.push('/');
    }
    parent.push_str(segment);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn codec(phrase: &str) -> NotebookV1Codec {
        NotebookV1Codec::new(SecretString::from(phrase.to_owned())).unwrap()
    }

    #[test]
    fn compatibility_path_round_trip_and_determinism() {
        let codec = codec("correct horse battery staple");
        let first = codec.encode_path("projects/roadmap/todo.md").unwrap();
        let second = codec.encode_path("projects/roadmap/todo.md").unwrap();
        assert_eq!(first, second);
        assert_ne!(first, "projects/roadmap/todo.md");
        assert_eq!(
            codec.decode_path(&first).unwrap(),
            "projects/roadmap/todo.md"
        );
    }

    #[test]
    fn fixture_listing_shows_decrypted_file_names() {
        let fixture_codec = codec("fixture phrase");
        let note_key = format!(
            "my-prefix/{}",
            fixture_codec.encode_path("notes/hello.md").unwrap()
        );
        let marker_key = format!(
            "my-prefix/{}",
            fixture_codec
                .encode_path("empty-folder/.notebook_dir")
                .unwrap()
        );
        let wrong_key = format!(
            "my-prefix/{}",
            codec("another phrase").encode_path("hidden.md").unwrap()
        );
        let listing = fixture_codec.decode_listing(
            Some("my-prefix"),
            [note_key.as_str(), marker_key.as_str(), wrong_key.as_str()],
        );
        assert_eq!(listing.files[0].logical_path, "notes/hello.md");
        assert_eq!(listing.directory_markers, ["empty-folder/.notebook_dir"]);
        assert_eq!(listing.undecodable, 1);
    }

    #[test]
    fn content_matches_legacy_layout_and_authenticates() {
        let codec = codec("fixture phrase");
        let nonce = [0x5a; NONCE_LEN];
        let encrypted = codec
            .encode_content_with_nonce("# Secret\nhello", nonce)
            .unwrap();
        assert_eq!(&encrypted[..NONCE_LEN], &nonce);
        assert_eq!(
            encrypted.len(),
            NONCE_LEN + "# Secret\nhello".len() + TAG_LEN
        );
        assert_eq!(
            codec.decode_content(&encrypted).unwrap().as_str(),
            "# Secret\nhello"
        );

        let mut tampered = encrypted.to_vec();
        let last = tampered.len() - 1;
        tampered[last] ^= 1;
        assert_eq!(
            codec.decode_content(&tampered),
            Err(LegacyCodecError::InvalidContent)
        );
    }

    #[test]
    fn wrong_phrase_cannot_read_names_or_content() {
        let right = codec("right phrase");
        let wrong = codec("wrong phrase");
        let name = right.encode_path("private/note.md").unwrap();
        let body = right
            .encode_content_with_nonce("classified", [7; NONCE_LEN])
            .unwrap();
        assert_eq!(wrong.decode_path(&name), Err(LegacyCodecError::InvalidPath));
        assert_eq!(
            wrong.decode_content(&body),
            Err(LegacyCodecError::InvalidContent)
        );
    }

    #[test]
    fn historical_trim_behavior_is_preserved() {
        assert_eq!(
            codec(" phrase ").key_reference(),
            codec("phrase").key_reference()
        );
    }
}

#[cfg(test)]
mod properties {
    use super::*;
    use proptest::prelude::*;
    use std::sync::OnceLock;

    // PBKDF2 runs 120,000 rounds, so every case shares one derived codec.
    fn shared_codec() -> &'static NotebookV1Codec {
        static CODEC: OnceLock<NotebookV1Codec> = OnceLock::new();
        CODEC.get_or_init(|| {
            NotebookV1Codec::new(SecretString::from("property phrase".to_owned())).unwrap()
        })
    }

    #[test]
    fn content_round_trips_at_block_boundaries() {
        let codec = shared_codec();
        for size in [0, 1, 15, 16, 17, 1024, 1024 * 1024] {
            let text = "a".repeat(size);
            let payload = codec.encode_content(&text).unwrap();
            assert_eq!(payload.len(), NONCE_LEN + size + TAG_LEN);
            assert_eq!(codec.decode_content(&payload).unwrap().as_str(), text);
        }
    }

    proptest! {
        #[test]
        fn paths_round_trip_as_opaque_base64url(
            segments in prop::collection::vec("[^/\\x00]{1,40}", 1..6)
        ) {
            let path = segments.join("/");
            let codec = shared_codec();
            let stored = codec.encode_path(&path).unwrap();
            prop_assert!(stored
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'/')));
            prop_assert_eq!(stored.split('/').count(), segments.len());
            prop_assert_eq!(codec.decode_path(&stored).unwrap(), path);
        }

        #[test]
        fn content_round_trips_and_rejects_any_bit_flip(
            text in "\\PC{0,512}",
            position in any::<prop::sample::Index>(),
            bit in 0_u8..8,
        ) {
            let codec = shared_codec();
            let payload = codec.encode_content(&text).unwrap();
            let decoded = codec.decode_content(&payload).unwrap();
            prop_assert_eq!(decoded.as_str(), text.as_str());

            let mut tampered = payload.to_vec();
            let index = position.index(tampered.len());
            tampered[index] ^= 1 << bit;
            prop_assert!(codec.decode_content(&tampered).is_err());
        }
    }
}
