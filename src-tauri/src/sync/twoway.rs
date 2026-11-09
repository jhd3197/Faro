//! Three-way reconciliation against independently recorded local/remote states.
//! Concurrent changes are never resolved by comparing clocks across computers.
use super::{recovery::FileState, SyncDelete, SyncDirection, SyncFile, SyncPlan, SyncReason, SyncStrategy};
use crate::scan::ScanTree;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Snapshot { pub local: Option<FileState>, pub remote: Option<FileState> }

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Version { pub state: Snapshot, pub revision: u64 }

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Baseline { pub identity: String, pub files: BTreeMap<String, Version> }

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Conflict { pub identity: String, pub relative: String, pub state: Snapshot, pub revision: u64 }

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Choice { pub conflict: Conflict, pub local: bool }

pub fn snapshot(local: &ScanTree, remote: &ScanTree, path: &str) -> Snapshot {
    Snapshot { local: local.files.get(path).map(FileState::from), remote: remote.files.get(path).map(FileState::from) }
}

#[derive(Debug, PartialEq)]
pub enum Decision { Unchanged, Local, Remote, Conflict }

pub fn decide(now: &Snapshot, previous: Option<&Snapshot>, mirror: bool) -> Decision {
    match previous {
        None => match (&now.local, &now.remote) {
            (None, None) => Decision::Unchanged,
            (Some(_), None) => Decision::Local,
            (None, Some(_)) => Decision::Remote,
            (Some(_), Some(_)) => Decision::Conflict,
        },
        Some(before) => match (now.local != before.local, now.remote != before.remote) {
            (false, false) => Decision::Unchanged,
            (true, true) if now.local.is_none() && now.remote.is_none() => Decision::Unchanged,
            (true, true) => Decision::Conflict,
            (true, false) if now.local.is_none() && !mirror => Decision::Remote,
            (false, true) if now.remote.is_none() && !mirror => Decision::Local,
            (true, false) => Decision::Local,
            (false, true) => Decision::Remote,
        },
    }
}

pub fn paths(local: &ScanTree, remote: &ScanTree, baseline: &Baseline) -> BTreeSet<String> {
    local.files.keys().chain(remote.files.keys()).chain(baseline.files.keys()).cloned().collect()
}

pub fn plan(relative: &str, state: &Snapshot, local_wins: bool, local_root: &str, remote_root: &str) -> SyncPlan {
    let (source, destination, source_root, destination_root, direction) = if local_wins {
        (&state.local, &state.remote, local_root, remote_root, SyncDirection::LocalToRemote)
    } else { (&state.remote, &state.local, remote_root, local_root, SyncDirection::RemoteToLocal) };
    let mut plan = SyncPlan { direction, strategy: SyncStrategy::Mirror, local_root: local_root.into(), remote_root: remote_root.into(), copies: vec![], directories: vec![], deletes: vec![], total_bytes: 0 };
    if let Some(source) = source {
        plan.total_bytes = source.size;
        plan.copies.push(SyncFile { relative: relative.into(), source_path: super::join(source_root, relative), destination_path: super::join(destination_root, relative), size: source.size, reason: if destination.is_some() { SyncReason::Edited } else { SyncReason::Missing }, destination_state: destination.clone() });
    } else if let Some(destination) = destination {
        plan.deletes.push(SyncDelete { relative: relative.into(), path: super::join(destination_root, relative), kind: crate::remotefs::FileKind::File, size: destination.size, destination_state: Some(destination.clone()) });
    }
    plan
}

