//! Shell profiles for the local terminal (Plan 36 Phase 1): which shells this
//! machine has, and how to start each one.
//!
//! A profile id is stable across launches so it can be stored in a setting or
//! a saved workspace: `pwsh`, `powershell`, `cmd`, `git-bash`, `wsl:<distro>`
//! on Windows; the shell's file name (`bash`, `zsh`, …) elsewhere.

use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LocalShell {
    pub id: String,
    pub name: String,
    pub program: String,
    pub args: Vec<String>,
}

impl LocalShell {
    fn new(id: &str, name: &str, program: impl Into<String>, args: &[&str]) -> Self {
        Self {
            id: id.to_string(),
            name: name.to_string(),
            program: program.into(),
            args: args.iter().map(|a| a.to_string()).collect(),
        }
    }
}

/// First match of `names` in the search path (Faro's PATH plus, on Windows,
/// the live registry PATH).
fn find_on_path(names: &[&str]) -> Option<PathBuf> {
    for dir in crate::env_path::search_dirs() {
        for name in names {
            let candidate = dir.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

fn path_string(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

/// Every shell found on this machine, the default first.
pub fn list() -> Vec<LocalShell> {
    #[cfg(windows)]
    {
        let mut out = windows_fixed();
        for distro in wsl_distros() {
            out.push(wsl_profile(&distro));
        }
        out
    }
    #[cfg(not(windows))]
    {
        unix_shells()
    }
}

/// The profile for `id`, or the machine's default when `id` is empty or no
/// longer installed. Never runs `wsl.exe`: a `wsl:<distro>` id is trusted as
/// written so opening a tab stays fast.
pub fn resolve(id: &str) -> LocalShell {
    #[cfg(windows)]
    {
        if let Some(distro) = id.strip_prefix("wsl:") {
            if !distro.is_empty() {
                return wsl_profile(distro);
            }
        }
        let fixed = windows_fixed();
        fixed
            .iter()
            .find(|s| s.id == id)
            .or_else(|| fixed.first())
            .cloned()
            .unwrap_or_else(|| LocalShell::new("cmd", "Command Prompt", "cmd.exe", &[]))
    }
    #[cfg(not(windows))]
    {
        let all = unix_shells();
        all.iter()
            .find(|s| s.id == id)
            .or_else(|| all.first())
            .cloned()
            .unwrap_or_else(|| LocalShell::new("sh", "sh", "/bin/sh", &[]))
    }
}

#[cfg(windows)]
fn windows_fixed() -> Vec<LocalShell> {
    let mut out = Vec::new();
    if let Some(p) = find_on_path(&["pwsh.exe"]) {
        out.push(LocalShell::new("pwsh", "PowerShell", path_string(&p), &["-NoLogo"]));
    }
    let system_root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
    let win_ps = Path::new(&system_root)
        .join(r"System32\WindowsPowerShell\v1.0\powershell.exe");
    if win_ps.is_file() {
        out.push(LocalShell::new(
            "powershell",
            "Windows PowerShell",
            path_string(&win_ps),
            &["-NoLogo"],
        ));
    }
    let cmd = std::env::var("ComSpec")
        .unwrap_or_else(|_| format!(r"{system_root}\System32\cmd.exe"));
    out.push(LocalShell::new("cmd", "Command Prompt", cmd, &[]));
    if let Some(p) = git_bash() {
        out.push(LocalShell::new(
            "git-bash",
            "Git Bash",
            path_string(&p),
            &["--login", "-i"],
        ));
    }
    out
}

#[cfg(windows)]
fn git_bash() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    for var in ["ProgramFiles", "ProgramFiles(x86)", "LocalAppData"] {
        if let Ok(base) = std::env::var(var) {
            let base = PathBuf::from(base);
            candidates.push(base.join(r"Git\bin\bash.exe"));
            candidates.push(base.join(r"Programs\Git\bin\bash.exe"));
        }
    }
    // A Git installed elsewhere: `<root>\cmd\git.exe` sits next to `<root>\bin`.
    if let Some(git) = find_on_path(&["git.exe"]) {
        if let Some(root) = git.parent().and_then(Path::parent) {
            candidates.push(root.join(r"bin\bash.exe"));
        }
    }
    candidates.into_iter().find(|p| p.is_file())
}

#[cfg(windows)]
fn wsl_profile(distro: &str) -> LocalShell {
    LocalShell {
        id: format!("wsl:{distro}"),
        name: format!("{distro} (WSL)"),
        program: "wsl.exe".into(),
        args: vec!["-d".into(), distro.into()],
    }
}

#[cfg(windows)]
fn wsl_distros() -> Vec<String> {
    use crate::proc::NoConsoleWindow;
    let Some(wsl) = find_on_path(&["wsl.exe"]) else {
        return Vec::new();
    };
    let out = std::process::Command::new(wsl)
        .args(["-l", "-q"])
        .no_console_window()
        .output();
    match out {
        Ok(o) if o.status.success() => parse_wsl_list(&o.stdout),
        _ => Vec::new(),
    }
}

/// `wsl.exe -l -q` prints one distro per line as UTF-16LE (with stray NULs and
/// a trailing blank line). Docker's internal distros are not shells.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn parse_wsl_list(raw: &[u8]) -> Vec<String> {
    let units: Vec<u16> = raw
        .chunks_exact(2)
        .map(|c| u16::from_le_bytes([c[0], c[1]]))
        .collect();
    String::from_utf16_lossy(&units)
        .lines()
        .map(|l| l.trim_matches(|c: char| c.is_whitespace() || c == '\0' || c == '\u{feff}'))
        .filter(|l| !l.is_empty() && !l.starts_with("docker-desktop"))
        .map(str::to_string)
        .collect()
}

#[cfg(not(windows))]
fn unix_shells() -> Vec<LocalShell> {
    let mut out: Vec<LocalShell> = Vec::new();
    let mut push = |path: PathBuf| {
        let Some(name) = path.file_name().map(|n| n.to_string_lossy().into_owned()) else {
            return;
        };
        if out.iter().any(|s| s.id == name) {
            return;
        }
        // A login shell, so the user's profile (PATH, aliases) is loaded.
        out.push(LocalShell::new(&name, &name, path_string(&path), &["-l"]));
    };
    if let Ok(shell) = std::env::var("SHELL") {
        let p = PathBuf::from(shell);
        if p.is_file() {
            push(p);
        }
    }
    for name in ["zsh", "bash", "fish"] {
        if let Some(p) = find_on_path(&[name]) {
            push(p);
        }
    }
    if out.is_empty() {
        out.push(LocalShell::new("sh", "sh", "/bin/sh", &[]));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn utf16le(s: &str) -> Vec<u8> {
        s.encode_utf16().flat_map(|u| u.to_le_bytes()).collect()
    }

    #[test]
    fn wsl_list_is_decoded_and_filtered() {
        let raw = utf16le("\u{feff}Ubuntu\r\ndocker-desktop\r\nDebian\r\ndocker-desktop-data\r\n\r\n");
        assert_eq!(parse_wsl_list(&raw), vec!["Ubuntu", "Debian"]);
        assert!(parse_wsl_list(&[]).is_empty());
    }

    #[test]
    fn resolve_always_returns_a_shell() {
        let s = resolve("no-such-shell");
        assert!(!s.program.is_empty());
        assert_eq!(resolve(""), s, "an unknown id falls back to the default");
    }

    #[cfg(windows)]
    #[test]
    fn wsl_id_resolves_without_listing() {
        let s = resolve("wsl:Ubuntu-24.04");
        assert_eq!(s.program, "wsl.exe");
        assert_eq!(s.args, vec!["-d", "Ubuntu-24.04"]);
    }
}
