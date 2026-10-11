//! One writer per document across windows (spec E).
//!
//! The main window writes every document that no document window holds. A
//! document window holds exactly one document, of the session it was opened
//! in: a hold of an earlier session counts for nothing, so a window left over
//! from before a lock, a workspace switch or a phrase change can never write
//! into a later session (and `window::close_stale_document_windows` closes
//! it). Holds follow their document through a rename, a move and a conflict
//! copy; a document that leaves the tree drops its hold.
//!
//! `holds` is a leaf lock: nothing else is locked while it is held.

use super::{IpcError, NotebookState, file_name, is_at_or_below, node_id};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::MutexGuard;

pub const MAIN_WINDOW: &str = "main";
pub const DOCUMENT_WINDOW_PREFIX: &str = "doc-";

#[derive(Default)]
pub(super) struct Holds {
    by_window: HashMap<String, Hold>,
    /// Holds a rename, move or Trash changed, for the windows to be told
    /// (`window::deliver_hold_notices`).
    notices: Vec<HoldNotice>,
    /// Windows whose document is being renamed, moved or trashed: their
    /// stages and commits are refused (`BUSY`, the edit stays in the window)
    /// until the objects are at their new keys. One entry per change, so two
    /// overlapping changes each unfreeze only their own.
    frozen: Vec<String>,
}

/// Unfreezes its windows however the change ends (`freeze_holds_within`).
pub(super) struct Frozen<'a> {
    state: &'a NotebookState,
    labels: Vec<String>,
}

impl Drop for Frozen<'_> {
    fn drop(&mut self) {
        if let Ok(mut holds) = self.state.holds.lock() {
            for label in &self.labels {
                if let Some(index) = holds.frozen.iter().position(|frozen| frozen == label) {
                    holds.frozen.swap_remove(index);
                }
            }
        }
    }
}

fn busy() -> IpcError {
    IpcError::new(
        "BUSY",
        "This document is being renamed or moved; the edit is kept and saved in a moment.",
    )
}

#[derive(Clone)]
struct Hold {
    session: u64,
    id: String,
    path: String,
}

/// The document a window holds.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct HeldDocument {
    pub id: String,
    pub name: String,
}

/// What `document_window_info` tells a document window when it starts.
#[derive(Clone, Debug, Serialize)]
pub struct DocumentWindowInfo {
    pub id: String,
    pub name: String,
    /// The document's vault path ("Notes/plan.md"): its preview's relative
    /// links start from this folder.
    pub path: String,
    pub theme: String,
    pub accent: String,
    /// The global preview zoom in percent (`layout.rs`).
    pub preview_zoom: u32,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Holding {
    /// The window now holds the document.
    New(HeldDocument),
    /// Another window holds it already; that window is shown instead.
    Existing(String),
}

/// A held document got a new id (rename, move, conflict copy).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct HeldMove {
    pub from: String,
    pub to: String,
    pub name: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum HoldNotice {
    Moved {
        label: String,
        change: HeldMove,
    },
    /// The document left the tree (Trash); its window closes.
    Gone {
        label: String,
        name: String,
    },
}

pub(super) fn not_writer() -> IpcError {
    IpcError::new(
        "NOT_WRITER",
        "This document is being edited in another window.",
    )
}

fn stale_window() -> IpcError {
    IpcError::new(
        "WINDOW_STALE",
        "This window belongs to a workspace session that has ended.",
    )
}

fn missing_document() -> IpcError {
    IpcError::invalid("The document does not exist.")
}

pub fn is_document_window(label: &str) -> bool {
    label.starts_with(DOCUMENT_WINDOW_PREFIX)
}

impl NotebookState {
    fn holds(&self) -> Result<MutexGuard<'_, Holds>, IpcError> {
        self.holds.lock().map_err(|_| IpcError::internal("STATE"))
    }

    fn current_session(&self) -> Option<u64> {
        self.inner
            .lock()
            .ok()
            .and_then(|inner| inner.session.as_ref().map(|session| session.id))
    }

    /// The current session and the path of the document `id`.
    fn document_path(&self, id: &str) -> Result<(u64, String), IpcError> {
        let inner = self.inner.lock().map_err(|_| IpcError::internal("STATE"))?;
        let session = inner.session.as_ref().ok_or_else(IpcError::locked)?;
        let node = session
            .nodes
            .get(id)
            .filter(|node| node.kind == "Document")
            .ok_or_else(missing_document)?;
        Ok((session.id, node.logical_path.clone()))
    }

