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
}

pub struct PtyManager {
    ptys: Mutex<HashMap<String, PtyHandle>>,
}

impl PtyManager {
    pub fn new() -> Self {
        Self {
            ptys: Mutex::new(HashMap::new()),
        }
    }

    pub async fn open(
        &self,
        session: &Arc<SshSession>,
        cols: u32,
        rows: u32,
        app: AppHandle,
    ) -> Result<String> {
        let id = Uuid::new_v4().to_string();

        let channel = {
            let h = session.handle.lock().await;
            h.channel_open_session().await?
        };
        channel
            .request_pty(true, "xterm-256color", cols, rows, 0, 0, &[])
            .await?;
        channel.request_shell(true).await?;

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

        self.ptys
            .lock()
            .await
            .insert(id.clone(), PtyHandle { tx });
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

    pub async fn close(&self, id: &str) -> Result<()> {
        let h = self.ptys.lock().await.remove(id);
        if let Some(h) = h {
            let _ = h.tx.send(PtyCommand::Close).await;
        }
        Ok(())
    }
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
}
