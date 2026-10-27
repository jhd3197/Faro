//! SSH over a local command's stdin/stdout: OpenSSH's `ProxyCommand`. Covers
//! Cloudflare Access (`cloudflared access ssh`), AWS SSM, Google IAP and any
//! other tool that carries the SSH stream itself. `spawn` returns a stream
//! that `ssh_connect` hands to `client::connect_stream` like a TCP socket.
//!
//! No shell runs. The command is split into argv first and `%h %p %r` are
//! expanded per argument afterwards, so a host or user name can never become
//! an extra argument or a shell metacharacter.

use crate::proc::NoConsoleWindow;
use crate::profiles::{ProxyCommandConfig, ProxyCommandKind};
use anyhow::{anyhow, bail, Context, Result};
use std::collections::VecDeque;
use std::future::Future;
use std::io;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::process::{ExitStatus, Stdio};
use std::sync::Arc;
use std::task::{Context as TaskContext, Poll};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, BufReader, ReadBuf};
use tokio::process::{ChildStdin, ChildStdout};
use tokio::sync::{oneshot, watch};
use tokio::time::{Instant, Sleep};

pub const CLOUDFLARED_DOWNLOAD_URL: &str =
    "https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/";
/// How long the command may stay silent before the first byte of SSH.
#[cfg(not(test))]
const FIRST_BYTE_TIMEOUT: Duration = Duration::from_secs(45);
#[cfg(test)]
const FIRST_BYTE_TIMEOUT: Duration = Duration::from_secs(3);
/// The same, once the command has asked for a browser login.
#[cfg(not(test))]
const LOGIN_TIMEOUT: Duration = Duration::from_secs(300);
#[cfg(test)]
const LOGIN_TIMEOUT: Duration = Duration::from_secs(20);
/// How long a dropped stream's command may take to exit by itself before
/// it is killed.
const EXIT_GRACE: Duration = Duration::from_millis(300);
/// Lines of the command's stderr kept for error messages.
const STDERR_TAIL: usize = 12;

/// A resolved command, ready to spawn.
#[derive(Debug, Clone, PartialEq)]
pub struct CommandSpec {
    pub program: String,
    pub args: Vec<String>,
    /// Extra environment (Access service tokens). Kept out of argv, which
    /// other local users can read.
    pub env: Vec<(String, String)>,
    /// `cloudflared`: login URLs are surfaced and its errors explained.
    pub cloudflared: bool,
}

impl CommandSpec {
    /// The command line for messages. Environment values are never shown.
    pub fn display(&self) -> String {
        std::iter::once(&self.program)
            .chain(&self.args)
            .map(|a| {
                if a.is_empty() || a.contains(char::is_whitespace) {
                    format!("\"{a}\"")
                } else {
                    a.clone()
                }
            })
            .collect::<Vec<_>>()
            .join(" ")
    }

    /// The Access hostname a `cloudflared access` command targets.
    fn cloudflare_hostname(&self) -> Option<&str> {
        let i = self
            .args
            .iter()
            .position(|a| matches!(a.as_str(), "--hostname" | "--tunnel-host" | "-T"))?;
        self.args.get(i + 1).map(String::as_str)
    }
}

/// Turn a profile's proxy command into argv for the hop at `host:port`,
/// logging in as `user`.
pub fn build(cfg: &ProxyCommandConfig, host: &str, port: u16, user: &str) -> Result<CommandSpec> {
    match cfg.kind {
        ProxyCommandKind::Command => {
            let mut argv = split(&cfg.command)?
                .into_iter()
                .map(|a| expand(&a, host, port, user))
                .collect::<Result<Vec<_>>>()?;
            // `exec` is the usual way to write one for a shell; there is none.
            if argv.first().is_some_and(|a| a == "exec") {
                argv.remove(0);
            }
            if argv.is_empty() {
                bail!("the proxy command is empty");
            }
            let program = argv.remove(0);
            Ok(CommandSpec {
                cloudflared: is_cloudflared(&program),
                program,
                args: argv,
                env: Vec::new(),
            })
        }
        ProxyCommandKind::Cloudflare => {
            let hostname = cfg
                .hostname
                .as_deref()
                .map(str::trim)
                .filter(|h| !h.is_empty())
                .unwrap_or(host);
            let id = cfg.service_token_id.as_deref().map(str::trim).filter(|s| !s.is_empty());
            let secret = cfg.service_token_secret.as_deref().filter(|s| !s.is_empty());
            let env = match (id, secret) {
                (Some(id), Some(secret)) => vec![
                    ("TUNNEL_SERVICE_TOKEN_ID".into(), id.into()),
                    ("TUNNEL_SERVICE_TOKEN_SECRET".into(), secret.into()),
                ],
                (Some(_), None) => {
                    bail!("the Cloudflare Access service token has an ID but no secret; enter the secret in the connection editor")
                }
                (None, Some(_)) => {
                    bail!("the Cloudflare Access service token has a secret but no ID; enter the ID in the connection editor")
                }
                (None, None) => Vec::new(),
            };
            Ok(CommandSpec {
                program: "cloudflared".into(),
                args: ["access", "ssh", "--hostname", hostname].map(String::from).to_vec(),
                env,
                cloudflared: true,
            })
        }
    }
}

