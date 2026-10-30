//! Compress / extract archives and change file ownership (issue #62).
//!
//! Remote SSH sessions run one shell command on the server (`tar`, `zip`,
//! `unzip`, `7z`, `chown`) so nothing round-trips through the client. Local
//! files use the `zip` / `tar` crates; formats those can't read fall back to the
//! system `tar` (bsdtar on Windows and macOS reads .7z/.tar.xz/.tar.bz2 too).
//!
//! Extraction never overwrites: files that already exist at the destination
//! are kept, so "Extract here" can't silently clobber a working tree.

use crate::proc::NoConsoleWindow;
use crate::scp::quote_path as sh_quote;
use anyhow::{anyhow, bail, Context, Result};
use serde::Serialize;
use std::fs::{self, File};
use std::io::{self, BufReader, BufWriter, Write};
use std::path::{Component, Path, PathBuf};

/// What "Compress" can write.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompressFormat {
    Zip,
    TarGz,
    Tar,
    SevenZ,
}

impl CompressFormat {
    pub fn parse(s: &str) -> Result<Self> {
        Ok(match s {
            "zip" => Self::Zip,
            "tar.gz" => Self::TarGz,
            "tar" => Self::Tar,
            "7z" => Self::SevenZ,
            other => bail!("Unknown archive format \"{other}\""),
        })
    }
}

/// What "Extract" recognizes, by file name.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArchiveKind {
    Zip,
    Tar,
    TarGz,
    TarBz2,
    TarXz,
    SevenZ,
}

const SUFFIXES: &[(&str, ArchiveKind)] = &[
    (".tar.gz", ArchiveKind::TarGz),
    (".tgz", ArchiveKind::TarGz),
    (".tar.bz2", ArchiveKind::TarBz2),
    (".tbz2", ArchiveKind::TarBz2),
    (".tbz", ArchiveKind::TarBz2),
    (".tar.xz", ArchiveKind::TarXz),
    (".txz", ArchiveKind::TarXz),
    (".tar", ArchiveKind::Tar),
    (".zip", ArchiveKind::Zip),
    (".7z", ArchiveKind::SevenZ),
];

/// The archive kind and the name without its archive extension
/// ("site.tar.gz" → (TarGz, "site")).
pub fn detect(name: &str) -> Option<(ArchiveKind, &str)> {
    let lower = name.to_ascii_lowercase();
    SUFFIXES.iter().find_map(|(suffix, kind)| {
        lower
            .ends_with(suffix)
            .then(|| (*kind, &name[..name.len() - suffix.len()]))
            .filter(|(_, stem)| !stem.is_empty())
    })
}

