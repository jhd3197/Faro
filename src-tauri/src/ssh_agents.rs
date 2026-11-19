//! Which SSH agent a profile's `AuthMethod::Agent` login talks to.
//!
//! A profile's `identity_agent` is absent (automatic), `system`, `1password`,
//! `bitwarden`, or a socket / pipe path. 1Password and Bitwarden each run an
//! agent: on macOS and Linux it listens on its own socket, which an app started
//! from the Dock or a launcher never sees through `SSH_AUTH_SOCK`. On Windows
//! both take over the OpenSSH pipe.
#[cfg(windows)]
use anyhow::Context;
use anyhow::{anyhow, Result};
use russh_keys::agent::client::AgentClient;
use serde::Serialize;
#[cfg(unix)]
use std::path::{Path, PathBuf};

pub const SYSTEM: &str = "system";
pub const ONEPASSWORD: &str = "1password";
pub const BITWARDEN: &str = "bitwarden";

#[cfg(unix)]
pub type Stream = tokio::net::UnixStream;
#[cfg(windows)]
pub type Stream = tokio::net::windows::named_pipe::NamedPipeClient;

/// An open agent and where it was found, for error messages.
pub struct Opened {
    pub agent: AgentClient<Stream>,
    pub path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentInfo {
    pub id: String,
    pub label: String,
    pub path: String,
    /// The socket or pipe exists.
    pub available: bool,
}

fn label(id: &str) -> &'static str {
    match id {
        ONEPASSWORD => "1Password",
        BITWARDEN => "Bitwarden",
        _ => "System agent",
    }
}

const ONEPASSWORD_NOT_RUNNING: &str =
    "1Password's SSH agent isn't running. Turn it on in 1Password › Settings › Developer.";
const BITWARDEN_NOT_RUNNING: &str =
    "Bitwarden's SSH agent isn't running. Turn it on in Bitwarden › Settings › Enable SSH agent.";

// ---------- Known endpoints ----------

/// 1Password's and Bitwarden's sockets, relative to the home directory, for
/// this OS. The first entry is the one written to an exported ssh config.
#[cfg(unix)]
fn home_relative(id: &str) -> &'static [&'static str] {
    match (id, cfg!(target_os = "macos")) {
        (ONEPASSWORD, true) => &["Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock"],
        (ONEPASSWORD, false) => &[".1password/agent.sock"],
        (BITWARDEN, true) => &[
            ".bitwarden-ssh-agent.sock",
            "Library/Containers/com.bitwarden.desktop/Data/.bitwarden-ssh-agent.sock",
        ],
        (BITWARDEN, false) => &[
            ".bitwarden-ssh-agent.sock",
            "snap/bitwarden/current/.bitwarden-ssh-agent.sock",
            ".var/app/com.bitwarden.desktop/data/.bitwarden-ssh-agent.sock",
        ],
        _ => &[],
    }
}

#[cfg(unix)]
fn known(id: &str, home: Option<&Path>) -> Vec<PathBuf> {
    match home {
        Some(home) => home_relative(id).iter().map(|r| home.join(r)).collect(),
        None => Vec::new(),
    }
}

#[cfg(unix)]
fn env_sock() -> Option<PathBuf> {
    std::env::var_os("SSH_AUTH_SOCK").filter(|s| !s.is_empty()).map(PathBuf::from)
}

/// `auto` on Unix: `$SSH_AUTH_SOCK`, then 1Password, then Bitwarden.
#[cfg(unix)]
pub fn auto_candidates(env_sock: Option<PathBuf>, home: Option<&Path>) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = env_sock.into_iter().collect();
    out.extend(known(ONEPASSWORD, home));
    out.extend(known(BITWARDEN, home));
    out
}

#[cfg(windows)]
const OPENSSH_PIPE: &str = r"\\.\pipe\openssh-ssh-agent";

