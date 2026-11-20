//! The shared installer against a local HTTP server standing in for GitHub and
//! for a publisher that signs its downloads. The "tool" is the relay example,
//! which answers `--version` with 2099.1.0.

use super::openpgp::test_signer::Signer;
use super::*;
use crate::cloudflared::tests::{http_server, relay_bytes, set_route};
use crate::password_managers::{bw_asset, op_asset, BW_TOOL, OP_TOOL};
use crate::proxy_command::e2e::scratch;

fn zip_of(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let mut out = std::io::Cursor::new(Vec::new());
    {
        let mut zip = zip::ZipWriter::new(&mut out);
        let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        for (name, bytes) in entries {
            zip.start_file(*name, opts).unwrap();
            zip.write_all(bytes).unwrap();
        }
        zip.finish().unwrap();
    }
    out.into_inner()
}

#[test]
fn versions_out_of_cli_output() {
    assert_eq!(plain_version("2.42.0\n").as_deref(), Some("2.42.0"));
    assert_eq!(plain_version("v2026.11.0").as_deref(), Some("2026.11.0"));
    // bw prints set-up chatter before the version on a first run.
    let chatter = "Could not find dir, \"C:\\Users\\x\\AppData\\Roaming\\Bitwarden CLI\"; creating it instead.\n2026.11.0\n";
    assert_eq!(plain_version(chatter).as_deref(), Some("2026.11.0"));
    assert_eq!(plain_version("cloudflared version 2099.1.0 (built 2099-01-01-0000 UTC)").as_deref(), Some("2099.1.0"));
    assert_eq!(plain_version("no version"), None);
    assert_eq!(plain_version("42"), None);
    assert!(is_newer("2.42.0", "2.9.1"), "numeric, not lexical");
    assert!(!is_newer("2026.11.0", "2026.11.0"));
}

#[test]
fn the_newest_stable_release_with_the_prefix_wins() {
    let rel = |tag: &str, draft: bool, pre: bool| {
        serde_json::json!({ "tag_name": tag, "draft": draft, "prerelease": pre, "assets": [] })
    };
    let list = serde_json::json!([
        rel("web-v2026.12.0", false, false),
        rel("cli-v2026.12.0", false, true),
        rel("cli-v2026.13.0", true, false),
        rel("cli-v2026.9.0", false, false),
        rel("cli-v2026.11.0", false, false),
        rel("desktop-v2026.11.5", false, false),
    ]);
    assert_eq!(newest_release(list, "cli-").unwrap().tag_name, "cli-v2026.11.0");
    // `/releases/latest` answers with one object.
    assert_eq!(newest_release(rel("2026.10.4", false, false), "").unwrap().tag_name, "2026.10.4");
    assert!(newest_release(serde_json::json!([rel("web-v1.0", false, false)]), "cli-").is_err());
}

#[test]
fn bitwarden_assets_for_every_platform() {
    let now = [
        "bitwarden-cli-2026.11.0-npm-build.zip",
        "bw-bit-linux-2026.11.0.zip",
        "bw-bit-linux-arm64-2026.11.0.zip",
        "bw-bit-macos-2026.11.0.zip",
        "bw-bit-macos-arm64-2026.11.0.zip",
        "bw-bit-windows-2026.11.0.zip",
        "bw-oss-linux-2026.11.0.zip",
        "bw-oss-windows-2026.11.0.zip",
        "bw_2026.11.0_amd64.snap",
    ];
    assert_eq!(bw_asset("windows", "x86_64", &now).unwrap(), "bw-bit-windows-2026.11.0.zip");
    assert_eq!(bw_asset("windows", "aarch64", &now).unwrap(), "bw-bit-windows-2026.11.0.zip");
    assert_eq!(bw_asset("linux", "x86_64", &now).unwrap(), "bw-bit-linux-2026.11.0.zip");
    assert_eq!(bw_asset("linux", "aarch64", &now).unwrap(), "bw-bit-linux-arm64-2026.11.0.zip");
    assert_eq!(bw_asset("macos", "x86_64", &now).unwrap(), "bw-bit-macos-2026.11.0.zip");
    assert_eq!(bw_asset("macos", "aarch64", &now).unwrap(), "bw-bit-macos-arm64-2026.11.0.zip");
    // Older releases named them without `bit-`.
    let before = ["bw-linux-2026.10.1.zip", "bw-linux-arm64-2026.10.1.zip", "bw-oss-linux-2026.10.1.zip", "bw-windows-2026.10.1.zip"];
    assert_eq!(bw_asset("linux", "x86_64", &before).unwrap(), "bw-linux-2026.10.1.zip");
    assert_eq!(bw_asset("linux", "aarch64", &before).unwrap(), "bw-linux-arm64-2026.10.1.zip");
    assert_eq!(bw_asset("windows", "x86_64", &before).unwrap(), "bw-windows-2026.10.1.zip");
    assert!(bw_asset("macos", "x86_64", &before).is_err());
    assert!(bw_asset("freebsd", "x86_64", &now).is_err());
}

