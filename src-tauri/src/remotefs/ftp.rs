use super::{Capabilities, ChangeSignal, DirEntry, FileKind, RemoteFs};
use crate::session::FtpSession;
use anyhow::{anyhow, Context, Result};
use async_trait::async_trait;
use std::sync::Arc;
use suppaftp::list::{File as FtpFile, PosixPexQuery};

pub struct FtpFs {
    session: Arc<FtpSession>,
}

impl FtpFs {
    pub fn new(session: Arc<FtpSession>) -> Self {
        Self { session }
    }
}

fn join(base: &str, name: &str) -> String {
    if base.is_empty() || base == "/" {
        format!("/{}", name.trim_start_matches('/'))
    } else {
        format!("{}/{}", base.trim_end_matches('/'), name.trim_start_matches('/'))
    }
}

fn entry_from_listing(parent: &str, line: &str) -> Option<DirEntry> {
    // Unix-style `ls -l` lines from most daemons, then IIS's MS-DOS format.
    // Only the Unix form carries permissions; DOS lines get no mode rather
    // than suppaftp's placeholder rwxrwxrwx.
    let (f, posix) = match FtpFile::from_posix_line(line) {
        Ok(f) => (f, true),
        Err(_) => (FtpFile::from_dos_line(line).ok()?, false),
    };
    let name = f.name().to_string();
    if name == "." || name == ".." {
        return None;
    }
    let kind = if f.is_directory() {
        FileKind::Directory
    } else if f.is_symlink() {
        FileKind::Symlink
    } else if f.is_file() {
        FileKind::File
    } else {
        FileKind::Other
    };
    let path = join(parent, &name);
    let modified = f
        .modified()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .ok();
    let mode = posix.then(|| posix_mode(&f));
    Some(DirEntry {
        name,
        path,
        kind,
        size: f.size() as u64,
        modified,
        mode,
        etag: None,
    })
}

fn posix_mode(f: &FtpFile) -> u32 {
    [
        (6, PosixPexQuery::Owner),
        (3, PosixPexQuery::Group),
        (0, PosixPexQuery::Others),
    ]
    .into_iter()
    .fold(0, |mode, (shift, who)| {
        let bits = (f.can_read(who) as u32) << 2
            | (f.can_write(who) as u32) << 1
            | f.can_execute(who) as u32;
        mode | bits << shift
    })
}

/// Parse one MLSD line (RFC 3659): `fact=value;fact=value; name`.
///
/// Unlike `LIST`, MLSD is machine-readable: exact UTC timestamps to the
/// second, unambiguous types, and (on Unix daemons) real permission bits.
/// suppaftp ships a parser, but it rejects whole entries on facts real servers
/// send (Pure-FTPd's 4-digit `unix.mode`, fractional `modify`, the
/// `OS.unix=slink:` type, a `;` in the name), so files silently go missing.
/// This one skips what it doesn't understand instead.
fn entry_from_mlsd(parent: &str, line: &str) -> Option<DirEntry> {
    // Facts end at the first space; the rest is the name, verbatim (it may
    // contain spaces, `;` or `=`).
    let (facts, name) = line.split_once(' ')?;
    if name.is_empty() || name == "." || name == ".." {
        return None;
    }
    let mut kind = FileKind::File;
    let mut size = 0u64;
    let mut modified = None;
    let mut mode = None;
    for fact in facts.split(';') {
        let Some((key, value)) = fact.split_once('=') else {
            continue;
        };
        match key.to_ascii_lowercase().as_str() {
            "type" => {
                let v = value.to_ascii_lowercase();
                kind = match v.as_str() {
                    "file" => FileKind::File,
                    "dir" => FileKind::Directory,
                    // The listed directory itself and its parent.
                    "cdir" | "pdir" => return None,
                    _ if v.starts_with("os.unix=slink") || v.starts_with("os.unix=symlink") => {
                        FileKind::Symlink
                    }
                    _ => FileKind::Other,
                };
            }
            // `sizd` is the directory-size variant some servers send.
            "size" | "sizd" => size = value.parse().unwrap_or(0),
            "modify" => modified = parse_mlsd_time(value),
            "unix.mode" => mode = u32::from_str_radix(value, 8).ok().map(|m| m & 0o7777),
            _ => {}
        }
    }
    Some(DirEntry {
        name: name.to_string(),
        path: join(parent, name),
        kind,
        size,
        modified,
        mode,
        etag: None,
    })
}

