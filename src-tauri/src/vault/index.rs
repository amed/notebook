//! Serializable vault index schema and structural validation.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

use super::names::{comparison_key, normalize_name};

pub const INDEX_FORMAT: u32 = 1;
pub const ROOT_ID: Uuid = Uuid::from_u128(1);
pub const TRASH_ID: Uuid = Uuid::from_u128(2);

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Index {
    pub format: u32,
    pub revision: u64,
    pub nodes: BTreeMap<Uuid, Node>,
    pub images: BTreeMap<Uuid, ImageMeta>,
    pub image_dedupe: BTreeMap<String, Uuid>,
    pub pending_purge: Vec<Uuid>,
}

impl fmt::Debug for Index {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Index")
            .field("format", &self.format)
            .field("revision", &self.revision)
            .field("node_count", &self.nodes.len())
            .field("image_count", &self.images.len())
            .field("dedupe_count", &self.image_dedupe.len())
            .field("pending_purge_count", &self.pending_purge.len())
            .finish()
    }
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Node {
    pub id: Uuid,
    pub parent: Option<Uuid>,
    pub name: String,
    pub created: i64,
    pub modified: i64,
    pub kind: NodeKind,
}

impl fmt::Debug for Node {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Node")
            .field("id", &self.id)
            .field("parent", &self.parent)
            .field("name", &"[redacted]")
            .field("created", &self.created)
            .field("modified", &self.modified)
            .field("kind", &self.kind)
            .finish()
    }
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum NodeKind {
    Folder,
    Document {
        size: u64,
        rev: u64,
        images: Vec<Uuid>,
    },
    TrashEntry,
    TrashOrigin(Origin),
}

impl fmt::Debug for NodeKind {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Folder => formatter.write_str("Folder"),
            Self::Document { size, rev, images } => formatter
                .debug_struct("Document")
                .field("size", size)
                .field("rev", rev)
                .field("image_count", &images.len())
                .finish(),
            Self::TrashEntry => formatter.write_str("TrashEntry"),
            Self::TrashOrigin(origin) => formatter.debug_tuple("TrashOrigin").field(origin).finish(),
        }
    }
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Origin {
    pub item_id: Uuid,
    pub parent_id: Uuid,
    pub path: Vec<String>,
    pub name: String,
    pub deleted_at: i64,
    pub item_kind: ItemKind,
    pub doc_count: u32,
    pub folder_count: u32,
    pub image_count: u32,
}

impl fmt::Debug for Origin {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Origin")
            .field("item_id", &self.item_id)
            .field("parent_id", &self.parent_id)
            .field("path", &"[redacted]")
            .field("name", &"[redacted]")
            .field("deleted_at", &self.deleted_at)
            .field("item_kind", &self.item_kind)
            .field("doc_count", &self.doc_count)
            .field("folder_count", &self.folder_count)
            .field("image_count", &self.image_count)
            .finish()
    }
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub enum ItemKind {
    Folder,
    Document,
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ImageMeta {
    pub mime: u8,
    pub size: u64,
    pub original_name: String,
    pub created: i64,
}

impl fmt::Debug for ImageMeta {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ImageMeta")
            .field("mime", &self.mime)
            .field("size", &self.size)
            .field("original_name", &"[redacted]")
            .field("created", &self.created)
            .finish()
    }
}

#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum IndexValidationError {
    #[error("The index format is unsupported.")]
    UnsupportedFormat,
    #[error("A required vault root is missing or malformed.")]
    InvalidRoot,
    #[error("A node ID does not match its index key.")]
    NodeIdMismatch,
    #[error("A node has an invalid name.")]
    InvalidName,
    #[error("A node has no valid parent.")]
    InvalidParent,
    #[error("The node graph contains a cycle.")]
    Cycle,
    #[error("A structural Trash node is in an invalid location.")]
    InvalidTrashStructure,
    #[error("A Trash entry does not contain exactly one item and one origin.")]
    InvalidTrashEntry,
    #[error("Sibling names are not unique.")]
    DuplicateName,
    #[error("A document references an unknown image.")]
    MissingImage,
    #[error("Image deduplication metadata is invalid.")]
    InvalidImageDedupe,
    #[error("An object pending deletion is still referenced by the index.")]
    InvalidPendingPurge,
    #[error("An object ID is used for more than one object.")]
    DuplicateObjectId,
}

