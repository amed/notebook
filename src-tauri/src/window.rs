//! The windows. The main window is created from its `tauri.conf.json` entry
//! (`"create": false`) and every document window from a copy of it, so each
//! gets the spec section 11 navigation policy before anything loads: the
//! webview never leaves the app origin and never opens a window by itself.
//! A reload of the main window ends the unlocked session, because the
//! reloaded frontend starts at the unlock screen and has lost its idle timer.
//! Closing any window while unlocked first lets its page write the open
//! document's edit to the encrypted outbox (milliseconds) and try to upload
//! it for up to 3 s; the main window first closes its document windows so.
//!
//! Document windows (spec D and E) show one document each, held for the
//! session they were opened in (`notebook/doc_windows.rs`): only the holder
//! writes it, and a window of an ended session is closed.

use crate::notebook::{
    DOCUMENT_WINDOW_PREFIX, DocumentWindowInfo, HeldDocument, HeldMove, HoldNotice, Holding,
    IpcError, MAIN_WINDOW, NotebookState, TreeDelta, is_document_window,
};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};
use tauri::utils::config::WindowConfig;
use tauri::webview::{NewWindowResponse, PageLoadEvent, WebviewWindowBuilder};
use tauri::{
    App, AppHandle, CloseRequestApi, Emitter as _, Manager as _, State, Url, WebviewUrl,
    WebviewWindow, WindowEvent,
};

/// Saves the pending edit, then calls `close_after_flush` (see `main.ts`).
const FLUSH_BEFORE_CLOSE: &str = "window.__notebookBeforeClose?.()";
/// The page answers within about 3.1 s: the outbox write takes milliseconds
/// and the upload gets at most 3 s, because an edit in the outbox is already
/// durable and is uploaded by the next unlock. This only catches a hung page.
const CLOSE_FALLBACK: Duration = Duration::from_secs(5);
/// The main window first closes its document windows (each within
/// `CLOSE_FALLBACK`, all at once), then saves its own document.
const MAIN_CLOSE_FALLBACK: Duration = Duration::from_secs(10);
/// How long `document_windows_close` waits for the document windows.
const DOCUMENT_CLOSE_WAIT: Duration = Duration::from_millis(5_500);
/// How long a rename, move or Trash waits for a document window to write its
/// pending edit to the outbox (milliseconds, unless the page hangs).
const FLUSH_WAIT: Duration = Duration::from_secs(2);
const DOCUMENT_WIDTH: f64 = 860.0;
const DOCUMENT_HEIGHT: f64 = 900.0;
const DOCUMENT_MIN_WIDTH: f64 = 480.0;
const DOCUMENT_MIN_HEIGHT: f64 = 360.0;
/// Each new document window opens this much further from the main window's corner.
const CASCADE: f64 = 28.0;

/// The windows whose close waits for their page; only those may close.
#[derive(Default)]
pub struct Closing(Mutex<HashSet<String>>);

impl Closing {
    fn waiting(&self, label: &str) -> bool {
        self.0.lock().is_ok_and(|labels| labels.contains(label))
    }

    fn set(&self, label: &str, waiting: bool) {
        if let Ok(mut labels) = self.0.lock() {
            if waiting {
                labels.insert(label.to_owned());
            } else {
                labels.remove(label);
            }
        }
    }
}

/// Answers of document windows asked to write their pending edit.
#[derive(Default)]
pub struct DocumentWindows {
    next_request: AtomicU64,
    /// The newest request each window has answered.
    flushed: Mutex<HashMap<String, u64>>,
    changed: tokio::sync::Notify,
}

/// `document-committed`: a document window uploaded its document.
#[derive(Clone, Serialize)]
struct DocumentCommitted {
    id: String,
    /// A conflict copy joined the tree.
    tree: Option<TreeDelta>,
}

pub fn create_main(app: &App) -> Result<(), Box<dyn std::error::Error>> {
    let config = main_config(app.handle()).ok_or("tauri.conf.json has no main window")?;
    app.manage(Closing::default());
    app.manage(DocumentWindows::default());
    guarded_window(app.handle(), &config)?;
    Ok(())
}

fn main_config(app: &AppHandle) -> Option<WindowConfig> {
    app.config()
        .app
        .windows
        .iter()
        .find(|window| window.label == MAIN_WINDOW)
        .cloned()
}

