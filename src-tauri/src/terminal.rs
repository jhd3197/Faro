use crate::session::SshSession;
use anyhow::{anyhow, Result};
use russh::ChannelMsg;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::sync::{mpsc, Mutex};
use uuid::Uuid;

enum PtyCommand {
    Input(Vec<u8>),
    Resize { cols: u32, rows: u32 },
    Close,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalDataEvent {
    terminal_id: String,
    data: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalExitEvent {
    terminal_id: String,
    code: Option<i32>,
}

struct PtyHandle {
    tx: mpsc::Sender<PtyCommand>,
    /// Set for a pane running inside a tmux session: closing the pane by hand
    /// ends that session, while a dropped connection only detaches from it.
    persist: Option<(Arc<SshSession>, String)>,
}

/// A pane that should survive the connection (Plan 36 Phase 4).
pub struct PersistRequest {
    /// The tmux session name (`faro-…`).
    pub name: String,
    /// Scrollback lines the session keeps.
    pub scrollback: u32,
}

pub struct PtyManager {
    ptys: Mutex<HashMap<String, PtyHandle>>,
    /// Per connection: the host's tmux version, or None when it has no tmux.
    /// Looked up once per connection.
    tmux: Mutex<HashMap<String, Option<String>>>,
}

impl PtyManager {
    pub fn new() -> Self {
        Self {
            ptys: Mutex::new(HashMap::new()),
            tmux: Mutex::new(HashMap::new()),
        }
    }

    /// The host's tmux version (cached). The bool is true the first time a
    /// connection turns out to have no tmux, so the hint is shown once.
    async fn tmux_version(
        &self,
        session_id: &str,
        session: &Arc<SshSession>,
    ) -> (Option<String>, bool) {
        if let Some(known) = self.tmux.lock().await.get(session_id) {
            return (known.clone(), false);
        }
        let found = crate::term_persist::detect(session).await;
        self.tmux
            .lock()
            .await
            .insert(session_id.to_string(), found.clone());
        let first_miss = found.is_none();
        (found, first_miss)
    }

    /// Forget what is known about a connection (it was closed).
    pub async fn forget_session(&self, session_id: &str) {
        self.tmux.lock().await.remove(session_id);
    }

    pub async fn open(
        &self,
        session_id: &str,
        session: &Arc<SshSession>,
        cols: u32,
        rows: u32,
        persist: Option<PersistRequest>,
        app: AppHandle,
    ) -> Result<String> {
        let id = Uuid::new_v4().to_string();

        // Persistent pane: run inside tmux when the host has it. Whatever is
        // written here reaches the frontend before the shell's own output.
        let mut intro = String::new();
        let mut tmux_command = None;
        let mut persisted = None;
        if let Some(req) = persist {
            if !crate::term_persist::valid_name(&req.name) {
                return Err(anyhow!("invalid persistent session name"));
            }
            match self.tmux_version(session_id, session).await {
                (Some(_), _) => {
                    intro = crate::term_persist::history(session, &req.name).await;
                    tmux_command = Some(crate::term_persist::attach_command(
                        &req.name,
                        req.scrollback,
                    ));
                    persisted = Some((session.clone(), req.name));
                }
                (None, true) => {
                    intro = "\x1b[2m[tmux isn't installed on this server, so shells here \
                             won't survive a disconnect]\x1b[0m\r\n"
                        .to_string();
                }
                (None, false) => {}
            }
        }

        let channel = {
            let h = session.handle.lock().await;
            h.channel_open_session().await?
        };
        channel
            .request_pty(true, "xterm-256color", cols, rows, 0, 0, &[])
            .await?;
        match &tmux_command {
            Some(command) => channel.exec(true, command.as_bytes()).await?,
            None => channel.request_shell(true).await?,
        }
        if !intro.is_empty() {
            let _ = app.emit(
                "terminal://data",
                TerminalDataEvent {
                    terminal_id: id.clone(),
                    data: intro,
                },
            );
        }

        let (tx, mut rx) = mpsc::channel::<PtyCommand>(64);
        let id_for_task = id.clone();
        let app_for_task = app.clone();

        tokio::spawn(async move {
            let mut channel = channel;
            let (mut out_text, mut err_text) = (Utf8Carry::default(), Utf8Carry::default());
            loop {
                tokio::select! {
                    biased;
                    cmd = rx.recv() => {
                        let Some(cmd) = cmd else { break };
                        match cmd {
                            PtyCommand::Input(bytes) => {
                                if channel.data(&bytes[..]).await.is_err() {
                                    break;
                                }
                            }
                            PtyCommand::Resize { cols, rows } => {
                                let _ = channel.window_change(cols, rows, 0, 0).await;
                            }
                            PtyCommand::Close => {
                                let _ = channel.eof().await;
                                // An explicit close makes sshd hang up the
                                // PTY. A tmux client only detaches on that;
                                // end-of-input alone leaves it attached.
                                let _ = channel.close().await;
                                break;
                            }
                        }
                    }
                    msg = channel.wait() => {
                        let Some(msg) = msg else { break };
                        match msg {
                            ChannelMsg::Data { ref data } => {
                                let s = out_text.push(data);
                                let _ = app_for_task.emit(
                                    "terminal://data",
                                    TerminalDataEvent {
                                        terminal_id: id_for_task.clone(),
                                        data: s,
                                    },
                                );
                            }
                            ChannelMsg::ExtendedData { ref data, .. } => {
                                let s = err_text.push(data);
                                let _ = app_for_task.emit(
                                    "terminal://data",
                                    TerminalDataEvent {
                                        terminal_id: id_for_task.clone(),
                                        data: s,
                                    },
                                );
                            }
                            ChannelMsg::ExitStatus { exit_status } => {
                                let _ = app_for_task.emit(
                                    "terminal://exit",
                                    TerminalExitEvent {
                                        terminal_id: id_for_task.clone(),
                                        code: Some(exit_status as i32),
                                    },
                                );
                            }
                            ChannelMsg::Close | ChannelMsg::Eof => break,
                            _ => {}
                        }
                    }
                }
            }
            let _ = app_for_task.emit(
                "terminal://exit",
                TerminalExitEvent {
                    terminal_id: id_for_task,
                    code: None,
                },
            );
        });

        self.ptys.lock().await.insert(
            id.clone(),
            PtyHandle {
                tx,
                persist: persisted,
            },
        );
        Ok(id)
    }

    /// Open a shell on this machine (Plan 36 Phase 1). Emits the same
    /// `terminal://data` / `terminal://exit` events as an SSH shell, so the
    /// frontend never branches on where a pane runs.
    pub async fn open_local(
        &self,
        shell: &crate::local_shell::LocalShell,
        cwd: Option<String>,
        cols: u32,
        rows: u32,
        app: AppHandle,
    ) -> Result<String> {
        let id = Uuid::new_v4().to_string();
        let (id_out, app_out) = (id.clone(), app.clone());
        let (id_exit, app_exit) = (id.clone(), app);
        let tx = spawn_local_pty(
            shell,
            cwd,
            cols,
            rows,
            move |data| {
                let _ = app_out.emit(
                    "terminal://data",
                    TerminalDataEvent {
                        terminal_id: id_out.clone(),
                        data,
                    },
                );
            },
            move |code| {
                let _ = app_exit.emit(
                    "terminal://exit",
                    TerminalExitEvent {
                        terminal_id: id_exit,
                        code,
                    },
                );
            },
        )?;
        self.ptys
            .lock()
            .await
            .insert(id.clone(), PtyHandle { tx, persist: None });
        Ok(id)
    }

    pub async fn write(&self, id: &str, data: String) -> Result<()> {
        let map = self.ptys.lock().await;
        let h = map
            .get(id)
            .ok_or_else(|| anyhow!("terminal {id} not found"))?;
        h.tx.send(PtyCommand::Input(data.into_bytes()))
            .await
            .map_err(|_| anyhow!("terminal closed"))
    }

    pub async fn resize(&self, id: &str, cols: u32, rows: u32) -> Result<()> {
        let map = self.ptys.lock().await;
        let h = map
            .get(id)
            .ok_or_else(|| anyhow!("terminal {id} not found"))?;
        h.tx.send(PtyCommand::Resize { cols, rows })
            .await
            .map_err(|_| anyhow!("terminal closed"))
    }

    /// Close a pane. `end_session` also ends a persistent pane's tmux session
    /// (the user closed it); without it the session keeps running on the host.
    pub async fn close(&self, id: &str, end_session: bool) -> Result<()> {
        let h = self.ptys.lock().await.remove(id);
        if let Some(h) = h {
            let _ = h.tx.send(PtyCommand::Close).await;
            if end_session {
                if let Some((session, name)) = h.persist {
                    crate::term_persist::kill(&session, &name).await;
                }
            }
        }
        Ok(())
    }
}

/// Start `shell` on a local PTY (ConPTY on Windows). `on_data` gets decoded
/// output, `on_exit` fires once with the exit code. The returned sender takes
/// input, resizes and the close request.
fn spawn_local_pty(
    shell: &crate::local_shell::LocalShell,
    cwd: Option<String>,
    cols: u32,
    rows: u32,
    on_data: impl Fn(String) + Send + 'static,
    on_exit: impl FnOnce(Option<i32>) + Send + 'static,
) -> Result<mpsc::Sender<PtyCommand>> {
    use portable_pty::{native_pty_system, CommandBuilder, PtySize};
    use std::io::{Read, Write};

    let size = |cols: u32, rows: u32| PtySize {
        rows: rows.clamp(1, u16::MAX as u32) as u16,
        cols: cols.clamp(1, u16::MAX as u32) as u16,
        pixel_width: 0,
        pixel_height: 0,
    };
    let pair = native_pty_system()
        .openpty(size(cols, rows))
        .map_err(|e| anyhow!("open pty: {e}"))?;

    let mut cmd = CommandBuilder::new(&shell.program);
    cmd.args(&shell.args);
    let start_dir = cwd
        .map(std::path::PathBuf::from)
        .filter(|p| p.is_dir())
        .or_else(dirs::home_dir);
    if let Some(dir) = start_dir {
        cmd.cwd(dir);
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");

    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| anyhow!("start {}: {e}", shell.name))?;
    // The slave end belongs to the child now; holding it would keep the PTY
    // open after the shell exits.
    drop(pair.slave);
    let mut killer = child.clone_killer();
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| anyhow!("pty reader: {e}"))?;
    let mut writer = pair
        .master
        .take_writer()
        .map_err(|e| anyhow!("pty writer: {e}"))?;
    let master = pair.master;

    let (tx, mut rx) = mpsc::channel::<PtyCommand>(64);

    // Output: PTY → caller.
    std::thread::spawn(move || {
        let mut text = Utf8Carry::default();
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let s = text.push(&buf[..n]);
                    if !s.is_empty() {
                        on_data(s);
                    }
                }
            }
        }
    });

    // Exit: report the code, then have the command thread drop the master. On
    // Windows the reader only sees end-of-file once the pseudo console is
    // closed, so it can't be the one that notices the shell is gone.
    let tx_exit = tx.clone();
    std::thread::spawn(move || {
        let code = child.wait().ok().map(|s| s.exit_code() as i32);
        // Let the last output drain before the PTY closes.
        std::thread::sleep(std::time::Duration::from_millis(150));
        on_exit(code);
        let _ = tx_exit.blocking_send(PtyCommand::Close);
    });

    // Input, resize, close: caller → PTY.
    std::thread::spawn(move || {
        while let Some(cmd) = rx.blocking_recv() {
            match cmd {
                PtyCommand::Input(bytes) => {
                    if writer.write_all(&bytes).and_then(|_| writer.flush()).is_err() {
                        break;
                    }
                }
                PtyCommand::Resize { cols, rows } => {
                    let _ = master.resize(size(cols, rows));
                }
                PtyCommand::Close => break,
            }
        }
        // Already gone when the shell exited by itself; harmless then.
        let _ = killer.kill();
        drop(writer);
        drop(master);
    });

    Ok(tx)
}

