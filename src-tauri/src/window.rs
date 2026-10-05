//! The main window, created from its `tauri.conf.json` entry (`"create": false`)
//! so the spec section 11 navigation policy is attached before anything loads:
//! the webview never leaves the app origin and never opens another window.
//! A page (re)load ends the unlocked session, because the reloaded frontend
//! starts at the unlock screen and has lost its idle timer.
//! Closing while unlocked first lets the page write the open document's edit
//! to the encrypted outbox (milliseconds) and try to upload it for up to 3 s.

use crate::notebook::NotebookState;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::webview::{NewWindowResponse, PageLoadEvent, WebviewWindowBuilder};
use tauri::{App, CloseRequestApi, Manager as _, Url, WebviewWindow, WindowEvent};

const MAIN_WINDOW: &str = "main";
/// Saves the pending edit, then calls `close_after_flush` (see `main.ts`).
const FLUSH_BEFORE_CLOSE: &str = "window.__notebookBeforeClose?.()";
/// The page answers within about 3.1 s: the outbox write takes milliseconds
/// and the upload gets at most 3 s, because an edit in the outbox is already
/// durable and is uploaded by the next unlock. This only catches a hung page.
const CLOSE_FALLBACK: Duration = Duration::from_secs(5);

/// Set once a close waits for the page; only then may the page close.
#[derive(Default)]
pub struct Closing(AtomicBool);

pub fn create_main(app: &App) -> Result<(), Box<dyn std::error::Error>> {
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == MAIN_WINDOW)
        .ok_or("tauri.conf.json has no main window")?;
    // `tauri dev` serves the frontend from devUrl; release builds never do.
    let dev_url = app
        .config()
        .build
        .dev_url
        .clone()
        .filter(|_| cfg!(debug_assertions));
    let https_scheme = config.use_https_scheme;
    app.manage(Closing::default());
    let window = WebviewWindowBuilder::from_config(app.handle(), config)?
        .on_navigation(move |url| is_app_url(url, dev_url.as_ref(), https_scheme))
        .on_new_window(|_, _| NewWindowResponse::Deny)
        .on_page_load(|window, payload| {
            if matches!(payload.event(), PageLoadEvent::Started)
                && let Some(state) = window.try_state::<NotebookState>()
            {
                state.end_session();
            }
        })
        .build()?;
    let handle = window.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            on_close_requested(&handle, api);
        }
    });
    Ok(())
}

/// An unlocked window stays open while the page saves the open document,
/// and the page then closes it. The window is not hidden meanwhile, so the
/// WebView is never throttled. A page that never answers is closed after
/// `CLOSE_FALLBACK`; a locked window closes at once.
fn on_close_requested(window: &WebviewWindow, api: &CloseRequestApi) {
    let closing = window.state::<Closing>();
    if closing.0.load(Ordering::SeqCst) {
        api.prevent_close();
        return;
    }
    if !window.state::<NotebookState>().is_unlocked() {
        return;
    }
    api.prevent_close();
    closing.0.store(true, Ordering::SeqCst);
    if window.eval(FLUSH_BEFORE_CLOSE).is_err() {
        let _ = window.destroy();
        return;
    }
    let window = window.clone();
    std::thread::spawn(move || {
        std::thread::sleep(CLOSE_FALLBACK);
        if window.state::<Closing>().0.load(Ordering::SeqCst) {
            let _ = window.destroy();
        }
    });
}

/// Called by the page once the open document's edit is durable (in the
/// outbox or in S3). It closes the window only while a close is waiting.
#[tauri::command]
pub fn close_after_flush(window: WebviewWindow) {
    if window.state::<Closing>().0.load(Ordering::SeqCst) {
        let _ = window.destroy();
    }
}

/// Cancels a pending close when the page could not write its edit even to
/// the local outbox. A later user close starts the guarded close flow again.
#[tauri::command]
pub fn cancel_close(window: WebviewWindow) {
    window.state::<Closing>().0.store(false, Ordering::SeqCst);
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
    fn dev_server_is_allowed_only_when_configured() {
        assert!(allowed("http://127.0.0.1:1420/", DEV));
        assert!(allowed("http://127.0.0.1:1420/src/main.ts", DEV));
        assert!(!allowed("http://127.0.0.1:1421/", DEV));
        assert!(!allowed("https://127.0.0.1:1420/", DEV));
        assert!(!allowed("http://localhost:1420/", DEV));
        assert!(!allowed("http://user@127.0.0.1:1420/", DEV));
    }
}