/// Builds a window with the navigation policy and the close guard.
fn guarded_window(app: &AppHandle, config: &WindowConfig) -> tauri::Result<WebviewWindow> {
    // `tauri dev` serves the frontend from devUrl; release builds never do.
    let dev_url = app
        .config()
        .build
        .dev_url
        .clone()
        .filter(|_| cfg!(debug_assertions));
    let https_scheme = config.use_https_scheme;
    let main = config.label == MAIN_WINDOW;
    let window = WebviewWindowBuilder::from_config(app, config)?
        .on_navigation(move |url| is_app_url(url, dev_url.as_ref(), https_scheme))
        .on_new_window(|_, _| NewWindowResponse::Deny)
        .on_page_load(move |window, payload| {
            // A document window that reloads asks for its document again.
            if main
                && matches!(payload.event(), PageLoadEvent::Started)
                && let Some(state) = window.try_state::<NotebookState>()
            {
                state.end_session();
                // Focus mode titled the window with a file name; the reloaded
                // page starts locked and would not reset it.
                reset_main_title(window.app_handle());
                close_stale_document_windows(window.app_handle());
            }
        })
        .build()?;
    let handle = window.clone();
    window.on_window_event(move |event| match event {
        WindowEvent::CloseRequested { api, .. } => on_close_requested(&handle, api),
        WindowEvent::Destroyed => on_destroyed(&handle),
        _ => {}
    });
    Ok(window)
}

/// An unlocked window stays open while the page saves the open document,
/// and the page then closes it. The window is not hidden meanwhile, so the
/// WebView is never throttled. A page that never answers is closed after
/// its fallback; a locked window closes at once.
fn on_close_requested(window: &WebviewWindow, api: &CloseRequestApi) {
    let label = window.label().to_owned();
    let closing = window.state::<Closing>();
    if closing.waiting(&label) {
        api.prevent_close();
        return;
    }
    if !window.state::<NotebookState>().is_unlocked() {
        return;
    }
    api.prevent_close();
    closing.set(&label, true);
    if window.eval(FLUSH_BEFORE_CLOSE).is_err() {
        let _ = window.destroy();
        return;
    }
    let fallback = if label == MAIN_WINDOW {
        MAIN_CLOSE_FALLBACK
    } else {
        CLOSE_FALLBACK
    };
    let window = window.clone();
    std::thread::spawn(move || {
        std::thread::sleep(fallback);
        if window.state::<Closing>().waiting(&label) {
            let _ = window.destroy();
        }
    });
}

/// A closed document window gives its document back to the main window,
/// which makes it editable again. When the main window is gone, the
/// document windows close too (each saves first while unlocked).
fn on_destroyed(window: &WebviewWindow) {
    let label = window.label();
    let app = window.app_handle();
    window.state::<Closing>().set(label, false);
    if label == MAIN_WINDOW {
        for document in document_windows(app) {
            let _ = document.close();
        }
        return;
    }
    let windows = window.state::<DocumentWindows>();
    if let Ok(mut flushed) = windows.flushed.lock() {
        flushed.remove(label);
    }
    windows.changed.notify_waiters();
    if let Some(id) = window.state::<NotebookState>().release_window(label) {
        let _ = app.emit_to(MAIN_WINDOW, "document-window-closed", id);
    }
}

/// Called by the page once the open document's edit is durable (in the
/// outbox or in S3). It closes the window only while a close is waiting.
#[tauri::command]
pub fn close_after_flush(window: WebviewWindow) {
    if window.state::<Closing>().waiting(window.label()) {
        let _ = window.destroy();
    }
}

/// Cancels a pending close when the page could not write its edit even to
/// the local outbox. A later user close starts the guarded close flow again.
#[tauri::command]
pub fn cancel_close(window: WebviewWindow) {
    window.state::<Closing>().set(window.label(), false);
}

fn document_windows(app: &AppHandle) -> Vec<WebviewWindow> {
    app.webview_windows()
        .into_iter()
        .filter(|(label, _)| is_document_window(label))
        .map(|(_, window)| window)
        .collect()
}