impl Index {
    pub fn new(created: i64) -> Self {
        let mut nodes = BTreeMap::new();
        nodes.insert(
            ROOT_ID,
            Node {
                id: ROOT_ID,
                parent: None,
                name: "/".to_owned(),
                created,
                modified: created,
                kind: NodeKind::Folder,
            },
        );
        nodes.insert(
            TRASH_ID,
            Node {
                id: TRASH_ID,
                parent: None,
                name: "Trash".to_owned(),
                created,
                modified: created,
                kind: NodeKind::Folder,
            },
        );

        Self {
            format: INDEX_FORMAT,
            revision: 0,
            nodes,
            images: BTreeMap::new(),
            image_dedupe: BTreeMap::new(),
            pending_purge: Vec::new(),
        }
    }

    pub fn validate(&self) -> Result<(), IndexValidationError> {
        if self.format != INDEX_FORMAT {
            return Err(IndexValidationError::UnsupportedFormat);
        }
        self.validate_roots()?;
        self.validate_ids_and_parents()?;
        self.validate_acyclic()?;
        self.validate_node_locations()?;
        self.validate_trash_entries()?;
        self.validate_live_names()?;
        self.validate_images()?;
        self.validate_pending_purge()?;
        Ok(())
    }

    pub fn node(&self, id: Uuid) -> Option<&Node> {
        self.nodes.get(&id)
    }

    pub fn children_ids(&self, parent: Uuid) -> Vec<Uuid> {
        self.nodes
            .values()
            .filter(|node| node.parent == Some(parent))
            .map(|node| node.id)
            .collect()
    }

    pub fn is_in_trash(&self, id: Uuid) -> Result<bool, IndexValidationError> {
        if id == TRASH_ID {
            return Ok(true);
        }
        if id == ROOT_ID {
            return Ok(false);
        }

        let mut cursor = id;
        let mut seen = BTreeSet::new();
        loop {
            if !seen.insert(cursor) {
                return Err(IndexValidationError::Cycle);
            }
            let node = self
                .nodes
                .get(&cursor)
                .ok_or(IndexValidationError::InvalidParent)?;
            let parent = node.parent.ok_or(IndexValidationError::InvalidParent)?;
            if parent == TRASH_ID {
                return Ok(true);
            }
            if parent == ROOT_ID {
                return Ok(false);
            }
            cursor = parent;
        }
    }

    pub fn path_to(&self, id: Uuid) -> Result<Vec<String>, IndexValidationError> {
        if id == ROOT_ID {
            return Ok(Vec::new());
        }
        if self.is_in_trash(id)? {
            return Err(IndexValidationError::InvalidTrashStructure);
        }

        let mut path = Vec::new();
        let mut cursor = id;
        while cursor != ROOT_ID {
            let node = self
                .nodes
                .get(&cursor)
                .ok_or(IndexValidationError::InvalidParent)?;
            path.push(node.name.clone());
            cursor = node.parent.ok_or(IndexValidationError::InvalidParent)?;
        }
        path.reverse();
        Ok(path)
    }

    pub(crate) fn descendants_including(&self, id: Uuid) -> Vec<Uuid> {
        let mut result = Vec::new();
        let mut stack = vec![id];
        while let Some(current) = stack.pop() {
            result.push(current);
            stack.extend(self.children_ids(current));
        }
        result
    }

    pub(crate) fn is_live_folder(&self, id: Uuid) -> bool {
        matches!(self.nodes.get(&id).map(|node| &node.kind), Some(NodeKind::Folder))
            && self.is_in_trash(id) == Ok(false)
    }

    fn validate_roots(&self) -> Result<(), IndexValidationError> {
        for (id, expected_name) in [(ROOT_ID, "/"), (TRASH_ID, "Trash")] {
            let node = self.nodes.get(&id).ok_or(IndexValidationError::InvalidRoot)?;
            if node.id != id
                || node.parent.is_some()
                || node.name != expected_name
                || !matches!(node.kind, NodeKind::Folder)
            {
                return Err(IndexValidationError::InvalidRoot);
            }
        }
        Ok(())
    }

    fn validate_ids_and_parents(&self) -> Result<(), IndexValidationError> {
        for (id, node) in &self.nodes {
            if *id != node.id {
                return Err(IndexValidationError::NodeIdMismatch);
            }
            if *id == ROOT_ID || *id == TRASH_ID {
                continue;
            }
            if normalize_name(&node.name).as_deref() != Ok(node.name.as_str()) {
                return Err(IndexValidationError::InvalidName);
            }
            let parent = node.parent.ok_or(IndexValidationError::InvalidParent)?;
            if !self.nodes.contains_key(&parent) {
                return Err(IndexValidationError::InvalidParent);
            }
        }
        Ok(())
    }

