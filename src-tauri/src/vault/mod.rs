//! Pure, in-memory vault index and virtual filesystem operations.
//!
//! This module deliberately performs no network or filesystem I/O.  Operations
//! describe the storage work that must happen around an index upload, leaving
//! ordering and retries to the sync layer.

mod index;
mod names;
mod ops;
mod trash;

pub use index::{
    ImageMeta, Index, IndexValidationError, ItemKind, Node, NodeKind, Origin,
    INDEX_FORMAT, ROOT_ID, TRASH_ID,
};
pub use names::{
    comparison_key, normalize_name, NameError, DEFAULT_ITEM_NAME, MAX_NAME_CHARS,
};
pub use ops::{
    ApplyResult, DroppedOperation, FlushPriority, Op, OpOutcome, OperationLog,
    ReplayReport, RestoreMode, StorageWork, VaultError,
};
pub use trash::{PurgeSummary, RestoreResult, TrashResult};
