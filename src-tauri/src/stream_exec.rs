//! Cancellable streamed exec over an SSH session (Plan 30).
//!
//! `SshSession::exec_bounded` collects a command's whole output and returns
//! when it exits. A [`StreamManager`] stream is for commands that never exit
//! on their own: it reads one exec channel line by line, hands each line to a
//! callback, and runs until the command ends or the stream is stopped. The
//! Server view's metrics sampler is the first user.
//!
//! Each stream holds one SSH channel for its whole life. sshd caps channels
//! per connection (`MaxSessions`, 10 by default) and SFTP plus every terminal
//! pane count against the same cap, so a session may run only one stream of
//! each [`StreamKind`]: starting another stops the one before it.
//!
//! Stopping kills the remote process group. Closing the channel alone is not
//! enough: a no-pty exec gets no SIGHUP, so a command that is quiet at that
//! moment would keep running on the server.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use russh::ChannelMsg;
use tokio::sync::{oneshot, Mutex};
use tokio::task::JoinHandle;
use uuid::Uuid;

use crate::cf_setup::sh_quote;
use crate::session::SshSession;

/// What a stream is for. A session runs at most one stream of each kind.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StreamKind {
    /// The Server view's metrics loop.
    Sampler,
    /// A live log (`docker logs -f`, `journalctl -f`): one at a time.
    Follow,
}

/// How a stream finished.
#[derive(Debug, Clone)]
pub struct StreamEnd {
    /// True when Faro stopped it, false when the command ended by itself or
    /// the connection dropped.
    pub stopped: bool,
    pub exit_code: Option<i32>,
    /// The last of what the command wrote to stderr.
    pub stderr: String,
}

struct Handle {
    session_id: String,
    kind: StreamKind,
    stop: oneshot::Sender<()>,
    task: JoinHandle<()>,
}

pub struct StreamManager {
    streams: Arc<Mutex<HashMap<String, Handle>>>,
}

impl StreamManager {
    pub fn new() -> Self {
        Self { streams: Arc::new(Mutex::new(HashMap::new())) }
    }

    /// Run `command` on a new exec channel and call `on_line` for each line of
    /// its stdout until it ends or is stopped; `on_end` then runs once.
    /// Replaces any running stream of the same `kind` on this session.
    /// `elevated` says the command runs under `sudo -n`, so stopping it has
    /// to go through sudo too.
    pub async fn start<L, E>(
        &self,
        ssh: Arc<SshSession>,
        kind: StreamKind,
        command: &str,
        elevated: bool,
        mut on_line: L,
        on_end: E,
    ) -> Result<String>
    where
        L: FnMut(&str) + Send + 'static,
        E: FnOnce(StreamEnd) + Send + 'static,
    {
        self.stop_kind(&ssh.id, kind).await;

        let id = Uuid::new_v4().to_string();
        // The remote shell reports its own pid on stderr before it runs the
        // command. sshd starts each exec in a fresh session, so that pid leads
        // the process group and one `kill -- -pid` reaps everything under it.
        let marker = format!("__FARO_STREAM_{}", Uuid::new_v4().simple());
        let launch = format!("echo \"{marker}:$$\" 1>&2; exec sh -c {}", sh_quote(command));
        let mut channel = ssh.open_exec_channel(&launch).await?;

        let (stop_tx, mut stop_rx) = oneshot::channel::<()>();
        let streams = self.streams.clone();
        let task_id = id.clone();
        let session_id = ssh.id.clone();

        // Hold the map across the spawn so the task can't remove its entry
        // before it has been inserted.
        let mut map = self.streams.lock().await;
        let task = tokio::spawn(async move {
            let mut lines = LineSplitter::default();
            let mut err = StderrTail::new(marker);
            let mut exit_code = None;
            let mut stopped = false;
            let mut saw_eof = false;
            loop {
                tokio::select! {
                    biased;
                    _ = &mut stop_rx => {
                        stopped = true;
                        break;
                    }
                    msg = next_msg(&mut channel, saw_eof) => {
                        let Some(msg) = msg else { break };
                        match msg {
                            ChannelMsg::Data { ref data } => lines.push(data, &mut on_line),
                            ChannelMsg::ExtendedData { ref data, ext } if ext == 1 => err.push(data),
                            ChannelMsg::ExitStatus { exit_status } => exit_code = Some(exit_status as i32),
                            ChannelMsg::Eof => saw_eof = true,
                            ChannelMsg::Close => break,
                            _ => {}
                        }
                    }
                }
            }
            lines.flush(&mut on_line);
            let _ = channel.close().await;
            drop(channel);
            if stopped {
                if let Some(pgid) = err.pgid {
                    kill_group(&ssh, pgid, elevated).await;
                }
            }
            streams.lock().await.remove(&task_id);
            on_end(StreamEnd { stopped, exit_code, stderr: err.text() });
        });
        map.insert(id.clone(), Handle { session_id, kind, stop: stop_tx, task });
        Ok(id)
    }

