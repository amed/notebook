//! Vault keys, domain-separated subkeys, and vault-key wrapping.

use std::fmt;

use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use secrecy::{ExposeSecret, SecretBox};
use sha2::Sha256;
use thiserror::Error;
use uuid::Uuid;

pub const KEY_LEN: usize = 32;
pub const WRAP_NONCE_LEN: usize = 12;
pub const WRAPPED_VAULT_KEY_LEN: usize = KEY_LEN + 16;

const CONTENT_INFO: &[u8] = b"content-v1";
const DEDUPE_INFO: &[u8] = b"dedupe-v1";

macro_rules! secret_key_type {
    ($name:ident) => {
        /// A non-cloneable, zeroizing 256-bit secret key.
        pub struct $name(SecretBox<[u8; KEY_LEN]>);

        impl $name {
            pub(crate) fn from_bytes(bytes: [u8; KEY_LEN]) -> Self {
                Self(SecretBox::new(Box::new(bytes)))
            }

            pub(crate) fn as_bytes(&self) -> &[u8; KEY_LEN] {
                self.0.expose_secret()
            }
        }

        impl fmt::Debug for $name {
            fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("[redacted]")
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("[redacted]")
            }
        }
    };
}

secret_key_type!(KeyEncryptionKey);
secret_key_type!(VaultKey);
secret_key_type!(ContentKey);
secret_key_type!(DedupeKey);

impl VaultKey {
    /// Generates a new vault key directly from the operating system RNG.
    pub fn generate() -> Result<Self, KeyError> {
        let mut bytes = [0_u8; KEY_LEN];
        getrandom::fill(&mut bytes).map_err(|_| KeyError::RandomUnavailable)?;
        Ok(Self::from_bytes(bytes))
    }
}

/// The two purpose-separated keys derived from a vault key.
pub struct DerivedKeys {
    pub content: ContentKey,
    pub dedupe: DedupeKey,
}

impl fmt::Debug for DerivedKeys {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("DerivedKeys")
            .field("content", &"[redacted]")
            .field("dedupe", &"[redacted]")
            .finish()
    }
}

/// Serialized fields of an AES-GCM wrapped vault key.
///
/// The ciphertext includes the 16-byte GCM authentication tag.  Construction
/// from untrusted header fields is length checked before any cryptography runs.
#[derive(Clone, PartialEq, Eq)]
pub struct WrappedVaultKey {
    nonce: [u8; WRAP_NONCE_LEN],
    ciphertext: [u8; WRAPPED_VAULT_KEY_LEN],
}

impl fmt::Debug for WrappedVaultKey {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("WrappedVaultKey")
            .field("nonce", &self.nonce)
            .field("ciphertext_len", &self.ciphertext.len())
            .finish()
    }
}

impl WrappedVaultKey {
    pub fn try_from_parts(nonce: &[u8], ciphertext: &[u8]) -> Result<Self, KeyError> {
        let nonce = nonce
            .try_into()
            .map_err(|_| KeyError::InvalidWrappedNonceLength {
                actual: nonce.len(),
            })?;
        let ciphertext =
            ciphertext
                .try_into()
                .map_err(|_| KeyError::InvalidWrappedKeyLength {
                    actual: ciphertext.len(),
                })?;
        Ok(Self { nonce, ciphertext })
    }

    pub fn nonce(&self) -> &[u8; WRAP_NONCE_LEN] {
        &self.nonce
    }