/// The `cloudflared` and Access hostname for issuing a short-lived SSH
/// certificate (`access ssh-gen`) to a profile routed through Cloudflare
/// Access, as `user` on `host:port`.
pub fn access_cert_target(cfg: Option<&ProxyCommandConfig>, host: &str, port: u16, user: &str) -> Result<(PathBuf, String)> {
    let spec = cfg.map(|c| build(c, host, port, user)).transpose()?;
    let target = spec
        .as_ref()
        .filter(|s| s.cloudflared)
        .and_then(|s| Some((s, s.cloudflare_hostname()?.to_string())));
    let Some((spec, hostname)) = target else {
        bail!("Cloudflare certificate login needs the Cloudflare Access route; set Proxy to Cloudflare Access in the connection editor");
    };
    if !spec.env.is_empty() {
        bail!("Cloudflare certificate login needs a signed-in person, and this connection uses an Access service token. Log in with a key or password for unattended connections");
    }
    Ok((resolve_program(spec)?, hostname))
}

/// Split a command line into argv with shell-style quoting: `'…'` is
/// literal, `"…"` honours `\"` and `\\`, and a backslash elsewhere is
/// literal unless it escapes whitespace or a quote (so `C:\Program Files`
/// paths survive). Pipes and redirections are refused: no shell runs them.
pub fn split(line: &str) -> Result<Vec<String>> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut in_word = false;
    // Whether the current word had any quoted part; a quoted `|` is data.
    let mut quoted = false;
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            c if c.is_whitespace() => {
                if in_word {
                    push_word(&mut out, std::mem::take(&mut cur), quoted)?;
                    in_word = false;
                    quoted = false;
                }
            }
            '\'' => {
                in_word = true;
                quoted = true;
                loop {
                    match chars.next() {
                        Some('\'') => break,
                        Some(c) => cur.push(c),
                        None => bail!("the proxy command has an unterminated ' quote"),
                    }
                }
            }
            '"' => {
                in_word = true;
                quoted = true;
                loop {
                    match chars.next() {
                        Some('"') => break,
                        Some('\\') if matches!(chars.peek(), Some('"' | '\\')) => {
                            cur.extend(chars.next());
                        }
                        Some(c) => cur.push(c),
                        None => bail!("the proxy command has an unterminated \" quote"),
                    }
                }
            }
            '\\' if chars.peek().is_some_and(|n| n.is_whitespace() || *n == '"' || *n == '\'') => {
                in_word = true;
                quoted = true;
                cur.extend(chars.next());
            }
            c => {
                in_word = true;
                cur.push(c);
            }
        }
    }
    if in_word {
        push_word(&mut out, cur, quoted)?;
    }
    Ok(out)
}

fn push_word(out: &mut Vec<String>, word: String, quoted: bool) -> Result<()> {
    if !quoted && matches!(word.as_str(), "|" | "||" | "&&" | "&" | ";" | ">" | ">>" | "<" | "2>") {
        bail!(
            "the proxy command uses `{word}`, but it runs without a shell; wrap it as sh -c '…' if you need one"
        );
    }
    out.push(word);
    Ok(())
}

/// Expand OpenSSH's `%h` (host), `%p` (port), `%r` (remote user) and `%%`.
pub fn expand(arg: &str, host: &str, port: u16, user: &str) -> Result<String> {
    let mut out = String::with_capacity(arg.len());
    let mut chars = arg.chars();
    while let Some(c) = chars.next() {
        if c != '%' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('h') => out.push_str(host),
            Some('p') => out.push_str(&port.to_string()),
            Some('r') => out.push_str(user),
            Some('%') => out.push('%'),
            Some(t) => bail!("the proxy command uses %{t}; Faro expands %h, %p, %r and %%"),
            None => bail!("the proxy command ends with a lone %; write %% for a literal %"),
        }
    }
    Ok(out)
}