    /// Stop one stream and wait (briefly) for its remote process to be killed.
    pub async fn stop(&self, id: &str) {
        let handle = self.streams.lock().await.remove(id);
        if let Some(h) = handle {
            let _ = h.stop.send(());
            let _ = tokio::time::timeout(Duration::from_secs(6), h.task).await;
        }
    }

    /// Stop this session's stream of `kind`, if one is running.
    pub async fn stop_kind(&self, session_id: &str, kind: StreamKind) {
        for id in self.ids(|h| h.session_id == session_id && h.kind == kind).await {
            self.stop(&id).await;
        }
    }

    /// Stop every stream on a session. Call before the session is dropped,
    /// while its transport can still carry the kill.
    pub async fn stop_session(&self, session_id: &str) {
        for id in self.ids(|h| h.session_id == session_id).await {
            self.stop(&id).await;
        }
    }

    async fn ids(&self, pick: impl Fn(&Handle) -> bool) -> Vec<String> {
        self.streams
            .lock()
            .await
            .iter()
            .filter(|(_, h)| pick(h))
            .map(|(id, _)| id.clone())
            .collect()
    }
}

/// The next channel message. After EOF, wait only a moment for the exit
/// status and close, which some servers never send.
async fn next_msg(
    channel: &mut russh::Channel<russh::client::Msg>,
    saw_eof: bool,
) -> Option<ChannelMsg> {
    if saw_eof {
        tokio::time::timeout(Duration::from_secs(2), channel.wait()).await.ok().flatten()
    } else {
        channel.wait().await
    }
}

/// SIGTERM the stream's process group on a fresh, short-lived channel.
/// Best-effort, and skipped when the transport is already gone: reconnecting
/// just to kill a process the dead connection already orphaned is not worth it
/// (and that process exits on its next write to the closed pipe anyway).
///
/// A command started under sudo runs as root, which the login user may not
/// signal; `elevated` repeats the kill through `sudo -n` (the same
/// passwordless sudo that started it).
async fn kill_group(ssh: &SshSession, pgid: i32, elevated: bool) {
    if ssh.handle.lock().await.is_closed() {
        return;
    }
    let mut cmd = format!("kill -TERM -{pgid} 2>/dev/null || kill -TERM {pgid} 2>/dev/null; ");
    if elevated {
        cmd.push_str(&format!("sudo -n kill -TERM -{pgid} 2>/dev/null; "));
    }
    cmd.push_str("true");
    if let Err(e) = ssh.exec_bounded(&cmd, 256, Duration::from_secs(5), None).await {
        tracing::warn!(session = %ssh.id, pgid, "failed to stop stream process group: {e:#}");
    }
}

/// Longest line handed to a callback; a longer run is cut at this length.
const MAX_LINE: usize = 256 * 1024;

/// Splits a byte stream into lines across packet boundaries.
#[derive(Default)]
struct LineSplitter {
    buf: Vec<u8>,
}

