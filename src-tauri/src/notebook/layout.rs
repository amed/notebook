//! Pane sizes: the sidebar and outline widths and the editor's share of
//! Split, and the preview zoom: global preferences in `config.json`
//! (`"layout"`). The frontend sends the sizes once a drag ends (or 500 ms
//! after the last resize key), never per pointer move, and the zoom 500 ms
//! after its last change; each call carries only the values it changes, so
//! a document window saving the zoom never resets the main window's sizes.
//! Saving them touches no workspace, secret or S3 object.
//!
//! The ranges match `src/panel-layout.ts` and `src/preview-zoom.ts`. A config
//! without the field, or with a value out of range or of the wrong type, gets
//! the default for that value: a cosmetic preference never makes the file
//! unreadable.

use super::*;

pub(super) const SIDEBAR_WIDTH: (u32, u32) = (180, 480);
pub(super) const OUTLINE_WIDTH: (u32, u32) = (180, 420);
pub(super) const SPLIT_RATIO: (f64, f64) = (0.2, 0.8);
pub(super) const PREVIEW_ZOOM: (u32, u32) = (50, 200);

/// CSS pixels for the widths; the editor's fraction of the editor and
/// preview in Split; the preview zoom in percent.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct PanelLayout {
    pub sidebar_width: u32,
    pub outline_width: u32,
    pub split_ratio: f64,
    pub preview_zoom: u32,
}

impl Default for PanelLayout {
    fn default() -> Self {
        Self {
            sidebar_width: 280,
            outline_width: 240,
            split_ratio: 0.5,
            preview_zoom: 100,
        }
    }
}

/// `layout_set`'s arguments: the values to change.
#[derive(Clone, Copy, Debug, Default)]
pub(super) struct LayoutChange {
    pub sidebar_width: Option<u32>,
    pub outline_width: Option<u32>,
    pub split_ratio: Option<f64>,
    pub preview_zoom: Option<u32>,
}

impl LayoutChange {
    fn applied_to(self, layout: PanelLayout) -> PanelLayout {
        PanelLayout {
            sidebar_width: self.sidebar_width.unwrap_or(layout.sidebar_width),
            outline_width: self.outline_width.unwrap_or(layout.outline_width),
            split_ratio: self.split_ratio.unwrap_or(layout.split_ratio),
            preview_zoom: self.preview_zoom.unwrap_or(layout.preview_zoom),
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

fn zoom_ok(percent: u32) -> bool {
    (PREVIEW_ZOOM.0..=PREVIEW_ZOOM.1).contains(&percent)
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
    if !zoom_ok(layout.preview_zoom) {
        return Err(IpcError::invalid(
            "The preview zoom must be between 50 and 200 percent.",
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
    if let Some(zoom) = width("preview_zoom", zoom_ok, &mut changed) {
        layout.preview_zoom = zoom;
    }
    if let Some(value) = object.get("split_ratio") {
        match value.as_f64().filter(|ratio| split_ok(*ratio)) {
            Some(ratio) => layout.split_ratio = ratio,
            None => changed = true,
        }
    }
    (layout, changed)
}

/// Saves the values in `change` with the other global preferences (written
/// durably, as `settings_set` does); the values not given stay. It never
/// touches a workspace, its credentials, the unlocked session or S3.
pub(super) fn save_layout(state: &NotebookState, change: LayoutChange) -> Result<(), IpcError> {
    validate_layout(&change.applied_to(PanelLayout::default()))?;
    let mut inner = state
        .inner
        .lock()
        .map_err(|_| IpcError::internal("STATE"))?;
    let layout = change.applied_to(inner.app.layout);
    if inner.app.layout == layout {
        return Ok(());
    }
    let mut app = inner.app.clone();
    app.layout = layout;
    state.save_config(&app)?;
    inner.app = app;
    Ok(())
}

/// `layout_set({ sidebar_width?, outline_width?, split_ratio?, preview_zoom? })`.
#[tauri::command(rename_all = "snake_case")]
pub fn layout_set(
    state: State<'_, NotebookState>,
    sidebar_width: Option<u32>,
    outline_width: Option<u32>,
    split_ratio: Option<f64>,
    preview_zoom: Option<u32>,
) -> Result<(), IpcError> {
    save_layout(
        &state,
        LayoutChange {
            sidebar_width,
            outline_width,
            split_ratio,
            preview_zoom,
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
            preview_zoom: 100,
        }
    }

    /// The pane sizes, as the main window sends them after a drag.
    fn sizes(layout: PanelLayout) -> LayoutChange {
        LayoutChange {
            sidebar_width: Some(layout.sidebar_width),
            outline_width: Some(layout.outline_width),
            split_ratio: Some(layout.split_ratio),
            preview_zoom: None,
        }
    }

    fn zoom(percent: u32) -> LayoutChange {
        LayoutChange {
            preview_zoom: Some(percent),
            ..LayoutChange::default()
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
            PanelLayout {
                preview_zoom: 49,
                ..PanelLayout::default()
            },
            PanelLayout {
                preview_zoom: 201,
                ..PanelLayout::default()
            },
        ] {
            assert_eq!(
                validate_layout(&bad).unwrap_err().code(),
                "INVALID_INPUT",
                "{bad:?}"
            );
        }
        for good in [50, 67, 100, 175, 200] {
            let zoomed = PanelLayout {
                preview_zoom: good,
                ..PanelLayout::default()
            };
            assert!(validate_layout(&zoomed).is_ok(), "{good}");
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
        let zoomed = |preview_zoom| PanelLayout {
            preview_zoom,
            ..PanelLayout::default()
        };
        assert_eq!(parse(r#"{"preview_zoom":150}"#), (zoomed(150), false));
        assert_eq!(parse(r#"{"preview_zoom":20}"#), (zoomed(100), true));
        assert_eq!(parse(r#"{"preview_zoom":1.5}"#), (zoomed(100), true));
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

        let mut wanted = layout(344, 212, 0.6375);
        save_layout(&state, sizes(wanted)).unwrap();
        // The zoom alone (a document window, say) keeps the sizes.
        save_layout(&state, zoom(125)).unwrap();
        wanted.preview_zoom = 125;
        let saved: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&config).unwrap()).unwrap();
        assert_eq!(
            saved["layout"],
            serde_json::json!({ "sidebar_width": 344, "outline_width": 212, "split_ratio": 0.6375, "preview_zoom": 125 })
        );
        assert_eq!(saved["theme"], "Dark");
        assert_eq!(saved["accent"], "teal");
        assert_eq!(saved["auto_lock_minutes"], 5);

        // A rejected value changes neither the state nor the file.
        let before = std::fs::read(&config).unwrap();
        assert!(save_layout(&state, sizes(layout(100, 212, 0.5))).is_err());
        assert!(save_layout(&state, zoom(300)).is_err());
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
            serde_json::json!({ "sidebar_width": 344, "outline_width": 212, "split_ratio": 0.6375, "preview_zoom": 125 })
        );
    }
}
