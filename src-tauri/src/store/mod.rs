//! Ciphertext-only object storage boundary.
//!
//! The deliberately small trait makes LIST, HEAD, COPY and unconditional PUT
//! impossible to introduce through the vault core.

use bytes::Bytes;
use serde::{Deserialize, Serialize};
use std::fmt;
use uuid::Uuid;

pub mod faulty;
pub mod memory;
pub mod outbox;
pub mod s3;

#[derive(Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ObjectKey(String);

impl ObjectKey {
    pub const INDEX: &'static str = "index";

    pub fn index() -> Self {
        Self(Self::INDEX.to_owned())
    }

    pub fn object(id: Uuid) -> Self {
        Self(format!("o/{id}.enc"))
    }

    pub fn parse(value: impl Into<String>) -> Result<Self, StoreError> {
        let value = value.into();
        if value == Self::INDEX {
            return Ok(Self(value));
        }
        let Some(id) = value
            .strip_prefix("o/")
            .and_then(|rest| rest.strip_suffix(".enc"))
        else {
            return Err(StoreError::InvalidResponse);
        };
        let parsed = Uuid::parse_str(id).map_err(|_| StoreError::InvalidResponse)?;
        if parsed.hyphenated().to_string() != id.to_ascii_lowercase() {
            return Err(StoreError::InvalidResponse);
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for ObjectKey {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.debug_tuple("ObjectKey").field(&self.0).finish()
    }
}

impl fmt::Display for ObjectKey {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ETag(String);

impl ETag {
    pub fn new(value: impl Into<String>) -> Result<Self, StoreError> {
        let value = value.into();
        if value.is_empty() || value.len() > 1_024 || value.contains(['\r', '\n']) {
            return Err(StoreError::InvalidResponse);
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PutCondition {
    IfNoneMatch,
    IfMatch(ETag),
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct DeleteReport {
    pub deleted: Vec<ObjectKey>,
    pub failed: Vec<ObjectKey>,
}

#[derive(Clone, Debug, thiserror::Error, PartialEq, Eq)]
pub enum StoreError {
    #[error("object missing or access was denied")]
    MissingOrDenied,
    #[error("access denied")]
    Denied,
    #[error("write precondition failed")]
    PreconditionFailed,
    #[error("network unavailable")]
    Network,
    #[error("request throttled")]
    Throttled,
    #[error("storage service returned HTTP {0}")]
    Server(u16),
    #[error("storage service returned an invalid response")]
    InvalidResponse,
}

impl StoreError {
    pub fn retryable(&self) -> bool {
        matches!(
            self,
            Self::Network | Self::Throttled | Self::Server(500 | 502 | 503 | 504)
        )
    }
}

#[allow(async_fn_in_trait)]
pub trait ObjectStore: Send + Sync {
    async fn get(&self, key: &ObjectKey) -> Result<(Bytes, ETag), StoreError>;

    async fn put(
        &self,
        key: &ObjectKey,
        body: Bytes,
        condition: PutCondition,
    ) -> Result<ETag, StoreError>;

    async fn delete_many(&self, keys: &[ObjectKey]) -> Result<DeleteReport, StoreError>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn object_key_rejects_everything_outside_the_layout() {
        assert!(ObjectKey::parse("index").is_ok());
        let id = Uuid::new_v4();
        assert!(ObjectKey::parse(format!("o/{id}.enc")).is_ok());
        for invalid in [
            "",
            "other",
            "o/nope.enc",
            "o/../index.enc",
            "prefix/index",
            "o/00000000-0000-0000-0000-000000000001",
        ] {
            assert!(ObjectKey::parse(invalid).is_err(), "accepted {invalid}");
        }
    }
}