    /// Gives the document `id` to the new document window `label`, unless
    /// another window of this session holds it already.
    pub fn hold_document(&self, label: &str, id: &str) -> Result<Holding, IpcError> {
        if !is_document_window(label) {
            return Err(IpcError::invalid("Not a document window."));
        }
        let (session, path) = self.document_path(id)?;
        let mut holds = self.holds()?;
        holds.by_window.retain(|_, hold| hold.session == session);
        if let Some((holder, _)) = holds.by_window.iter().find(|(_, hold)| hold.id == id) {
            return Ok(Holding::Existing(holder.clone()));
        }
        holds.by_window.insert(
            label.to_owned(),
            Hold {
                session,
                id: id.to_owned(),
                path: path.clone(),
            },
        );
        Ok(Holding::New(HeldDocument {
            id: id.to_owned(),
            name: file_name(&path).to_owned(),
        }))
    }

    /// What the document window `label` shows: its document while the
    /// session it was opened in lasts and the document is in the tree.
    pub fn document_window_info(&self, label: &str) -> Result<DocumentWindowInfo, IpcError> {
        let session = self.current_session().ok_or_else(IpcError::locked)?;
        let hold = self
            .holds()?
            .by_window
            .get(label)
            .filter(|hold| hold.session == session)
            .cloned()
            .ok_or_else(stale_window)?;
        let inner = self.inner.lock().map_err(|_| IpcError::internal("STATE"))?;
        let live = inner.session.as_ref().ok_or_else(IpcError::locked)?;
        if live.id != hold.session {
            return Err(stale_window());
        }
        let node = live
            .nodes
            .get(&hold.id)
            .filter(|node| node.kind == "Document")
            .ok_or_else(missing_document)?;
        Ok(DocumentWindowInfo {
            id: hold.id,
            name: node.name.clone(),
            path: node.logical_path.clone(),
            theme: inner.app.theme.clone(),
            accent: inner.app.accent.clone(),
            preview_zoom: inner.app.layout.preview_zoom,
        })
    }

    /// The window that writes `id` in session `session`: its holder, else main.
    pub(super) fn writer_of(&self, session: u64, id: &str) -> Result<String, IpcError> {
        Ok(self
            .holds()?
            .by_window
            .iter()
            .find(|(_, hold)| hold.session == session && hold.id == id)
            .map_or_else(|| MAIN_WINDOW.to_owned(), |(label, _)| label.clone()))
    }