impl LineSplitter {
    fn push(&mut self, data: &[u8], on_line: &mut impl FnMut(&str)) {
        self.buf.extend_from_slice(data);
        let mut start = 0;
        while let Some(nl) = self.buf[start..].iter().position(|&b| b == b'\n') {
            emit(&self.buf[start..start + nl], on_line);
            start += nl + 1;
        }
        self.buf.drain(..start);
        if self.buf.len() > MAX_LINE {
            emit(&self.buf, on_line);
            self.buf.clear();
        }
    }

    /// Hand over a final line that had no trailing newline.
    fn flush(&mut self, on_line: &mut impl FnMut(&str)) {
        if !self.buf.is_empty() {
            emit(&self.buf, on_line);
            self.buf.clear();
        }
    }
}

fn emit(line: &[u8], on_line: &mut impl FnMut(&str)) {
    let line = line.strip_suffix(b"\r").unwrap_or(line);
    on_line(&String::from_utf8_lossy(line));
}

/// How much stderr to keep for the end-of-stream report.
const STDERR_TAIL: usize = 4096;

/// Reads the pid marker off the first stderr line and keeps the tail of the
/// rest.
struct StderrTail {
    marker: String,
    head: Vec<u8>,
    marker_done: bool,
    pgid: Option<i32>,
    tail: Vec<u8>,
}

impl StderrTail {
    fn new(marker: String) -> Self {
        Self { marker, head: Vec::new(), marker_done: false, pgid: None, tail: Vec::new() }
    }

    fn push(&mut self, data: &[u8]) {
        if self.marker_done {
            self.keep(data);
            return;
        }
        self.head.extend_from_slice(data);
        if let Some(nl) = self.head.iter().position(|&b| b == b'\n') {
            let rest = self.head.split_off(nl + 1);
            self.pgid = parse_pgid(&self.head[..nl], self.marker.as_bytes());
            self.marker_done = true;
            self.head.clear();
            self.keep(&rest);
        }
    }

    fn keep(&mut self, data: &[u8]) {
        self.tail.extend_from_slice(data);
        if self.tail.len() > STDERR_TAIL {
            let cut = self.tail.len() - STDERR_TAIL;
            self.tail.drain(..cut);
        }
    }

    fn text(&self) -> String {
        String::from_utf8_lossy(&self.tail).trim().to_string()
    }
}

/// Parse the `<marker>:<pid>` line the launch wrapper prints.
fn parse_pgid(line: &[u8], marker: &[u8]) -> Option<i32> {
    let line = line.strip_suffix(b"\r").unwrap_or(line);
    let rest = line.strip_prefix(marker)?.strip_prefix(b":")?;
    std::str::from_utf8(rest).ok()?.trim().parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn split(chunks: &[&[u8]]) -> Vec<String> {
        let mut out = Vec::new();
        let mut s = LineSplitter::default();
        let mut cb = |l: &str| out.push(l.to_string());
        for c in chunks {
            s.push(c, &mut cb);
        }
        s.flush(&mut cb);
        out
    }

    #[test]
    fn lines_survive_packet_boundaries() {
        assert_eq!(split(&[b"ab", b"c\nde\r\n", b"f"]), vec!["abc", "de", "f"]);
        assert_eq!(split(&[b"\n\nx\n"]), vec!["", "", "x"]);
        assert!(split(&[]).is_empty());
    }

    #[test]
    fn overlong_run_is_cut_instead_of_buffered() {
        let big = vec![b'a'; MAX_LINE + 10];
        let lines = split(&[&big]);
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].len(), MAX_LINE + 10);
    }

    #[test]
    fn marker_line_yields_pgid_and_is_dropped() {
        let mut e = StderrTail::new("__M".into());
        e.push(b"__M:41");
        assert_eq!(e.pgid, None);
        e.push(b"7\nsh: nope: not found\n");
        assert_eq!(e.pgid, Some(417));
        assert_eq!(e.text(), "sh: nope: not found");
    }

    #[test]
    fn stderr_tail_is_bounded() {
        let mut e = StderrTail::new("__M".into());
        e.push(b"__M:1\n");
        e.push(&vec![b'x'; STDERR_TAIL * 3]);
        assert_eq!(e.text().len(), STDERR_TAIL);
    }
}
