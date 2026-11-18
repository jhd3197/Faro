//! Settings › Storage: how much disk Faro's clearable caches use, and a clear
//! action for each. Every cache here is safe to drop: thumbnails regenerate,
//! leftover edit copies belong to no open edit, and clearing resume data only
//! touches transfers that aren't running.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::AppHandle;

/// Remote image thumbnails (`<app data>/thumbnails`).
pub const THUMBNAILS: &str = "thumbnails";
/// Saved progress of paused or failed transfers and their partial files.
pub const TRANSFER_RESUME: &str = "transferResume";
/// Local copies left behind by edit-in-place sessions that are no longer open.
pub const EDIT_COPIES: &str = "editCopies";

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CacheUsage {
    pub id: String,
    pub bytes: u64,
    pub items: u64,
}

/// Bytes and file count under `path`, recursively. Missing = empty.
fn dir_usage(path: &Path, skip: &HashSet<PathBuf>) -> (u64, u64) {
    let mut bytes = 0;
    let mut files = 0;
    let mut stack = vec![path.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        for entry in rd.flatten() {
            let p = entry.path();
            if skip.contains(&p) {
                continue;
            }
            let Ok(ft) = entry.file_type() else { continue };
            if ft.is_dir() {
                stack.push(p);
            } else if ft.is_file() {
                bytes += entry.metadata().map(|m| m.len()).unwrap_or(0);
                files += 1;
            }
        }
    }
    (bytes, files)
}

/// Count of thumbnail files only (temp files from in-flight writes aside).
fn thumbnail_usage(dir: &Path) -> (u64, u64) {
    let mut bytes = 0;
    let mut files = 0;
    if let Ok(rd) = std::fs::read_dir(dir) {
        for entry in rd.flatten() {
            let p = entry.path();
            if p.extension().and_then(|e| e.to_str()) == Some("png") {
                bytes += entry.metadata().map(|m| m.len()).unwrap_or(0);
                files += 1;
            }
        }
    }
    (bytes, files)
}

/// Leftover edit folders: every child of `root` that isn't an open edit.
fn leftover_edit_dirs(root: &Path, open: &HashSet<PathBuf>) -> Vec<PathBuf> {
    let Ok(rd) = std::fs::read_dir(root) else { return Vec::new() };
    rd.flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir() && !open.contains(p))
        .collect()
}

fn edit_copies_usage(root: &Path, open: &HashSet<PathBuf>) -> (u64, u64) {
    let dirs = leftover_edit_dirs(root, open);
    let mut bytes = 0;
    for d in &dirs {
        bytes += dir_usage(d, &HashSet::new()).0;
    }
    (bytes, dirs.len() as u64)
}

async fn usage(id: &str, state: &crate::AppState) -> Result<CacheUsage, String> {
    let (bytes, items) = match id {
        THUMBNAILS => {
            let dir = state.preview.cache_dir().to_path_buf();
            tokio::task::spawn_blocking(move || thumbnail_usage(&dir))
                .await
                .map_err(|e| e.to_string())?
        }
        TRANSFER_RESUME => state.transfers.resume_usage().await,
        EDIT_COPIES => {
            let open = state.editors.open_dirs().await;
            tokio::task::spawn_blocking(move || edit_copies_usage(&crate::editor::edits_root(), &open))
                .await
                .map_err(|e| e.to_string())?
        }
        other => return Err(format!("unknown cache {other}")),
    };
    Ok(CacheUsage { id: id.to_string(), bytes, items })
}

/// Size of every clearable cache.
#[tauri::command]
pub async fn cache_usage(state: tauri::State<'_, crate::AppState>) -> Result<Vec<CacheUsage>, String> {
    let mut out = Vec::new();
    for id in [THUMBNAILS, TRANSFER_RESUME, EDIT_COPIES] {
        out.push(usage(id, &state).await?);
    }
    Ok(out)
}

/// Clear one cache and return its size afterwards.
#[tauri::command]
pub async fn cache_clear(
    id: String,
    app: AppHandle,
    state: tauri::State<'_, crate::AppState>,
) -> Result<CacheUsage, String> {
    match id.as_str() {
        THUMBNAILS => state
            .preview
            .clear_all(&state.db)
            .await
            .map_err(|e| format!("{e:#}"))?,
        TRANSFER_RESUME => {
            state.transfers.clear_resume(&app).await;
        }
        EDIT_COPIES => {
            let open = state.editors.open_dirs().await;
            let root = crate::editor::edits_root();
            tokio::task::spawn_blocking(move || {
                for d in leftover_edit_dirs(&root, &open) {
                    let _ = std::fs::remove_dir_all(d);
                }
            })
            .await
            .map_err(|e| e.to_string())?;
        }
        other => return Err(format!("unknown cache {other}")),
    }
    usage(&id, &state).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("faro-cache-test-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn thumbnail_usage_counts_only_pngs() {
        let d = scratch("thumbs");
        std::fs::write(d.join("a.png"), [0u8; 10]).unwrap();
        std::fs::write(d.join("b.png"), [0u8; 5]).unwrap();
        std::fs::write(d.join("c.tmp"), [0u8; 100]).unwrap();
        assert_eq!(thumbnail_usage(&d), (15, 2));
        assert_eq!(thumbnail_usage(&d.join("missing")), (0, 0));
        std::fs::remove_dir_all(d).ok();
    }

    #[test]
    fn leftover_edits_skip_open_ones() {
        let root = scratch("edits");
        let open_dir = root.join("open");
        let stale = root.join("stale");
        std::fs::create_dir_all(&open_dir).unwrap();
        std::fs::create_dir_all(stale.join("nested")).unwrap();
        std::fs::write(open_dir.join("f.txt"), [0u8; 7]).unwrap();
        std::fs::write(stale.join("nested").join("g.txt"), [0u8; 3]).unwrap();
        let open: HashSet<PathBuf> = [open_dir.clone()].into_iter().collect();
        assert_eq!(leftover_edit_dirs(&root, &open), vec![stale.clone()]);
        assert_eq!(edit_copies_usage(&root, &open), (3, 1));
        std::fs::remove_dir_all(root).ok();
    }
}
