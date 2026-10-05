use super::{DeleteReport, ETag, ObjectKey, ObjectStore, PutCondition, StoreError};
use bytes::Bytes;
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Operation {
    Get,
    PutBeforeWrite,
    PutAfterWrite,
    DeleteBeforeWrite,
    DeleteAfterWrite,
}

#[derive(Clone, Debug)]
pub struct Fault {
    pub operation: Operation,
    pub error: StoreError,
}

/// Failure-injection wrapper used to exercise ambiguous network outcomes. A
/// `PutAfterWrite` forwards the write and then reports the injected error,
/// reproducing the case where S3 committed a request but the response was lost.
#[derive(Clone)]
pub struct FaultyStore<S> {
    inner: S,
    faults: Arc<Mutex<VecDeque<Fault>>>,
}

impl<S> FaultyStore<S> {
    pub fn new(inner: S) -> Self {
        Self { inner, faults: Arc::new(Mutex::new(VecDeque::new())) }
    }

    pub fn push(&self, operation: Operation, error: StoreError) {
        self.faults
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .push_back(Fault { operation, error });
    }

    pub fn inner(&self) -> &S {
        &self.inner
    }

    fn take(&self, operation: Operation) -> Option<StoreError> {
        let mut faults = self.faults.lock().unwrap_or_else(|poison| poison.into_inner());
        let position = faults.iter().position(|fault| fault.operation == operation)?;
        faults.remove(position).map(|fault| fault.error)
    }
}

impl<S: ObjectStore> ObjectStore for FaultyStore<S> {
    async fn get(&self, key: &ObjectKey) -> Result<(Bytes, ETag), StoreError> {
        if let Some(error) = self.take(Operation::Get) {
            return Err(error);
        }
        self.inner.get(key).await
    }

    async fn put(
        &self,
        key: &ObjectKey,
        body: Bytes,
        condition: PutCondition,
    ) -> Result<ETag, StoreError> {
        if let Some(error) = self.take(Operation::PutBeforeWrite) {
            return Err(error);
        }
        let result = self.inner.put(key, body, condition).await;
        if result.is_ok() {
            if let Some(error) = self.take(Operation::PutAfterWrite) {
                return Err(error);
            }
        }
        result
    }

    async fn delete_many(&self, keys: &[ObjectKey]) -> Result<DeleteReport, StoreError> {
        if let Some(error) = self.take(Operation::DeleteBeforeWrite) {
            return Err(error);
        }
        let result = self.inner.delete_many(keys).await;
        if result.is_ok() {
            if let Some(error) = self.take(Operation::DeleteAfterWrite) {
                return Err(error);
            }
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::memory::MemoryStore;

    #[tokio::test]
    async fn can_fail_after_a_successful_write() {
        let memory = MemoryStore::default();
        let store = FaultyStore::new(memory.clone());
        let key = ObjectKey::object(uuid::Uuid::new_v4());
        store.push(Operation::PutAfterWrite, StoreError::Network);
        assert_eq!(
            store.put(&key, Bytes::from_static(b"ciphertext"), PutCondition::IfNoneMatch).await,
            Err(StoreError::Network)
        );
        assert!(memory.contains(&key));
        assert_eq!(
            store.put(&key, Bytes::new(), PutCondition::IfNoneMatch).await,
            Err(StoreError::PreconditionFailed)
        );
    }
}
