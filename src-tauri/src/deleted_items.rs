//! Notebook's deleted-items bin: `_deleted/items/<id>/item/<name>`, with the
//! original parent recorded as a directory under `_deleted/items/<id>/parent/`.
//!
//! The layout, the id scheme and the catalog rules follow Notebook's
//! `src/app/deleted_items.rs` and its S3 tree mapper exactly, so an item
//! deleted in either app is listed, restorable and purgeable in both. Paths
//! here are logical (decrypted, prefix-relative); callers encrypt them.

use crate::compat::notebook_v1::DIRECTORY_MARKER;
use std::collections::BTreeMap;

pub const BIN_FOLDER: &str = "_deleted";
pub const LEGACY_RESERVED: &str = "_delete";
/// Trash namespace of earlier builds of this app. Read, restored and purged,
/// never written.
pub const LEGACY_TRASH: &str = ".secure-vault-trash";
const ITEMS: &str = "items";
const ITEM_CONTENT: &str = "item";
const ITEM_PARENT: &str = "parent";
const BIN_KEY: &str = "bin:";
const LEGACY_KEY: &str = "legacy:";

/// Names users may not create, rename to or restore through.
pub fn is_reserved_name(name: &str) -> bool {
    matches!(name, BIN_FOLDER | LEGACY_RESERVED | LEGACY_TRASH)
}

/// Bin storage, top-level only like Notebook's `is_deleted_path`, never shows
/// in the workspace tree, search or counts.
pub fn is_hidden_path(path: &str) -> bool {
    is_reserved_name(path.split('/').next().unwrap_or(path))
}

pub fn has_reserved_segment(path: &str) -> bool {
    path.split('/').map(str::trim).any(is_reserved_name)
}

fn container_path(id: &str) -> String {
    format!("{BIN_FOLDER}/{ITEMS}/{id}")
}

fn marker(path: &str) -> String {
    format!("{path}/{DIRECTORY_MARKER}")
}

#[derive(Debug, PartialEq, Eq)]
pub struct DeletePlan {
    pub key: String,
    /// Directory markers to write, in Notebook's order, before the move.
    pub markers: Vec<String>,
    /// Where the deleted item's root goes.
    pub destination: String,
}

