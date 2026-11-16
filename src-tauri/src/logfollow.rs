//! Live log following (Plan 31): `docker logs -f` and `journalctl -f` shown
//! as they arrive.
//!
//! A follow is a [`crate::stream_exec`] stream of kind `Follow`, so a session
//! has at most one. Its lines are not emitted one event each: a chatty
//! container can print thousands a second. They collect in a [`FollowBuf`]
//! that a timer drains every [`FLUSH`], and a batch that fills up drops the
//! overflow and reports how many lines it skipped instead of queueing without
//! bound.
//!
//! Events: `stream://lines` (a batch) and `stream://ended`. Both carry the
//! `key` the follow was started with, so a view that has moved on to another
//! log ignores what is left of the old one.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use anyhow::Result;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::session::SshSession;
use crate::stream_exec::{StreamEnd, StreamKind, StreamManager};
use crate::AppState;

/// How often buffered lines are sent to the UI.
const FLUSH: Duration = Duration::from_millis(100);
/// Lines kept per batch; the rest of a burst is counted and dropped.
const MAX_BATCH_LINES: usize = 2000;
/// Longest line sent on; a longer one is cut.
const MAX_LINE_BYTES: usize = 8 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LinesEvent {
    session_id: String,
    key: String,
    lines: Vec<String>,
    /// Lines this batch had no room for.
    dropped: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct EndedEvent {
    session_id: String,
    key: String,
    /// True when Faro stopped the follow itself.
    stopped: bool,
    reason: Option<String>,
}

/// Which log each session is following right now: session id -> (key, stream
/// id). Lets a stop name the log it means, so closing one log can't cancel
/// the one opened right after it.
fn current() -> &'static Mutex<HashMap<String, (String, String)>> {
    static CURRENT: OnceLock<Mutex<HashMap<String, (String, String)>>> = OnceLock::new();
    CURRENT.get_or_init(Default::default)
}

/// Lines waiting for the next flush.
#[derive(Default)]
struct FollowBuf {
    lines: Vec<String>,
    dropped: usize,
    end: Option<StreamEnd>,
}

impl FollowBuf {
    fn push(&mut self, line: &str) {
        if self.lines.len() >= MAX_BATCH_LINES {
            self.dropped += 1;
            return;
        }
        if line.len() > MAX_LINE_BYTES {
            let mut cut = MAX_LINE_BYTES;
            while !line.is_char_boundary(cut) {
                cut -= 1;
            }
            self.lines.push(format!("{}…", &line[..cut]));
        } else {
            self.lines.push(line.to_string());
        }
    }

    /// Take what has collected since the last flush.
    fn take(&mut self) -> (Vec<String>, usize, Option<StreamEnd>) {
        (std::mem::take(&mut self.lines), std::mem::take(&mut self.dropped), self.end.take())
    }
}

/// Follow `command`'s output on `ssh`, replacing the session's current follow.
/// `key` names what is being followed; `elevated` says `command` runs under
/// `sudo -n`.
pub async fn start(
    streams: &StreamManager,
    app: AppHandle,
    ssh: Arc<SshSession>,
    key: String,
    command: &str,
    elevated: bool,
) -> Result<()> {
    let session_id = ssh.id.clone();
    let buf: Arc<Mutex<FollowBuf>> = Arc::default();
    let (line_buf, end_buf) = (buf.clone(), buf.clone());

    let stream_id = streams
        .start(
            ssh,
            StreamKind::Follow,
            command,
            elevated,
            move |line| line_buf.lock().unwrap().push(line),
            move |end| end_buf.lock().unwrap().end = Some(end),
        )
        .await?;
    current().lock().unwrap().insert(session_id.clone(), (key.clone(), stream_id));

    tokio::spawn(async move {
        loop {
            tokio::time::sleep(FLUSH).await;
            let (lines, dropped, end) = buf.lock().unwrap().take();
            if !lines.is_empty() || dropped > 0 {
                let _ = app.emit(
                    "stream://lines",
                    LinesEvent { session_id: session_id.clone(), key: key.clone(), lines, dropped },
                );
            }
            if let Some(end) = end {
                let reason = if end.stopped {
                    None
                } else if !end.stderr.is_empty() {
                    Some(end.stderr)
                } else {
                    Some(match end.exit_code {
                        Some(0) => "the log ended".to_string(),
                        Some(code) => format!("the command exited with status {code}"),
                        None => "the connection dropped".to_string(),
                    })
                };
                let _ = app.emit(
                    "stream://ended",
                    EndedEvent { session_id, key, stopped: end.stopped, reason },
                );
                break;
            }
        }
    });
    Ok(())
}

/// Stop the live log `key` on this session. A no-op when the session has
/// already moved on to another log.
#[tauri::command]
pub async fn follow_stop(session_id: String, key: String, state: State<'_, AppState>) -> Result<(), String> {
    let stream_id = {
        let mut map = current().lock().unwrap();
        match map.get(&session_id) {
            Some((k, _)) if *k == key => map.remove(&session_id).map(|(_, id)| id),
            _ => None,
        }
    };
    if let Some(id) = stream_id {
        state.streams.stop(&id).await;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_burst_is_capped_and_counted() {
        let mut b = FollowBuf::default();
        for i in 0..MAX_BATCH_LINES + 25 {
            b.push(&format!("line {i}"));
        }
        let (lines, dropped, end) = b.take();
        assert_eq!(lines.len(), MAX_BATCH_LINES);
        assert_eq!(dropped, 25);
        assert!(end.is_none());
        assert_eq!(lines[0], "line 0");
        // Taking resets the batch.
        b.push("next");
        let (lines, dropped, _) = b.take();
        assert_eq!((lines, dropped), (vec!["next".to_string()], 0));
    }

    #[test]
    fn an_overlong_line_is_cut_on_a_character_boundary() {
        let mut b = FollowBuf::default();
        b.push(&"é".repeat(MAX_LINE_BYTES)); // two bytes each
        let (lines, _, _) = b.take();
        assert!(lines[0].ends_with('…'));
        assert!(lines[0].len() <= MAX_LINE_BYTES + '…'.len_utf8());
    }
}