    /// Freezes the windows holding a document at or below `source` while a
    /// rename, move or Trash of it runs. Taken after they wrote their pending
    /// edit (`window::flush_document_windows`) and before the staged edits
    /// are uploaded (`commit_subtree`): an edit staged later would go to a
    /// key that is about to disappear.
    pub(super) fn freeze_holds_within(&self, source: &str) -> Frozen<'_> {
        let session = self.current_session();
        let mut labels = Vec::new();
        if let Ok(mut holds) = self.holds.lock() {
            labels = holds
                .by_window
                .iter()
                .filter(|(_, hold)| {
                    Some(hold.session) == session && is_at_or_below(&hold.path, source)
                })
                .map(|(label, _)| label.clone())
                .collect();
            holds.frozen.extend(labels.iter().cloned());
        }
        Frozen {
            state: self,
            labels,
        }
    }

    /// A stage or commit comes only from the document's writer, and not
    /// while its document is being renamed, moved or trashed (`BUSY`).
    pub(super) fn check_writer(&self, session: u64, id: &str, label: &str) -> Result<(), IpcError> {
        if self.holds()?.frozen.iter().any(|frozen| frozen == label) {
            return Err(busy());
        }
        if self.writer_of(session, id)? == label {
            Ok(())
        } else {
            Err(not_writer())
        }
    }

    /// A document window reads only the document it holds; the main window
    /// reads every document, read-only while another window writes it.
    /// Returns whether `label` may write the document.
    pub(super) fn check_reader(
        &self,
        session: u64,
        id: &str,
        label: &str,
    ) -> Result<bool, IpcError> {
        if self.writer_of(session, id)? == label {
            Ok(true)
        } else if label == MAIN_WINDOW {
            Ok(false)
        } else {
            Err(not_writer())
        }
    }

    /// The window `label` is gone: the main window writes its document again.
    /// Returns that document's id while its session lasts.
    pub fn release_window(&self, label: &str) -> Option<String> {
        let hold = self.holds.lock().ok()?.by_window.remove(label)?;
        (self.current_session() == Some(hold.session)).then_some(hold.id)
    }

    /// Whether `label` holds a document of the current session.
    pub fn holds_current(&self, label: &str) -> bool {
        let Some(session) = self.current_session() else {
            return false;
        };
        self.holds.lock().is_ok_and(|holds| {
            holds
                .by_window
                .get(label)
                .is_some_and(|hold| hold.session == session)
        })
    }

    /// The windows holding the document `id` or, for a folder, a document in it.
    pub fn holders_within(&self, id: &str) -> Vec<String> {
        let found = self.inner.lock().ok().and_then(|inner| {
            let session = inner.session.as_ref()?;
            let node = session.nodes.get(id)?;
            Some((session.id, node.logical_path.clone()))
        });
        let Some((session, path)) = found else {
            return Vec::new();
        };
        self.holds.lock().map_or_else(
            |_| Vec::new(),
            |holds| {
                holds
                    .by_window
                    .iter()
                    .filter(|(_, hold)| {
                        hold.session == session && is_at_or_below(&hold.path, &path)
                    })
                    .map(|(label, _)| label.clone())
                    .collect()
            },
        )
    }

    /// After a rename or move of `source` to `destination` (`None`: Trash),
    /// a held document inside follows to its new id; one that left the tree
    /// drops its hold. The windows are told by `window::deliver_hold_notices`.
    pub(super) fn follow_holds(&self, source: &str, destination: Option<&str>) {
        let Some(session) = self.current_session() else {
            return;
        };
        let inside = match self.holds.lock() {
            Ok(holds) => holds
                .by_window
                .iter()
                .filter(|(_, hold)| hold.session == session && is_at_or_below(&hold.path, source))
                .map(|(label, hold)| (label.clone(), hold.clone()))
                .collect::<Vec<_>>(),
            Err(_) => return,
        };
        if inside.is_empty() {
            return;
        }
        let present = |path: &str| -> bool {
            self.inner.lock().is_ok_and(|inner| {
                inner.session.as_ref().is_some_and(|live| {
                    live.id == session
                        && live
                            .nodes
                            .get(&node_id("Document", path))
                            .is_some_and(|node| {
                                node.kind == "Document" && node.logical_path == path
                            })
                })
            })
        };
        let mut notices = Vec::new();
        for (label, hold) in inside {
            let moved = destination.map(|to| format!("{to}{}", &hold.path[source.len()..]));
            match moved {
                Some(path) if path != hold.path && present(&path) => {
                    notices.push(HoldNotice::Moved {
                        label,
                        change: HeldMove {
                            from: hold.id,
                            to: node_id("Document", &path),
                            name: file_name(&path).to_owned(),
                        },
                    });
                }
                _ if present(&hold.path) => {}
                _ => notices.push(HoldNotice::Gone {
                    label,
                    name: file_name(&hold.path).to_owned(),
                }),
            }
        }
        if let Ok(mut holds) = self.holds.lock() {
            for notice in &notices {
                match notice {
                    HoldNotice::Moved { label, change } => {
                        if let Some(hold) = holds.by_window.get_mut(label) {
                            hold.id.clone_from(&change.to);
                            hold.path = moved_path(&hold.path, source, destination);
                        }
                    }
                    HoldNotice::Gone { label, .. } => {
                        holds.by_window.remove(label);
                    }
                }
            }
            holds.notices.extend(notices);
        }
    }

    /// The window `label` committed its edit as the conflict copy `to`: it
    /// holds the copy now, as the main window keeps editing a copy it made.
    pub fn follow_copy(&self, label: &str, from: &str, to: &str) -> Option<HeldMove> {
        let (session, path) = self.document_path(to).ok()?;
        let mut holds = self.holds.lock().ok()?;
        if holds
            .by_window
            .iter()
            .any(|(other, hold)| other != label && hold.session == session && hold.id == to)
        {
            return None;
        }
        let hold = holds
            .by_window
            .get_mut(label)
            .filter(|hold| hold.session == session && hold.id == from)?;
        hold.id = to.to_owned();
        hold.path.clone_from(&path);
        Some(HeldMove {
            from: from.to_owned(),
            to: to.to_owned(),
            name: file_name(&path).to_owned(),
        })
    }

    /// The notices `follow_holds` queued, oldest first.
    pub fn take_hold_notices(&self) -> Vec<HoldNotice> {
        self.holds
            .lock()
            .map(|mut holds| std::mem::take(&mut holds.notices))
            .unwrap_or_default()
    }
}