/// "Open in new window": the document moves to a window of its own, which
/// writes it from now on (the page wrote its pending edit to the outbox
/// first). A document already in a window brings that window to the front.
#[tauri::command]
pub async fn open_document_window(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, NotebookState>,
    document_id: String,
) -> Result<(), IpcError> {
    if window.label() != MAIN_WINDOW {
        return Err(IpcError::invalid(
            "Only the main window opens document windows.",
        ));
    }
    let label = format!("{DOCUMENT_WINDOW_PREFIX}{}", uuid::Uuid::new_v4().simple());
    for _ in 0..2 {
        match state.hold_document(&label, &document_id)? {
            Holding::Existing(holder) => {
                if let Some(existing) = app.get_webview_window(&holder) {
                    let _ = existing.unminimize();
                    let _ = existing.show();
                    let _ = existing.set_focus();
                    return Ok(());
                }
                // A hold whose window is gone: forget it and try again.
                state.release_window(&holder);
            }
            Holding::New(held) => {
                return create_document_window(&app, &label, &held)
                    .map(drop)
                    .map_err(|_| {
                        state.release_window(&label);
                        IpcError::internal("WINDOW_CREATE")
                    });
            }
        }
    }
    Err(IpcError::internal("WINDOW_CREATE"))
}

/// A copy of the main window's configuration (the same webview settings),
/// titled with the file name. The page reads `window` and `id` from its
/// URL only to know what to show: Rust answers by the window's label.
fn create_document_window(
    app: &AppHandle,
    label: &str,
    held: &HeldDocument,
) -> tauri::Result<WebviewWindow> {
    let mut config = main_config(app).ok_or(tauri::Error::WindowNotFound)?;
    config.label = label.to_owned();
    config.url = WebviewUrl::App(document_url(&held.id).into());
    config.title.clone_from(&held.name);
    config.center = false;
    config.min_width = Some(DOCUMENT_MIN_WIDTH);
    config.min_height = Some(DOCUMENT_MIN_HEIGHT);
    let (width, height, position) = placement(app);
    config.width = width;
    config.height = height;
    config.x = position.map(|(x, _)| x);
    config.y = position.map(|(_, y)| y);
    guarded_window(app, &config)
}

/// The page of a document window; the id is form-encoded (`document-window.ts` decodes it).
fn document_url(id: &str) -> String {
    let query = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("window", "document")
        .append_pair("id", id)
        .finish();
    format!("index.html?{query}")
}

/// The default size, made to fit the main window's screen, cascading from
/// the main window's top-left corner.
fn placement(app: &AppHandle) -> (f64, f64, Option<(f64, f64)>) {
    let Some(main) = app.get_webview_window(MAIN_WINDOW) else {
        return (DOCUMENT_WIDTH, DOCUMENT_HEIGHT, None);
    };
    let Ok(scale) = main.scale_factor() else {
        return (DOCUMENT_WIDTH, DOCUMENT_HEIGHT, None);
    };
    let offset = CASCADE * document_windows(app).len() as f64 + CASCADE;
    let mut position = main
        .outer_position()
        .ok()
        .map(|corner| corner.to_logical::<f64>(scale))
        .map(|corner| (corner.x + offset, corner.y + offset));
    let (mut width, mut height) = (DOCUMENT_WIDTH, DOCUMENT_HEIGHT);
    if let Ok(Some(monitor)) = main.current_monitor() {
        let area = monitor.work_area();
        let origin = area.position.to_logical::<f64>(monitor.scale_factor());
        let size = area.size.to_logical::<f64>(monitor.scale_factor());
        width = width.min(size.width).max(DOCUMENT_MIN_WIDTH);
        height = height.min(size.height).max(DOCUMENT_MIN_HEIGHT);
        position = position.map(|(x, y)| {
            (
                x.min(origin.x + size.width - width).max(origin.x),
                y.min(origin.y + size.height - height).max(origin.y),
            )
        });
    }
    (width, height, position)
}

/// What a document window shows, checked by its label: its document while
/// the session it was opened in lasts (`LOCKED`, `WINDOW_STALE` otherwise).
#[tauri::command]
pub fn document_window_info(
    window: WebviewWindow,
    state: State<'_, NotebookState>,
) -> Result<DocumentWindowInfo, IpcError> {
    state.document_window_info(window.label())
}

