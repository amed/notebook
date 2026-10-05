//! Pane sizes: the sidebar and outline widths and the editor's share of
//! Split, a global preference in `config.json` (`"layout"`). The frontend
//! sends them once a drag ends (or 500 ms after the last resize key), never
//! per pointer move; saving them touches no workspace, secret or S3 object.
//!
//! The ranges match `src/panel-layout.ts`. A config without the field, or with
//! a value out of range or of the wrong type, gets the default for that value:
//! a cosmetic preference never makes the file unreadable.

use super::*;

pub(super) const SIDEBAR_WIDTH: (u32, u32) = (180, 480);
pub(super) const OUTLINE_WIDTH: (u32, u32) = (180, 420);
pub(super) const SPLIT_RATIO: (f64, f64) = (0.2, 0.8);

/// CSS pixels for the widths; the editor's fraction of the editor and
/// preview in Split.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct PanelLayout {
    pub sidebar_width: u32,
    pub outline_width: u32,
    pub split_ratio: f64,
}

impl Default for PanelLayout {
    fn default() -> Self {
        Self {
            sidebar_width: 280,
            outline_width: 240,
            split_ratio: 0.5,
        }
    }
}

fn sidebar_ok(width: u32) -> bool {
    (SIDEBAR_WIDTH.0..=SIDEBAR_WIDTH.1).contains(&width)
}

fn outline_ok(width: u32) -> bool {
    (OUTLINE_WIDTH.0..=OUTLINE_WIDTH.1).contains(&width)
}

fn split_ok(ratio: f64) -> bool {
    ratio.is_finite() && (SPLIT_RATIO.0..=SPLIT_RATIO.1).contains(&ratio)
}

pub(super) fn validate_layout(layout: &PanelLayout) -> Result<(), IpcError> {
    if !sidebar_ok(layout.sidebar_width) {
        return Err(IpcError::invalid(
            "The sidebar width must be between 180 and 480 pixels.",
        ));
    }
    if !outline_ok(layout.outline_width) {
        return Err(IpcError::invalid(
            "The outline width must be between 180 and 420 pixels.",
        ));
    }
    if !split_ok(layout.split_ratio) {
        return Err(IpcError::invalid(
            "The split ratio must be between 0.2 and 0.8.",
        ));
    }
    Ok(())
}

/// `config.json`'s `"layout"`. Returns the layout and whether it differs
/// from the file (a value was repaired); a missing field or value is the
/// default and is not a change, as for the accent.
pub(super) fn parse_layout(raw: Option<&serde_json::Value>) -> (PanelLayout, bool) {
    let mut layout = PanelLayout::default();
    let Some(raw) = raw else {
        return (layout, false);
    };
    let Some(object) = raw.as_object() else {
        return (layout, true);
    };
    let mut changed = false;
    let width = |key: &str, ok: fn(u32) -> bool, changed: &mut bool| -> Option<u32> {
        let value = object.get(key)?;
        let width = value
            .as_u64()
            .and_then(|width| u32::try_from(width).ok())
            .filter(|width| ok(*width));
        if width.is_none() {
            *changed = true;
        }
        width
    };
    if let Some(sidebar) = width("sidebar_width", sidebar_ok, &mut changed) {
        layout.sidebar_width = sidebar;
    }
    if let Some(outline) = width("outline_width", outline_ok, &mut changed) {
        layout.outline_width = outline;
    }
    if let Some(value) = object.get("split_ratio") {
        match value.as_f64().filter(|ratio| split_ok(*ratio)) {
            Some(ratio) => layout.split_ratio = ratio,
            None => changed = true,
        }
    }
    (layout, changed)
}

/// Saves the pane sizes with the other global preferences (written durably,
/// as `settings_set` does). It never touches a workspace, its credentials,
/// the unlocked session or S3.
pub(super) fn save_layout(state: &NotebookState, layout: PanelLayout) -> Result<(), IpcError> {
    validate_layout(&layout)?;
    let mut inner = state
        .inner
        .lock()
        .map_err(|_| IpcError::internal("STATE"))?;
    if inner.app.layout == layout {
        return Ok(());
    }
    let mut app = inner.app.clone();
    app.layout = layout;
    state.save_config(&app)?;
    inner.app = app;
    Ok(())
}

