//! The folders to search for a tool someone installed outside Faro.
//!
//! A process keeps the PATH it started with. On Windows, an installer or
//! winget that adds cloudflared, op or bw to PATH only updates the registry
//! (and Explorer), so a Faro that was already running never saw the new
//! folder until it, or the whole PC, restarted. This reads the current user
//! and system PATH from the registry as well, after Faro's own PATH.

use std::path::PathBuf;

/// Faro's own PATH first, then the live registry PATH (Windows), no repeats.
pub fn search_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    for extra in registry_path() {
        let key = normalize(&extra);
        if !extra.as_os_str().is_empty() && !dirs.iter().any(|d| normalize(d) == key) {
            dirs.push(extra);
        }
    }
    dirs
}

fn normalize(p: &std::path::Path) -> String {
    let s = p.to_string_lossy();
    let s = s.trim_end_matches(['\\', '/']);
    if cfg!(windows) { s.to_ascii_lowercase() } else { s.to_string() }
}

#[cfg(windows)]
fn registry_path() -> Vec<PathBuf> {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
    use winreg::RegKey;
    let read = |root, sub: &str| -> Option<String> {
        RegKey::predef(root).open_subkey(sub).ok()?.get_value::<String, _>("Path").ok()
    };
    // System first, then user: the order Windows builds a new process's PATH.
    let system = read(HKEY_LOCAL_MACHINE, r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment");
    let user = read(HKEY_CURRENT_USER, "Environment");
    [system, user]
        .into_iter()
        .flatten()
        .flat_map(|raw| {
            expand(&raw)
                .split(';')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(PathBuf::from)
                .collect::<Vec<_>>()
        })
        .collect()
}

#[cfg(not(windows))]
fn registry_path() -> Vec<PathBuf> {
    Vec::new()
}

/// Expand `%NAME%` (REG_EXPAND_SZ values like `%SystemRoot%\system32`).
/// Unknown names stay as written.
#[cfg_attr(not(windows), allow(dead_code))]
fn expand(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut rest = raw;
    while let Some(start) = rest.find('%') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        match after.find('%') {
            Some(end) if end > 0 => {
                let name = &after[..end];
                match std::env::var(name) {
                    Ok(v) => out.push_str(&v),
                    Err(_) => {
                        out.push('%');
                        out.push_str(name);
                        out.push('%');
                    }
                }
                rest = &after[end + 1..];
            }
            _ => {
                out.push('%');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expands_known_variables_only() {
        std::env::set_var("FARO_ENV_PATH_TEST", r"C:\Tools");
        assert_eq!(expand(r"%FARO_ENV_PATH_TEST%\bin;%NOPE_NOT_SET%\x;50%"), r"C:\Tools\bin;%NOPE_NOT_SET%\x;50%");
    }

    #[test]
    fn keeps_process_path_first_without_repeats() {
        let dirs = search_dirs();
        let process: Vec<PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
        assert_eq!(&dirs[..process.len()], &process[..]);
        let keys: Vec<String> = dirs[process.len()..].iter().map(|d| normalize(d)).collect();
        let mut unique = keys.clone();
        unique.sort();
        unique.dedup();
        assert_eq!(keys.len(), unique.len());
    }
}