/// A link to another vault document in a document window's preview
/// (`nb-doc:` / `nb-wiki:`, preview.rs): the main window resolves it against
/// its tree, from the folder of this window's document (Rust's, by the
/// window's label, never the page's word), opens what it names and comes to
/// the front. Only an internal href exactly as the preview writes it passes.
#[tauri::command]
pub fn document_link_open(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, NotebookState>,
    href: String,
) -> Result<(), IpcError> {
    if !crate::preview::is_internal_href(&href) {
        return Err(IpcError::new(
            "LINK_REJECTED",
            "Only links to documents in this workspace open here.",
        ));
    }
    let from = state.document_window_info(window.label())?.path;
    let main = app
        .get_webview_window(MAIN_WINDOW)
        .ok_or_else(|| IpcError::internal("WINDOW"))?;
    app.emit_to(MAIN_WINDOW, "document-link", DocumentLink { from, href })
        .map_err(|_| IpcError::internal("WINDOW"))?;
    let _ = main.unminimize();
    let _ = main.show();
    let _ = main.set_focus();
    Ok(())
}

/// `document-link`: what the main window opens for a document window.
#[derive(Clone, Serialize)]
struct DocumentLink {
    from: String,
    href: String,
}

/// The main window's title from its config ("Notebook"): focus mode shows a
/// file name there, which must not outlive the session that showed it. The
/// page resets it itself; this covers a reload and a forced lock of a hung page.
pub fn reset_main_title(app: &AppHandle) {
    if let (Some(window), Some(config)) = (app.get_webview_window(MAIN_WINDOW), main_config(app)) {
        let _ = window.set_title(&config.title);
    }
}

/// A document window's Close window button (the window shows no document):
/// it closes only itself, through the close guard like its close button.
#[tauri::command]
pub fn document_window_close(window: WebviewWindow) -> Result<(), IpcError> {
    if !is_document_window(window.label()) {
        return Err(IpcError::invalid("Not a document window."));
    }
    window
        .close()
        .map_err(|_| IpcError::internal("WINDOW_CLOSE"))
}

/// A document window answers `flush_document_windows`.
#[tauri::command]
pub fn document_window_flushed(window: WebviewWindow, request: u64) {
    let windows = window.state::<DocumentWindows>();
    if let Ok(mut flushed) = windows.flushed.lock() {
        let answered = flushed.entry(window.label().to_owned()).or_default();
        *answered = (*answered).max(request);
    }
    windows.changed.notify_waiters();
}

/// Lock, workspace switch, phrase change and quit: every document window
/// saves (as its close button does) and closes. Fails when one stays open,
/// because its edit could not be written even to the outbox.
#[tauri::command]
pub async fn document_windows_close(app: AppHandle, window: WebviewWindow) -> Result<(), IpcError> {
    if window.label() != MAIN_WINDOW {
        return Err(IpcError::invalid(
            "Only the main window closes document windows.",
        ));
    }
    let windows = document_windows(&app);
    for document in &windows {
        let _ = document.close();
    }
    let labels = windows
        .iter()
        .map(|document| document.label().to_owned())
        .collect::<Vec<_>>();
    let deadline = Instant::now() + DOCUMENT_CLOSE_WAIT;
    loop {
        if labels
            .iter()
            .all(|label| app.get_webview_window(label).is_none())
        {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(IpcError::new(
                "WINDOW_OPEN",
                "A document window could not save its edit on this device. Retry there, or close that window, then try again.",
            ));
        }
        tokio::time::sleep(Duration::from_millis(40)).await;
    }
}

/// Asks the document windows `labels` to write their pending edit to the
/// outbox (`window.__notebookFlush`), and waits for their answers. They stay
/// read-only until `resume_document_windows`.
pub async fn flush_document_windows(app: &AppHandle, labels: Vec<String>) {
    if labels.is_empty() {
        return;
    }
    let windows = app.state::<DocumentWindows>();
    let request = windows.next_request.fetch_add(1, Ordering::SeqCst) + 1;
    let waiting = labels
        .into_iter()
        .filter(|label| {
            app.get_webview_window(label).is_some_and(|window| {
                window
                    .eval(format!("window.__notebookFlush?.({request})"))
                    .is_ok()
            })
        })
        .collect::<Vec<_>>();
    let deadline = tokio::time::Instant::now() + FLUSH_WAIT;
    loop {
        let changed = windows.changed.notified();
        tokio::pin!(changed);
        changed.as_mut().enable();
        let answered = windows.flushed.lock().map_or(true, |flushed| {
            waiting.iter().all(|label| {
                flushed.get(label).is_some_and(|&done| done >= request)
                    || app.get_webview_window(label).is_none()
            })
        });
        if answered || tokio::time::timeout_at(deadline, changed).await.is_err() {
            return;
        }
    }
}