/// `YYYYMMDDHHMMSS[.sss]`, always UTC, to unix seconds.
fn parse_mlsd_time(v: &str) -> Option<i64> {
    let digits = v.get(..14)?;
    if !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let n = |r: std::ops::Range<usize>| digits[r].parse::<i64>().unwrap_or(0);
    let (y, mo, d) = (n(0..4), n(4..6), n(6..8));
    let (h, mi, s) = (n(8..10), n(10..12), n(12..14));
    let leap = y % 4 == 0 && (y % 100 != 0 || y % 400 == 0);
    let max_day = match mo {
        2 if leap => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        _ => return None,
    };
    // Second 60 is RFC 3659's leap second; it lands on the next minute.
    if !(1..=max_day).contains(&d) || h > 23 || mi > 59 || s > 60 {
        return None;
    }
    // Days from the civil date (Howard Hinnant's algorithm).
    let y = if mo <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * ((mo + 9) % 12) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(days * 86_400 + h * 3_600 + mi * 60 + s)
}

/// List a directory: MLSD when the server advertises it (exact metadata),
/// otherwise — or if MLSD fails — `LIST -a`.
fn list_entries(
    stream: &mut crate::session::ftp::FtpStreamKind,
    dir: &str,
    use_mlsd: bool,
) -> Result<Vec<DirEntry>> {
    let target = if dir.is_empty() { "." } else { dir };
    if use_mlsd {
        if let Ok(lines) = stream.mlsd(target) {
            return Ok(lines.iter().filter_map(|l| entry_from_mlsd(dir, l)).collect());
        }
    }
    Ok(list_lines(stream, target)?
        .iter()
        .filter_map(|l| entry_from_listing(dir, l))
        .collect())
}

/// Issue a directory listing that includes dotfiles.
///
/// Plain `LIST` runs the server's `ls` without `-a`, so `.htaccess`, `.env` and
/// every other dotfile are simply absent from the listing — the file is there
/// and downloadable by name, but nothing that walks a directory can see it. That
/// silence is worse than an error: a tree walk (recursive delete, sync, search)
/// quietly skips them.
///
/// So ask for `LIST -a` and fall back to a bare `LIST` when the server rejects
/// the flag (IIS and a few others take the argument as a literal path). Servers
/// that already include dotfiles are unaffected — `-a` is a no-op there.
fn list_lines(
    stream: &mut crate::session::ftp::FtpStreamKind,
    target: &str,
) -> Result<Vec<String>> {
    match stream.list(Some(&format!("-a {target}"))) {
        Ok(lines) => Ok(lines),
        Err(_) => stream
            .list(Some(target))
            .with_context(|| format!("FTP LIST {target}")),
    }
}

#[async_trait]
impl RemoteFs for FtpFs {
    async fn list_dir(&self, path: &str) -> Result<Vec<DirEntry>> {
        let path = path.to_string();
        let use_mlsd = self.session.supports_mlsd();
        self.session
            .with_stream(move |stream| list_entries(stream, &path, use_mlsd))
            .await
    }

    async fn rename(&self, from: &str, to: &str) -> Result<()> {
        let from = from.to_string();
        let to = to.to_string();
        self.session
            .with_stream(move |stream| {
                stream
                    .rename(&from, &to)
                    .with_context(|| format!("FTP RNFR/RNTO {from} -> {to}"))?;
                Ok(())
            })
            .await
    }

    async fn delete(&self, path: &str, recursive: bool) -> Result<()> {
        // The FTP protocol distinguishes file deletion (DELE) from directory
        // deletion (RMD), and has no native recursive variant. We probe the
        // type via a CWD trick: if we can change into it, it's a directory.
        let path = path.to_string();
        if recursive {
            // Recursive: walk children using a stack of (dir, listing-line)
            // pairs we collect by repeatedly issuing LIST.
            delete_recursive(self.session.clone(), path).await
        } else {
            self.session
                .with_stream(move |stream| {
                    // Try file delete first; if the server says it's a directory,
                    // fall back to RMD. Many servers return distinct codes.
                    match stream.rm(&path) {
                        Ok(()) => Ok(()),
                        Err(_) => stream
                            .rmdir(&path)
                            .with_context(|| format!("FTP RMD/DELE {path}")),
                    }
                })
                .await
        }
    }

    async fn create_dir(&self, path: &str) -> Result<()> {
        let path = path.to_string();
        self.session
            .with_stream(move |stream| {
                stream
                    .mkdir(&path)
                    .with_context(|| format!("FTP MKD {path}"))?;
                Ok(())
            })
            .await
    }