#[test]
fn onepassword_assets_for_every_platform() {
    assert_eq!(op_asset("windows", "x86_64", "2.42.0").unwrap(), "v2.42.0/op_windows_amd64_v2.42.0.zip");
    assert_eq!(op_asset("windows", "aarch64", "2.42.0").unwrap(), "v2.42.0/op_windows_amd64_v2.42.0.zip");
    assert_eq!(op_asset("linux", "aarch64", "2.42.0").unwrap(), "v2.42.0/op_linux_arm64_v2.42.0.zip");
    assert_eq!(op_asset("macos", "aarch64", "2.42.0").unwrap(), "v2.42.0/op_darwin_arm64_v2.42.0.zip");
    assert_eq!(op_asset("macos", "x86_64", "2.42.0").unwrap(), "v2.42.0/op_darwin_amd64_v2.42.0.zip");
    assert!(op_asset("freebsd", "x86_64", "2.42.0").is_err());
    assert!(op_asset(std::env::consts::OS, std::env::consts::ARCH, "1.0").is_ok());
}

// ---- A publisher that signs its downloads (1Password's shape) -------------------

/// Serves `{"version": version}` at /check and `zip` at the URL `op_asset`
/// builds for this machine. Returns an installer pointed at it.
async fn fake_signed(version: &str, zip: Vec<u8>, key: PgpKey) -> Installer {
    let base = http_server(HashMap::new()).await;
    set_route(&base, "/check", serde_json::to_vec(&serde_json::json!({ "available": "1", "version": version })).unwrap());
    if let Ok(path) = op_asset(std::env::consts::OS, std::env::consts::ARCH, version) {
        set_route(&base, &format!("/dl/{path}"), zip);
    }
    Installer::with_urls(&OP_TOOL, &format!("{base}/check"), &format!("{base}/dl"), Some(key))
}

fn signed_zip(signer: &Signer, binary: &[u8]) -> Vec<u8> {
    let exe = exe_name("op");
    zip_of(&[(exe.as_str(), binary), (format!("{exe}.sig").as_str(), &signer.sign(binary))])
}

#[tokio::test]
async fn installs_a_signed_release() {
    let signer = Signer::new();
    let dest = scratch("tool-signed").join("bin").join(exe_name("op"));
    let installer = fake_signed("2099.1.0", signed_zip(&signer, &relay_bytes()), signer.key.clone()).await;
    assert_eq!(installer.latest().await.unwrap().version, "2099.1.0");
    assert_eq!(installer.install(&dest).await.unwrap(), "2099.1.0");
    assert_eq!(std::fs::read(&dest).unwrap(), relay_bytes());
    for leftover in ["part", "download", "old"] {
        assert!(!dest.with_extension(leftover).exists(), "{leftover} left behind");
    }
}

