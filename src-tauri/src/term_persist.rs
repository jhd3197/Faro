//! Persistent terminal sessions over tmux (Plan 36 Phase 4).
//!
//! With persistence on, a pane's shell runs inside a tmux session on the host
//! instead of directly on the SSH channel, so it survives a dropped
//! connection or an app restart and can be picked up again.
//!
//! Everything goes through a private tmux server (`-L faro`, no config file):
//! the user's own tmux, its sessions and its key bindings are never touched.
//! The server is set up so the pane behaves like a plain shell in the app:
//! no status bar, and no alternate screen, so output lands in the terminal's
//! own scrollback where wheel, selection and search already work.

use crate::session::SshSession;
use std::sync::Arc;
use std::time::Duration;

/// The private tmux server every Faro session lives on.
const TMUX: &str = "tmux -L faro";

/// Session names are `faro-` plus lowercase hex/alphanumerics the frontend
/// derives from a pane id. Anything else is refused, so a name can be placed
/// in a shell command without quoting concerns.
pub fn valid_name(name: &str) -> bool {
    let Some(rest) = name.strip_prefix("faro-") else {
        return false;
    };
    !rest.is_empty()
        && rest.len() <= 40
        && rest
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
}

/// Prints the tmux version when tmux is installed.
pub const DETECT: &str = "command -v tmux >/dev/null 2>&1 && tmux -V";

/// The command a persistent pane runs on its PTY: start (or reuse) the
/// private server, apply the settings, then create or attach the session.
/// The settings come before `new-session` so they are in force when this
/// client's terminal is opened.
pub fn attach_command(name: &str, history_limit: u32) -> String {
    let history = history_limit.clamp(1_000, 200_000);
    format!(
        "exec {TMUX} -f /dev/null start-server \\; \
         set -g status off \\; \
         set -g escape-time 0 \\; \
         set -g history-limit {history} \\; \
         set -g mouse off \\; \
         set -g default-terminal screen-256color \\; \
         set -g terminal-overrides 'xterm*:smcup@:rmcup@:Tc' \\; \
         new-session -A -s {name}"
    )
}

/// The session's scrollback above the visible screen, with colours. The
/// visible screen is left out: tmux repaints it on attach.
pub fn history_command(name: &str) -> String {
    format!("{TMUX} capture-pane -p -e -J -S - -E -1 -t '={name}:' 2>/dev/null")
}

pub fn kill_command(name: &str) -> String {
    format!("{TMUX} kill-session -t '={name}' 2>/dev/null")
}

/// One line per session: name, attached clients, last activity (epoch secs).
pub const LIST: &str =
    "tmux -L faro list-sessions -F '#{session_name} #{session_attached} #{session_activity}' 2>/dev/null";

#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PersistedSession {
    pub name: String,
    /// Clients attached right now (0 = detached).
    pub attached: u32,
    /// Last activity, seconds since the epoch (0 when unknown).
    pub last_activity: u64,
}

pub fn parse_list(stdout: &str) -> Vec<PersistedSession> {
    stdout
        .lines()
        .filter_map(|line| {
            let mut parts = line.split_whitespace();
            let name = parts.next()?;
            if !valid_name(name) {
                return None;
            }
            Some(PersistedSession {
                name: name.to_string(),
                attached: parts.next().and_then(|v| v.parse().ok()).unwrap_or(0),
                last_activity: parts.next().and_then(|v| v.parse().ok()).unwrap_or(0),
            })
        })
        .collect()
}

/// tmux's version string (`tmux 3.4`) when the host has tmux.
pub async fn detect(ssh: &Arc<SshSession>) -> Option<String> {
    let out = ssh
        .exec_bounded(DETECT, 256, Duration::from_secs(15), None)
        .await
        .ok()?;
    let version = out.stdout.trim();
    (out.exit_code == Some(0) && version.starts_with("tmux")).then(|| version.to_string())
}

/// Scrollback of an existing session, ready to write to a terminal. Empty
/// when the session doesn't exist yet (a fresh pane) or has no history.
pub async fn history(ssh: &Arc<SshSession>, name: &str) -> String {
    let Ok(out) = ssh
        .exec_bounded(
            &history_command(name),
            4 * 1024 * 1024,
            Duration::from_secs(15),
            None,
        )
        .await
    else {
        return String::new();
    };
    if out.exit_code != Some(0) {
        return String::new();
    }
    to_terminal_lines(&out.stdout)
}

/// `capture-pane` separates lines with `\n`; a terminal needs `\r\n`. Trailing
/// blank lines are dropped so the live screen starts right under the history.
pub fn to_terminal_lines(captured: &str) -> String {
    let trimmed = captured.trim_end_matches(['\n', '\r', ' ']);
    if trimmed.is_empty() {
        return String::new();
    }
    let mut out = String::with_capacity(trimmed.len() + 64);
    for line in trimmed.split('\n') {
        out.push_str(line.trim_end_matches('\r'));
        out.push_str("\r\n");
    }
    out
}

pub async fn list(ssh: &Arc<SshSession>) -> Vec<PersistedSession> {
    match ssh
        .exec_bounded(LIST, 64 * 1024, Duration::from_secs(15), None)
        .await
    {
        Ok(out) if out.exit_code == Some(0) => parse_list(&out.stdout),
        _ => Vec::new(),
    }
}