/// The rename, move or Trash that `flush_document_windows` announced to
/// `labels` is over (done or failed): those still open write again
/// (`document-window-resume`). A trashed document's window is gone already.
pub fn resume_document_windows(app: &AppHandle, labels: &[String]) {
    for label in labels {
        if app.get_webview_window(label).is_some() {
            let _ = app.emit_to(label.as_str(), "document-window-resume", ());
        }
    }
}

/// A document window uploaded its document: the main window re-reads it
/// (read-only there) and adds a conflict copy to its tree. A conflict copy
/// is held by the window from now on, as the main window keeps editing a
/// copy it made.
pub fn after_document_commit(
    app: &AppHandle,
    label: &str,
    id: &str,
    copy: Option<&str>,
    tree: Option<TreeDelta>,
) {
    let state = app.state::<NotebookState>();
    if let Some(copy) = copy
        && let Some(change) = state.follow_copy(label, id, copy)
    {
        tell_moved(app, label, &change);
    }
    let committed = DocumentCommitted {
        id: id.to_owned(),
        tree,
    };
    let _ = app.emit_to(MAIN_WINDOW, "document-committed", committed);
}

/// Tells document windows what a rename, move or Trash did to their
/// document: a new id and title, or the window closes (its edit was written
/// and uploaded before the change) and the main window says why.
pub fn deliver_hold_notices(app: &AppHandle) {
    let mut gone = Vec::new();
    for notice in app.state::<NotebookState>().take_hold_notices() {
        match notice {
            HoldNotice::Moved { label, change } => tell_moved(app, &label, &change),
            HoldNotice::Gone { label, name } => {
                if let Some(window) = app.get_webview_window(&label) {
                    let _ = window.destroy();
                }
                gone.push(name);
            }
        }
    }
    if !gone.is_empty() {
        let _ = app.emit_to(MAIN_WINDOW, "document-windows-gone", gone);
    }
}

fn tell_moved(app: &AppHandle, label: &str, change: &HeldMove) {
    if let Some(window) = app.get_webview_window(label) {
        let _ = window.set_title(&change.name);
        let _ = app.emit_to(label, "document-window-moved", change.clone());
    }
}

/// Closes, without saving, every document window that holds no document of
/// the current session: the session it was opened for has ended, so it can
/// neither save nor show anything. The page closes them with a save first.
pub fn close_stale_document_windows(app: &AppHandle) {
    let Some(state) = app.try_state::<NotebookState>() else {
        return;
    };
    for window in document_windows(app) {
        if !state.holds_current(window.label()) {
            let _ = window.destroy();
        }
    }
}

/// On macOS the default menu's Quit ends the process without closing the
/// window first. It is replaced by an item that closes the window, which ends
/// the app once the page has saved.
#[cfg(target_os = "macos")]
pub const QUIT_MENU_ID: &str = "notebook-quit";

#[cfg(target_os = "macos")]
pub fn app_menu(app: &tauri::AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{Menu, MenuItem, MenuItemKind};
    let menu = Menu::default(app)?;
    if let Some(MenuItemKind::Submenu(app_menu)) = menu.items()?.into_iter().next() {
        for (index, item) in app_menu.items()?.into_iter().enumerate() {
            if let MenuItemKind::Predefined(predefined) = item {
                let text = predefined.text()?;
                if text.starts_with("Quit") {
                    let quit =
                        MenuItem::with_id(app, QUIT_MENU_ID, text, true, Some("CmdOrCtrl+Q"))?;
                    app_menu.remove_at(index)?;
                    app_menu.insert(&quit, index)?;
                    break;
                }
            }
        }
    }
    Ok(menu)
}

/// Quit from the menu: close the main window the same way its close button does.
#[cfg(target_os = "macos")]
pub fn quit(app: &tauri::AppHandle) {
    match app.get_webview_window(MAIN_WINDOW) {
        Some(window) => {
            let _ = window.close();
        }
        None => app.exit(0),
    }
}

/// The origin Tauri serves the embedded frontend from on this platform:
/// `tauri://localhost` on macOS and Linux, and on Windows
/// `http://tauri.localhost`, or `https://` with `useHttpsScheme`. wry
/// intercepts only that origin; the others would reach the network.
fn embedded_origin(https_scheme: bool) -> (&'static str, &'static str) {
    if cfg!(windows) {
        (
            if https_scheme { "https" } else { "http" },
            "tauri.localhost",
        )
    } else {
        ("tauri", "localhost")
    }
}