/// Whether a named pipe exists, without opening (and so consuming) it.
#[cfg(windows)]
fn pipe_exists(name: &str) -> bool {
    std::fs::read_dir(r"\\.\pipe\")
        .map(|entries| entries.flatten().any(|e| e.file_name().to_string_lossy().eq_ignore_ascii_case(name)))
        .unwrap_or(false)
}

/// PuTTY Pageant 0.78+ pipes are `\\.\pipe\pageant.<user>.<random>`; the
/// suffix changes every launch. Older Pageant (file-mapping IPC) isn't
/// supported.
#[cfg(windows)]
fn find_pageant_pipe() -> Option<String> {
    let entries = std::fs::read_dir(r"\\.\pipe\").ok()?;
    entries.flatten().find_map(|entry| {
        let name = entry.file_name().to_string_lossy().into_owned();
        name.starts_with("pageant.").then(|| format!(r"\\.\pipe\{name}"))
    })
}

/// The agents on this OS, for the profile editor's "found" / "not running".
pub fn list() -> Vec<AgentInfo> {
    [SYSTEM, ONEPASSWORD, BITWARDEN]
        .iter()
        .map(|id| {
            let (path, available) = endpoint(id);
            AgentInfo { id: id.to_string(), label: label(id).into(), path, available }
        })
        .collect()
}

#[cfg(unix)]
fn endpoint(id: &str) -> (String, bool) {
    let candidates: Vec<PathBuf> = if id == SYSTEM { env_sock().into_iter().collect() } else { known(id, dirs::home_dir().as_deref()) };
    let found = candidates.iter().find(|p| p.exists());
    match found.or(candidates.first()) {
        Some(p) => (p.display().to_string(), found.is_some()),
        None => (String::new(), false),
    }
}

#[cfg(windows)]
fn endpoint(id: &str) -> (String, bool) {
    let openssh = pipe_exists("openssh-ssh-agent");
    if id == SYSTEM && !openssh {
        if let Some(pageant) = find_pageant_pipe() {
            return (pageant, true);
        }
    }
    (OPENSSH_PIPE.into(), openssh)
}

// ---------- ssh config mapping ----------

/// An OpenSSH `IdentityAgent` value as a profile's `identity_agent`: known
/// 1Password / Bitwarden sockets become their id, `SSH_AUTH_SOCK` becomes
/// `system`, `none` is dropped and any other path is kept.
pub fn from_ssh_config(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty() || value.eq_ignore_ascii_case("none") {
        return None;
    }
    if value == "SSH_AUTH_SOCK" || value == "$SSH_AUTH_SOCK" || value == "${SSH_AUTH_SOCK}" {
        return Some(SYSTEM.into());
    }
    let normalized = value.replace('\\', "/");
    if normalized.ends_with("/.1password/agent.sock") || normalized.contains("2BUA8C4S2C.com.1password/") {
        return Some(ONEPASSWORD.into());
    }
    if normalized.ends_with("/.bitwarden-ssh-agent.sock") || normalized == ".bitwarden-ssh-agent.sock" {
        return Some(BITWARDEN.into());
    }
    Some(crate::keys::expand_tilde(value).to_string_lossy().into_owned())
}

/// A profile's `identity_agent` as an OpenSSH `IdentityAgent` value.
pub fn to_ssh_config(choice: Option<&str>) -> String {
    match choice {
        None | Some("") | Some("auto") | Some(SYSTEM) => "SSH_AUTH_SOCK".into(),
        #[cfg(unix)]
        Some(id @ (ONEPASSWORD | BITWARDEN)) => format!("~/{}", home_relative(id)[0]),
        #[cfg(windows)]
        Some(ONEPASSWORD | BITWARDEN) => OPENSSH_PIPE.into(),
        Some(path) => path.into(),
    }
}

// ---------- Opening ----------

/// Open the agent `choice` names (see the module docs). Errors say what was
/// tried.
pub async fn open(choice: Option<&str>) -> Result<Opened> {
    match choice.map(str::trim).filter(|c| !c.is_empty()) {
        None | Some("auto") => open_auto().await,
        Some(id) => open_named(id).await,
    }
}

#[cfg(unix)]
async fn first_answering(candidates: &[PathBuf]) -> Option<(Stream, PathBuf)> {
    for path in candidates {
        if let Ok(stream) = tokio::net::UnixStream::connect(path).await {
            return Some((stream, path.clone()));
        }
    }
    None
}

#[cfg(unix)]
fn opened(stream: Stream, path: &Path) -> Opened {
    Opened { agent: AgentClient::connect(stream), path: path.display().to_string() }
}

#[cfg(unix)]
async fn open_auto() -> Result<Opened> {
    let candidates = auto_candidates(env_sock(), dirs::home_dir().as_deref());
    match first_answering(&candidates).await {
        Some((stream, path)) => Ok(opened(stream, &path)),
        None if candidates.is_empty() => Err(anyhow!(
            "No SSH agent found: SSH_AUTH_SOCK isn't set. Start an SSH agent, or turn on the one in 1Password or Bitwarden."
        )),
        None => {
            let tried: Vec<String> = candidates.iter().map(|p| p.display().to_string()).collect();
            Err(anyhow!(
                "No SSH agent answered. Tried {}. Start an SSH agent, or turn on the one in 1Password or Bitwarden.",
                tried.join(", ")
            ))
        }
    }
}

#[cfg(unix)]
async fn open_named(id: &str) -> Result<Opened> {
    let home = dirs::home_dir();
    let (candidates, not_running): (Vec<PathBuf>, String) = match id {
        SYSTEM => match env_sock() {
            Some(sock) => {
                let msg = format!("No SSH agent is answering at {} (SSH_AUTH_SOCK).", sock.display());
                (vec![sock], msg)
            }
            None => anyhow::bail!(
                "SSH_AUTH_SOCK isn't set, so there's no system SSH agent. Pick 1Password, Bitwarden or a custom path instead."
            ),
        },
        ONEPASSWORD => (known(ONEPASSWORD, home.as_deref()), ONEPASSWORD_NOT_RUNNING.into()),
        BITWARDEN => (known(BITWARDEN, home.as_deref()), BITWARDEN_NOT_RUNNING.into()),
        path => {
            let path = crate::keys::expand_tilde(path);
            let msg = format!("No SSH agent is answering at {}.", path.display());
            (vec![path], msg)
        }
    };
    let (stream, path) = first_answering(&candidates).await.ok_or_else(|| anyhow!(not_running))?;
    Ok(opened(stream, &path))
}

#[cfg(windows)]
fn open_pipe(name: &str) -> Option<Opened> {
    let stream = tokio::net::windows::named_pipe::ClientOptions::new().open(name).ok()?;
    Some(Opened { agent: AgentClient::connect(stream), path: name.into() })
}

#[cfg(windows)]
async fn open_auto() -> Result<Opened> {
    // OpenSSH for Windows (the 'OpenSSH Authentication Agent' service, and the
    // pipe 1Password and Bitwarden take over), then Pageant.
    if let Some(opened) = open_pipe(OPENSSH_PIPE) {
        return Ok(opened);
    }
    if let Some(opened) = find_pageant_pipe().and_then(|pipe| open_pipe(&pipe)) {
        return Ok(opened);
    }
    Err(anyhow!(
        "No SSH agent found. Tried OpenSSH ({OPENSSH_PIPE}) and Pageant. Start the 'OpenSSH Authentication Agent' \
         service, launch Pageant (PuTTY 0.78+), or turn on the SSH agent in 1Password or Bitwarden."
    ))
}

#[cfg(windows)]
async fn open_named(id: &str) -> Result<Opened> {
    match id {
        SYSTEM => open_auto().await,
        // Both serve the OpenSSH pipe on Windows.
        ONEPASSWORD => open_pipe(OPENSSH_PIPE).context(ONEPASSWORD_NOT_RUNNING),
        BITWARDEN => open_pipe(OPENSSH_PIPE).context(BITWARDEN_NOT_RUNNING),
        path => open_pipe(path).with_context(|| format!("No SSH agent is answering at {path}.")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_agent_import_mapping() {
        assert_eq!(from_ssh_config("none"), None);
        assert_eq!(from_ssh_config("SSH_AUTH_SOCK").as_deref(), Some(SYSTEM));
        assert_eq!(from_ssh_config("$SSH_AUTH_SOCK").as_deref(), Some(SYSTEM));
        assert_eq!(from_ssh_config("~/.1password/agent.sock").as_deref(), Some(ONEPASSWORD));
        assert_eq!(
            from_ssh_config("~/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock").as_deref(),
            Some(ONEPASSWORD)
        );
        assert_eq!(from_ssh_config("~/.bitwarden-ssh-agent.sock").as_deref(), Some(BITWARDEN));
        assert_eq!(
            from_ssh_config("/Users/me/Library/Containers/com.bitwarden.desktop/Data/.bitwarden-ssh-agent.sock").as_deref(),
            Some(BITWARDEN)
        );
        assert_eq!(from_ssh_config("/run/user/1000/gnupg/S.gpg-agent.ssh").as_deref(), Some("/run/user/1000/gnupg/S.gpg-agent.ssh"));
    }

    #[test]
    fn identity_agent_export_mapping() {
        assert_eq!(to_ssh_config(None), "SSH_AUTH_SOCK");
        assert_eq!(to_ssh_config(Some(SYSTEM)), "SSH_AUTH_SOCK");
        assert_eq!(to_ssh_config(Some("/tmp/agent.sock")), "/tmp/agent.sock");
        // Known ids round-trip through the importer.
        for id in [ONEPASSWORD, BITWARDEN] {
            assert_eq!(from_ssh_config(&to_ssh_config(Some(id))).as_deref(), if cfg!(windows) { Some(r"\\.\pipe\openssh-ssh-agent") } else { Some(id) });
        }
    }

    #[test]
    fn lists_three_agents() {
        let ids: Vec<String> = list().into_iter().map(|a| a.id).collect();
        assert_eq!(ids, [SYSTEM, ONEPASSWORD, BITWARDEN]);
    }

    #[tokio::test]
    async fn missing_custom_agent_names_the_path() {
        let path = std::env::temp_dir().join(format!("faro-no-agent-{}", uuid::Uuid::new_v4()));
        let err = open(Some(&path.to_string_lossy())).await.err().expect("no agent there");
        assert!(format!("{err:#}").contains(&*path.to_string_lossy()), "{err:#}");
    }

    #[cfg(unix)]
    #[test]
    fn auto_order_is_env_then_1password_then_bitwarden() {
        let home = Path::new("/home/me");
        let order = auto_candidates(Some("/tmp/env.sock".into()), Some(home));
        assert_eq!(order[0], PathBuf::from("/tmp/env.sock"));
        let one = order.iter().position(|p| p.to_string_lossy().contains("1password")).unwrap();
        let bw = order.iter().position(|p| p.to_string_lossy().contains("bitwarden")).unwrap();
        assert!(0 < one && one < bw);
        assert!(auto_candidates(None, Some(home))[0].to_string_lossy().contains("1password"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn auto_takes_the_first_socket_that_answers() {
        let dir = std::env::temp_dir().join(format!("faro-agents-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let (missing, second, third) = (dir.join("a.sock"), dir.join("b.sock"), dir.join("c.sock"));
        let _b = tokio::net::UnixListener::bind(&second).unwrap();
        let _c = tokio::net::UnixListener::bind(&third).unwrap();
        let (_, path) = first_answering(&[missing, second.clone(), third]).await.expect("an agent");
        assert_eq!(path, second);
        std::fs::remove_dir_all(dir).ok();
    }
}