/// "Extract to folder" target: the archive's stem, made unique with " 2", " 3"…
pub fn fresh_folder_name(stem: &str, n: usize) -> String {
    if n <= 1 {
        stem.to_string()
    } else {
        format!("{stem} {n}")
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Ownership {
    pub owner: String,
    pub group: String,
}

/// User and group names go into a shell command (quoted, but still): accept
/// the portable POSIX set plus numeric ids, and nothing else.
pub fn valid_account_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && !name.starts_with('-')
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// `owner:group`, `owner`, or `:group` for chown. Empty means "leave as is".
pub fn chown_spec(owner: &str, group: &str) -> Result<String> {
    let (owner, group) = (owner.trim(), group.trim());
    for (label, value) in [("owner", owner), ("group", group)] {
        if !value.is_empty() && !valid_account_name(value) {
            bail!("\"{value}\" isn't a valid {label} name");
        }
    }
    Ok(match (owner.is_empty(), group.is_empty()) {
        (true, true) => bail!("Enter an owner, a group, or both"),
        (false, true) => owner.to_string(),
        (true, false) => format!(":{group}"),
        (false, false) => format!("{owner}:{group}"),
    })
}

/// Add a hint to the usual "you're not root" failure.
pub fn chown_error(stderr: &str) -> String {
    let msg = stderr.trim();
    let msg = if msg.is_empty() { "chown failed" } else { msg };
    if msg.contains("Operation not permitted") || msg.contains("Permission denied") {
        format!("{msg}\nChanging the owner usually needs root. Connect as root, or run chown with sudo in the terminal.")
    } else if msg.contains("invalid user") || msg.contains("invalid group") || msg.contains("unknown user") || msg.contains("unknown group") {
        format!("{msg}\nThat user or group doesn't exist on this machine.")
    } else {
        msg.to_string()
    }
}

// ---------- Remote (SSH) command builders ----------

/// Pick whichever 7-Zip binary the server has.
const SEVEN_Z: &str = "Z=$(command -v 7z || command -v 7zz || command -v 7za) || { echo '7-Zip (7z) is not installed on the server' >&2; exit 127; }";

/// Compress `names` (entries of `parent`) into `out`. Refuses to replace an
/// existing file and removes a half-written archive on failure.
pub fn remote_compress_command(parent: &str, names: &[String], out: &str, format: CompressFormat) -> String {
    let files = names
        .iter()
        .map(|n| sh_quote(&format!("./{n}")))
        .collect::<Vec<_>>()
        .join(" ");
    let (p, o) = (sh_quote(parent), sh_quote(out));
    let build = match format {
        CompressFormat::Zip => format!("cd {p} && zip -r -q -y {o} {files}"),
        CompressFormat::TarGz => format!("tar -czf {o} -C {p} {files}"),
        CompressFormat::Tar => format!("tar -cf {o} -C {p} {files}"),
        CompressFormat::SevenZ => format!("{SEVEN_Z}; cd {p} && \"$Z\" a -bd -y {o} {files} >/dev/null"),
    };
    format!(
        "if [ -e {o} ]; then echo 'An item with that name already exists' >&2; exit 17; fi; ( {build} ) || {{ rc=$?; rm -f {o}; exit $rc; }}"
    )
}

/// Extract `archive` into `dest` (created if missing), keeping existing files.
pub fn remote_extract_command(archive: &str, dest: &str, kind: ArchiveKind) -> String {
    let (a, d) = (sh_quote(archive), sh_quote(dest));
    let run = match kind {
        ArchiveKind::Zip => format!("unzip -q -n {a} -d {d}"),
        ArchiveKind::Tar => format!("tar -xkf {a} -C {d}"),
        ArchiveKind::TarGz => format!("tar -xzkf {a} -C {d}"),
        ArchiveKind::TarBz2 => format!("tar -xjkf {a} -C {d}"),
        ArchiveKind::TarXz => format!("tar -xJkf {a} -C {d}"),
        ArchiveKind::SevenZ => format!("{SEVEN_Z}; \"$Z\" x -bd -y -aos -o{d} {a} >/dev/null"),
    };
    format!("mkdir -p {d} && {run}")
}

/// Turn a failed archive command's stderr into something a person can act on.
pub fn archive_error(stderr: &str, verb: &str) -> String {
    let msg = stderr.trim();
    let msg = if msg.is_empty() { "the command failed" } else { msg };
    let missing = |tool: &str| msg.contains(&format!("{tool}: not found")) || msg.contains(&format!("{tool}: command not found"));
    let hint = if missing("zip") {
        "\nThe zip command isn't installed on the server. Try .tar.gz instead."
    } else if missing("unzip") {
        "\nThe unzip command isn't installed on the server."
    } else if msg.contains("File exists") || msg.contains("Cannot open: File exists") {
        "\nFiles that already existed were kept, not overwritten."
    } else {
        ""
    };
    format!("{verb} failed: {msg}{hint}")
}

/// `stat` the owner and group by name: GNU first, then BSD.
pub fn remote_ownership_command(path: &str) -> String {
    let p = sh_quote(path);
    format!("stat -c '%U:%G' -- {p} 2>/dev/null || stat -f '%Su:%Sg' -- {p}")
}

pub fn parse_ownership(stdout: &str) -> Result<Ownership> {
    let line = stdout.lines().find(|l| !l.trim().is_empty()).unwrap_or("").trim();
    let (owner, group) = line
        .split_once(':')
        .ok_or_else(|| anyhow!("Couldn't read the owner of this item"))?;
    Ok(Ownership { owner: owner.to_string(), group: group.to_string() })
}

pub fn remote_chown_command(path: &str, spec: &str, recursive: bool) -> String {
    format!(
        "chown {}-- {} {}",
        if recursive { "-R " } else { "" },
        sh_quote(spec),
        sh_quote(path)
    )
}

// ---------- Local ----------

/// Compress `sources` (siblings) into a new archive at `out`.
pub fn local_compress(sources: &[PathBuf], out: &Path, format: CompressFormat) -> Result<()> {
    if format == CompressFormat::SevenZ {
        bail!("7-Zip archives can only be created on a server for now. Choose .zip or .tar.gz.");
    }
    let file = File::options()
        .write(true)
        .create_new(true)
        .open(out)
        .with_context(|| format!("Couldn't create {}", out.display()))?;
    let result = (|| -> Result<()> {
        let writer = BufWriter::new(file);
        match format {
            CompressFormat::Zip => write_zip(sources, writer),
            CompressFormat::TarGz => {
                let gz = flate2::write::GzEncoder::new(writer, flate2::Compression::default());
                write_tar(sources, gz)?.finish()?.flush()?;
                Ok(())
            }
            CompressFormat::Tar => {
                write_tar(sources, writer)?.flush()?;
                Ok(())
            }
            CompressFormat::SevenZ => unreachable!(),
        }
    })();
    if result.is_err() {
        let _ = fs::remove_file(out);
    }
    result
}

fn entry_name(path: &Path) -> Result<String> {
    path.file_name()
        .and_then(|n| n.to_str())
        .map(str::to_owned)
        .ok_or_else(|| anyhow!("{} has no usable name", path.display()))
}

fn write_tar<W: Write>(sources: &[PathBuf], w: W) -> Result<W> {
    let mut tar = tar::Builder::new(w);
    tar.follow_symlinks(false);
    for src in sources {
        let name = entry_name(src)?;
        if fs::symlink_metadata(src)?.is_dir() {
            tar.append_dir_all(&name, src)
        } else {
            tar.append_path_with_name(src, &name)
        }
        .with_context(|| format!("Couldn't add {}", src.display()))?;
    }
    Ok(tar.into_inner()?)
}

fn write_zip<W: Write + io::Seek>(sources: &[PathBuf], w: W) -> Result<()> {
    use zip::write::SimpleFileOptions;
    let mut zip = zip::ZipWriter::new(w);
    let base = SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .large_file(true);
    let mut stack: Vec<(PathBuf, String)> = Vec::new();
    for src in sources {
        stack.push((src.clone(), entry_name(src)?));
    }
    while let Some((path, name)) = stack.pop() {
        let meta = fs::metadata(&path).with_context(|| format!("Couldn't read {}", path.display()))?;
        let opts = with_unix_mode(base, &meta);
        if meta.is_dir() {
            zip.add_directory(format!("{name}/"), opts)?;
            // A link to a folder is stored as an empty folder so a link back up
            // the tree can't loop forever.
            if fs::symlink_metadata(&path)?.file_type().is_symlink() {
                continue;
            }
            let mut children = fs::read_dir(&path)?.collect::<io::Result<Vec<_>>>()?;
            children.sort_by_key(|c| std::cmp::Reverse(c.file_name()));
            for child in children {
                let child_name = child
                    .file_name()
                    .into_string()
                    .map_err(|n| anyhow!("{:?} has a name zip can't store", n))?;
                stack.push((child.path(), format!("{name}/{child_name}")));
            }
        } else {
            zip.start_file(name, opts)?;
            io::copy(&mut File::open(&path)?, &mut zip)?;
        }
    }
    zip.finish()?;
    Ok(())
}

#[cfg(unix)]
fn with_unix_mode(o: zip::write::SimpleFileOptions, meta: &fs::Metadata) -> zip::write::SimpleFileOptions {
    use std::os::unix::fs::PermissionsExt;
    o.unix_permissions(meta.permissions().mode() & 0o7777)
}

#[cfg(not(unix))]
fn with_unix_mode(o: zip::write::SimpleFileOptions, _meta: &fs::Metadata) -> zip::write::SimpleFileOptions {
    o
}

/// Extract `archive` into `dest` (created if missing). Existing files are kept.
pub fn local_extract(archive: &Path, dest: &Path, kind: ArchiveKind) -> Result<()> {
    fs::create_dir_all(dest).with_context(|| format!("Couldn't create {}", dest.display()))?;
    match kind {
        ArchiveKind::Zip => extract_zip(archive, dest),
        ArchiveKind::Tar => extract_tar(BufReader::new(File::open(archive)?), dest),
        ArchiveKind::TarGz => extract_tar(flate2::read::GzDecoder::new(BufReader::new(File::open(archive)?)), dest),
        ArchiveKind::TarBz2 | ArchiveKind::TarXz | ArchiveKind::SevenZ => system_tar_extract(archive, dest),
    }
}

/// A member path that stays inside the destination, or None.
fn safe_relative(path: &Path) -> Option<PathBuf> {
    let mut out = PathBuf::new();
    for c in path.components() {
        match c {
            Component::Normal(p) => out.push(p),
            Component::CurDir => {}
            _ => return None,
        }
    }
    (!out.as_os_str().is_empty()).then_some(out)
}

fn extract_zip(archive: &Path, dest: &Path) -> Result<()> {
    let mut zip = zip::ZipArchive::new(BufReader::new(File::open(archive)?)).context("Not a readable zip archive")?;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i)?;
        let Some(rel) = entry.enclosed_name().and_then(|p| safe_relative(&p)) else {
            bail!("The archive has an unsafe path: {}", entry.name());
        };
        let target = dest.join(rel);
        if entry.is_dir() {
            fs::create_dir_all(&target)?;
            continue;
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut out = match File::options().write(true).create_new(true).open(&target) {
            Ok(f) => f,
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e).with_context(|| format!("Couldn't write {}", target.display())),
        };
        io::copy(&mut entry, &mut out)?;
        #[cfg(unix)]
        if let Some(mode) = entry.unix_mode() {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&target, fs::Permissions::from_mode(mode & 0o777));
        }
    }
    Ok(())
}

