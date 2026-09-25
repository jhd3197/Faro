//! Faro as a Vela companion app.
//!
//! When Vela runs on this computer, Faro registers with it (see the
//! `vela-companion` crate). Once the owner connects it in Vela, transfers,
//! Agent Bridge requests and folder sync show on the Vela desk and on every
//! phone signed in to it. From there transfers can be paused and resumed,
//! folder sync run, and waiting agent requests denied.
//!
//! Approving an agent request is deliberately not offered: that decision
//! belongs at the computer, where the full command and its session are in view.

use std::sync::Mutex;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use vela_companion::{Action, Companion, Handle, Layout, Size, Widgets};

use crate::transfer::{Transfer, TransferStatus};
use crate::AppState;

const READ_TIMEOUT: Duration = Duration::from_secs(4);

#[derive(Default)]
pub struct VelaLink(Mutex<Option<Handle>>);

/// Register with Vela. Harmless when Vela is not installed: the file waits.
pub fn start(app: &AppHandle) {
    app.manage(VelaLink::default());
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let (for_widgets, for_actions) = (handle.clone(), handle.clone());
        let companion = Companion::new("faro", "Faro", env!("CARGO_PKG_VERSION"))
            .description("File transfers, folder sync and the Agent Bridge on this computer.")
            .color("#f5a524")
            .icon_png(include_bytes!("../icons/128x128.png").to_vec())
            .widget("transfers", "Transfers", Layout::Actions, Size::M)
            .widget("agent", "Agent requests", Layout::List, Size::M)
            .widget("sync", "Folder sync", Layout::List, Size::M)
            .action(Action::new("pause-transfers", "Pause transfers"))
            .action(Action::new("resume-transfers", "Resume transfers"))
            .action(Action::new("sync-now", "Sync folders now"))
            .action(
                Action::new("deny-agent", "Deny agent requests")
                    .description("Denies every Agent Bridge request waiting for you.")
                    .confirm("Deny every waiting agent request?"),
            )
            .on_widgets(move || {
                let app = for_widgets.clone();
                async move {
                    tokio::time::timeout(READ_TIMEOUT, widgets(&app))
                        .await
                        .unwrap_or_default()
                }
            })
            .on_action(move |id| {
                let app = for_actions.clone();
                async move { action(&app, &id).await }
            });
        match companion.start().await {
            Ok(registered) => {
                if let Some(link) = handle.try_state::<VelaLink>() {
                    *link.0.lock().unwrap() = Some(registered);
                }
            }
            Err(e) => eprintln!("[vela] could not register: {e}"),
        }
    });
}

/// Unregister, so Vela shows Faro as closed rather than not answering.
pub fn stop(app: &AppHandle) {
    if let Some(link) = app.try_state::<VelaLink>() {
        link.0.lock().unwrap().take();
    }
}

async fn widgets(app: &AppHandle) -> Widgets {
    let state = app.state::<AppState>();
    let mut out = Widgets::new();
    out.insert(
        "transfers".into(),
        transfers(
            &state.transfers.list().await,
            state.transfers.is_paused_all(),
        ),
    );
    out.insert(
        "agent".into(),
        agent(&state.bridge.pending_approvals().await),
    );
    let pairs: Vec<Value> = state
        .foldersync
        .views()
        .await
        .iter()
        .filter_map(|view| serde_json::to_value(view).ok())
        .collect();
    out.insert("sync".into(), sync(&pairs));
    out
}

fn is_active(status: &TransferStatus) -> bool {
    matches!(
        status,
        TransferStatus::Queued | TransferStatus::Transferring | TransferStatus::Paused
    )
}

fn transfers(list: &[Transfer], paused: bool) -> Value {
    let active: Vec<&Transfer> = list.iter().filter(|t| is_active(&t.status)).collect();
    let failed = list
        .iter()
        .filter(|t| matches!(t.status, TransferStatus::Error))
        .count();
    let (done, total) = active.iter().fold((0u64, 0u64), |(d, s), t| {
        (d + t.transferred.min(t.size), s + t.size)
    });
    let toggle = if paused {
        json!({ "action": "resume-transfers", "label": "Resume" })
    } else {
        json!({ "action": "pause-transfers", "label": "Pause" })
    };
    if active.is_empty() {
        let caption = match failed {
            0 => "Nothing transferring.".to_string(),
            1 => "1 failed this session.".to_string(),
            n => format!("{n} failed this session."),
        };
        let mut summary = json!({ "value": "Idle", "progress": 0, "caption": caption });
        if paused {
            summary["actions"] = json!([toggle]);
            summary["unit"] = json!("paused");
        }
        return summary;
    }
    let percent = if total == 0 {
        0.0
    } else {
        (done as f64 / total as f64 * 100.0).clamp(0.0, 100.0)
    };
    let mut caption = format!("{:.0}% · {} of {}", percent, bytes(done), bytes(total));
    if failed > 0 {
        caption.push_str(&format!(" · {failed} failed"));
    }
    json!({
        "value": format!("{} active", active.len()),
        "unit": if paused { "paused" } else { "" },
        "progress": (percent * 10.0).round() / 10.0,
        "caption": caption,
        "actions": [toggle],
    })
}