    fn validate_acyclic(&self) -> Result<(), IndexValidationError> {
        for id in self.nodes.keys().copied() {
            let mut cursor = id;
            let mut seen = BTreeSet::new();
            while cursor != ROOT_ID && cursor != TRASH_ID {
                if !seen.insert(cursor) {
                    return Err(IndexValidationError::Cycle);
                }
                cursor = self
                    .nodes
                    .get(&cursor)
                    .and_then(|node| node.parent)
                    .ok_or(IndexValidationError::InvalidParent)?;
            }
        }
        Ok(())
    }

    fn validate_node_locations(&self) -> Result<(), IndexValidationError> {
        for node in self.nodes.values() {
            if node.id == ROOT_ID || node.id == TRASH_ID {
                continue;
            }
            let parent_id = node.parent.ok_or(IndexValidationError::InvalidParent)?;
            let parent = self
                .nodes
                .get(&parent_id)
                .ok_or(IndexValidationError::InvalidParent)?;

            match &node.kind {
                NodeKind::TrashEntry => {
                    if parent_id != TRASH_ID {
                        return Err(IndexValidationError::InvalidTrashStructure);
                    }
                }
                NodeKind::TrashOrigin(_) => {
                    if !matches!(parent.kind, NodeKind::TrashEntry) {
                        return Err(IndexValidationError::InvalidTrashStructure);
                    }
                }
                NodeKind::Folder | NodeKind::Document { .. } => {
                    if parent_id == TRASH_ID
                        || !matches!(parent.kind, NodeKind::Folder | NodeKind::TrashEntry)
                    {
                        return Err(IndexValidationError::InvalidParent);
                    }
                }
            }

            if matches!(node.kind, NodeKind::TrashEntry | NodeKind::TrashOrigin(_))
                && self.is_in_trash(node.id)? == false
            {
                return Err(IndexValidationError::InvalidTrashStructure);
            }
        }

        if self
            .children_ids(TRASH_ID)
            .iter()
            .any(|id| !matches!(self.nodes[id].kind, NodeKind::TrashEntry))
        {
            return Err(IndexValidationError::InvalidTrashStructure);
        }

        for node in self.nodes.values() {
            if matches!(node.kind, NodeKind::Document { .. } | NodeKind::TrashOrigin(_))
                && !self.children_ids(node.id).is_empty()
            {
                return Err(IndexValidationError::InvalidParent);
            }
        }
        Ok(())
    }

    fn validate_trash_entries(&self) -> Result<(), IndexValidationError> {
        for entry in self
            .nodes
            .values()
            .filter(|node| matches!(node.kind, NodeKind::TrashEntry))
        {
            let children = self.children_ids(entry.id);
            if children.len() != 2 {
                return Err(IndexValidationError::InvalidTrashEntry);
            }

            let mut item = None;
            let mut origin = None;
            for child_id in children {
                let child = &self.nodes[&child_id];
                match &child.kind {
                    NodeKind::Folder | NodeKind::Document { .. } => {
                        if item.replace(child).is_some() {
                            return Err(IndexValidationError::InvalidTrashEntry);
                        }
                    }
                    NodeKind::TrashOrigin(value) => {
                        if child.name != ".origin" || origin.replace(value).is_some() {
                            return Err(IndexValidationError::InvalidTrashEntry);
                        }
                    }
                    NodeKind::TrashEntry => {
                        return Err(IndexValidationError::InvalidTrashEntry);
                    }
                }
            }

            let item = item.ok_or(IndexValidationError::InvalidTrashEntry)?;
            let origin = origin.ok_or(IndexValidationError::InvalidTrashEntry)?;
            let expected_kind = match item.kind {
                NodeKind::Folder => ItemKind::Folder,
                NodeKind::Document { .. } => ItemKind::Document,
                _ => return Err(IndexValidationError::InvalidTrashEntry),
            };
            if origin.item_id != item.id
                || origin.name != item.name
                || origin.item_kind != expected_kind
                || origin
                    .path
                    .iter()
                    .any(|part| normalize_name(part).as_deref() != Ok(part.as_str()))
            {
                return Err(IndexValidationError::InvalidTrashEntry);
            }

            let subtree = self.descendants_including(item.id);
            let mut documents = 0u32;
            let mut folders = 0u32;
            let mut images = BTreeSet::new();
            for id in subtree {
                match &self.nodes[&id].kind {
                    NodeKind::Folder => folders = folders.saturating_add(1),
                    NodeKind::Document { images: refs, .. } => {
                        documents = documents.saturating_add(1);
                        images.extend(refs.iter().copied());
                    }
                    NodeKind::TrashEntry | NodeKind::TrashOrigin(_) => {
                        return Err(IndexValidationError::InvalidTrashEntry);
                    }
                }
            }
            if origin.doc_count != documents
                || origin.folder_count != folders
                || origin.image_count != u32::try_from(images.len()).unwrap_or(u32::MAX)
            {
                return Err(IndexValidationError::InvalidTrashEntry);
            }
        }
        Ok(())
    }