fn moved_path(path: &str, source: &str, destination: Option<&str>) -> String {
    destination.map_or_else(
        || path.to_owned(),
        |to| format!("{to}{}", &path[source.len()..]),
    )
}

#[cfg(test)]
mod tests {
    use super::super::tests::{codec, remote, temporary_state};
    use super::super::*;
    use super::*;

    const DOC: &str = "Notes/plan.md";
    const OTHER: &str = "Notes/other.md";
    const WINDOW: &str = "doc-a1";

    /// An unlocked session with two documents in "Notes"; nothing listens on S3.
    fn unlocked_state() -> (tempfile::TempDir, NotebookState) {
        let (directory, state) = temporary_state();
        let codec = codec();
        let listed = [DOC, OTHER]
            .into_iter()
            .map(|path| ListedObject {
                key: codec.encode_path(path).unwrap(),
                etag: format!("etag-{path}"),
            })
            .collect();
        let session = build_session(&VaultConfig::default(), codec, listed, remote()).unwrap();
        install(&state, session);
        (directory, state)
    }

    fn install(state: &NotebookState, session: Session) {
        state.journal.lock().unwrap().adopt(&session);
        state.inner.lock().unwrap().session = Some(session);
    }

    /// The error code of a call that must fail (the results hold no Debug).
    fn code<T>(result: Result<T, IpcError>) -> &'static str {
        match result {
            Ok(_) => panic!("the call succeeded"),
            Err(error) => error.code(),
        }
    }

    fn id(path: &str) -> String {
        node_id("Document", path)
    }

    #[test]
    fn opening_a_window_moves_writing_to_it() {
        let (_directory, state) = unlocked_state();
        let doc = id(DOC);
        assert_eq!(
            state.hold_document(WINDOW, &doc).unwrap(),
            Holding::New(HeldDocument {
                id: doc.clone(),
                name: "plan.md".into()
            })
        );
        // The main window may no longer write it; the window may.
        let refused = stage_document_as(&state, &doc, "from main".into(), MAIN_WINDOW).unwrap_err();
        assert_eq!(refused.code(), "NOT_WRITER");
        assert_eq!(
            stage_document_as(&state, &doc, "from the window".into(), WINDOW).unwrap(),
            "Staged"
        );
        // Main still writes every other document; the window writes nothing else.
        let other = id(OTHER);
        assert_eq!(
            stage_document_as(&state, &other, "main".into(), MAIN_WINDOW).unwrap(),
            "Staged"
        );
        assert_eq!(
            stage_document_as(&state, &other, "window".into(), WINDOW)
                .unwrap_err()
                .code(),
            "NOT_WRITER"
        );
        // A second window for the same document is the first one, shown again.
        assert_eq!(
            state.hold_document("doc-b2", &doc).unwrap(),
            Holding::Existing(WINDOW.into())
        );
        assert!(state.hold_document(MAIN_WINDOW, &other).is_err());
    }

    #[tokio::test]
    async fn non_writers_cannot_commit_and_main_reads_read_only() {
        let (_directory, state) = unlocked_state();
        let doc = id(DOC);
        state.hold_document(WINDOW, &doc).unwrap();
        stage_document_as(&state, &doc, "window text".into(), WINDOW).unwrap();
        let refused = commit_document_as(&state, &doc, MAIN_WINDOW).await;
        assert_eq!(code(refused), "NOT_WRITER");
        // Main opens the staged text read-only, without an S3 request.
        let opened = open_document_as(&state, &doc, MAIN_WINDOW).await.unwrap();
        assert_eq!(opened.text.as_deref(), Some("window text"));
        assert!(opened.read_only && opened.dirty);
        let held = open_document_as(&state, &doc, WINDOW).await.unwrap();
        assert!(!held.read_only);
        // A document window opens nothing but its own document.
        let other = open_document_as(&state, &id(OTHER), WINDOW).await;
        assert_eq!(code(other), "NOT_WRITER");
    }

    #[tokio::test]
    async fn a_known_rev_leaves_the_text_out_until_the_text_changes() {
        let (_directory, state) = unlocked_state();
        let doc = id(DOC);
        state.hold_document(WINDOW, &doc).unwrap();
        let (_, sha) = stage_document_sha(&state, &doc, "first".into(), WINDOW).unwrap();
        let rev = text_rev(&sha);
        let known = open_document_known(&state, &doc, MAIN_WINDOW, Some(&rev))
            .await
            .unwrap();
        assert_eq!((known.text, known.rev.as_str()), (None, rev.as_str()));
        assert!(known.read_only && known.dirty);
        // The window's next edit: the main window's rev is stale.
        stage_document_as(&state, &doc, "second".into(), WINDOW).unwrap();
        let changed = open_document_known(&state, &doc, MAIN_WINDOW, Some(&rev))
            .await
            .unwrap();
        assert_eq!(changed.text.as_deref(), Some("second"));
        assert_ne!(changed.rev, rev);
        let again = open_document_known(&state, &doc, WINDOW, Some(&changed.rev))
            .await
            .unwrap();
        assert_eq!((again.text, again.rev), (None, changed.rev));
    }

    #[test]
    fn closing_the_window_gives_writing_back_to_main() {
        let (_directory, state) = unlocked_state();
        let doc = id(DOC);
        state.hold_document(WINDOW, &doc).unwrap();
        assert_eq!(state.release_window(WINDOW), Some(doc.clone()));
        assert!(!state.holds_current(WINDOW));
        assert_eq!(
            stage_document_as(&state, &doc, "main again".into(), MAIN_WINDOW).unwrap(),
            "Staged"
        );
        assert_eq!(
            stage_document_as(&state, &doc, "late".into(), WINDOW)
                .unwrap_err()
                .code(),
            "NOT_WRITER"
        );
        assert_eq!(state.release_window(WINDOW), None);
    }

    #[test]
    fn a_window_never_outlives_its_session() {
        let (_directory, state) = unlocked_state();
        let doc = id(DOC);
        state.hold_document(WINDOW, &doc).unwrap();
        let info = state.document_window_info(WINDOW).unwrap();
        assert_eq!((info.id, info.path), (doc.clone(), DOC.to_owned()));
        // Lock: nothing to hold, nothing to show.
        state.end_session();
        assert!(!state.holds_current(WINDOW));
        assert_eq!(
            state.document_window_info(WINDOW).unwrap_err().code(),
            "LOCKED"
        );
        // Unlocked again (or another workspace with the same paths): the old
        // window's hold counts for nothing, and main writes the document.
        let codec = codec();
        let listed = vec![ListedObject {
            key: codec.encode_path(DOC).unwrap(),
            etag: "etag-again".into(),
        }];
        install(
            &state,
            build_session(&VaultConfig::default(), codec, listed, remote()).unwrap(),
        );
        assert!(!state.holds_current(WINDOW));
        assert_eq!(
            state.document_window_info(WINDOW).unwrap_err().code(),
            "WINDOW_STALE"
        );
        assert_eq!(
            stage_document_as(&state, &doc, "stale window".into(), WINDOW)
                .unwrap_err()
                .code(),
            "NOT_WRITER"
        );
        assert_eq!(
            stage_document_as(&state, &doc, "main".into(), MAIN_WINDOW).unwrap(),
            "Staged"
        );
        // The stale hold does not block a new window for the document.
        assert!(matches!(
            state.hold_document("doc-b2", &doc).unwrap(),
            Holding::New(_)
        ));
    }

    #[test]
    fn holds_follow_renames_and_drop_on_trash() {
        let (_directory, state) = unlocked_state();
        let doc = id(DOC);
        state.hold_document(WINDOW, &doc).unwrap();
        assert_eq!(state.holders_within(&node_id("Folder", "Notes")), [WINDOW]);
        assert_eq!(state.holders_within(&id(OTHER)), Vec::<String>::new());
        // The folder is renamed: the document has a new path and id.
        let renamed = "Archive/plan.md";
        with_session(&state, |session| {
            let object = session.objects.remove(DOC).unwrap();
            session.apply([(renamed.to_owned(), Some(object))]);
            session.rebuild();
        })
        .unwrap();
        state.follow_holds("Notes", Some("Archive"));
        let moved = HeldMove {
            from: doc.clone(),
            to: id(renamed),
            name: "plan.md".into(),
        };
        assert_eq!(
            state.take_hold_notices(),
            [HoldNotice::Moved {
                label: WINDOW.into(),
                change: moved
            }]
        );
        let info = state.document_window_info(WINDOW).unwrap();
        // Its preview's relative links start from the new folder.
        assert_eq!((info.id, info.path), (id(renamed), renamed.to_owned()));
        assert_eq!(
            stage_document_as(&state, &id(renamed), "renamed".into(), WINDOW).unwrap(),
            "Staged"
        );
        // Moved to Trash: the hold is dropped and the window is told to close.
        with_session(&state, |session| {
            session.objects.remove(renamed);
            session.rebuild();
        })
        .unwrap();
        state.follow_holds("Archive/plan.md", None);
        assert_eq!(
            state.take_hold_notices(),
            [HoldNotice::Gone {
                label: WINDOW.into(),
                name: "plan.md".into()
            }]
        );
        assert!(!state.holds_current(WINDOW));
        assert!(state.take_hold_notices().is_empty());
    }

    #[test]
    fn a_conflict_copy_moves_the_hold_to_the_copy() {
        let (_directory, state) = unlocked_state();
        let doc = id(DOC);
        state.hold_document(WINDOW, &doc).unwrap();
        let copy = id(OTHER);
        assert_eq!(
            state.follow_copy(WINDOW, &doc, &copy),
            Some(HeldMove {
                from: doc.clone(),
                to: copy.clone(),
                name: "other.md".into()
            })
        );
        assert_eq!(
            state
                .writer_of(state.current_session().unwrap(), &doc)
                .unwrap(),
            MAIN_WINDOW
        );
        assert_eq!(
            state
                .writer_of(state.current_session().unwrap(), &copy)
                .unwrap(),
            WINDOW
        );
        // Only the window that held `from` follows.
        assert_eq!(state.follow_copy("doc-b2", &copy, &doc), None);
    }

    #[tokio::test]
    async fn a_window_cannot_write_while_its_document_moves() {
        let (_directory, state) = unlocked_state();
        let doc = id(DOC);
        state.hold_document(WINDOW, &doc).unwrap();
        state.hold_document("doc-b2", &id(OTHER)).unwrap();
        // Written when Rust asked (`flush_document_windows`), before the freeze.
        stage_document_as(&state, &doc, "flushed".into(), WINDOW).unwrap();
        {
            // A rename of "Notes": both windows inside are frozen.
            let outer = state.freeze_holds_within("Notes");
            {
                // An overlapping change of one document inside.
                let inner = state.freeze_holds_within(DOC);
                assert_eq!(inner.labels.as_slice(), [WINDOW]);
                assert_eq!(
                    stage_document_as(&state, &doc, "typed".into(), WINDOW)
                        .unwrap_err()
                        .code(),
                    "BUSY"
                );
            }
            // The inner change ended; the outer one still freezes the window.
            assert_eq!(
                stage_document_as(&state, &doc, "typed".into(), WINDOW)
                    .unwrap_err()
                    .code(),
                "BUSY"
            );
            assert_eq!(code(commit_document_as(&state, &doc, WINDOW).await), "BUSY");
            assert_eq!(
                stage_document_as(&state, &id(OTHER), "other".into(), "doc-b2")
                    .unwrap_err()
                    .code(),
                "BUSY"
            );
            assert_eq!(outer.labels.len(), 2);
            // Reading is not writing: the window still shows its document.
            let shown = open_document_as(&state, &doc, WINDOW).await.unwrap();
            assert_eq!(shown.text.as_deref(), Some("flushed"));
        }
        // Done (or failed): the windows write again.
        assert_eq!(
            stage_document_as(&state, &doc, "typed".into(), WINDOW).unwrap(),
            "Staged"
        );
        // A change outside freezes nobody.
        let _elsewhere = state.freeze_holds_within("Archive");
        assert_eq!(
            stage_document_as(&state, &id(OTHER), "other".into(), "doc-b2").unwrap(),
            "Staged"
        );
    }
}