fn agent(pending: &[crate::bridge::ApprovalRequest]) -> Value {
    if pending.is_empty() {
        return json!({ "caption": "No agent requests waiting.", "attention": false });
    }
    let rows: Vec<Value> = pending
        .iter()
        .take(8)
        .map(|request| {
            json!({
                "label": truncate(&request.command, 200),
                "detail": truncate(&format!("{} · {}", request.session_name, request.kind), 200),
            })
        })
        .collect();
    let count = pending.len();
    json!({
        "rows": rows,
        "caption": if count == 1 { "1 request waiting for you.".to_string() } else { format!("{count} requests waiting for you.") },
        "attention": true,
        "badge": if count > 99 { "99+".to_string() } else { count.to_string() },
        "actions": [{ "action": "deny-agent", "label": "Deny all" }],
    })
}

fn sync(pairs: &[Value]) -> Value {
    let enabled: Vec<&Value> = pairs.iter().filter(|p| p["enabled"] == true).collect();
    if enabled.is_empty() {
        return json!({ "caption": "No folders syncing." });
    }
    let rows: Vec<Value> = enabled
        .iter()
        .take(8)
        .map(|pair| {
            let state = pair["state"].as_str().unwrap_or("idle");
            let detail = match state {
                "error" => format!(
                    "Error: {}",
                    pair["lastError"].as_str().unwrap_or("sync failed")
                ),
                "syncing" => match pair["inFlight"].as_u64().unwrap_or(0) {
                    0 => "Syncing".to_string(),
                    n => format!("Syncing {n} files"),
                },
                "scanning" => "Scanning".to_string(),
                _ if pair["running"] == true => "Up to date".to_string(),
                _ => "Stopped".to_string(),
            };
            json!({
                "label": truncate(pair["name"].as_str().unwrap_or("Folder"), 200),
                "detail": truncate(&detail, 200),
            })
        })
        .collect();
    let errors = enabled.iter().filter(|p| p["state"] == "error").count();
    json!({
        "rows": rows,
        "attention": errors > 0,
    })
}

async fn action(app: &AppHandle, id: &str) -> Result<String, String> {
    let state = app.state::<AppState>();
    match id {
        "pause-transfers" => {
            state.transfers.pause_all(app).await;
            Ok("Transfers paused.".into())
        }
        "resume-transfers" => {
            state.transfers.resume_all(app).await;
            Ok("Transfers resumed.".into())
        }
        "sync-now" => {
            let pairs = state.foldersync.views().await;
            let ids: Vec<String> = pairs
                .iter()
                .filter_map(|view| serde_json::to_value(view).ok())
                .filter(|pair| pair["running"] == true)
                .filter_map(|pair| pair["id"].as_str().map(str::to_string))
                .collect();
            if ids.is_empty() {
                return Err("No folder sync is running.".into());
            }
            for pair in &ids {
                let _ = state.foldersync.sync_now(pair).await;
            }
            Ok(if ids.len() == 1 {
                "Syncing 1 folder.".into()
            } else {
                format!("Syncing {} folders.", ids.len())
            })
        }
        "deny-agent" => match state.bridge.deny_all_pending().await {
            0 => Err("No agent requests are waiting.".into()),
            1 => Ok("Denied 1 request.".into()),
            n => Ok(format!("Denied {n} requests.")),
        },
        _ => Err("Unknown action.".into()),
    }
}

fn bytes(n: u64) -> String {
    let units = ["B", "KB", "MB", "GB", "TB"];
    let mut value = n as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit < units.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{n} B")
    } else {
        format!("{value:.1} {}", units[unit])
    }
}

fn truncate(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut out: String = text.chars().take(max - 1).collect();
    out.push('…');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sizes_read_naturally() {
        assert_eq!(bytes(512), "512 B");
        assert_eq!(bytes(1536), "1.5 KB");
        assert_eq!(bytes(3 * 1024 * 1024 * 1024), "3.0 GB");
    }

    #[test]
    fn waiting_requests_need_the_person() {
        let pending = vec![crate::bridge::ApprovalRequest {
            request_id: "r1".into(),
            session_id: "s1".into(),
            session_name: "prod-web".into(),
            kind: "exec".into(),
            command: "systemctl restart nginx".into(),
        }];
        let summary = agent(&pending);
        assert_eq!(summary["attention"], true);
        assert_eq!(summary["badge"], "1");
        assert_eq!(summary["rows"][0]["label"], "systemctl restart nginx");
        assert_eq!(summary["rows"][0]["detail"], "prod-web · exec");
        assert_eq!(agent(&[])["attention"], false);
    }

    #[test]
    fn a_failed_folder_needs_the_person() {
        let pairs = vec![
            json!({ "name": "Site", "enabled": true, "running": true, "state": "error", "lastError": "denied" }),
            json!({ "name": "Docs", "enabled": true, "running": true, "state": "idle" }),
            json!({ "name": "Off", "enabled": false, "running": false, "state": "idle" }),
        ];
        let summary = sync(&pairs);
        assert_eq!(summary["attention"], true);
        assert_eq!(summary["rows"].as_array().unwrap().len(), 2);
        assert_eq!(summary["rows"][0]["detail"], "Error: denied");
        assert_eq!(summary["rows"][1]["detail"], "Up to date");
    }
}
