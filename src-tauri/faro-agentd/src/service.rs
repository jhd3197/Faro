//! Install `faro-agentd` as a background service so a controlled machine keeps
//! serving across reboots without anyone leaving a terminal open.
//!
//! Per platform, using only what ships with the OS (no extra tooling):
//!   * **Linux** — a systemd unit. A system unit when run as root, otherwise a
//!     per-user unit (`systemctl --user`), which needs no sudo. This is the
//!     primary target: the ServerKit/hosting case.
//!   * **macOS** — a per-user LaunchAgent plist.
//!   * **Windows** — a per-user logon Scheduled Task (`schtasks`). `faro-agentd`
//!     is a plain console app, not an SCM service, so a Task is the honest fit.
//!
//! The unit/plist/task just runs `faro-agentd run`, so it obeys the same
//! identity, pins, and policy as an interactive run — installing changes *when*
//! it runs, not *what* it can do.

use anyhow::{bail, Context, Result};
use std::path::PathBuf;

#[cfg(target_os = "macos")]
const LAUNCHD_LABEL: &str = "com.juandenis.faro-agentd";
const TASK_NAME: &str = "FaroAgent";

/// Absolute path to the running executable, for the service definition.
fn exe_path() -> Result<PathBuf> {
    std::env::current_exe().context("resolve current executable path")
}

/// Extra args to append to `run` in the service definition (e.g. --read-only,
/// --port). `--config-dir` is passed through so a service uses the same config
/// the admin set up interactively.
pub fn install(extra_args: &[String]) -> Result<()> {
    #[cfg(target_os = "linux")]
    return linux::install(extra_args);
    #[cfg(target_os = "macos")]
    return macos::install(extra_args);
    #[cfg(target_os = "windows")]
    return windows::install(extra_args);
    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    bail!("service install isn't supported on this platform — run `faro-agentd run` yourself");
}

pub fn uninstall() -> Result<()> {
    #[cfg(target_os = "linux")]
    return linux::uninstall();
    #[cfg(target_os = "macos")]
    return macos::uninstall();
    #[cfg(target_os = "windows")]
    return windows::uninstall();
    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    bail!("service uninstall isn't supported on this platform");
}

/// Build the `run …` argument line shared by every backend.
fn run_args(extra_args: &[String]) -> String {
    let mut parts = vec!["run".to_string()];
    parts.extend(extra_args.iter().cloned());
    parts.join(" ")
}

#[cfg(target_os = "linux")]
mod linux {
    use super::*;
    use std::process::Command;

    pub fn install(extra: &[String]) -> Result<()> {
        let exe = exe_path()?;
        let is_root = unsafe { libc_geteuid() } == 0;
        let unit = unit_file(&exe, extra);
        let (path, user_flag) = if is_root {
            (PathBuf::from("/etc/systemd/system/faro-agentd.service"), false)
        } else {
            let dir = dirs::config_dir()
                .context("no user config dir")?
                .join("systemd/user");
            std::fs::create_dir_all(&dir).ok();
            (dir.join("faro-agentd.service"), true)
        };
        std::fs::write(&path, unit).with_context(|| format!("write {}", path.display()))?;

        let scope = |args: &[&str]| -> Result<()> {
            let mut c = Command::new("systemctl");
            if user_flag {
                c.arg("--user");
            }
            c.args(args);
            let status = c.status().context("run systemctl")?;
            if !status.success() {
                bail!("systemctl {:?} failed", args);
            }
            Ok(())
        };
        scope(&["daemon-reload"])?;
        scope(&["enable", "--now", "faro-agentd.service"])?;

        println!("Installed {} systemd service.", if user_flag { "user" } else { "system" });
        println!("  unit  : {}", path.display());
        println!(
            "  status: systemctl {}status faro-agentd",
            if user_flag { "--user " } else { "" }
        );
        if user_flag {
            println!(
                "  note  : a user service stops at logout unless you enable lingering:\n\
                 \x20         sudo loginctl enable-linger $USER"
            );
        }
        Ok(())
    }

    pub fn uninstall() -> Result<()> {
        let is_root = unsafe { libc_geteuid() } == 0;
        let (path, user_flag) = if is_root {
            (PathBuf::from("/etc/systemd/system/faro-agentd.service"), false)
        } else {
            (
                dirs::config_dir()
                    .context("no user config dir")?
                    .join("systemd/user/faro-agentd.service"),
                true,
            )
        };
        let mut c = Command::new("systemctl");
        if user_flag {
            c.arg("--user");
        }
        let _ = c.args(["disable", "--now", "faro-agentd.service"]).status();
        std::fs::remove_file(&path).ok();
        let mut c = Command::new("systemctl");
        if user_flag {
            c.arg("--user");
        }
        let _ = c.arg("daemon-reload").status();
        println!("Removed faro-agentd systemd service.");
        Ok(())
    }