/// Both separators on every OS: a profile written on Windows (imported or
/// synced) can name `C:\...\cloudflared.exe` on Linux or macOS.
fn is_cloudflared(program: &str) -> bool {
    let name = program.rsplit(['/', '\\']).next().unwrap_or(program);
    let stem = match name.len().checked_sub(4) {
        Some(i) if name.is_char_boundary(i) && name[i..].eq_ignore_ascii_case(".exe") => &name[..i],
        _ => name,
    };
    stem.eq_ignore_ascii_case("cloudflared")
}

/// Where to look for a bare program name besides PATH. A GUI app launched
/// from the macOS Finder or a Windows shortcut often has a minimal PATH, and
/// the cloudflared installers don't always add theirs.
fn extra_dirs(cloudflared: bool) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if cfg!(windows) {
        if cloudflared {
            for var in ["ProgramFiles(x86)", "ProgramFiles"] {
                if let Some(base) = std::env::var_os(var) {
                    dirs.push(PathBuf::from(base).join("cloudflared"));
                }
            }
        }
    } else {
        dirs.extend(["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/snap/bin"].map(PathBuf::from));
    }
    if let Some(home) = dirs::home_dir() {
        dirs.push(home.join(".local").join("bin"));
        if cloudflared {
            dirs.push(home.join(".cloudflared"));
        }
    }
    dirs
}

/// The `cloudflared` the user picked in Settings (their own path, or the copy
/// Faro installed). Wins over PATH for a bare `cloudflared`. Set by
/// `cloudflared::configure` in the app and in faro-cli.
static CLOUDFLARED_PATH: std::sync::RwLock<Option<PathBuf>> = std::sync::RwLock::new(None);

pub fn set_cloudflared_path(path: Option<PathBuf>) {
    if let Ok(mut p) = CLOUDFLARED_PATH.write() {
        *p = path;
    }
}

/// The first match for a bare program name on PATH or in `extra_dirs`.
pub fn find_program(name: &str, cloudflared: bool) -> Option<PathBuf> {
    let names: Vec<String> = if cfg!(windows) && Path::new(name).extension().is_none() {
        let exts = std::env::var("PATHEXT").unwrap_or_else(|_| ".EXE;.CMD;.BAT".into());
        exts.split(';')
            .filter(|e| !e.is_empty())
            .map(|e| format!("{name}{}", e.to_ascii_lowercase()))
            .collect()
    } else {
        vec![name.to_string()]
    };
    let path_dirs = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect::<Vec<_>>())
        .unwrap_or_default();
    path_dirs
        .into_iter()
        .chain(extra_dirs(cloudflared))
        .flat_map(|dir| names.iter().map(move |n| dir.join(n)))
        .find(|c| c.is_file())
}

/// The `cloudflared` to run: the one picked in Settings, else PATH.
pub fn resolve_cloudflared() -> Result<PathBuf> {
    let spec = CommandSpec {
        program: "cloudflared".into(),
        args: Vec::new(),
        env: Vec::new(),
        cloudflared: true,
    };
    resolve_program(&spec)
}

/// The executable to run: a path as given, else the first match for a bare
/// name on PATH or in `extra_dirs`.
fn resolve_program(spec: &CommandSpec) -> Result<PathBuf> {
    let program = Path::new(&spec.program);
    if program.components().count() > 1 {
        if !program.exists() {
            bail!("the proxy command program {} doesn't exist", program.display());
        }
        return Ok(program.to_path_buf());
    }
    if spec.cloudflared && spec.program.eq_ignore_ascii_case("cloudflared") {
        let chosen = CLOUDFLARED_PATH.read().ok().and_then(|p| p.clone());
        if let Some(path) = chosen {
            if !path.is_file() {
                bail!("the cloudflared chosen in Settings ({}) doesn't exist; pick another or install one there", path.display());
            }
            return Ok(path);
        }
    }
    if let Some(found) = find_program(&spec.program, spec.cloudflared) {
        return Ok(found);
    }
    if spec.cloudflared {
        bail!("cloudflared isn't installed. Install it from Settings → Cloudflare (Faro downloads the official release), or from {CLOUDFLARED_DOWNLOAD_URL}");
    }
    bail!("`{}` was not found on PATH; install it or use its full path in the proxy command", spec.program)
}