/// Decodes a byte stream to text chunk by chunk, holding back a multi-byte
/// character split across two SSH packets (htop's box drawing, CJK, "ñ")
/// instead of turning each half into U+FFFD.
#[derive(Default)]
struct Utf8Carry {
    pending: Vec<u8>,
}

impl Utf8Carry {
    fn push(&mut self, data: &[u8]) -> String {
        self.pending.extend_from_slice(data);
        let mut out = String::new();
        loop {
            match std::str::from_utf8(&self.pending) {
                Ok(s) => {
                    out.push_str(s);
                    self.pending.clear();
                    return out;
                }
                Err(e) => {
                    let valid = e.valid_up_to();
                    out.push_str(std::str::from_utf8(&self.pending[..valid]).unwrap_or_default());
                    match e.error_len() {
                        // An incomplete character at the end: keep it for the next chunk.
                        None => {
                            self.pending.drain(..valid);
                            return out;
                        }
                        Some(bad) => {
                            out.push('\u{FFFD}');
                            self.pending.drain(..valid + bad);
                        }
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::Utf8Carry;

    #[test]
    fn split_characters_survive_packet_boundaries() {
        let text = "a─b你ñ";
        let bytes = text.as_bytes();
        for cut in 0..=bytes.len() {
            let mut c = Utf8Carry::default();
            let joined = c.push(&bytes[..cut]) + &c.push(&bytes[cut..]);
            assert_eq!(joined, text, "cut at {cut}");
        }
        let mut c = Utf8Carry::default();
        assert_eq!(c.push(b"x\xffy"), "x\u{FFFD}y", "invalid bytes still replaced");
    }

    /// A real shell on a real PTY: type a command, read its output, see the
    /// exit code. Covers ConPTY on Windows and the Unix PTY elsewhere.
    #[test]
    fn local_pty_runs_a_shell() {
        use super::{spawn_local_pty, PtyCommand};
        use std::sync::{mpsc as std_mpsc, Arc, Mutex};
        use std::time::{Duration, Instant};

        let shell = if cfg!(windows) {
            crate::local_shell::resolve("cmd")
        } else {
            crate::local_shell::LocalShell {
                id: "sh".into(),
                name: "sh".into(),
                program: "/bin/sh".into(),
                args: vec![],
            }
        };
        let out = Arc::new(Mutex::new(String::new()));
        let out_w = out.clone();
        let (exit_tx, exit_rx) = std_mpsc::channel();
        let tx = spawn_local_pty(
            &shell,
            None,
            100,
            30,
            move |s| out_w.lock().unwrap().push_str(&s),
            move |code| {
                let _ = exit_tx.send(code);
            },
        )
        .expect("spawn local shell");

        // The marker is computed by the shell, so an echo of the typed line
        // can't satisfy the assertion.
        let line = if cfg!(windows) {
            "set /a 4000+321\r\n"
        } else {
            "echo $((4000+321))\n"
        };
        tx.blocking_send(PtyCommand::Input(line.as_bytes().to_vec())).unwrap();
        tx.blocking_send(PtyCommand::Resize { cols: 120, rows: 40 }).unwrap();

        let deadline = Instant::now() + Duration::from_secs(20);
        let mut answered = false;
        while !out.lock().unwrap().contains("4321") {
            // ConPTY asks where the cursor is before it starts the shell and
            // waits for the reply. xterm answers this in the app.
            if !answered && out.lock().unwrap().contains("\x1b[6n") {
                answered = true;
                tx.blocking_send(PtyCommand::Input(b"\x1b[1;1R".to_vec())).unwrap();
            }
            assert!(Instant::now() < deadline, "no output: {:?}", out.lock().unwrap());
            std::thread::sleep(Duration::from_millis(50));
        }

        let quit = if cfg!(windows) { "exit 7\r\n" } else { "exit 7\n" };
        tx.blocking_send(PtyCommand::Input(quit.as_bytes().to_vec())).unwrap();
        let code = exit_rx
            .recv_timeout(Duration::from_secs(20))
            .expect("shell exits");
        assert_eq!(code, Some(7));
    }
}
