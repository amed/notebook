//! Pure cryptographic building blocks for the vault.
//!
//! This module deliberately performs no filesystem or network I/O.  Callers are
//! responsible for mapping the detailed errors here to the deliberately vague
//! unlock errors presented to users.

pub mod envelope;
pub mod kdf;
pub mod keys;

pub use envelope::{
    open, seal, EnvelopeContext, EnvelopeError, ObjectKind, ENVELOPE_MAGIC,
    ENVELOPE_VERSION,
};
pub use kdf::{
    calibrate, calibrate_with, derive_kek, normalize_passphrase, random_salt,
    KdfError, KdfParams, KdfSalt,
};
pub use keys::{
    dedupe_tag, dedupe_tag_hex, derive_subkeys, unwrap_vault_key, wrap_vault_key,
    ContentKey, DedupeKey, DerivedKeys, KeyEncryptionKey, KeyError, VaultKey,
    WrappedVaultKey,
};
