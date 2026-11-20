//! Settings › Rules — rename, sort and view rules (Plan 34 Phase 5).

use std::path::Path;

use anyhow::Result;

use crate::scan::ScanEntry;

/// A destination-path mapper handed to [`crate::copyto::plan`].
pub type BoxNamer = Box<dyn Fn(&str, &ScanEntry) -> String + Send + Sync>;

fn identity() -> BoxNamer {
    Box::new(|rel: &str, _: &ScanEntry| rel.to_string())
}

/// The namer for an optional rule set, read from `rules.json` in `data_dir`
/// (shared by the app and `faro-cli`). Identity when none is attached.
pub fn load_namer(_data_dir: &Path, rule_set: Option<&str>) -> Result<BoxNamer> {
    match rule_set {
        None => Ok(identity()),
        Some(id) => anyhow::bail!("unknown rule set {id}"),
    }
}

/// [`load_namer`] against the app's data dir.
pub async fn namer_for(app: &tauri::AppHandle, rule_set: Option<&str>) -> Result<BoxNamer> {
    use tauri::Manager;
    let dir = app.path().app_data_dir()?;
    load_namer(&dir, rule_set)
}