fn extract_tar<R: io::Read>(reader: R, dest: &Path) -> Result<()> {
    let mut tar = tar::Archive::new(reader);
    tar.set_overwrite(false);
    for entry in tar.entries().context("Not a readable tar archive")? {
        let mut entry = entry?;
        let path = entry.path()?.into_owned();
        let Some(rel) = safe_relative(&path) else {
            bail!("The archive has an unsafe path: {}", path.display());
        };
        let target = dest.join(&rel);
        if fs::symlink_metadata(&target).is_ok_and(|m| !m.is_dir()) {
            continue;
        }
        entry
            .unpack_in(dest)
            .with_context(|| format!("Couldn't extract {}", rel.display()))?;
    }
    Ok(())
}

/// .tar.bz2 / .tar.xz / .7z locally: hand off to the system `tar`, which is
/// bsdtar on Windows 10+ and macOS (reads all three); GNU tar on Linux reads
/// the first two.
fn system_tar_extract(archive: &Path, dest: &Path) -> Result<()> {
    let out = std::process::Command::new("tar")
        .arg("-xkf")
        .arg(archive)
        .arg("-C")
        .arg(dest)
        .no_console_window()
        .output()
        .context("This format needs the system tar command, which wasn't found")?;
    if !out.status.success() {
        bail!(archive_error(&String::from_utf8_lossy(&out.stderr), "Extract"));
    }
    Ok(())
}