/// Start the command. `on_login` gets each Cloudflare Access sign-in URL the
/// command prints, so the UI can show it.
pub fn spawn(spec: &CommandSpec, on_login: impl Fn(String) + Send + 'static) -> Result<CommandStream> {
    let program = resolve_program(spec)?;
    let mut cmd = tokio::process::Command::new(&program);
    cmd.args(&spec.args)
        .envs(spec.env.iter().map(|(k, v)| (k, v)))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .no_console_window();
    let mut child = cmd
        .spawn()
        .with_context(|| format!("couldn't start the proxy command `{}`", spec.display()))?;
    let (Some(stdin), Some(stdout), Some(stderr)) = (child.stdin.take(), child.stdout.take(), child.stderr.take())
    else {
        bail!("the proxy command's pipes could not be opened");
    };
    let diag = Diagnostics::new(spec, child.id(), &program);

    // Drain stderr for the whole session: a full pipe would stall the child.
    let d = diag.clone();
    tokio::spawn(async move {
        let mut reader = BufReader::new(stderr);
        let mut buf = Vec::new();
        loop {
            buf.clear();
            match reader.read_until(b'\n', &mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    let line = String::from_utf8_lossy(&buf).trim().to_string();
                    if let Some(url) = d.push_line(line) {
                        on_login(url);
                    }
                }
            }
        }
        d.state.send_modify(|s| s.stderr_done = true);
    });

    // Owns the child: records how it ended, and kills it once the stream is
    // dropped (session closed, reconnect, a failed handshake).
    let (kill_tx, kill_rx) = oneshot::channel::<()>();
    let d = diag.clone();
    tokio::spawn(async move {
        let status = tokio::select! {
            status = child.wait() => status.ok(),
            // A command that is already on its way out (it closed stdout as it
            // exited, which is what ended the stream) keeps its real status;
            // the grace covers process teardown finishing after the pipes.
            _ = kill_rx => match tokio::time::timeout(EXIT_GRACE, child.wait()).await {
                Ok(status) => status.ok(),
                Err(_) => {
                    let _ = child.kill().await;
                    None
                }
            },
        };
        d.state.send_modify(|s| {
            s.exited = true;
            s.status = status;
        });
    });

    Ok(CommandStream {
        stdin,
        stdout,
        diag,
        _kill: kill_tx,
        deadline: Some(Box::pin(tokio::time::sleep(FIRST_BYTE_TIMEOUT))),
        login_extended: false,
    })
}

/// The command's stdout (read) and stdin (write) as one duplex stream.
pub struct CommandStream {
    stdin: ChildStdin,
    stdout: ChildStdout,
    diag: Diagnostics,
    /// Dropped with the stream, which tells the watcher to kill the child.
    _kill: oneshot::Sender<()>,
    /// Until the first byte arrives.
    deadline: Option<Pin<Box<Sleep>>>,
    login_extended: bool,
}

impl CommandStream {
    pub fn diagnostics(&self) -> Diagnostics {
        self.diag.clone()
    }
}

impl AsyncRead for CommandStream {
    fn poll_read(self: Pin<&mut Self>, cx: &mut TaskContext<'_>, buf: &mut ReadBuf<'_>) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        let before = buf.filled().len();
        if let Poll::Ready(r) = Pin::new(&mut this.stdout).poll_read(cx, buf) {
            if buf.filled().len() > before {
                this.deadline = None;
            }
            return Poll::Ready(r);
        }
        if let Some(deadline) = this.deadline.as_mut() {
            if deadline.as_mut().poll(cx).is_ready() {
                if !this.login_extended && this.diag.login_url().is_some() {
                    // A browser login is in progress; give the user time.
                    this.login_extended = true;
                    deadline.as_mut().reset(Instant::now() + LOGIN_TIMEOUT);
                    let _ = deadline.as_mut().poll(cx);
                } else {
                    this.deadline = None;
                    this.diag.state.send_modify(|s| s.timed_out = true);
                    return Poll::Ready(Err(io::Error::new(
                        io::ErrorKind::TimedOut,
                        "the proxy command produced no output",
                    )));
                }
            }
        }
        Poll::Pending
    }
}

impl AsyncWrite for CommandStream {
    fn poll_write(self: Pin<&mut Self>, cx: &mut TaskContext<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.get_mut().stdin).poll_write(cx, buf)
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut TaskContext<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().stdin).poll_flush(cx)
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut TaskContext<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().stdin).poll_shutdown(cx)
    }
}

#[derive(Debug, Default)]
struct State {
    tail: VecDeque<String>,
    login_url: Option<String>,
    stderr_done: bool,
    exited: bool,
    /// None when Faro killed it (or the wait failed).
    status: Option<ExitStatus>,
    timed_out: bool,
}

