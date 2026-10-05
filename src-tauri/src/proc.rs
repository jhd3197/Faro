//! Child-process helpers. Faro is a GUI-subsystem app on Windows, so every
//! console program it spawns (`where`, `faro-cli`, `cmd`, …) would otherwise
//! get its own console window — a visible flash on each status check.

/// `CREATE_NO_WINDOW`: run a console child without allocating a window.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Hide the console window a spawned console program would open on Windows.
/// No-op elsewhere.
pub(crate) trait NoConsoleWindow {
    fn no_console_window(&mut self) -> &mut Self;
}

impl NoConsoleWindow for std::process::Command {
    fn no_console_window(&mut self) -> &mut Self {
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            self.creation_flags(CREATE_NO_WINDOW);
        }
        self
    }
}

impl NoConsoleWindow for tokio::process::Command {
    fn no_console_window(&mut self) -> &mut Self {
        #[cfg(windows)]
        self.creation_flags(CREATE_NO_WINDOW);
        self
    }
}

/// Open `url` in the user's default browser (the OS URL handler).
pub(crate) fn open_in_browser(url: &str) -> anyhow::Result<()> {
    use anyhow::Context;
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = std::process::Command::new("rundll32");
        c.args(["url.dll,FileProtocolHandler", url]);
        c
    };
    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = std::process::Command::new("open");
        c.arg(url);
        c
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut cmd = {
        let mut c = std::process::Command::new("xdg-open");
        c.arg(url);
        c
    };
    cmd.no_console_window()
        .spawn()
        .context("open the system browser")?;
    Ok(())
}