#[cfg(unix)]
pub fn local_ownership(path: &Path) -> Result<Ownership> {
    let out = std::process::Command::new("sh")
        .arg("-c")
        .arg(remote_ownership_command(&path.to_string_lossy()))
        .output()?;
    parse_ownership(&String::from_utf8_lossy(&out.stdout))
}

#[cfg(not(unix))]
pub fn local_ownership(_path: &Path) -> Result<Ownership> {
    bail!("Owner and group aren't available for local files on Windows")
}

#[cfg(unix)]
pub fn local_chown(path: &Path, spec: &str, recursive: bool) -> Result<()> {
    let mut cmd = std::process::Command::new("chown");
    if recursive {
        cmd.arg("-R");
    }
    let out = cmd.arg("--").arg(spec).arg(path).output()?;
    if !out.status.success() {
        bail!(chown_error(&String::from_utf8_lossy(&out.stderr)));
    }
    Ok(())
}

#[cfg(not(unix))]
pub fn local_chown(_path: &Path, _spec: &str, _recursive: bool) -> Result<()> {
    bail!("Changing the owner isn't supported for local files on Windows")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_archives_and_stems() {
        assert_eq!(detect("site.tar.gz"), Some((ArchiveKind::TarGz, "site")));
        assert_eq!(detect("Backup.TGZ"), Some((ArchiveKind::TarGz, "Backup")));
        assert_eq!(detect("a.b.zip"), Some((ArchiveKind::Zip, "a.b")));
        assert_eq!(detect("x.tar.xz"), Some((ArchiveKind::TarXz, "x")));
        assert_eq!(detect("x.7z"), Some((ArchiveKind::SevenZ, "x")));
        assert_eq!(detect("notes.gz"), None);
        assert_eq!(detect(".zip"), None);
    }

    #[test]
    fn chown_spec_accepts_names_and_rejects_shell() {
        assert_eq!(chown_spec("www-data", "www-data").unwrap(), "www-data:www-data");
        assert_eq!(chown_spec(" root ", "").unwrap(), "root");
        assert_eq!(chown_spec("", "staff").unwrap(), ":staff");
        assert_eq!(chown_spec("1000", "1000").unwrap(), "1000:1000");
        assert!(chown_spec("", "").is_err());
        assert!(chown_spec("root;rm", "").is_err());
        assert!(chown_spec("-R", "").is_err());
        assert!(chown_spec("a b", "").is_err());
    }

    #[test]
    fn remote_commands_quote_every_path() {
        let cmd = remote_compress_command("/srv/my site", &["a b".into(), "-x".into()], "/srv/my site/out.zip", CompressFormat::Zip);
        assert!(cmd.contains("cd '/srv/my site' && zip -r -q -y '/srv/my site/out.zip' './a b' './-x'"));
        assert!(cmd.starts_with("if [ -e '/srv/my site/out.zip' ]"));
        let cmd = remote_extract_command("/a/it's.tar.gz", "/a/it", ArchiveKind::TarGz);
        assert_eq!(cmd, r"mkdir -p '/a/it' && tar -xzkf '/a/it'\''s.tar.gz' -C '/a/it'");
        assert_eq!(remote_chown_command("/var/www", "www-data:www-data", true), "chown -R -- 'www-data:www-data' '/var/www'");
    }

    #[test]
    fn parses_stat_output() {
        assert_eq!(parse_ownership("root:www-data\n").unwrap(), Ownership { owner: "root".into(), group: "www-data".into() });
        assert!(parse_ownership("").is_err());
    }

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("faro-archive-test-{tag}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn fixture(root: &Path) -> Vec<PathBuf> {
        fs::create_dir_all(root.join("site/css")).unwrap();
        fs::write(root.join("site/index.html"), "<h1>hi</h1>").unwrap();
        fs::write(root.join("site/css/app.css"), "body{}").unwrap();
        fs::write(root.join("notes.txt"), "remember").unwrap();
        vec![root.join("site"), root.join("notes.txt")]
    }

    #[test]
    fn local_round_trip_every_writable_format() {
        for (format, ext, kind) in [
            (CompressFormat::Zip, "zip", ArchiveKind::Zip),
            (CompressFormat::TarGz, "tar.gz", ArchiveKind::TarGz),
            (CompressFormat::Tar, "tar", ArchiveKind::Tar),
        ] {
            let root = scratch(ext);
            let sources = fixture(&root);
            let out = root.join(format!("bundle.{ext}"));
            local_compress(&sources, &out, format).unwrap();
            assert!(local_compress(&sources, &out, format).is_err(), "must not replace {ext}");

            let dest = root.join("out");
            local_extract(&out, &dest, kind).unwrap();
            assert_eq!(fs::read_to_string(dest.join("site/css/app.css")).unwrap(), "body{}");
            assert_eq!(fs::read_to_string(dest.join("notes.txt")).unwrap(), "remember");

            // A second extract keeps what's already there.
            fs::write(dest.join("notes.txt"), "edited").unwrap();
            local_extract(&out, &dest, kind).unwrap();
            assert_eq!(fs::read_to_string(dest.join("notes.txt")).unwrap(), "edited");
            fs::remove_dir_all(&root).unwrap();
        }
    }

    #[test]
    fn zip_with_escaping_path_is_refused() {
        let root = scratch("slip");
        let out = root.join("evil.zip");
        let mut zip = zip::ZipWriter::new(File::create(&out).unwrap());
        zip.start_file("../escape.txt", zip::write::SimpleFileOptions::default()).unwrap();
        zip.write_all(b"x").unwrap();
        zip.finish().unwrap();
        assert!(local_extract(&out, &root.join("dest"), ArchiveKind::Zip).is_err());
        assert!(!root.join("escape.txt").exists());
        fs::remove_dir_all(&root).unwrap();
    }
}