pub async fn kill(ssh: &Arc<SshSession>, name: &str) {
    let _ = ssh
        .exec_bounded(&kill_command(name), 256, Duration::from_secs(15), None)
        .await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_restricted() {
        assert!(valid_name("faro-0123456789abcdef"));
        assert!(!valid_name("faro-"));
        assert!(!valid_name("main"));
        assert!(!valid_name("faro-ab cd"));
        assert!(!valid_name("faro-ab;rm"));
        assert!(!valid_name("faro-AB"));
        assert!(!valid_name(&format!("faro-{}", "a".repeat(41))));
    }

    #[test]
    fn attach_command_sets_options_before_the_session() {
        let cmd = attach_command("faro-abc123", 5000);
        let set = cmd.find("terminal-overrides").unwrap();
        let new = cmd.find("new-session -A -s faro-abc123").unwrap();
        assert!(set < new, "options are applied before the client attaches");
        assert!(cmd.starts_with("exec tmux -L faro -f /dev/null start-server"));
        assert!(cmd.contains("history-limit 5000"));
        assert!(attach_command("faro-a", 5).contains("history-limit 1000"));
        assert!(attach_command("faro-a", 9_000_000).contains("history-limit 200000"));
    }

    #[test]
    fn list_output_is_parsed_and_foreign_sessions_dropped() {
        let out = "faro-aaa 0 1700000000\nfaro-bbb 1 1700000500\nscratch 0 1\nfaro-bad;x 0 1\n\n";
        assert_eq!(
            parse_list(out),
            vec![
                PersistedSession {
                    name: "faro-aaa".into(),
                    attached: 0,
                    last_activity: 1_700_000_000
                },
                PersistedSession {
                    name: "faro-bbb".into(),
                    attached: 1,
                    last_activity: 1_700_000_500
                },
            ]
        );
        assert!(parse_list("").is_empty());
    }

    #[test]
    fn captured_history_becomes_terminal_lines() {
        assert_eq!(to_terminal_lines("a\nb\n\n\n"), "a\r\nb\r\n");
        assert_eq!(to_terminal_lines("a\r\nb"), "a\r\nb\r\n");
        assert_eq!(to_terminal_lines("\n\n"), "");
    }
}

/// Against a real SSH host with tmux:
/// `FARO_LIVE_SFTP=host:port:user:pass cargo test -p faro --lib
/// term_persist::live_tests -- --ignored --nocapture --test-threads 1`.
#[cfg(test)]
mod live_tests {
    use super::*;
    use crate::session::Session;
    use russh::ChannelMsg;

    async fn ssh() -> Arc<SshSession> {
        let session = crate::transfer::live_tests::sftp_session()
            .await
            .expect("FARO_LIVE_SFTP");
        let Session::Ssh(ssh) = &*session else {
            unreachable!()
        };
        ssh.clone()
    }

    /// Attach the way a pane does, type `input`, and return what was printed
    /// up to `until`, then close the channel: the client goes away, the
    /// session must not.
    async fn attach_and(ssh: &Arc<SshSession>, name: &str, input: &str, until: &str) -> String {
        let mut channel = {
            let h = ssh.handle.lock().await;
            h.channel_open_session().await.expect("open channel")
        };
        channel
            .request_pty(true, "xterm-256color", 100, 30, 0, 0, &[])
            .await
            .expect("pty");
        channel
            .exec(true, attach_command(name, 5000).as_bytes())
            .await
            .expect("exec tmux");
        tokio::time::sleep(Duration::from_millis(600)).await;
        channel.data(input.as_bytes()).await.expect("type");
        let mut out = String::new();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
        while !out.contains(until) {
            let msg = tokio::time::timeout_at(deadline, channel.wait())
                .await
                .unwrap_or_else(|_| panic!("timed out waiting for {until:?}; got {out:?}"));
            match msg {
                Some(ChannelMsg::Data { ref data }) => out.push_str(&String::from_utf8_lossy(data)),
                Some(_) => {}
                None => panic!("channel closed early; got {out:?}"),
            }
        }
        // What closing a pane without ending its session does.
        let _ = channel.eof().await;
        let _ = channel.close().await;
        out
    }

    #[tokio::test]
    #[ignore]
    async fn a_session_survives_a_dropped_channel_and_keeps_its_history() {
        let ssh = ssh().await;
        let name = "faro-livetest0001";
        kill(&ssh, name).await;
        assert!(detect(&ssh).await.is_some(), "the lab host has tmux");
        assert!(history(&ssh, name).await.is_empty(), "no session, no history");

        // First attach: fill the scrollback and leave something in the shell.
        let first = attach_and(
            &ssh,
            name,
            "export FARO_KEEP=still-here; seq 1 200; echo first-$((40+2))\n",
            "first-42",
        )
        .await;
        assert!(
            !first.contains("\x1b[?1049h"),
            "the alternate screen is off, so output reaches the scrollback"
        );

        // The channel was dropped. The session is still there, detached.
        tokio::time::sleep(Duration::from_millis(800)).await;
        let listed = list(&ssh).await;
        let found = listed.iter().find(|s| s.name == name).expect("session listed");
        assert_eq!(found.attached, 0, "nobody is attached after the drop");

        // Its history is what scrolled off the screen.
        let hist = history(&ssh, name).await;
        assert!(hist.contains("\r\n57\r\n"), "history has the seq output");
        assert!(!hist.contains('\n') || hist.contains("\r\n"), "CRLF line ends");

        // Reattach: the same shell, with its environment.
        let second = attach_and(&ssh, name, "echo keep=$FARO_KEEP\n", "keep=still-here").await;
        assert!(second.contains("keep=still-here"));

        // Closing by hand ends it.
        kill(&ssh, name).await;
        assert!(list(&ssh).await.iter().all(|s| s.name != name));
    }
}