/// `layout_set({ sidebar_width, outline_width, split_ratio })`.
#[tauri::command(rename_all = "snake_case")]
pub fn layout_set(
    state: State<'_, NotebookState>,
    sidebar_width: u32,
    outline_width: u32,
    split_ratio: f64,
) -> Result<(), IpcError> {
    save_layout(
        &state,
        PanelLayout {
            sidebar_width,
            outline_width,
            split_ratio,
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::notebook::workspaces::MemoryKeychain;

    fn state_in(directory: &Path) -> NotebookState {
        NotebookState::load_with(
            directory.join("config"),
            directory.join("local"),
            Arc::new(MemoryKeychain::default()),
        )
    }

    fn layout(sidebar_width: u32, outline_width: u32, split_ratio: f64) -> PanelLayout {
        PanelLayout {
            sidebar_width,
            outline_width,
            split_ratio,
        }
    }

    #[test]
    fn layout_values_are_validated() {
        for good in [
            layout(180, 180, 0.2),
            layout(480, 420, 0.8),
            layout(280, 240, 0.5),
            layout(333, 201, 0.6125),
        ] {
            assert!(validate_layout(&good).is_ok(), "{good:?}");
        }
        for bad in [
            layout(179, 240, 0.5),
            layout(481, 240, 0.5),
            layout(280, 179, 0.5),
            layout(280, 421, 0.5),
            layout(280, 240, 0.19),
            layout(280, 240, 0.81),
            layout(280, 240, f64::NAN),
            layout(280, 240, f64::INFINITY),
        ] {
            assert_eq!(
                validate_layout(&bad).unwrap_err().code(),
                "INVALID_INPUT",
                "{bad:?}"
            );
        }
    }

    #[test]
    fn configs_without_a_layout_get_the_defaults_and_bad_values_are_repaired() {
        assert_eq!(parse_layout(None), (PanelLayout::default(), false));
        let parse = |text: &str| parse_layout(Some(&serde_json::from_str(text).unwrap()));
        assert_eq!(parse("{}"), (PanelLayout::default(), false));
        assert_eq!(
            parse(r#"{"sidebar_width":300}"#),
            (layout(300, 240, 0.5), false)
        );
        assert_eq!(
            parse(r#"{"sidebar_width":320,"outline_width":200,"split_ratio":0.65}"#),
            (layout(320, 200, 0.65), false)
        );
        // Out of range or the wrong type: that value is the default again.
        assert_eq!(
            parse(r#"{"sidebar_width":5000,"outline_width":"wide","split_ratio":0.7}"#),
            (layout(280, 240, 0.7), true)
        );
        assert_eq!(
            parse(r#"{"sidebar_width":-1,"outline_width":300.5,"split_ratio":2}"#),
            (PanelLayout::default(), true)
        );
        assert_eq!(parse(r#""narrow""#), (PanelLayout::default(), true));
    }

    #[test]
    fn the_layout_round_trips_through_config_json_and_keeps_the_other_preferences() {
        let directory = tempfile::tempdir().unwrap();
        let config = directory.path().join("config").join("config.json");
        std::fs::create_dir_all(config.parent().unwrap()).unwrap();
        // Written before the layout existed.
        std::fs::write(
            &config,
            br#"{"version":2,"auto_lock_minutes":5,"theme":"Dark","accent":"teal","workspaces":[]}"#,
        )
        .unwrap();
        let state = state_in(directory.path());
        assert_eq!(
            state.lock_inner().unwrap().app.layout,
            PanelLayout::default()
        );

        let wanted = layout(344, 212, 0.6375);
        save_layout(&state, wanted).unwrap();
        let saved: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&config).unwrap()).unwrap();
        assert_eq!(
            saved["layout"],
            serde_json::json!({ "sidebar_width": 344, "outline_width": 212, "split_ratio": 0.6375 })
        );
        assert_eq!(saved["theme"], "Dark");
        assert_eq!(saved["accent"], "teal");
        assert_eq!(saved["auto_lock_minutes"], 5);

        // A rejected value changes neither the state nor the file.
        let before = std::fs::read(&config).unwrap();
        assert!(save_layout(&state, layout(100, 212, 0.5)).is_err());
        assert_eq!(std::fs::read(&config).unwrap(), before);
        assert_eq!(state.lock_inner().unwrap().app.layout, wanted);

        // A new process reads it back, without rewriting the file.
        drop(state);
        let again = state_in(directory.path());
        assert_eq!(again.lock_inner().unwrap().app.layout, wanted);
        assert_eq!(std::fs::read(&config).unwrap(), before);
        let view =
            serde_json::to_value(workspaces::config_view(&again.lock_inner().unwrap())).unwrap();
        assert_eq!(
            view["layout"],
            serde_json::json!({ "sidebar_width": 344, "outline_width": 212, "split_ratio": 0.6375 })
        );
    }
}