/// What the command said and how it ended, kept after the stream itself has
/// moved into the SSH session.
#[derive(Clone)]
pub struct Diagnostics {
    display: Arc<str>,
    hostname: Option<Arc<str>>,
    cloudflared: bool,
    pid: Option<u32>,
    /// The executable that ran.
    program: Arc<Path>,
    state: Arc<watch::Sender<State>>,
}

impl Diagnostics {
    fn new(spec: &CommandSpec, pid: Option<u32>, program: &Path) -> Self {
        Self {
            display: spec.display().into(),
            hostname: spec.cloudflare_hostname().map(Into::into),
            cloudflared: spec.cloudflared,
            pid,
            program: program.into(),
            state: Arc::new(watch::channel(State::default()).0),
        }
    }

    pub fn program(&self) -> &Path {
        &self.program
    }

    pub fn pid(&self) -> Option<u32> {
        self.pid
    }

    pub fn login_url(&self) -> Option<String> {
        self.state.borrow().login_url.clone()
    }

    /// The Access hostname, when the command is `cloudflared access`.
    pub fn access_hostname(&self) -> Option<String> {
        self.cloudflared.then(|| self.hostname.as_deref().map(String::from)).flatten()
    }

    pub fn has_exited(&self) -> bool {
        self.state.borrow().exited
    }

    /// Resolves once the process is gone (and reaped).
    pub async fn exited(&self) {
        let mut rx = self.state.subscribe();
        let _ = rx.wait_for(|s| s.exited).await;
    }

    pub fn stderr_tail(&self) -> Vec<String> {
        self.state.borrow().tail.iter().cloned().collect()
    }

    /// Record a stderr line; returns a newly seen Access login URL.
    fn push_line(&self, line: String) -> Option<String> {
        if line.is_empty() {
            return None;
        }
        let url = self.cloudflared.then(|| access_login_url(&line)).flatten();
        let mut fresh = None;
        self.state.send_modify(|s| {
            if let Some(url) = url {
                if s.login_url.as_deref() != Some(url.as_str()) {
                    s.login_url = Some(url.clone());
                    fresh = Some(url);
                }
            }
            if s.tail.len() == STDERR_TAIL {
                s.tail.pop_front();
            }
            s.tail.push_back(line);
        });
        fresh
    }

    /// Rewrite a failed SSH handshake into what the command reported: a
    /// failed login, an unreachable tunnel, or its own exit and stderr.
    pub async fn explain(&self, err: anyhow::Error) -> anyhow::Error {
        // The process usually exits a moment after closing its stdout; wait
        // briefly for that and for the last of its stderr.
        let mut rx = self.state.subscribe();
        let _ = tokio::time::timeout(Duration::from_secs(2), rx.wait_for(|s| s.exited && s.stderr_done)).await;
        let s = self.state.borrow();
        let tail: Vec<&str> = s.tail.iter().map(String::as_str).collect();
        let headline = if self.cloudflared {
            classify_cloudflared(&tail, self.hostname.as_deref(), s.login_url.as_deref(), s.timed_out)
        } else {
            None
        };
        let headline = headline.unwrap_or_else(|| {
            let how = if s.timed_out {
                format!("produced no output for {}s", FIRST_BYTE_TIMEOUT.as_secs())
            } else {
                match (s.exited, s.status) {
                    (true, Some(st)) => format!("exited ({st})"),
                    (true, None) => "was stopped".into(),
                    (false, _) => "closed the connection".into(),
                }
            };
            match tail.last() {
                Some(last) => format!("the proxy command `{}` {how}: {last}", self.display),
                None => format!("the proxy command `{}` {how}", self.display),
            }
        });
        // The UI shows only the outermost message; the full stderr tail sits
        // under it for logs and `{:#}`.
        let err = if tail.is_empty() {
            err
        } else {
            err.context(format!("`{}` said:\n  {}", self.display, tail.join("\n  ")))
        };
        err.context(headline)
    }
}

/// A Cloudflare Access sign-in URL on a `cloudflared` stderr line.
pub fn access_login_url(line: &str) -> Option<String> {
    let start = line.find("https://")?;
    let url: String = line[start..].chars().take_while(|c| !c.is_whitespace()).collect();
    url.contains("/cdn-cgi/access/").then_some(url)
}