fn is_app_url(url: &Url, dev_url: Option<&Url>, https_scheme: bool) -> bool {
    let (scheme, host) = embedded_origin(https_scheme);
    let embedded = url.scheme() == scheme && url.host_str() == Some(host);
    let plain = url.port().is_none() && url.username().is_empty() && url.password().is_none();
    (embedded && plain) || dev_url.is_some_and(|dev| same_origin(url, dev))
}

fn same_origin(url: &Url, other: &Url) -> bool {
    url.scheme() == other.scheme()
        && url.host_str().is_some()
        && url.host_str() == other.host_str()
        && url.port_or_known_default() == other.port_or_known_default()
        && url.username().is_empty()
        && url.password().is_none()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn allowed_with(url: &str, dev: Option<&str>, https_scheme: bool) -> bool {
        let dev = dev.map(|value| Url::parse(value).unwrap());
        is_app_url(&Url::parse(url).unwrap(), dev.as_ref(), https_scheme)
    }

    fn allowed(url: &str, dev: Option<&str>) -> bool {
        allowed_with(url, dev, false)
    }

    const DEV: Option<&str> = Some("http://127.0.0.1:1420");

    #[cfg(not(windows))]
    #[test]
    fn app_origins_are_allowed() {
        for url in [
            "tauri://localhost",
            "tauri://localhost/index.html",
            "tauri://localhost/#footnote-1",
        ] {
            assert!(allowed(url, None), "{url}");
            assert!(allowed_with(url, None, true), "{url}");
        }
        // Network origins on macOS and Linux, whatever useHttpsScheme says.
        for url in [
            "http://tauri.localhost/",
            "https://tauri.localhost/assets/main.js?x=1",
        ] {
            assert!(!allowed(url, None), "{url}");
            assert!(!allowed_with(url, None, true), "{url}");
        }
    }

    #[cfg(windows)]
    #[test]
    fn app_origins_are_allowed() {
        for url in [
            "http://tauri.localhost/",
            "http://tauri.localhost/#footnote-1",
        ] {
            assert!(allowed(url, None), "{url}");
            assert!(!allowed_with(url, None, true), "{url}");
        }
        assert!(allowed_with(
            "https://tauri.localhost/assets/main.js?x=1",
            None,
            true
        ));
        // wry does not intercept these on Windows.
        for url in ["https://tauri.localhost/", "tauri://localhost/"] {
            assert!(!allowed(url, None), "{url}");
        }
    }

    #[test]
    fn foreign_origins_are_denied() {
        for url in [
            "https://example.com/",
            "http://localhost/",
            "tauri://evil.example/",
            "tauri://localhost:8080/",
            "http://tauri.localhost:8080/",
            "https://tauri.localhost:8080/",
            "http://tauri.localhost.evil.example/",
            "https://user:pass@tauri.localhost/",
            "tauri://user@localhost/",
            "file:///etc/passwd",
            "about:blank",
            "data:text/html,<script>alert(1)</script>",
            "javascript:alert(1)",
            "blob:tauri://localhost/1234",
            "secure-img://localhost/1",
            "http://127.0.0.1:1420/",
        ] {
            assert!(!allowed(url, None), "{url}");
        }
    }

    #[test]
    fn document_window_urls_encode_the_id_and_stay_in_the_app() {
        assert_eq!(
            document_url("n-a b&c=d/é?#"),
            "index.html?window=document&id=n-a+b%26c%3Dd%2F%C3%A9%3F%23"
        );
        let id = format!("n-{}", "0".repeat(64));
        let page = Url::parse("tauri://localhost/")
            .unwrap()
            .join(&document_url(&id))
            .unwrap();
        assert_eq!(page.path(), "/index.html");
        assert!(allowed(page.as_str(), None) || cfg!(windows));
        assert!(allowed(
            Url::parse("http://127.0.0.1:1420/")
                .unwrap()
                .join(&document_url(&id))
                .unwrap()
                .as_str(),
            DEV
        ));
    }

    #[test]
    fn dev_server_is_allowed_only_when_configured() {
        assert!(allowed("http://127.0.0.1:1420/", DEV));
        assert!(allowed("http://127.0.0.1:1420/src/main.ts", DEV));
        assert!(!allowed("http://127.0.0.1:1421/", DEV));
        assert!(!allowed("https://127.0.0.1:1420/", DEV));
        assert!(!allowed("http://localhost:1420/", DEV));
        assert!(!allowed("http://user@127.0.0.1:1420/", DEV));
    }
}
