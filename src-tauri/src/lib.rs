#![forbid(unsafe_code)]

pub mod compat;
mod deleted_items;
mod hardening;
mod links;
pub mod notebook;
mod preview;
mod secrets;
mod window;

use tauri::{Emitter as _, Manager as _};

/// Application entry point. The command graph is registered here so the
/// platform binary stays thin and pure modules remain independently testable.
pub fn run() {
    hardening::init();
    let builder = tauri::Builder::default()
        // Only the Rust API is used (`link_open`); the webview gets no opener
        // permission and no injected link-click script.
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        )
        .setup(|app| {
            let config_dir = app.path().app_config_dir()?;
            let data_dir = app.path().app_local_data_dir()?;
            app.manage(notebook::NotebookState::load(config_dir, data_dir));
            window::create_main(app)?;
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(10)).await;
                    let Some(state) = handle.try_state::<notebook::NotebookState>() else {
                        break;
                    };
                    let forced = match state.check_idle_session() {
                        notebook::IdleAction::None => continue,
                        notebook::IdleAction::Notify => false,
                        notebook::IdleAction::Forced => true,
                    };
                    let _ = handle.emit("auto-lock", forced);
                }
            });
            Ok(())
        });
    #[cfg(target_os = "macos")]
    let builder = builder.menu(window::app_menu).on_menu_event(|app, event| {
        if event.id() == window::QUIT_MENU_ID {
            window::quit(app);
        }
    });
    notebook::configure(builder)
        .run(tauri::generate_context!())
        .expect("failed to run Notebook");
}