    pub fn ciphertext(&self) -> &[u8; WRAPPED_VAULT_KEY_LEN] {
        &self.ciphertext
    }
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum KeyError {
    #[error("the operating system random source is unavailable")]
    RandomUnavailable,
    #[error("could not construct the cipher key")]
    CipherKeyRejected,
    #[error("vault-key wrapping failed")]
    WrapFailed,
    #[error("vault-key authentication failed")]
    AuthenticationFailed,
    #[error("HKDF expansion failed")]
    HkdfExpandFailed,
    #[error("HMAC key construction failed")]
    HmacKeyRejected,
    #[error("wrapped-key nonce has length {actual}, expected {WRAP_NONCE_LEN}")]
    InvalidWrappedNonceLength { actual: usize },
    #[error("wrapped key has length {actual}, expected {WRAPPED_VAULT_KEY_LEN}")]
    InvalidWrappedKeyLength { actual: usize },
}

/// Derives independent content-encryption and image-deduplication keys.
pub fn derive_subkeys(vault_key: &VaultKey, vault_id: Uuid) -> Result<DerivedKeys, KeyError> {
    let hkdf = Hkdf::<Sha256>::new(Some(vault_id.as_bytes()), vault_key.as_bytes());
    let mut content = [0_u8; KEY_LEN];
    let mut dedupe = [0_u8; KEY_LEN];

    hkdf.expand(CONTENT_INFO, &mut content)
        .map_err(|_| KeyError::HkdfExpandFailed)?;
    hkdf.expand(DEDUPE_INFO, &mut dedupe)
        .map_err(|_| KeyError::HkdfExpandFailed)?;

    Ok(DerivedKeys {
        content: ContentKey::from_bytes(content),
        dedupe: DedupeKey::from_bytes(dedupe),
    })
}

/// Computes the keyed image-deduplication digest.
pub fn dedupe_tag(key: &DedupeKey, image: &[u8]) -> Result<[u8; 32], KeyError> {
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(key.as_bytes())
        .map_err(|_| KeyError::HmacKeyRejected)?;
    mac.update(image);
    Ok(mac.finalize().into_bytes().into())
}

/// Computes the lowercase hexadecimal keyed image-deduplication digest.
pub fn dedupe_tag_hex(key: &DedupeKey, image: &[u8]) -> Result<String, KeyError> {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let digest = dedupe_tag(key, image)?;
    let mut encoded = String::with_capacity(digest.len() * 2);
    for byte in digest {
        encoded.push(char::from(HEX[usize::from(byte >> 4)]));
        encoded.push(char::from(HEX[usize::from(byte & 0x0f)]));
    }
    Ok(encoded)
}

/// Wraps the vault key using a fresh 96-bit OS-random nonce.
///
/// `header_aad` must be the canonical encoding of every plaintext index-header
/// field other than the wrap nonce and ciphertext.  Those two fields are
/// authenticated by GCM directly, avoiding an impossible self-reference.
pub fn wrap_vault_key(
    kek: &KeyEncryptionKey,
    vault_key: &VaultKey,
    header_aad: &[u8],
) -> Result<WrappedVaultKey, KeyError> {
    let mut nonce = [0_u8; WRAP_NONCE_LEN];
    getrandom::fill(&mut nonce).map_err(|_| KeyError::RandomUnavailable)?;
    wrap_vault_key_with_nonce(kek, vault_key, header_aad, nonce)
}

fn wrap_vault_key_with_nonce(
    kek: &KeyEncryptionKey,
    vault_key: &VaultKey,
    header_aad: &[u8],
    nonce: [u8; WRAP_NONCE_LEN],
) -> Result<WrappedVaultKey, KeyError> {
    let cipher =
        Aes256Gcm::new_from_slice(kek.as_bytes()).map_err(|_| KeyError::CipherKeyRejected)?;
    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: vault_key.as_bytes(),
                aad: header_aad,
            },
        )
        .map_err(|_| KeyError::WrapFailed)?;
    let ciphertext = ciphertext
        .try_into()
        .map_err(|_| KeyError::WrapFailed)?;
    Ok(WrappedVaultKey { nonce, ciphertext })
}

