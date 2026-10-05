use super::{DeleteReport, ETag, ObjectKey, ObjectStore, PutCondition, StoreError};
use bytes::Bytes;
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct RequestCounts {
    pub get: usize,
    pub put: usize,
    pub delete_objects: usize,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Call {
    Get(ObjectKey),
    Put(ObjectKey, PutCondition),
    Delete(Vec<ObjectKey>),
}

#[derive(Clone, Default)]
pub struct MemoryStore {
    inner: Arc<Mutex<State>>,
}

#[derive(Default)]
struct State {
    objects: BTreeMap<ObjectKey, (Bytes, ETag)>,
    next_etag: u64,
    calls: Vec<Call>,
}

impl MemoryStore {
    pub fn counts(&self) -> RequestCounts {
        let state = self.inner.lock().unwrap_or_else(|poison| poison.into_inner());
        state.calls.iter().fold(RequestCounts::default(), |mut counts, call| {
            match call {
                Call::Get(_) => counts.get += 1,
                Call::Put(_, _) => counts.put += 1,
                Call::Delete(_) => counts.delete_objects += 1,
            }
            counts
        })
    }

    pub fn calls(&self) -> Vec<Call> {
        self.inner
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .calls
            .clone()
    }

    pub fn reset_calls(&self) {
        self.inner
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .calls
            .clear();
    }

    /// Inserts test fixture ciphertext without counting a request. Production
    /// code cannot use this method to bypass conditional writes.
    #[cfg(test)]
    pub fn seed(&self, key: ObjectKey, body: Bytes) -> ETag {
        let mut state = self.inner.lock().unwrap_or_else(|poison| poison.into_inner());
        state.next_etag += 1;
        let etag = ETag::new(format!("\"memory-{}\"", state.next_etag))
            .expect("generated ETag is valid");
        state.objects.insert(key, (body, etag.clone()));
        etag
    }

    #[cfg(test)]
    pub fn contains(&self, key: &ObjectKey) -> bool {
        self.inner
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .objects
            .contains_key(key)
    }
}

impl ObjectStore for MemoryStore {
    async fn get(&self, key: &ObjectKey) -> Result<(Bytes, ETag), StoreError> {
        let mut state = self.inner.lock().unwrap_or_else(|poison| poison.into_inner());
        state.calls.push(Call::Get(key.clone()));
        state
            .objects
            .get(key)
            .cloned()
            .ok_or(StoreError::MissingOrDenied)
    }

    async fn put(
        &self,
        key: &ObjectKey,
        body: Bytes,
        condition: PutCondition,
    ) -> Result<ETag, StoreError> {
        let mut state = self.inner.lock().unwrap_or_else(|poison| poison.into_inner());
        state.calls.push(Call::Put(key.clone(), condition.clone()));
        match &condition {
            PutCondition::IfNoneMatch if state.objects.contains_key(key) => {
                return Err(StoreError::PreconditionFailed);
            }
            PutCondition::IfMatch(expected) => {
                if state.objects.get(key).map(|(_, tag)| tag) != Some(expected) {
                    return Err(StoreError::PreconditionFailed);
                }
            }
            PutCondition::IfNoneMatch => {}
        }
        state.next_etag += 1;
        let etag = ETag::new(format!("\"memory-{}\"", state.next_etag))?;
        state.objects.insert(key.clone(), (body, etag.clone()));
        Ok(etag)
    }

    async fn delete_many(&self, keys: &[ObjectKey]) -> Result<DeleteReport, StoreError> {
        if keys.len() > 1_000 {
            return Err(StoreError::InvalidResponse);
        }
        let mut state = self.inner.lock().unwrap_or_else(|poison| poison.into_inner());
        state.calls.push(Call::Delete(keys.to_vec()));
        for key in keys {
            state.objects.remove(key);
        }
        Ok(DeleteReport { deleted: keys.to_vec(), failed: Vec::new() })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn every_write_is_conditional_and_etags_are_opaque() {
        let store = MemoryStore::default();
        let key = ObjectKey::object(uuid::Uuid::new_v4());
        let first = store
            .put(&key, Bytes::from_static(b"one"), PutCondition::IfNoneMatch)
            .await
            .unwrap();
        assert_eq!(
            store.put(&key, Bytes::new(), PutCondition::IfNoneMatch).await,
            Err(StoreError::PreconditionFailed)
        );
        assert_eq!(
            store
                .put(
                    &key,
                    Bytes::new(),
                    PutCondition::IfMatch(ETag::new("not-the-etag").unwrap()),
                )
                .await,
            Err(StoreError::PreconditionFailed)
        );
        let second = store
            .put(&key, Bytes::from_static(b"two"), PutCondition::IfMatch(first))
            .await
            .unwrap();
        assert_eq!(store.get(&key).await.unwrap(), (Bytes::from_static(b"two"), second));
        assert_eq!(store.counts(), RequestCounts { get: 1, put: 3, delete_objects: 0 });
    }

    #[tokio::test]
    async fn delete_is_one_batch_and_missing_counts_as_deleted() {
        let store = MemoryStore::default();
        let keys = [ObjectKey::object(uuid::Uuid::new_v4()), ObjectKey::object(uuid::Uuid::new_v4())];
        let report = store.delete_many(&keys).await.unwrap();
        assert_eq!(report.deleted, keys);
        assert!(report.failed.is_empty());
        assert_eq!(store.counts().delete_objects, 1);
    }
}