#[tokio::test]
async fn a_badly_signed_or_unsigned_download_is_refused() {
    let dir = scratch("tool-badsig").join("bin");
    let dest = dir.join(exe_name("op"));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(&dest, b"previous copy").unwrap();

    // Signed by someone else.
    let (publisher, impostor) = (Signer::new(), Signer::new());
    let err = fake_signed("2099.1.0", signed_zip(&impostor, &relay_bytes()), publisher.key.clone())
        .await
        .install(&dest)
        .await
        .unwrap_err();
    assert!(err.to_string().contains("failed its signature check"), "{err:#}");

    // Signed, then the binary swapped.
    let exe = exe_name("op");
    let swapped = zip_of(&[(exe.as_str(), b"something else"), (format!("{exe}.sig").as_str(), &publisher.sign(&relay_bytes()))]);
    let err = fake_signed("2099.1.0", swapped, publisher.key.clone()).await.install(&dest).await.unwrap_err();
    assert!(err.to_string().contains("failed its signature check"), "{err:#}");

    // No signature at all.
    let bare = zip_of(&[(exe.as_str(), &relay_bytes())]);
    let err = fake_signed("2099.1.0", bare, publisher.key.clone()).await.install(&dest).await.unwrap_err();
    assert!(err.to_string().contains("carries no signature"), "{err:#}");

    assert_eq!(std::fs::read(&dest).unwrap(), b"previous copy");
    assert!(!dest.with_extension("download").exists() && !dest.with_extension("part").exists());
}

#[tokio::test]
async fn an_odd_version_from_the_update_check_is_refused() {
    let signer = Signer::new();
    for bad in ["../../evil", "2.42.0/../x", ""] {
        let installer = fake_signed(bad, Vec::new(), signer.key.clone()).await;
        let err = installer.latest().await.unwrap_err();
        assert!(err.to_string().contains("unexpected answer from 1Password"), "{bad}: {err:#}");
    }
    let offline = Installer::with_urls(&OP_TOOL, "http://127.0.0.1:1/check", "http://127.0.0.1:1", Some(signer.key));
    assert!(offline.latest().await.unwrap_err().to_string().contains("couldn't reach 1Password"));
}

// ---- GitHub with a tag prefix and a zip (Bitwarden's shape) ----------------------

async fn fake_bw_github(zip: Vec<u8>, digest: Option<String>) -> Installer {
    let base = http_server(HashMap::new()).await;
    let names_now = ["bw-bit-windows-2099.1.0.zip", "bw-bit-linux-2099.1.0.zip", "bw-bit-linux-arm64-2099.1.0.zip", "bw-bit-macos-2099.1.0.zip", "bw-bit-macos-arm64-2099.1.0.zip"];
    let digest = digest.unwrap_or_else(|| format!("sha256:{:x}", Sha256::digest(&zip)));
    set_route(&base, "/asset", zip);
    let assets: Vec<Value> = names_now
        .iter()
        .map(|n| serde_json::json!({ "name": n, "browser_download_url": format!("{base}/asset"), "digest": digest }))
        .collect();
    let list = serde_json::json!([
        { "tag_name": "desktop-v2099.9.0", "assets": [] },
        { "tag_name": "cli-v2099.1.0", "assets": assets },
        { "tag_name": "cli-v2001.1.0", "assets": [] },
    ]);
    set_route(&base, "/releases", serde_json::to_vec(&list).unwrap());
    Installer::with_urls(&BW_TOOL, &format!("{base}/releases"), "", None)
}

#[tokio::test]
async fn installs_a_zipped_release_from_a_shared_repository() {
    let exe = exe_name("bw");
    let zip = zip_of(&[("README.txt", b"hi"), (exe.as_str(), &relay_bytes())]);
    let dest = scratch("tool-bw").join("bin").join(&exe);
    let installer = fake_bw_github(zip.clone(), None).await;
    assert_eq!(installer.install(&dest).await.unwrap(), "2099.1.0");
    assert_eq!(std::fs::read(&dest).unwrap(), relay_bytes());

    let dest = scratch("tool-bw-bad").join("bin").join(&exe);
    let err = fake_bw_github(zip, Some(format!("sha256:{}", "0".repeat(64)))).await.install(&dest).await.unwrap_err();
    assert!(err.to_string().contains("failed its checksum"), "{err:#}");
    assert!(!dest.exists());

    let dest = scratch("tool-bw-empty").join("bin").join(&exe);
    let err = fake_bw_github(zip_of(&[("README.txt", b"hi")]), None).await.install(&dest).await.unwrap_err();
    assert!(err.to_string().contains(&format!("has no {exe}")), "{err:#}");
}