/// Notebook's `move_entry_to_deleted_items` for `original_path`, given every
/// logical object path in the workspace and the current Unix time in ms.
pub fn plan_delete(paths: &[&str], original_path: &str, now_ms: u64) -> DeletePlan {
    let exists = |path: &str| {
        let below = format!("{path}/");
        paths
            .iter()
            .any(|candidate| *candidate == path || candidate.starts_with(&below))
    };
    let items_root = format!("{BIN_FOLDER}/{ITEMS}");
    let mut markers = Vec::new();
    if !paths
        .iter()
        .any(|path| path.starts_with(&format!("{items_root}/")))
    {
        markers.push(marker(&items_root));
    }
    let name = file_name(original_path);
    let base = match sanitize_id_component(name) {
        value if value.is_empty() => "deleted-item".to_owned(),
        value => value,
    };
    let id = (0_usize..)
        .map(|attempt| match attempt {
            0 => format!("{now_ms}-{base}"),
            _ => format!("{now_ms}-{base}-{}", attempt + 1),
        })
        .find(|candidate| !exists(&container_path(candidate)))
        .unwrap_or_default();
    let container = container_path(&id);
    markers.push(marker(&format!("{container}/{ITEM_CONTENT}")));
    let parent = parent_path(original_path).trim_matches('/');
    if !parent.is_empty() {
        markers.push(marker(&format!("{container}/{ITEM_PARENT}/{parent}")));
    }
    DeletePlan {
        key: format!("{BIN_KEY}{id}"),
        markers,
        destination: format!("{container}/{ITEM_CONTENT}/{}", name.trim_matches('/')),
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BinEntry {
    /// `bin:<Notebook item id>` or `legacy:<UUID>`.
    pub key: String,
    pub name: String,
    pub original_path: String,
    pub original_parent: String,
    pub deleted_at_ms: Option<u64>,
    pub is_folder: bool,
    /// Notebook's "N items": every file and folder below the root.
    pub item_count: usize,
    pub documents: usize,
    pub folders: usize,
    /// Logical path of the item root in storage.
    pub root_path: String,
    /// Every object under this prefix belongs to the entry.
    pub storage_prefix: String,
    pub legacy: bool,
}

/// Every bin entry, Notebook's first and in Notebook's order (newest first,
/// then by name), followed by legacy entries of earlier builds of this app.
pub fn catalog(paths: &[&str]) -> Vec<BinEntry> {
    let mut entries = notebook_entries(paths);
    entries.extend(legacy_entries(paths));
    entries
}

pub fn find(paths: &[&str], key: &str) -> Option<BinEntry> {
    catalog(paths).into_iter().find(|entry| entry.key == key)
}

fn notebook_entries(paths: &[&str]) -> Vec<BinEntry> {
    let items_prefix = format!("{BIN_FOLDER}/{ITEMS}/");
    let mut items = Node::default();
    for path in paths {
        if let Some(relative) = path.strip_prefix(&items_prefix) {
            items.insert(relative);
        }
    }
    let mut entries = items
        .sorted()
        .into_iter()
        .filter(|(_, container)| container.is_dir())
        .filter_map(|(id, container)| {
            let content = container
                .children
                .get(ITEM_CONTENT)
                .filter(|node| node.is_dir())?;
            let (name, root) = content.sorted().into_iter().next()?;
            let original_parent = container
                .children
                .get(ITEM_PARENT)
                .filter(|node| node.is_dir())
                .and_then(|node| node.deepest_dir(String::new()))
                .unwrap_or_default();
            let container = container_path(id);
            Some(entry(
                format!("{BIN_KEY}{id}"),
                name,
                root,
                original_parent,
                id.split('-').next().and_then(|value| value.parse().ok()),
                format!("{container}/{ITEM_CONTENT}/{name}"),
                format!("{container}/"),
            ))
        })
        .collect::<Vec<_>>();
    entries.sort_by(|left, right| {
        right
            .deleted_at_ms
            .cmp(&left.deleted_at_ms)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });
    entries
}

/// `.secure-vault-trash/<UUID>/<original path>`; a folder's origin is its
/// shallowest directory marker, a document's its only object.
fn legacy_entries(paths: &[&str]) -> Vec<BinEntry> {
    let mut grouped = BTreeMap::<&str, Vec<&str>>::new();
    for path in paths {
        if let Some((uuid, rest)) = path
            .strip_prefix(&format!("{LEGACY_TRASH}/"))
            .and_then(|rest| rest.split_once('/'))
            .filter(|(_, rest)| !rest.is_empty())
        {
            grouped.entry(uuid).or_default().push(rest);
        }
    }
    let marker_suffix = format!("/{DIRECTORY_MARKER}");
    grouped
        .into_iter()
        .filter_map(|(uuid, relative)| {
            let origin = relative
                .iter()
                .filter_map(|path| path.strip_suffix(&marker_suffix))
                .chain(relative.iter().copied().filter(|path| !is_marker(path)))
                .min_by_key(|path| path.matches('/').count())?;
            let mut tree = Node::default();
            for path in &relative {
                tree.insert(path);
            }
            let root = tree.get(origin)?;
            let prefix = format!("{LEGACY_TRASH}/{uuid}/");
            Some(entry(
                format!("{LEGACY_KEY}{uuid}"),
                file_name(origin),
                root,
                parent_path(origin).to_owned(),
                None,
                format!("{prefix}{origin}"),
                prefix,
            ))
        })
        .collect()
}

fn entry(
    key: String,
    name: &str,
    root: &Node,
    original_parent: String,
    deleted_at_ms: Option<u64>,
    root_path: String,
    storage_prefix: String,
) -> BinEntry {
    let (documents, folders) = root.kinds();
    BinEntry {
        legacy: key.starts_with(LEGACY_KEY),
        key,
        name: name.to_owned(),
        original_path: if original_parent.is_empty() {
            name.to_owned()
        } else {
            format!("{original_parent}/{name}")
        },
        original_parent,
        deleted_at_ms,
        is_folder: root.is_dir(),
        item_count: root.count(),
        documents,
        folders,
        root_path,
        storage_prefix,
    }
}

/// The virtual tree Notebook's S3 mapper builds from object paths: a marker
/// object creates its folder but no node, a node with children is a folder,
/// and a childless node is a file only if an object has exactly its path.
#[derive(Default)]
struct Node {
    children: BTreeMap<String, Node>,
    file: bool,
}

impl Node {
    fn insert(&mut self, path: &str) {
        let parts = path.split('/').collect::<Vec<_>>();
        let mut cursor = self;
        for (index, part) in parts.iter().enumerate() {
            let last = index + 1 == parts.len();
            if last && *part == DIRECTORY_MARKER {
                break;
            }
            cursor = cursor.children.entry((*part).to_owned()).or_default();
            if last {
                cursor.file = true;
            }
        }
    }

    fn get(&self, path: &str) -> Option<&Node> {
        path.split('/')
            .try_fold(self, |node, part| node.children.get(part))
    }

    fn is_dir(&self) -> bool {
        !(self.children.is_empty() && self.file)
    }

    /// Notebook's sibling order: folders, then files, each by lowercase name.
    fn sorted(&self) -> Vec<(&str, &Node)> {
        let (mut folders, mut files): (Vec<_>, Vec<_>) = self
            .children
            .iter()
            .map(|(name, node)| (name.as_str(), node))
            .partition(|(_, node)| node.is_dir());
        folders.sort_by_key(|(name, _)| name.to_lowercase());
        files.sort_by_key(|(name, _)| name.to_lowercase());
        folders.extend(files);
        folders
    }

    fn count(&self) -> usize {
        self.children.len() + self.children.values().map(Node::count).sum::<usize>()
    }

    /// (documents, folders), the node itself included.
    fn kinds(&self) -> (usize, usize) {
        if !self.is_dir() {
            return (1, 0);
        }
        self.children.values().map(Node::kinds).fold(
            (0, 1),
            |(documents, folders), (more_documents, more_folders)| {
                (documents + more_documents, folders + more_folders)
            },
        )
    }

    /// Notebook's `deepest_directory_path`: the longest folder path, the
    /// first one in sibling order on a tie.
    fn deepest_dir(&self, path: String) -> Option<String> {
        let mut deepest = self.is_dir().then(|| path.clone());
        for (name, child) in self.sorted() {
            let child_path = if path.is_empty() {
                name.to_owned()
            } else {
                format!("{path}/{name}")
            };
            if let Some(candidate) = child.deepest_dir(child_path)
                && deepest
                    .as_ref()
                    .is_none_or(|current| candidate.len() > current.len())
            {
                deepest = Some(candidate);
            }
        }
        deepest
    }
}

fn is_marker(path: &str) -> bool {
    file_name(path) == DIRECTORY_MARKER
}

fn file_name(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

fn parent_path(path: &str) -> &str {
    path.rsplit_once('/').map_or("", |(parent, _)| parent)
}

fn sanitize_id_component(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    const T: u64 = 1_712_000_000_123;

    #[test]
    fn catalog_reads_notebook_container_layout() {
        let paths = [
            "_deleted/items/.notebook_dir",
            "_deleted/items/1712000000123-todo-txt/item/.notebook_dir",
            "_deleted/items/1712000000123-todo-txt/parent/notes/.notebook_dir",
            "_deleted/items/1712000000123-todo-txt/item/todo.txt",
            "notes/other.md",
        ];
        let catalog = catalog(&paths);
        assert_eq!(catalog.len(), 1);
        let item = &catalog[0];
        assert_eq!(item.key, "bin:1712000000123-todo-txt");
        assert_eq!(item.name, "todo.txt");
        assert_eq!(item.original_parent, "notes");
        assert_eq!(item.original_path, "notes/todo.txt");
        assert_eq!(item.deleted_at_ms, Some(T));
        assert!(!item.is_folder);
        assert_eq!((item.documents, item.folders), (1, 0));
        assert_eq!(
            item.root_path,
            "_deleted/items/1712000000123-todo-txt/item/todo.txt"
        );
        assert_eq!(
            item.storage_prefix,
            "_deleted/items/1712000000123-todo-txt/"
        );
    }

    #[test]
    fn folders_report_location_and_notebook_item_count() {
        let paths = [
            "_deleted/items/1712000000123-projects/item/projects/todo.txt",
            "_deleted/items/1712000000123-projects/item/projects/drafts/ideas.txt",
            "_deleted/items/1712000000123-projects/item/projects/empty/.notebook_dir",
        ];
        let item = &catalog(&paths)[0];
        assert_eq!(item.original_parent, "");
        assert_eq!(item.original_path, "projects");
        assert!(item.is_folder);
        // drafts, drafts/ideas.txt, empty, todo.txt
        assert_eq!(item.item_count, 4);
        assert_eq!((item.documents, item.folders), (2, 3));
    }

    #[test]
    fn entries_sort_newest_first_then_by_name_and_skip_empty_containers() {
        let paths = [
            "_deleted/items/100-b/item/b.md",
            "_deleted/items/100-a/item/A.md",
            "_deleted/items/200-z/item/z.md",
            "_deleted/items/300-half/item/.notebook_dir",
            "_deleted/items/no-time/item/n.md",
            "_deleted/items/file-container",
        ];
        let names = catalog(&paths)
            .into_iter()
            .map(|entry| entry.name)
            .collect::<Vec<_>>();
        assert_eq!(names, ["z.md", "A.md", "b.md", "n.md"]);
    }

    #[test]
    fn parent_marker_uses_the_deepest_folder() {
        let paths = [
            "_deleted/items/1-x/item/x.md",
            "_deleted/items/1-x/parent/a/.notebook_dir",
            "_deleted/items/1-x/parent/a/bb/.notebook_dir",
            "_deleted/items/1-x/parent/a/c/d/.notebook_dir",
            "_deleted/items/1-x/parent/stray.md",
        ];
        assert_eq!(catalog(&paths)[0].original_path, "a/c/d/x.md");
        let tie = [
            "_deleted/items/1-x/item/x.md",
            "_deleted/items/1-x/parent/B/.notebook_dir",
            "_deleted/items/1-x/parent/a/.notebook_dir",
        ];
        assert_eq!(catalog(&tie)[0].original_parent, "a");
    }

    #[test]
    fn delete_plan_matches_notebook_layout_and_ids() {
        let plan = plan_delete(&["notes/todo.txt"], "notes/todo.txt", T);
        assert_eq!(plan.key, "bin:1712000000123-todo-txt");
        assert_eq!(
            plan.markers,
            [
                "_deleted/items/.notebook_dir",
                "_deleted/items/1712000000123-todo-txt/item/.notebook_dir",
                "_deleted/items/1712000000123-todo-txt/parent/notes/.notebook_dir",
            ]
        );
        assert_eq!(
            plan.destination,
            "_deleted/items/1712000000123-todo-txt/item/todo.txt"
        );

        let taken = [
            "_deleted/items/1712000000123-todo-txt/item/todo.txt",
            "_deleted/items/1712000000123-todo-txt-2",
        ];
        let plan = plan_delete(&taken, "todo.txt", T);
        assert_eq!(plan.key, "bin:1712000000123-todo-txt-3");
        assert_eq!(
            plan.markers,
            ["_deleted/items/1712000000123-todo-txt-3/item/.notebook_dir"]
        );
    }

    #[test]
    fn id_component_is_sanitized_like_notebook() {
        assert_eq!(sanitize_id_component("Über Notes.md"), "ber-notes-md");
        assert_eq!(
            plan_delete(&[], "日本", T).key,
            "bin:1712000000123-deleted-item"
        );
    }

    #[test]
    fn legacy_entries_stay_listed_after_notebook_entries() {
        let paths = [
            ".secure-vault-trash/0b9c/Projects/Old/.notebook_dir",
            ".secure-vault-trash/0b9c/Projects/Old/a.md",
            ".secure-vault-trash/7f1e/Inbox/note.md",
            "_deleted/items/5-n/item/n.md",
        ];
        let catalog = catalog(&paths);
        assert_eq!(catalog.len(), 3);
        assert_eq!(catalog[0].key, "bin:5-n");
        let folder = &catalog[1];
        assert_eq!(folder.key, "legacy:0b9c");
        assert!(folder.legacy && folder.is_folder);
        assert_eq!(folder.original_path, "Projects/Old");
        assert_eq!(folder.item_count, 1);
        assert_eq!(folder.root_path, ".secure-vault-trash/0b9c/Projects/Old");
        assert_eq!(folder.deleted_at_ms, None);
        assert_eq!(catalog[2].original_path, "Inbox/note.md");
        assert!(!catalog[2].is_folder);
    }

    #[test]
    fn reserved_names_and_hidden_roots() {
        for name in ["_deleted", "_delete", ".secure-vault-trash"] {
            assert!(is_reserved_name(name));
            assert!(is_hidden_path(&format!("{name}/x/y.md")));
        }
        assert!(!is_hidden_path("notes/_deleted/x.md"));
        assert!(has_reserved_segment("notes/_deleted/x.md"));
        assert!(!has_reserved_segment("notes/deleted/x.md"));
    }
}