    fn unit_file(exe: &std::path::Path, extra: &[String]) -> String {
        format!(
            "[Unit]\n\
             Description=Faro Agent daemon (control this machine from Faro)\n\
             After=network-online.target\n\
             Wants=network-online.target\n\n\
             [Service]\n\
             Type=simple\n\
             ExecStart={exe} {args}\n\
             Restart=on-failure\n\
             RestartSec=5\n\n\
             [Install]\n\
             WantedBy=default.target\n",
            exe = exe.display(),
            args = run_args(extra),
        )
    }

    // Avoid a whole `libc` dependency for one call.
    extern "C" {
        fn geteuid() -> u32;
    }
    unsafe fn libc_geteuid() -> u32 {
        geteuid()
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use std::process::Command;

    fn plist_path() -> Result<PathBuf> {
        Ok(dirs::home_dir()
            .context("no home dir")?
            .join("Library/LaunchAgents")
            .join(format!("{LAUNCHD_LABEL}.plist")))
    }

    pub fn install(extra: &[String]) -> Result<()> {
        let exe = exe_path()?;
        let path = plist_path()?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).ok();
        }
        std::fs::write(&path, plist(&exe, extra))
            .with_context(|| format!("write {}", path.display()))?;
        // bootout any prior instance, then bootstrap fresh (idempotent).
        let uid = unsafe { geteuid() };
        let _ = Command::new("launchctl")
            .args(["bootout", &format!("gui/{uid}/{LAUNCHD_LABEL}")])
            .status();
        let status = Command::new("launchctl")
            .args(["bootstrap", &format!("gui/{uid}"), &path.to_string_lossy()])
            .status()
            .context("run launchctl bootstrap")?;
        if !status.success() {
            bail!("launchctl bootstrap failed");
        }
        println!("Installed LaunchAgent {}.", path.display());
        println!("  status: launchctl print gui/{uid}/{LAUNCHD_LABEL}");
        Ok(())
    }

    pub fn uninstall() -> Result<()> {
        let path = plist_path()?;
        let uid = unsafe { geteuid() };
        let _ = Command::new("launchctl")
            .args(["bootout", &format!("gui/{uid}/{LAUNCHD_LABEL}")])
            .status();
        std::fs::remove_file(&path).ok();
        println!("Removed LaunchAgent.");
        Ok(())
    }

    fn plist(exe: &std::path::Path, extra: &[String]) -> String {
        let mut args = String::new();
        args.push_str(&format!("    <string>{}</string>\n", exe.display()));
        args.push_str("    <string>run</string>\n");
        for a in extra {
            args.push_str(&format!("    <string>{a}</string>\n"));
        }
        format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
             <!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \
             \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n\
             <plist version=\"1.0\">\n<dict>\n\
             \x20 <key>Label</key>\n  <string>{LAUNCHD_LABEL}</string>\n\
             \x20 <key>ProgramArguments</key>\n  <array>\n{args}  </array>\n\
             \x20 <key>RunAtLoad</key>\n  <true/>\n\
             \x20 <key>KeepAlive</key>\n  <true/>\n\
             </dict>\n</plist>\n"
        )
    }

    extern "C" {
        fn geteuid() -> u32;
    }
}

#[cfg(target_os = "windows")]
mod windows {
    use super::*;
    use std::process::Command;

    pub fn install(extra: &[String]) -> Result<()> {
        let exe = exe_path()?;
        // A logon Scheduled Task: faro-agentd is a console app, not an SCM
        // service, so `sc create` would be killed for not reporting to the SCM.
        let tr = format!("\"{}\" {}", exe.display(), run_args(extra));
        let status = Command::new("schtasks")
            .args([
                "/create", "/f", "/tn", TASK_NAME, "/sc", "onlogon", "/rl", "limited", "/tr", &tr,
            ])
            .status()
            .context("run schtasks (is it on PATH?)")?;
        if !status.success() {
            bail!("schtasks failed to create the task");
        }
        // Start it now so the user doesn't have to log out/in first.
        let _ = Command::new("schtasks").args(["/run", "/tn", TASK_NAME]).status();
        println!("Installed logon task '{TASK_NAME}'. It starts faro-agentd at every sign-in.");
        println!("  remove: faro-agentd uninstall");
        Ok(())
    }

    pub fn uninstall() -> Result<()> {
        let _ = Command::new("schtasks").args(["/end", "/tn", TASK_NAME]).status();
        let status = Command::new("schtasks")
            .args(["/delete", "/f", "/tn", TASK_NAME])
            .status()
            .context("run schtasks")?;
        if !status.success() {
            bail!("schtasks failed to delete the task (was it installed?)");
        }
        println!("Removed logon task '{TASK_NAME}'.");
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn run_args_joins_extra() {
        assert_eq!(run_args(&[]), "run");
        assert_eq!(
            run_args(&["--read-only".into(), "--port".into(), "9000".into()]),
            "run --read-only --port 9000"
        );
    }
}
