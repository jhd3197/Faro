use super::*;
use crate::sync::twoway::{self, Baseline, Choice, Conflict, Decision, Version};

fn read<T: serde::de::DeserializeOwned + Default>(db: &crate::db::Db, key: &str) -> Result<T> {
    match db.sync_reconcile_get(key)? { Some(value) => Ok(serde_json::from_str(&value)?), None => Ok(T::default()) }
}

pub(super) async fn reconcile(app: &AppHandle, state: &AppState, pair: &SyncPair, session: Arc<crate::session::Session>) -> Result<Option<String>> {
    let local = crate::remotefs::local::LocalFs;
    let remote = crate::commands::fs_for_session(&session);
    let identity = serde_json::to_string(&(&pair.local_root, &pair.remote_root, crate::sync::recovery::destination_key(session.profile(), false)))?;
    let baseline_key = twoway::key(&pair.id, "baseline");
    let mut baseline: Baseline = read(&state.db, &baseline_key)?;
    if baseline.identity != identity { baseline = Baseline { identity: identity.clone(), ..Default::default() }; }
    // Both roots must exist. A missing/unreadable root is never a mass deletion.
    let mut left = crate::scan::sync_tree(&local, &pair.local_root, false).await?;
    let mut right = crate::scan::sync_tree(remote.as_ref(), &pair.remote_root, false).await?;
    left.files.retain(|p, _| !is_excluded(p, &pair.exclude));
    right.files.retain(|p, _| !is_excluded(p, &pair.exclude));
    let mut conflicts = Vec::new();
    let mut actions = Vec::new();
    let mut unchanged = Vec::new();
    for path in twoway::paths(&left, &right, &baseline) {
        if is_excluded(&path, &pair.exclude) { continue; }
        let now = twoway::snapshot(&left, &right, &path);
        let before = baseline.files.get(&path);
        let revision = before.map(|v| v.revision).unwrap_or(0);
        let decision = twoway::decide(&now, before.map(|v| &v.state), matches!(pair.strategy, SyncStrategy::Mirror));
        let local_wins = match decision {
            Decision::Unchanged => { unchanged.push((path, now, revision)); continue; }
            Decision::Local => true,
            Decision::Remote => false,
            Decision::Conflict => {
                let conflict = Conflict { relative: path.clone(), state: now.clone(), revision, identity: identity.clone() };
                let choice: Option<Choice> = read(&state.db, &twoway::choice_key(&pair.id, &path))?;
                conflicts.push(conflict.clone());
                match choice.filter(|c| c.conflict == conflict) { Some(c) => c.local, None => continue }
            }
        };
        actions.push((path, now, revision, local_wins));
    }
    state.db.sync_reconcile_set(&twoway::key(&pair.id, "conflicts"), &serde_json::to_string(&conflicts)?)?;
    let deletes = actions.iter().filter(|(_, s, _, local)| if *local { s.local.is_none() } else { s.remote.is_none() }).count();
    let guarded = pair.mirror_delete_cap != 0 && deletes > pair.mirror_delete_cap as usize;
    // A fully emptied side needs explicit conflict choices for every delete;
    // default batch deletion remains blocked even below the numeric guard.
    let mut completed = Vec::new();
    for (path, before, revision, local_wins) in actions {
        let source = if local_wins { &before.local } else { &before.remote };
        if source.is_none() && guarded { continue; }
        if source.is_none() && (if local_wins { left.files.is_empty() } else { right.files.is_empty() }) {
            let conflict = Conflict { relative: path.clone(), state: before.clone(), revision, identity: identity.clone() };
            let choice: Option<Choice> = read(&state.db, &twoway::choice_key(&pair.id, &path))?;
            if !choice.is_some_and(|c| c.conflict == conflict && c.local == local_wins) {
                if !conflicts.contains(&conflict) { conflicts.push(conflict); }
                continue;
            }
        }
        let (source_fs, source_root): (&dyn crate::remotefs::RemoteFs, &str) = if local_wins { (&local, &pair.local_root) } else { (remote.as_ref(), &pair.remote_root) };
        twoway::check_source(source_fs, source_root, &path, source.as_ref()).await?;
        let mut plan = twoway::plan(&path, &before, local_wins, &pair.local_root, &pair.remote_root);
        if source.is_some() {
            let (root, tree) = if local_wins { (&pair.remote_root, &right) } else { (&pair.local_root, &left) };
            let mut parents = Vec::new();
            let mut parent = path.rsplit_once('/').map(|(p, _)| p);
            while let Some(p) = parent {
                if !tree.directories.contains(p) { parents.push(crate::sync::join(root, p)); }
                parent = p.rsplit_once('/').map(|(p, _)| p);
            }
            parents.reverse();
            plan.directories = parents;
        }
        let created = plan.directories.clone();
        let ids = crate::commands::execute_sync_plan(session.clone(), plan, &state.transfers, app).await?;
        anyhow::ensure!(wait_for_transfers(state, &ids).await.is_empty(), "Two-way sync has incomplete transfers; resolve them before continuing");
        let (root, tree) = if local_wins { (&pair.remote_root, &mut right) } else { (&pair.local_root, &mut left) };
        for directory in created { tree.directories.insert(crate::scan::relative_of(root, &directory)); }
        completed.push((path, before, revision, local_wins));
    }
    let after_left = crate::scan::sync_tree(&local, &pair.local_root, false).await?;
    let after_right = crate::scan::sync_tree(remote.as_ref(), &pair.remote_root, false).await?;
    for (path, before, revision, local_wins) in completed {
        let now = twoway::snapshot(&after_left, &after_right, &path);
        let (source_before, source_now, dest_now) = if local_wins { (&before.local, &now.local, &now.remote) } else { (&before.remote, &now.remote, &now.local) };
        if source_before == source_now && source_now.as_ref().map(|s| s.size) == dest_now.as_ref().map(|s| s.size) {
            baseline.files.insert(path.clone(), Version { state: now, revision: revision + 1 });
            conflicts.retain(|c| c.relative != path);
        }
    }
    for (path, snapshot, revision) in unchanged {
        if twoway::snapshot(&after_left, &after_right, &path) == snapshot {
            let changed = baseline.files.get(&path).is_none_or(|v| v.state != snapshot);
            baseline.files.insert(path, Version { state: snapshot, revision: revision + u64::from(changed) });
        }
    }
    state.db.sync_reconcile_set(&baseline_key, &serde_json::to_string(&baseline)?)?;
    state.db.sync_reconcile_set(&twoway::key(&pair.id, "conflicts"), &serde_json::to_string(&conflicts)?)?;
    if guarded { Ok(Some(format!("Two-way delete guard blocked {deletes} deletions. Review the pair's safety cap."))) }
    else if !conflicts.is_empty() { Ok(Some(format!("{} file conflicts need a local or remote choice in Folder Sync settings.", conflicts.len()))) }
    else { Ok(None) }
}

#[tauri::command]
pub fn folder_sync_conflicts(pair_id: String, state: State<'_, AppState>) -> Result<Vec<Conflict>, String> {
    read(&state.db, &twoway::key(&pair_id, "conflicts")).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn folder_sync_resolve(pair_id: String, conflict: Conflict, local: bool, state: State<'_, AppState>) -> Result<(), String> {
    let known: Vec<Conflict> = read(&state.db, &twoway::key(&pair_id, "conflicts")).map_err(|e| e.to_string())?;
    if !known.contains(&conflict) { return Err("Conflict changed; refresh the list before choosing a version".into()); }
    state.db.sync_reconcile_set(&twoway::choice_key(&pair_id, &conflict.relative), &serde_json::to_string(&Choice { conflict, local }).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}