pub fn key(pair: &str, kind: &str) -> String { format!("two-way:{pair}:{kind}") }
pub fn choice_key(pair: &str, relative: &str) -> String {
    use sha2::{Digest, Sha256};
    format!("two-way:{pair}:choice:{:x}", Sha256::digest(relative.as_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn file(n: i64) -> Option<FileState> { Some(FileState { size: 3, modified: n, etag: None }) }
    #[tokio::test]
    async fn source_revalidation_refuses_changed_files_and_detects_new_files() {
        let root = std::env::temp_dir().join(format!("faro-two-way-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let root_str = root.to_str().unwrap();
        let fs = crate::remotefs::local::LocalFs;
        check_source(&fs, root_str, "nested/file", None).await.unwrap();
        std::fs::write(root.join("file"), b"old").unwrap();
        let tree = crate::scan::sync_tree(&fs, root_str, false).await.unwrap();
        let stamp = FileState::from(tree.files.get("file").unwrap());
        check_source(&fs, root_str, "file", Some(&stamp)).await.unwrap();
        assert!(check_source(&fs, root_str, "file", None).await.is_err());
        std::fs::write(root.join("file"), b"changed").unwrap();
        assert!(check_source(&fs, root_str, "file", Some(&stamp)).await.is_err());
        std::fs::remove_file(root.join("file")).unwrap();
        std::fs::remove_dir(root).unwrap();
    }
    #[test]
    fn two_way_memory_is_durable_and_separate_from_user_settings() {
        let db = crate::db::Db::open_in_memory().unwrap();
        db.sync_reconcile_set(&key("one", "baseline"), "{}").unwrap();
        db.sync_reconcile_set(&key("two", "baseline"), "{}").unwrap();
        assert_eq!(db.sync_reconcile_get(&key("one", "baseline")).unwrap().as_deref(), Some("{}"));
        assert!(db.settings_get_all().unwrap().is_empty());
        db.clear_pair("one").unwrap();
        assert!(db.sync_reconcile_get(&key("one", "baseline")).unwrap().is_none());
        assert!(db.sync_reconcile_get(&key("two", "baseline")).unwrap().is_some());
    }

    #[test]
    fn concurrent_edits_and_delete_edit_conflicts_are_never_clock_winners() {
        let before = Snapshot { local: file(10), remote: file(99) };
        assert_eq!(decide(&Snapshot { local: file(11), remote: file(100) }, Some(&before), true), Decision::Conflict);
        assert_eq!(decide(&Snapshot { local: None, remote: file(100) }, Some(&before), true), Decision::Conflict);
        assert_eq!(decide(&Snapshot { local: file(11), remote: file(99) }, Some(&before), true), Decision::Local);
        assert_eq!(decide(&Snapshot { local: None, remote: file(99) }, Some(&before), true), Decision::Local);
        assert_eq!(decide(&Snapshot { local: None, remote: file(99) }, Some(&before), false), Decision::Remote);
        assert_eq!(decide(&before, None, true), Decision::Conflict);
        assert_eq!(decide(&before, Some(&before), true), Decision::Unchanged);
    }
}

/// Inspect without following directory symlinks; missing ancestors mean absent.
pub async fn check_source(fs: &dyn crate::remotefs::RemoteFs, root: &str, path: &str, expected: Option<&FileState>) -> anyhow::Result<()> {
    super::recovery::validate_relative(path)?;
    let parts: Vec<_> = path.split('/').collect();
    let mut parent = root.to_string();
    let mut found = None;
    for (i, part) in parts.iter().enumerate() {
        let entries = fs.list_dir(&parent).await?;
        let Some(entry) = entries.iter().find(|e| e.name == *part) else { break; };
        if i + 1 == parts.len() {
            anyhow::ensure!(entry.kind == crate::remotefs::FileKind::File, "Sync source changed type; re-plan");
            found = Some(FileState { size: entry.size, modified: entry.modified.unwrap_or(0), etag: entry.etag.clone() });
        } else {
            anyhow::ensure!(entry.kind == crate::remotefs::FileKind::Directory, "Sync source parent changed type; re-plan");
            parent = super::join(&parent, part);
        }
    }
    anyhow::ensure!(found.as_ref() == expected, "Sync source changed since planning; retry before replacing or deleting another version");
    Ok(())
}
