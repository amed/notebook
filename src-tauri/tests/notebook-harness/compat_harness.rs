//! Copied into a scratch copy of Notebook as `src/app/compat_harness.rs` by
//! `scripts/notebook-compat.sh`; never compiled in this repository.
//!
//! Each run opens the S3 workspace given in `NB_*` variables and performs one
//! action through Notebook's own UI command flow (the prompts and handlers
//! its sidebar uses), then prints the result. It never reads or writes
//! Notebook's saved settings, session or keychain entries.

use super::commands;
use super::deleted_items;
use super::state::{AppState, create_open_service};
use crate::domain::storage::types::{
    DocumentHandle, EntryHandle, FileNode, ProviderConfig, S3Credentials, S3ProviderConfig,
    StorageProviderId,
};
use crate::model::config::{AppConfig, RemoteEncryptionConfig};
use std::process::ExitCode;
use std::time::{Duration, Instant};

pub fn main() -> ExitCode {
    match run(std::env::args().skip(1).collect()) {
        Ok(output) => {
            println!("{output}");
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("{error}");
            ExitCode::FAILURE
        }
    }
}

fn var(name: &str) -> Result<String, String> {
    std::env::var(name).map_err(|_| format!("{name} is not set"))
}

fn run(args: Vec<String>) -> Result<String, String> {
    let mut state = open()?;
    let arg = |index: usize| {
        args.get(index)
            .cloned()
            .ok_or_else(|| format!("missing argument {index}"))
    };
    match arg(0)?.as_str() {
        "mkdir" => {
            commands::request_new_workspace_folder(&mut state);
            submit(&mut state, Some(format!("/{}", arg(1)?)))?;
            Ok(String::from("ok"))
        }
        "write" => {
            let path = arg(1)?;
            commands::request_new_workspace_file(&mut state);
            submit(&mut state, Some(format!("/{path}")))?;
            let session = state.storage_session.clone().ok_or("no session")?;
            let document = DocumentHandle {
                provider_id: StorageProviderId::s3(),
                name: path.rsplit('/').next().unwrap_or(&path).to_string(),
                path,
            };
            state
                .open_service
                .save_document(&session, &document, &arg(2)?)
                .map_err(|error| error.to_string())?;
            Ok(String::from("ok"))
        }
        "read" => {
            let session = state.storage_session.clone().ok_or("no session")?;
            let path = arg(1)?;
            let document = DocumentHandle {
                provider_id: StorageProviderId::s3(),
                name: path.rsplit('/').next().unwrap_or(&path).to_string(),
                path,
            };
            state
                .open_service
                .read_document(&session, &document)
                .map(|contents| contents.text)
                .map_err(|error| error.to_string())
        }
        "tree" => {
            let mut paths = Vec::new();
            collect_visible(&state.tree, &mut paths);
            paths.sort();
            serde_json::to_string(&paths).map_err(|error| error.to_string())
        }
        "catalog" => {
            let items = state
                .deleted_items_catalog
                .items
                .iter()
                .map(|item| {
                    serde_json::json!({
                        "id": item.id,
                        "name": item.name(),
                        "original_path": item.original_path,
                        "original_parent_path": item.original_parent_path,
                        "deleted_at_unix_ms": item.deleted_at_unix_ms,
                        "is_directory": item.root.is_directory(),
                        "descendant_count": item.descendant_count,
                        "list_annotation": item.list_annotation(),
                        "root_path": item.handle().path,
                    })
                })
                .collect::<Vec<_>>();
            serde_json::to_string(&items).map_err(|error| error.to_string())
        }
        "delete" => {
            state.deleted_items_visible = false;
            state.explorer_selection = Some(EntryHandle::new(StorageProviderId::s3(), arg(1)?));
            commands::request_delete_selected(&mut state);
            submit(&mut state, None)?;
            Ok(String::from("ok"))
        }
        "purge" => {
            select_deleted(&mut state, &arg(1)?)?;
            commands::request_delete_selected(&mut state);
            submit(&mut state, None)?;
            Ok(String::from("ok"))
        }
        "restore" => {
            select_deleted(&mut state, &arg(1)?)?;
            commands::request_restore_selected(&mut state);
            check(&mut state)?;
            settle(&mut state)?;
            Ok(String::from("ok"))
        }
        "restore-to" => {
            select_deleted(&mut state, &arg(1)?)?;
            commands::request_restore_selected_to(&mut state);
            submit(&mut state, Some(arg(2)?))?;
            Ok(String::from("ok"))
        }
        other => Err(format!("unknown action {other}")),
    }
}