    async fn chmod(&self, path: &str, mode: u32) -> Result<()> {
        // Standard FTP has no permission command. Most Unix FTP servers
        // accept `SITE CHMOD <oct> <path>` as a server extension; we try it
        // and surface the server's error if it isn't supported.
        let path = path.to_string();
        self.session
            .with_stream(move |stream| {
                let cmd = format!("SITE CHMOD {:o} {}", mode, path);
                stream
                    .site(&cmd)
                    .with_context(|| format!("FTP {cmd}"))?;
                Ok(())
            })
            .await
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            can_chmod: true, // best-effort via SITE CHMOD
            can_symlink: false,
            can_rename: true,
            has_directories: true,
            has_shell: false,
            has_commands: false,
            change_signal: ChangeSignal::MtimeSize,
        }
    }
}

/// Walk an FTP tree breadth-first and delete leaves then parents.
async fn delete_recursive(session: Arc<FtpSession>, root: String) -> Result<()> {
    // Collect a list of (full_path, is_dir) entries, deepest-last.
    let use_mlsd = session.supports_mlsd();
    let to_delete: Vec<(String, bool)> = session
        .with_stream({
            let root = root.clone();
            move |stream| {
                let mut stack = vec![root.clone()];
                let mut out = Vec::new();
                while let Some(d) = stack.pop() {
                    // MLSD / `LIST -a`, so a directory holding only dotfiles
                    // isn't reported as empty and left behind by the RMD pass.
                    let listing = list_entries(stream, &d, use_mlsd).unwrap_or_default();
                    for entry in listing {
                        match entry.kind {
                            FileKind::Directory => {
                                stack.push(entry.path.clone());
                                out.push((entry.path, true));
                            }
                            _ => out.push((entry.path, false)),
                        }
                    }
                }
                Ok::<_, anyhow::Error>(out)
            }
        })
        .await?;

    session
        .with_stream(move |stream| {
            for (p, is_dir) in to_delete.iter().rev() {
                let res = if *is_dir { stream.rmdir(p) } else { stream.rm(p) };
                res.with_context(|| format!("FTP delete {p}"))?;
            }
            stream
                .rmdir(&root)
                .with_context(|| format!("FTP RMD {root}"))?;
            Ok(())
        })
        .await
}

/// Helper to surface "unsupported" errors uniformly. Kept private to this
/// module; callers should rely on capabilities() advertising the truth.
#[allow(dead_code)]
fn unsupported(action: &str) -> anyhow::Error {
    anyhow!("FTP backend does not support {action}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_mlsd_lines() {
        let e = entry_from_mlsd(
            "/www",
            "type=file;size=1234;modify=20240102030405.123;UNIX.mode=0644;unix.owner=1000; my; file=1.txt",
        )
        .unwrap();
        assert_eq!(e.name, "my; file=1.txt");
        assert_eq!(e.path, "/www/my; file=1.txt");
        assert_eq!(e.kind, FileKind::File);
        assert_eq!(e.size, 1234);
        assert_eq!(e.modified, Some(1_704_164_645)); // 2024-01-02T03:04:05Z
        assert_eq!(e.mode, Some(0o644));

        let d = entry_from_mlsd("/", "Type=dir;Modify=19991231235959; sub").unwrap();
        assert_eq!((d.kind, d.path.as_str()), (FileKind::Directory, "/sub"));
        assert_eq!(d.modified, Some(946_684_799));

        let l = entry_from_mlsd("/", "type=OS.unix=slink:/etc;unix.mode=777; link").unwrap();
        assert_eq!(l.kind, FileKind::Symlink);

        assert!(entry_from_mlsd("/", "type=cdir;modify=20240101000000; /www").is_none());

        // Impossible dates are dropped rather than normalised into another day.
        assert_eq!(parse_mlsd_time("20240231000000"), None);
        assert_eq!(parse_mlsd_time("20230229000000"), None);
        assert_eq!(parse_mlsd_time("20240229120000"), Some(1_709_208_000));
        assert_eq!(parse_mlsd_time("20241301000000"), None);
        assert!(entry_from_mlsd("/", "type=pdir; ..").is_none());
    }

    #[test]
    fn list_lines_carry_posix_mode() {
        let e = entry_from_listing("/", "-rwxr-x--- 1 user group 42 Jan  1  2024 run.sh").unwrap();
        assert_eq!(e.mode, Some(0o750));
        let dos = entry_from_listing("/", "01-16-24  09:30AM       <DIR>          Logs").unwrap();
        assert_eq!((dos.kind, dos.mode), (FileKind::Directory, None));
    }
}