/// A plain-language cause for a `cloudflared access` failure, from its stderr.
fn classify_cloudflared(
    tail: &[&str],
    hostname: Option<&str>,
    login_url: Option<&str>,
    timed_out: bool,
) -> Option<String> {
    let host = hostname.unwrap_or("the Access hostname");
    let text = tail.join("\n").to_ascii_lowercase();
    let has = |needles: &[&str]| needles.iter().any(|n| text.contains(n));
    if has(&["no such host", "could not resolve", "server misbehaving"]) {
        return Some(format!("Cloudflare Access: {host} doesn't resolve. Check the Access hostname"));
    }
    if let Some(url) = login_url {
        return Some(format!(
            "Cloudflare Access sign-in for {host} didn't finish. Complete the login in your browser ({url}) and connect again. For faro-cli or the Agent Bridge, add an Access service token to the connection"
        ));
    }
    if has(&["service token", "403", "forbidden", "unauthorized", "401", "token is expired", "failed to fetch token", "failed to find token", "failed to get token"]) {
        return Some(format!(
            "Cloudflare Access refused the login for {host}: the token is missing, expired or not allowed. Sign in again, or check the service token and the Access policy"
        ));
    }
    if has(&["bad handshake", "websocket", "502", "503", "530", "1033", "origin"]) {
        return Some(format!(
            "Cloudflare couldn't reach the SSH server behind {host}. Check that the tunnel (cloudflared on the server) is running and routes to sshd"
        ));
    }
    if timed_out {
        return Some(format!("cloudflared got no answer from {host} in {}s", FIRST_BYTE_TIMEOUT.as_secs()));
    }
    None
}

type NoticeHook = Box<dyn Fn(&str, Option<&str>) + Send + Sync>;
static NOTICE_HOOK: std::sync::OnceLock<NoticeHook> = std::sync::OnceLock::new();

/// Where notices go when no interactive prompter is attached (silent
/// reconnects): the GUI sets this once at startup.
pub fn set_notice_hook(hook: impl Fn(&str, Option<&str>) + Send + Sync + 'static) {
    let _ = NOTICE_HOOK.set(Box::new(hook));
}