fn open() -> Result<AppState, String> {
    let mut app_config = AppConfig::default();
    app_config.remote_encryption = RemoteEncryptionConfig {
        enabled: true,
        key_phrase: var("NB_PHRASE")?,
    };
    let service = create_open_service(&app_config);
    let prefix = var("NB_PREFIX").ok().filter(|value| !value.is_empty());
    let opened = service
        .open(ProviderConfig::S3(S3ProviderConfig {
            bucket: var("NB_BUCKET")?,
            region: var("NB_REGION").unwrap_or_else(|_| String::from("us-east-1")),
            endpoint: Some(var("NB_ENDPOINT")?),
            prefix,
            credentials: S3Credentials::AccessKey {
                access_key_id: var("NB_ACCESS_KEY_ID")?,
                secret_access_key: var("NB_SECRET_ACCESS_KEY")?,
                session_token: None,
            },
        }))
        .map_err(|error| error.to_string())?;
    let mut state = AppState::new(None, app_config, service);
    state.workspace_refresh_interval = Duration::from_secs(3_600);
    state.tree = opened.tree;
    state.deleted_items_catalog = deleted_items::catalog_from_tree(&state.tree);
    state.current_workspace = Some(opened.session.workspace.clone());
    state.storage_session = Some(opened.session);
    Ok(state)
}

fn select_deleted(state: &mut AppState, id: &str) -> Result<(), String> {
    let item = state
        .deleted_items_catalog
        .items
        .iter()
        .find(|item| item.id == id)
        .ok_or_else(|| format!("no deleted item {id}"))?;
    state.explorer_selection = Some(item.handle().clone());
    state.deleted_items_visible = true;
    Ok(())
}

/// Confirms the pending prompt like the dialog's primary button.
fn submit(state: &mut AppState, value: Option<String>) -> Result<(), String> {
    check(state)?;
    let prompt = state
        .pending_prompt
        .as_mut()
        .ok_or_else(|| format!("no prompt opened: {}", state.status_message))?;
    if let Some(value) = value {
        prompt.value = value;
    }
    commands::submit_prompt(state);
    check(state)?;
    if state.pending_prompt.is_some() {
        return Err(String::from("the prompt stayed open"));
    }
    settle(state)
}

fn check(state: &mut AppState) -> Result<(), String> {
    match state.error_message.take() {
        Some(error) => Err(error),
        None => Ok(()),
    }
}

/// Waits for the background open or refresh Notebook starts after a change.
fn settle(state: &mut AppState) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(60);
    while state.refresh_in_flight || state.open_document_in_flight {
        if Instant::now() > deadline {
            return Err(String::from("timed out waiting for Notebook to refresh"));
        }
        std::thread::sleep(Duration::from_millis(20));
        commands::refresh_workspace_if_stale(state);
    }
    check(state)
}

fn collect_visible(nodes: &[FileNode], paths: &mut Vec<String>) {
    for node in nodes {
        if deleted_items::is_deleted_path(&node.handle.path) {
            continue;
        }
        if node.is_directory() {
            paths.push(format!("{}/", node.handle.path));
            collect_visible(&node.children, paths);
        } else {
            paths.push(node.handle.path.clone());
        }
    }
}