/// Authenticates the header binding and unwraps a vault key.
pub fn unwrap_vault_key(
    kek: &KeyEncryptionKey,
    wrapped: &WrappedVaultKey,
    header_aad: &[u8],
) -> Result<VaultKey, KeyError> {
    let cipher =
        Aes256Gcm::new_from_slice(kek.as_bytes()).map_err(|_| KeyError::CipherKeyRejected)?;
    let plaintext = cipher
        .decrypt(
            Nonce::from_slice(&wrapped.nonce),
            Payload {
                msg: &wrapped.ciphertext,
                aad: header_aad,
            },
        )
        .map_err(|_| KeyError::AuthenticationFailed)?;
    let bytes = plaintext
        .try_into()
        .map_err(|_| KeyError::AuthenticationFailed)?;
    Ok(VaultKey::from_bytes(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kek(byte: u8) -> KeyEncryptionKey {
        KeyEncryptionKey::from_bytes([byte; KEY_LEN])
    }

    fn vault_key(byte: u8) -> VaultKey {
        VaultKey::from_bytes([byte; KEY_LEN])
    }

    #[test]
    fn generated_vault_keys_are_not_reused() {
        let first = VaultKey::generate().unwrap();
        let second = VaultKey::generate().unwrap();
        assert_ne!(first.as_bytes(), second.as_bytes());
        assert_ne!(first.as_bytes(), &[0; KEY_LEN]);
    }

    #[test]
    fn key_formatting_is_always_redacted() {
        let key = vault_key(0x41);
        assert_eq!(format!("{key:?}"), "[redacted]");
        assert_eq!(format!("{key}"), "[redacted]");
        assert!(!format!("{key:?}").contains("41"));
    }

    #[test]
    fn hkdf_is_deterministic_and_domain_separated() {
        let id = Uuid::from_u128(0x0123456789abcdef0123456789abcdef);
        let first = derive_subkeys(&vault_key(7), id).unwrap();
        let second = derive_subkeys(&vault_key(7), id).unwrap();
        let other_vault = derive_subkeys(&vault_key(7), Uuid::from_u128(2)).unwrap();

        assert_eq!(first.content.as_bytes(), second.content.as_bytes());
        assert_eq!(first.dedupe.as_bytes(), second.dedupe.as_bytes());
        assert_ne!(first.content.as_bytes(), first.dedupe.as_bytes());
        assert_ne!(first.content.as_bytes(), other_vault.content.as_bytes());
        assert_ne!(first.dedupe.as_bytes(), other_vault.dedupe.as_bytes());
    }

    #[test]
    fn dedupe_tags_are_keyed_and_stable() {
        let id = Uuid::from_u128(9);
        let first = derive_subkeys(&vault_key(3), id).unwrap();
        let second = derive_subkeys(&vault_key(4), id).unwrap();

        let tag = dedupe_tag(&first.dedupe, b"image bytes").unwrap();
        assert_eq!(tag, dedupe_tag(&first.dedupe, b"image bytes").unwrap());
        assert_ne!(tag, dedupe_tag(&first.dedupe, b"other bytes").unwrap());
        assert_ne!(tag, dedupe_tag(&second.dedupe, b"image bytes").unwrap());

        let hex = dedupe_tag_hex(&first.dedupe, b"image bytes").unwrap();
        assert_eq!(hex.len(), 64);
        assert!(hex.bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()));
    }

    #[test]
    fn wrap_round_trip_is_bound_to_the_entire_header_aad() {
        let kek = kek(0x11);
        let vk = vault_key(0x22);
        let header = br#"{"vault_id":"v","created":1,"kdf":{"m_kib":131072}}"#;
        let wrapped = wrap_vault_key_with_nonce(&kek, &vk, header, [0x33; 12]).unwrap();
        let opened = unwrap_vault_key(&kek, &wrapped, header).unwrap();
        assert_eq!(opened.as_bytes(), vk.as_bytes());

        for index in 0..header.len() {
            let mut changed = header.to_vec();
            changed[index] ^= 1;
            assert_eq!(
                unwrap_vault_key(&kek, &wrapped, &changed),
                Err(KeyError::AuthenticationFailed)
            );
        }
    }

    #[test]
    fn wrong_kek_and_every_wrap_field_tamper_are_rejected() {
        let good_kek = kek(1);
        let wrapped =
            wrap_vault_key_with_nonce(&good_kek, &vault_key(2), b"header", [3; 12]).unwrap();
        assert_eq!(
            unwrap_vault_key(&kek(9), &wrapped, b"header"),
            Err(KeyError::AuthenticationFailed)
        );

        for index in 0..WRAP_NONCE_LEN {
            let mut changed = wrapped.clone();
            changed.nonce[index] ^= 1;
            assert_eq!(
                unwrap_vault_key(&good_kek, &changed, b"header"),
                Err(KeyError::AuthenticationFailed)
            );
        }
        for index in 0..WRAPPED_VAULT_KEY_LEN {
            let mut changed = wrapped.clone();
            changed.ciphertext[index] ^= 1;
            assert_eq!(
                unwrap_vault_key(&good_kek, &changed, b"header"),
                Err(KeyError::AuthenticationFailed)
            );
        }
    }

    #[test]
    fn wrapped_key_parts_require_exact_lengths() {
        let nonce = [0_u8; WRAP_NONCE_LEN];
        let ciphertext = [0_u8; WRAPPED_VAULT_KEY_LEN];
        assert!(WrappedVaultKey::try_from_parts(&nonce, &ciphertext).is_ok());

        for length in [0, WRAP_NONCE_LEN - 1, WRAP_NONCE_LEN + 1] {
            assert_eq!(
                WrappedVaultKey::try_from_parts(&vec![0; length], &ciphertext),
                Err(KeyError::InvalidWrappedNonceLength { actual: length })
            );
        }
        for length in [0, WRAPPED_VAULT_KEY_LEN - 1, WRAPPED_VAULT_KEY_LEN + 1] {
            assert_eq!(
                WrappedVaultKey::try_from_parts(&nonce, &vec![0; length]),
                Err(KeyError::InvalidWrappedKeyLength { actual: length })
            );
        }
    }
}