    fn validate_live_names(&self) -> Result<(), IndexValidationError> {
        for folder in self.nodes.values().filter(|node| {
            matches!(node.kind, NodeKind::Folder) && self.is_in_trash(node.id) == Ok(false)
        }) {
            let mut names = BTreeSet::new();
            for child_id in self.children_ids(folder.id) {
                let child = &self.nodes[&child_id];
                if !names.insert(comparison_key(&child.name)) {
                    return Err(IndexValidationError::DuplicateName);
                }
            }
        }
        Ok(())
    }

    fn validate_images(&self) -> Result<(), IndexValidationError> {
        for id in self.images.keys() {
            if self.nodes.contains_key(id) {
                return Err(IndexValidationError::DuplicateObjectId);
            }
        }

        for node in self.nodes.values() {
            if let NodeKind::Document { images, .. } = &node.kind {
                let mut unique = BTreeSet::new();
                for image in images {
                    if !self.images.contains_key(image) {
                        return Err(IndexValidationError::MissingImage);
                    }
                    if !unique.insert(*image) {
                        return Err(IndexValidationError::MissingImage);
                    }
                }
            }
        }

        let mut deduped_ids = BTreeSet::new();
        for (digest, id) in &self.image_dedupe {
            if digest.len() != 64
                || !digest.bytes().all(|byte| byte.is_ascii_hexdigit())
                || !self.images.contains_key(id)
                || !deduped_ids.insert(*id)
            {
                return Err(IndexValidationError::InvalidImageDedupe);
            }
        }
        Ok(())
    }

    fn validate_pending_purge(&self) -> Result<(), IndexValidationError> {
        let mut seen = BTreeSet::new();
        for id in &self.pending_purge {
            if !seen.insert(*id)
                || self.nodes.contains_key(id)
                || self.images.contains_key(id)
            {
                return Err(IndexValidationError::InvalidPendingPurge);
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id(value: u128) -> Uuid {
        Uuid::from_u128(value)
    }

    #[test]
    fn fresh_index_is_valid_and_redacted() {
        let index = Index::new(123);
        assert_eq!(index.validate(), Ok(()));
        assert!(!format!("{index:?}").contains("Trash"));
    }

    #[test]
    fn detects_cycles_and_missing_parents() {
        let mut index = Index::new(0);
        index.nodes.insert(
            id(10),
            Node {
                id: id(10),
                parent: Some(id(11)),
                name: "a".into(),
                created: 0,
                modified: 0,
                kind: NodeKind::Folder,
            },
        );
        assert_eq!(index.validate(), Err(IndexValidationError::InvalidParent));

        index.nodes.insert(
            id(11),
            Node {
                id: id(11),
                parent: Some(id(10)),
                name: "b".into(),
                created: 0,
                modified: 0,
                kind: NodeKind::Folder,
            },
        );
        assert_eq!(index.validate(), Err(IndexValidationError::Cycle));
    }

    #[test]
    fn detects_case_insensitive_sibling_collision() {
        let mut index = Index::new(0);
        for (value, name) in [(10, "Notes"), (11, "notes")] {
            index.nodes.insert(
                id(value),
                Node {
                    id: id(value),
                    parent: Some(ROOT_ID),
                    name: name.into(),
                    created: 0,
                    modified: 0,
                    kind: NodeKind::Folder,
                },
            );
        }
        assert_eq!(index.validate(), Err(IndexValidationError::DuplicateName));
    }
}