// ---- One tool's manager ------------------------------------------------------------------

static TEST_TOOL: ToolSpec = ToolSpec {
    id: "test-tool",
    name: "Test tool",
    program: "faro-test-tool",
    config_file: "test-tool.json",
    feed: Feed::GitHub { api: "http://127.0.0.1:1/unused", tag_prefix: "cli-", pick: bw_asset },
    parse_version: plain_version,
    find_installed: || None,
    check_custom: |_| Ok(()),
    on_select: |_| {},
};

#[tokio::test]
async fn a_manager_picks_custom_then_its_own_copy_and_reports_updates() {
    let dir = scratch("tool-manager");
    let m = ToolManager::from_dir(&TEST_TOOL, dir.clone());
    let s = m.status().await;
    assert_eq!((s.source, s.id.as_str(), s.name.as_str()), (Source::Missing, "test-tool", "Test tool"));
    assert_eq!(selected("test-tool"), None);

    // Faro's own copy, at an older version than the one published.
    std::fs::create_dir_all(dir.join("bin")).unwrap();
    std::fs::write(m.managed_path(), relay_bytes()).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(m.managed_path(), std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    configure(&TEST_TOOL, &dir);
    assert_eq!(selected("test-tool"), Some(m.managed_path()));
    *m.latest.lock().await = Some("2100.0.0".into());
    let s = m.status().await;
    assert_eq!((s.source, s.version.as_deref(), s.update_available), (Source::Managed, Some("2099.1.0"), true));

    // A custom path must exist and run; then it wins and is remembered.
    assert!(m.set_custom_path(Some(dir.join("nope").display().to_string())).await.unwrap_err().to_string().contains("doesn't exist"));
    let not_a_tool = dir.join("notes.txt");
    std::fs::write(&not_a_tool, "hi").unwrap();
    assert!(m.set_custom_path(Some(not_a_tool.display().to_string())).await.is_err());
    let custom = crate::proxy_command::e2e::relay_exe();
    let s = m.set_custom_path(Some(custom.display().to_string())).await.unwrap();
    assert_eq!(s.source, Source::Custom);
    assert_eq!(selected("test-tool"), Some(custom.clone()));
    assert_eq!(read_config(&TEST_TOOL, &dir).custom_path, Some(custom.display().to_string()));

    // Clearing it goes back to Faro's copy; removing that, to nothing.
    m.set_custom_path(None).await.unwrap();
    assert_eq!(selected("test-tool"), Some(m.managed_path()));
    std::fs::remove_file(m.managed_path()).unwrap();
    configure(&TEST_TOOL, &dir);
    assert_eq!(selected("test-tool"), None);
}

// ---- The real publishers -------------------------------------------------------------

/// Downloads the real 1Password and Bitwarden CLIs (~50 MB each) and checks
/// them the way Settings does: the pinned key, GitHub's digest, a version.
#[tokio::test]
#[ignore = "downloads from 1Password and GitHub"]
async fn live_installs_the_real_op_and_bw() {
    for spec in [&OP_TOOL, &BW_TOOL] {
        let dest = scratch("tool-live").join("bin").join(exe_name(spec.program));
        let installer = Installer::new(spec);
        let latest = installer.latest().await.unwrap();
        let installed = installer.install(&dest).await.unwrap_or_else(|e| panic!("{}: {e:#}", spec.name));
        assert_eq!(installed, latest.version, "{}", spec.name);
        eprintln!("{} {installed} from {}", spec.name, latest.url);
    }
}