/// Show `message` (and `url`) through the app's hook, else on stderr.
pub fn notice(message: &str, url: Option<&str>) {
    match (NOTICE_HOOK.get(), url) {
        (Some(hook), _) => hook(message, url),
        (None, Some(url)) => eprintln!("{message}
  {url}"),
        (None, None) => eprintln!("{message}"),
    }
}

/// Error for a profile that has both a TCP proxy and a proxy command.
pub fn conflict_error(profile_name: &str) -> anyhow::Error {
    anyhow!("'{profile_name}' has both a proxy and a proxy command; pick one in the connection editor")
}

#[cfg(test)]
#[path = "proxy_command_tests.rs"]
pub(crate) mod e2e;

#[cfg(test)]
mod tests {
    use super::*;

    fn cmd(line: &str) -> ProxyCommandConfig {
        ProxyCommandConfig {
            kind: ProxyCommandKind::Command,
            command: line.into(),
            hostname: None,
            service_token_id: None,
            service_token_secret: None,
        }
    }

    fn cf(hostname: Option<&str>, id: Option<&str>, secret: Option<&str>) -> ProxyCommandConfig {
        ProxyCommandConfig {
            kind: ProxyCommandKind::Cloudflare,
            command: String::new(),
            hostname: hostname.map(Into::into),
            service_token_id: id.map(Into::into),
            service_token_secret: secret.map(Into::into),
        }
    }

    #[test]
    fn split_handles_quotes_escapes_and_windows_paths() {
        assert_eq!(split("a  b\tc").unwrap(), ["a", "b", "c"]);
        assert_eq!(
            split(r#"'single  quoted' "double \"q\" \\ x""#).unwrap(),
            ["single  quoted", r#"double "q" \ x"#]
        );
        assert_eq!(split(r#"a"b c"d"#).unwrap(), ["ab cd"]);
        assert_eq!(split(r"one\ arg two").unwrap(), ["one arg", "two"]);
        assert_eq!(
            split(r#""C:\Program Files (x86)\cloudflared\cloudflared.exe" access ssh"#).unwrap(),
            [r"C:\Program Files (x86)\cloudflared\cloudflared.exe", "access", "ssh"]
        );
        assert_eq!(split(r"C:\tools\proxy.exe %h").unwrap(), [r"C:\tools\proxy.exe", "%h"]);
        assert_eq!(split(r#""" x"#).unwrap(), ["", "x"]);
        assert!(split("   ").unwrap().is_empty());
        assert!(split("a 'open").unwrap_err().to_string().contains("unterminated '"));
        assert!(split("a \"open").unwrap_err().to_string().contains("unterminated \""));
    }

    #[test]
    fn split_refuses_shell_operators_but_not_quoted_ones() {
        for line in ["nc host 22 | tee log", "a && b", "a ; b", "a > out", "a < in", "a &"] {
            let err = split(line).unwrap_err().to_string();
            assert!(err.contains("without a shell"), "{line}: {err}");
        }
        assert_eq!(split("sh -c 'nc %h %p | cat'").unwrap(), ["sh", "-c", "nc %h %p | cat"]);
        assert_eq!(split("grep '|'").unwrap(), ["grep", "|"]);
        // Operators glued to words are ordinary characters, as in argv.
        assert_eq!(split("a|b").unwrap(), ["a|b"]);
    }

    #[test]
    fn expand_tokens() {
        assert_eq!(expand("%h:%p@%r", "db.internal", 2222, "ivo").unwrap(), "db.internal:2222@ivo");
        assert_eq!(expand("100%%", "h", 1, "u").unwrap(), "100%");
        assert_eq!(expand("%%h", "h", 1, "u").unwrap(), "%h");
        assert_eq!(expand("plain", "h", 1, "u").unwrap(), "plain");
        let err = expand("%C", "h", 1, "u").unwrap_err().to_string();
        assert!(err.contains("%C") && err.contains("%h, %p, %r"), "{err}");
        assert!(expand("50%", "h", 1, "u").unwrap_err().to_string().contains("lone %"));
    }

    #[test]
    fn expansion_cannot_inject_arguments() {
        let hostile = r#"evil host" --x '; rm -rf ~ | nc"#;
        let spec = build(&cmd("relay --to %h:%p %r"), hostile, 22, "a b").unwrap();
        assert_eq!(spec.program, "relay");
        assert_eq!(spec.args, ["--to".to_string(), format!("{hostile}:22"), "a b".into()]);
    }

    #[test]
    fn build_custom_command() {
        let line = "exec aws ssm start-session --target %h --document-name AWS-StartSSHSession --parameters portNumber=%p";
        let spec = build(&cmd(line), "i-0abc", 22, "ec2-user").unwrap();
        assert_eq!(spec.program, "aws");
        assert_eq!(spec.args[3], "i-0abc");
        assert_eq!(spec.args.last().unwrap(), "portNumber=22");
        assert!(!spec.cloudflared && spec.env.is_empty());
        assert!(build(&cmd("  "), "h", 22, "u").unwrap_err().to_string().contains("empty"));
        assert!(build(&cmd("exec"), "h", 22, "u").is_err());

        let line = r#""C:\Program Files\cloudflared\cloudflared.EXE" access ssh --hostname %h"#;
        let spec = build(&cmd(line), "ssh.example.com", 22, "u").unwrap();
        assert!(spec.cloudflared);
        assert_eq!(spec.cloudflare_hostname(), Some("ssh.example.com"));
    }

    #[test]
    fn build_cloudflare_keeps_the_secret_out_of_argv() {
        let spec = build(&cf(None, None, None), "ssh.example.com", 22, "u").unwrap();
        assert_eq!(spec.program, "cloudflared");
        assert_eq!(spec.args, ["access", "ssh", "--hostname", "ssh.example.com"]);
        assert!(spec.cloudflared && spec.env.is_empty());

        let spec = build(&cf(Some(" ssh.corp.dev "), Some("id.access"), Some("s3cr3t")), "10.0.0.5", 22, "u").unwrap();
        assert_eq!(spec.cloudflare_hostname(), Some("ssh.corp.dev"));
        assert_eq!(
            spec.env,
            [
                ("TUNNEL_SERVICE_TOKEN_ID".to_string(), "id.access".to_string()),
                ("TUNNEL_SERVICE_TOKEN_SECRET".into(), "s3cr3t".into())
            ]
        );
        assert!(!spec.args.iter().any(|a| a.contains("s3cr3t")));
        assert!(!spec.display().contains("s3cr3t"));

        // A blank hostname falls back to the profile host.
        let spec = build(&cf(Some("  "), None, None), "h.example", 22, "u").unwrap();
        assert_eq!(spec.cloudflare_hostname(), Some("h.example"));
        // Half a token is a mistake, not "no token".
        assert!(build(&cf(None, Some("id"), None), "h", 22, "u").unwrap_err().to_string().contains("no secret"));
        assert!(build(&cf(None, None, Some("s")), "h", 22, "u").unwrap_err().to_string().contains("no ID"));
    }

    #[test]
    fn missing_programs_get_actionable_errors() {
        let spec = build(&cmd("faro-definitely-not-installed-xyz %h"), "h", 22, "u").unwrap();
        let err = resolve_program(&spec).unwrap_err().to_string();
        assert!(err.contains("not found on PATH"), "{err}");

        let mut cf_spec = spec.clone();
        cf_spec.program = "cloudflared-not-installed-xyz".into();
        cf_spec.cloudflared = true;
        let err = resolve_program(&cf_spec).unwrap_err().to_string();
        assert!(err.contains(CLOUDFLARED_DOWNLOAD_URL), "{err}");

        let mut path_spec = spec;
        path_spec.program = std::env::temp_dir().join("faro-nope").join("proxy.exe").display().to_string();
        assert!(resolve_program(&path_spec).unwrap_err().to_string().contains("doesn't exist"));
    }

    #[test]
    fn cloudflared_is_recognised_on_any_os() {
        for p in [
            "cloudflared",
            "CLOUDFLARED.EXE",
            "/usr/local/bin/cloudflared",
            r"C:\Program Files (x86)\cloudflared\cloudflared.exe",
            r"D:\tools/cloudflared.Exe",
        ] {
            assert!(is_cloudflared(p), "{p}");
        }
        for p in ["cloudflared2", "my-cloudflared", r"C:\cloudflared\proxy.exe", "ssh", "", "é", "日本.exe"] {
            assert!(!is_cloudflared(p), "{p}");
        }
    }

    #[test]
    fn login_urls_are_access_urls_only() {
        let url = "https://team.cloudflareaccess.com/cdn-cgi/access/cli?aud=x&token=y";
        assert_eq!(access_login_url(url).as_deref(), Some(url));
        assert_eq!(access_login_url(&format!("  {url}  ")).as_deref(), Some(url));
        assert!(access_login_url("INF see https://developers.cloudflare.com/x for help").is_none());
        assert!(access_login_url("no url here").is_none());
    }

    #[test]
    fn cloudflared_failures_are_classified() {
        let c = |lines: &[&str], login: Option<&str>, timed_out: bool| {
            classify_cloudflared(lines, Some("ssh.example.com"), login, timed_out)
        };
        let msg = c(&["ERR dial tcp: lookup ssh.example.com: no such host"], None, false).unwrap();
        assert!(msg.contains("doesn't resolve"), "{msg}");
        let msg = c(&["failed to find token"], Some("https://t/cdn-cgi/access/cli"), false).unwrap();
        assert!(msg.contains("sign-in") && msg.contains("https://t/cdn-cgi/access/cli"), "{msg}");
        assert!(msg.contains("service token"), "{msg}");
        let msg = c(&["failed to fetch token: 403 Forbidden"], None, false).unwrap();
        assert!(msg.contains("refused the login"), "{msg}");
        let msg = c(&["websocket: bad handshake"], None, false).unwrap();
        assert!(msg.contains("couldn't reach the SSH server"), "{msg}");
        assert!(c(&["Error 1033 Argo Tunnel error"], None, false).unwrap().contains("tunnel"));
        assert!(c(&[], None, true).unwrap().contains("got no answer"));
        assert!(c(&["something new"], None, false).is_none());
    }

    #[test]
    fn profiles_round_trip_and_old_ones_still_load() {
        let p: crate::profiles::ConnectionProfile = serde_json::from_value(serde_json::json!({
            "id": "p", "name": "cf", "protocol": "sftp", "host": "ssh.example.com", "port": 22,
            "username": "u", "auth": { "kind": "agent" },
            "proxyCommand": { "kind": "cloudflare", "serviceTokenId": "id" }
        }))
        .unwrap();
        let c = p.proxy_command.as_ref().unwrap();
        assert_eq!(c.kind, ProxyCommandKind::Cloudflare);
        assert_eq!((c.service_token_id.as_deref(), c.command.as_str()), (Some("id"), ""));
        let back = serde_json::to_value(&p).unwrap();
        assert_eq!(back["proxyCommand"], serde_json::json!({ "kind": "cloudflare", "serviceTokenId": "id" }));

        let old: crate::profiles::ConnectionProfile = serde_json::from_value(serde_json::json!({
            "id": "p", "name": "old", "protocol": "sftp", "host": "h", "port": 22,
            "username": "u", "auth": { "kind": "agent" }
        }))
        .unwrap();
        assert!(old.proxy_command.is_none());
        assert!(serde_json::to_value(&old).unwrap().get("proxyCommand").is_none());
    }
}
