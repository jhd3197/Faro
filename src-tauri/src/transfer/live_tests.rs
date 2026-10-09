//! Live checks against real servers (Plan 24 verification). Ignored by
//! default; start the servers, then for example:
//!
//! ```text
//! FARO_LIVE_SFTP=127.0.0.1:2223:faro:farotest \
//! FARO_LIVE_S3=http://127.0.0.1:9001:faro-test:faroadmin:farosecret \
//! FARO_LIVE_AZURE=http://127.0.0.1:10000/devstoreaccount1:faro-test \
//! FARO_LIVE_HTTP=http://127.0.0.1:8089/big.bin \
//! FARO_LIVE_FTP=127.0.0.1:2121:faro:farotest \
//! cargo test -p faro --lib transfer::live_tests -- --ignored --nocapture --test-threads 1
//! ```
//!
//! The S3 bucket / Azure container must already exist. Each test drives
//! the real runner (`run_job`) the way the app does, minus
//! the UI, and checks the bytes on both ends.

use super::*;
use crate::profiles::{AuthMethod, ConnectionProfile};
use sha2::{Digest, Sha256};

fn env(name: &str) -> Option<Vec<String>> {
    let v = std::env::var(name).ok()?;
    // `http://host:port/...` keeps its scheme colon.
    let (scheme, rest) = match v.split_once("://") {
        Some((s, r)) => (Some(s.to_string()), r.to_string()),
        None => (None, v),
    };
    let mut parts: Vec<String> = rest.split(':').map(str::to_string).collect();
    if let Some(s) = scheme {
        // Re-join "host" and "port/path" for URLs.
        let host = parts.remove(0);
        let port = parts.remove(0);
        parts.insert(0, format!("{s}://{host}:{port}"));
    }
    Some(parts)
}

fn profile(protocol: &str, host: &str, port: u16, user: &str, pass: &str) -> ConnectionProfile {
    ConnectionProfile {
        id: format!("live-{protocol}"),
        name: format!("live {protocol}"),
        protocol: protocol.into(),
        host: host.into(),
        port,
        username: user.into(),
        auth: AuthMethod::Password {
            password: pass.into(),
        },
        default_remote_path: None,
        color: None,
        auto_connect: None,
        bucket: None,
        region: None,
        endpoint: None,
        account: None,
        agent_key: None,
        group: None,
        sort_order: None,
        icon: None,
        jump_host: None,
        jump_port: None,
        jump_username: None,
        ftp_encoding: None,
        ftp_active_mode: None,
        ftp_max_connections: None,
        ftp_segments: None,
    }
}

struct AcceptAll;

#[async_trait::async_trait]
impl crate::session::HostKeyVerifier for AcceptAll {
    async fn decide(
        &self,
        _host: &str,
        _port: u16,
        _key_type: &str,
        _fingerprint: &str,
        _stored: Option<&str>,
        _kind: crate::session::HostPromptKind,
    ) -> std::result::Result<crate::session::HostDecision, russh::Error> {
        Ok(crate::session::HostDecision::Accept)
    }
}

async fn sftp_session() -> Option<Arc<Session>> {
    let v = env("FARO_LIVE_SFTP")?;
    let p = profile("sftp", &v[0], v[1].parse().unwrap(), &v[2], &v[3]);
    let conn = crate::session::ssh_connect(
        &p,
        Arc::new(AcceptAll),
        Arc::new(crate::session::RejectAuthPrompter),
    )
    .await
    .expect("ssh connect");
    Some(Arc::new(Session::Ssh(Arc::new(SshSession::new(p, conn.handle)))))
}

async fn ftp_session() -> Option<Arc<Session>> {
    let v = env("FARO_LIVE_FTP")?;
    let p = profile("ftp", &v[0], v[1].parse().unwrap(), &v[2], &v[3]);
    let s = crate::session::ftp::ftp_connect(&p, Arc::new(AcceptAll))
        .await
        .expect("ftp connect");
    Some(Arc::new(Session::Ftp(Arc::new(s))))
}

async fn object_session(var: &str) -> Option<Arc<Session>> {
    let v = env(var)?;
    let mut p = if var == "FARO_LIVE_S3" {
        let mut p = profile("s3", "", 0, &v[2], &v[3]);
        p.bucket = Some(v[1].clone());
        p.endpoint = Some(v[0].clone());
        p
    } else {
        // Azurite's well-known development account.
        let mut p = profile(
            "azure",
            "",
            0,
            "devstoreaccount1",
            "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==",
        );
        p.bucket = Some(v[1].clone());
        p.endpoint = Some(v[0].clone());
        p
    };
    p.region = Some("us-east-1".into());
    let s = crate::session::object::object_connect(&p).await.expect("object connect");
    Some(Arc::new(Session::Object(Arc::new(s))))
}

fn scratch(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("faro-live-{tag}-{}", Uuid::new_v4().simple()));
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn sha_file(p: &Path) -> String {
    let mut h = Sha256::new();
    let mut f = std::fs::File::open(p).unwrap();
    std::io::copy(&mut f, &mut h).unwrap();
    format!("{:x}", h.finalize())
}

fn row(id: &str, kind: TransferKind, src: &str, dst: &str, size: u64) -> Transfer {
    Transfer {
        id: id.into(),
        kind,
        source: src.into(),
        destination: dst.into(),
        size,
        transferred: 0,
        status: TransferStatus::Queued,
        error: None,
        retry_attempt: None,
        delta: None,
        started_at: 0,
        bytes_per_sec: None,
        eta_secs: None,
        segments: None,
        stalled: false,
        notice: None,
        restored: false,
    }
}

/// Run one job through the real runner to completion; returns the final
/// row, the wall time, and the most parallel segments seen.
async fn run(mgr: &Arc<TransferManager>, t: Transfer, job: RetryInfo) -> (Transfer, Duration, usize) {
    let id = t.id.clone();
    mgr.insert(t).await;
    mgr.pauses.lock().await.insert(id.clone(), PauseGate::new());
    mgr.waiting.lock().await.push_back(id.clone());
    let started = Instant::now();
    let peak = Arc::new(AtomicUsize::new(0));
    let watch = {
        let mgr = Arc::clone(mgr);
        let id = id.clone();
        let peak = peak.clone();
        tokio::spawn(async move {
            loop {
                let l = mgr.live(&id);
                peak.fetch_max(l.segments.load(Ordering::Relaxed), Ordering::Relaxed);
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        })
    };
    run_job(Arc::clone(mgr), id.clone(), job).await;
    watch.abort();
    (mgr.get(&id).await.unwrap(), started.elapsed(), peak.load(Ordering::Relaxed))
}

fn mbps(bytes: u64, d: Duration) -> f64 {
    bytes as f64 / 1_048_576.0 / d.as_secs_f64()
}

/// Download with the speed capped until the driver has split the file into
/// parallel ranges, then uncapped. Local servers are so fast that a whole
/// file is never worth splitting (`min_split` = 6 s of per-worker work);
/// starting slow makes the split observable.
async fn download_split(mgr: &Arc<TransferManager>, session: &Arc<Session>, remote: &str, dir: &Path, slow_kbps: u64) -> (Transfer, Duration, usize) {
    mgr.set_throttle_kbps(slow_kbps);
    let m = Arc::clone(mgr);
    let lift = tokio::spawn(async move {
        for _ in 0..400 {
            let split = m
                .live
                .lock()
                .unwrap()
                .values()
                .any(|l| l.segments.load(Ordering::Relaxed) > 1);
            if split {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        m.set_throttle_kbps(0);
    });
    let out = download(mgr, session, remote, dir).await;
    lift.abort();
    mgr.set_throttle_kbps(0);
    out
}

async fn download(mgr: &Arc<TransferManager>, session: &Arc<Session>, remote: &str, dir: &Path) -> (Transfer, Duration, usize) {
    let size = remote_size(session, remote).await.unwrap();
    let target = dir.join(basename(remote));
    let t = row(
        &Uuid::new_v4().to_string(),
        TransferKind::Download,
        remote,
        &target.to_string_lossy(),
        size,
    );
    let job = RetryInfo::Download {
        session: Arc::clone(session),
        remote_path: remote.into(),
        target,
        policy: OverwritePolicy::Overwrite,
    };
    run(mgr, t, job).await
}

async fn upload(mgr: &Arc<TransferManager>, session: &Arc<Session>, local: &Path, remote: &str) -> (Transfer, Duration, usize) {
    let size = std::fs::metadata(local).unwrap().len();
    let t = row(
        &Uuid::new_v4().to_string(),
        TransferKind::Upload,
        &local.to_string_lossy(),
        remote,
        size,
    );
    let job = RetryInfo::Upload {
        session: Arc::clone(session),
        local: local.into(),
        final_remote: remote.into(),
    };
    run(mgr, t, job).await
}

fn random_file(path: &Path, mib: usize) {
    use rand::RngCore;
    let mut f = std::fs::File::create(path).unwrap();
    let mut buf = vec![0u8; 1024 * 1024];
    for _ in 0..mib {
        rand::thread_rng().fill_bytes(&mut buf);
        std::io::Write::write_all(&mut f, &buf).unwrap();
    }
}

#[tokio::test]
#[ignore]
async fn live_sftp_download_throughput_and_integrity() {
    let Some(session) = sftp_session().await else { return };
    let Session::Ssh(ssh) = &*session else { unreachable!() };
    let dir = scratch("sftp");

    // Before: the old copy loop (one 64 KiB read in flight at a time).
    let probe = "/home/faro/data/mid.bin";
    let started = Instant::now();
    let cell = ssh.ensure_sftp().await.unwrap();
    let mut f = cell.lock().await.open(probe).await.unwrap();
    let mut buf = vec![0u8; 64 * 1024];
    let mut n = 0u64;
    while n < 16 * 1024 * 1024 {
        let r = f.read(&mut buf).await.unwrap();
        if r == 0 {
            break;
        }
        n += r as u64;
    }
    let old = mbps(n, started.elapsed());
    drop(f);

    // After: the new pipeline on the whole 256 MiB file, checksum-verified.
    let mgr = Arc::new(TransferManager::new());
    mgr.set_verify(true);
    let remote = "/home/faro/data/big.bin";
    let (t, took, peak) = download(&mgr, &session, remote, &dir).await;
    assert_eq!(t.status, TransferStatus::Done, "{:?}", t.error);
    let local = dir.join("big.bin");
    let remote_sha = ssh.exec(&format!("sha256sum {remote}")).await.unwrap().stdout;
    assert!(remote_sha.starts_with(&sha_file(&local)), "hash mismatch");
    assert!(!dir.join("big.bin.faro-part").exists());
    let new = mbps(t.size, took);
    println!("SFTP download: old loop {old:.1} MiB/s, pipeline {new:.1} MiB/s ({:.1}x), peak segments {peak}", new / old);
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
#[ignore]
async fn live_sftp_upload_and_pause_resume() {
    let Some(session) = sftp_session().await else { return };
    let Session::Ssh(ssh) = &*session else { unreachable!() };
    let dir = scratch("sftp-up");
    let local = dir.join("up.bin");
    random_file(&local, 64);
    let mgr = Arc::new(TransferManager::new());
    mgr.set_verify(true);
    let remote = "/home/faro/up.bin";
    let (t, took, _) = upload(&mgr, &session, &local, remote).await;
    assert_eq!(t.status, TransferStatus::Done, "{:?}", t.error);
    let remote_sha = ssh.exec(&format!("sha256sum {remote}")).await.unwrap().stdout;
    assert!(remote_sha.starts_with(&sha_file(&local)));
    println!("SFTP upload: {:.1} MiB/s", mbps(t.size, took));

    // Pause a download midway, check it keeps its temp, resume, finish.
    let mgr = Arc::new(TransferManager::new());
    let id = "pause-1".to_string();
    let remote = "/home/faro/data/big.bin";
    let target = dir.join("big.bin");
    let size = remote_size(&session, remote).await.unwrap();
    mgr.insert(row(&id, TransferKind::Download, remote, &target.to_string_lossy(), size)).await;
    mgr.pauses.lock().await.insert(id.clone(), PauseGate::new());
    mgr.waiting.lock().await.push_back(id.clone());
    let job = RetryInfo::Download {
        session: Arc::clone(&session),
        remote_path: remote.into(),
        target: target.clone(),
        policy: OverwritePolicy::Overwrite,
    };
    let task = tokio::spawn(run_job(Arc::clone(&mgr), id.clone(), job));
    while mgr.live(&id).get() < size / 3 {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    mgr.pauses.lock().await.get(&id).unwrap().set(true);
    while mgr.get(&id).await.unwrap().status != TransferStatus::Paused {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let kept = mgr.resume_state(&id).unwrap().ranges.total();
    assert!(kept >= size / 3, "resume state keeps the bytes: {kept}");
    assert!(dir.join("big.bin.faro-part").exists(), "pause keeps the temp");
    // Resume: the next run starts from what's on disk, not from 0.
    mgr.pauses.lock().await.get(&id).unwrap().set(false);
    mgr.bump_queue_quiet().await;
    let mut first_after = None;
    while !task.is_finished() {
        let b = mgr.live(&id).get();
        if first_after.is_none() && b > 0 {
            first_after = Some(b);
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let t = mgr.get(&id).await.unwrap();
    assert_eq!(t.status, TransferStatus::Done, "{:?}", t.error);
    let remote_sha = ssh.exec(&format!("sha256sum {remote}")).await.unwrap().stdout;
    assert!(remote_sha.starts_with(&sha_file(&target)));
    println!("paused at {kept} of {size}; resumed counting from {:?}", first_after);
    assert!(first_after.unwrap_or(0) >= kept);
    let _ = std::fs::remove_dir_all(&dir);
}

async fn object_round_trip(var: &str) {
    let Some(session) = object_session(var).await else { return };
    let Session::Object(obj) = &*session else { unreachable!() };
    let dir = scratch("obj");
    let local = dir.join("blob.bin");
    random_file(&local, 200);
    let mgr = Arc::new(TransferManager::new());
    // S3: the multipart ETag is checked against the parts' MD5s.
    mgr.set_verify(true);
    let key = format!("faro-live/{}.bin", Uuid::new_v4().simple());
    let (t, took, peak_up) = upload(&mgr, &session, &local, &key).await;
    assert_eq!(t.status, TransferStatus::Done, "{:?}", t.error);
    println!("{var} upload: {:.1} MiB/s, peak parts in flight {peak_up}", mbps(t.size, took));
    assert!(peak_up > 1, "parts went up in parallel");

    let down = dir.join("down");
    std::fs::create_dir_all(&down).unwrap();
    let (t, took, peak) = download_split(&mgr, &session, &key, &down, 8 * 1024).await;
    assert_eq!(t.status, TransferStatus::Done, "{:?}", t.error);
    let got = down.join(basename(&key));
    assert_eq!(sha_file(&got), sha_file(&local));
    println!("{var} download: {:.1} MiB/s, peak segments {peak}", mbps(t.size, took));
    assert!(peak > 1, "ranges ran in parallel");

    // Changing the object between runs (pause, replace, resume) restarts
    // the download from 0 with a notice; the two versions are never mixed.
    let mgr2 = Arc::new(TransferManager::new());
    let id = "chg".to_string();
    let size = remote_size(&session, &key).await.unwrap();
    let target = dir.join("changed.bin");
    mgr2.insert(row(&id, TransferKind::Download, &key, &target.to_string_lossy(), size)).await;
    mgr2.pauses.lock().await.insert(id.clone(), PauseGate::new());
    mgr2.waiting.lock().await.push_back(id.clone());
    mgr2.set_throttle_kbps(20 * 1024);
    let task = tokio::spawn(run_job(
        Arc::clone(&mgr2),
        id.clone(),
        RetryInfo::Download {
            session: Arc::clone(&session),
            remote_path: key.clone(),
            target: target.clone(),
            policy: OverwritePolicy::Overwrite,
        },
    ));
    while mgr2.live(&id).get() < 20 * 1024 * 1024 {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    mgr2.pauses.lock().await.get(&id).unwrap().set(true);
    while mgr2.get(&id).await.unwrap().status != TransferStatus::Paused {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let replacement = dir.join("replacement.bin");
    random_file(&replacement, 200);
    obj.store
        .put(
            &object_store::path::Path::from(key.as_str()),
            bytes::Bytes::from(std::fs::read(&replacement).unwrap()).into(),
        )
        .await
        .unwrap();
    mgr2.set_throttle_kbps(0);
    mgr2.pauses.lock().await.get(&id).unwrap().set(false);
    mgr2.bump_queue_quiet().await;
    task.await.unwrap();
    let t = mgr2.get(&id).await.unwrap();
    assert_eq!(t.status, TransferStatus::Done, "{:?}", t.error);
    assert_eq!(t.notice.as_deref(), Some("remote changed, restarted"));
    assert_eq!(sha_file(&target), sha_file(&replacement), "never stitched");
    println!("{var}: a remote changed between runs restarted cleanly");
    let _ = obj.store.delete(&object_store::path::Path::from(key.as_str())).await;
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
#[ignore]
async fn live_s3_parallel_round_trip() {
    object_round_trip("FARO_LIVE_S3").await;
}

/// Run against scripts/s3-lab.py. Uses the same RemoteFs listing as the
/// directory queue and the real transfer runner for every discovered file.
#[tokio::test]
#[ignore = "requires scripts/s3-lab.py and FARO_LIVE_S3"]
async fn live_s3_directory_markers() {
    let session = object_session("FARO_LIVE_S3").await.expect("set FARO_LIVE_S3");
    let fs = fs_for_session(&session);
    let expected = std::collections::BTreeMap::from([
        ("/issue-33/marked/hello.txt", "hello from marked folder\n"),
        ("/issue-33/marked/nested/data.txt", "nested payload\n"),
        ("/issue-33/implicit/hello.txt", "hello from implicit folder\n"),
        ("/issue-33/empty.txt", ""),
        ("/issue-33/spaces & symbols/hello world.txt", "spaced filename\n"),
    ]);
    let dir = scratch("s3-directories");
    let mgr = Arc::new(TransferManager::new());
    let mut dirs = vec!["/issue-33".to_string()];
    let mut seen = std::collections::BTreeSet::new();
    let mut files = std::collections::BTreeSet::new();
    while let Some(path) = dirs.pop() {
        assert!(seen.insert(path.clone()), "directory cycle: {path}");
        assert!(seen.len() <= 10, "unexpected directory tree");
        let local_dir = dir.join(path.trim_start_matches('/'));
        std::fs::create_dir_all(&local_dir).unwrap();
        for entry in fs.list_dir(&path).await.unwrap() {
            if entry.kind == crate::remotefs::FileKind::Directory {
                dirs.push(entry.path);
            } else {
                assert!(expected.contains_key(entry.path.as_str()), "unexpected file: {entry:?}");
                assert!(files.insert(entry.path.clone()), "duplicate file");
                let (t, _, _) = tokio::time::timeout(
                    Duration::from_secs(30), download(&mgr, &session, &entry.path, &local_dir),
                ).await.expect("download timed out");
                assert_eq!(t.status, TransferStatus::Done, "{}: {:?}", entry.path, t.error);
                assert_eq!(std::fs::read(local_dir.join(&entry.name)).unwrap(), expected[entry.path.as_str()].as_bytes());
            }
        }
    }
    assert_eq!(files.len(), expected.len());
    assert!(dir.join("issue-33/marked/empty").is_dir(), "empty marker folder preserved");
    // The fix must not turn genuine missing-file errors into successful copies.
    let error = remote_size(&session, "/issue-33/missing.txt").await.unwrap_err();
    assert!(error.to_string().contains("object head"));
    println!("5 files copied with exact bytes; empty folder preserved; missing file still errors");
    std::fs::remove_dir_all(&dir).unwrap();
}

/// Regression for exact Unicode keys, through metadata and the real downloader.
#[tokio::test]
#[ignore = "requires scripts/s3-lab.py and FARO_LIVE_S3"]
async fn live_s3_unicode_key() {
    let session = object_session("FARO_LIVE_S3").await.expect("set FARO_LIVE_S3");
    let Session::Object(obj) = &*session else { unreachable!() };
    let key = object_store::path::Path::parse("key-encoding/café.txt").unwrap();
    let bytes = obj.store.get(&key).await.unwrap().bytes().await.unwrap();
    assert_eq!(bytes.as_ref(), b"coffee\n", "the original S3 key is readable");
    assert_eq!(remote_size(&session, "/key-encoding/café.txt").await.unwrap(), 7);
    let dir = scratch("s3-unicode");
    let mgr = Arc::new(TransferManager::new());
    let (t, _, _) = download(&mgr, &session, "/key-encoding/café.txt", &dir).await;
    assert_eq!(t.status, TransferStatus::Done, "{:?}", t.error);
    assert_eq!(std::fs::read(dir.join("café.txt")).unwrap(), b"coffee\n");
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
#[ignore]
async fn live_azure_parallel_round_trip() {
    object_round_trip("FARO_LIVE_AZURE").await;
}

#[tokio::test]
#[ignore]
async fn live_http_ranged_download() {
    let Some(v) = env("FARO_LIVE_HTTP") else { return };
    let url = url::Url::parse(&v[0]).unwrap();
    let mut base = url.clone();
    base.set_path("/");
    let p = profile("http", url.host_str().unwrap(), url.port().unwrap_or(80), "", "");
    let http = crate::session::HttpSession {
        id: "live".into(),
        profile: p,
        client: reqwest::Client::new(),
        base,
        auth: crate::session::http::HttpAuth::None,
        mode: crate::session::http::HttpMode::Listing,
    };
    let session = Arc::new(Session::Http(Arc::new(http)));
    let dir = scratch("http");
    let mgr = Arc::new(TransferManager::new());
    let (t, took, peak) = download_split(&mgr, &session, url.path(), &dir, 4 * 1024).await;
    assert_eq!(t.status, TransferStatus::Done, "{:?}", t.error);
    let got = dir.join(basename(url.path()));
    let want = reqwest::get(url.as_str()).await.unwrap().bytes().await.unwrap();
    assert_eq!(std::fs::read(&got).unwrap(), want.to_vec());
    println!("HTTP download: {:.1} MiB/s, peak segments {peak}", mbps(t.size, took));
    assert!(peak > 1, "Range requests ran in parallel");
    let _ = std::fs::remove_dir_all(&dir);
}

/// Plan 24 Phase 8: a download copies on its own login, so listing a folder
/// on the browsing connection doesn't wait behind it; and a server that
/// caps logins (the test vsftpd allows 3 per IP) only lowers the number of
/// parallel connections — the download still finishes intact.
#[tokio::test]
#[ignore]
async fn live_ftp_browse_during_download_and_login_cap() {
    let Some(v) = env("FARO_LIVE_FTP") else { return };
    let mut p = profile("ftp", &v[0], v[1].parse().unwrap(), &v[2], &v[3]);
    p.ftp_max_connections = Some(8);
    p.ftp_segments = Some(4);
    let ftp = Arc::new(
        crate::session::ftp::ftp_connect(&p, Arc::new(AcceptAll))
            .await
            .expect("ftp connect"),
    );
    let session = Arc::new(Session::Ftp(Arc::clone(&ftp)));
    let dir = scratch("ftp-pool");
    let mgr = Arc::new(TransferManager::new());
    let remote = "/home/faro/data/big.bin";
    let size = remote_size(&session, remote).await.unwrap();
    let target = dir.join("big.bin");
    let id = "ftp-pool".to_string();
    mgr.insert(row(&id, TransferKind::Download, remote, &target.to_string_lossy(), size)).await;
    mgr.pauses.lock().await.insert(id.clone(), PauseGate::new());
    mgr.waiting.lock().await.push_back(id.clone());
    // Slow enough to be mid-copy while we browse, and to be worth splitting.
    mgr.set_throttle_kbps(16 * 1024);
    let task = tokio::spawn(run_job(
        Arc::clone(&mgr),
        id.clone(),
        RetryInfo::Download {
            session: Arc::clone(&session),
            remote_path: remote.into(),
            target: target.clone(),
            policy: OverwritePolicy::Overwrite,
        },
    ));
    while mgr.live(&id).get() < 32 * 1024 * 1024 {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let fs = crate::remotefs::ftp::FtpFs::new(Arc::clone(&ftp));
    let started = Instant::now();
    let listing = crate::remotefs::RemoteFs::list_dir(&fs, "/home/faro/data").await.unwrap();
    let browse = started.elapsed();
    assert!(listing.iter().any(|e| e.name == "big.bin"));
    println!("FTP: listed a folder in {browse:?} during a running download");
    assert!(browse < Duration::from_secs(3), "browsing waited behind the copy: {browse:?}");
    let mut peak = 0;
    while !task.is_finished() {
        peak = peak.max(mgr.live(&id).segments.load(Ordering::Relaxed));
        if mgr.live(&id).get() > size / 2 {
            mgr.set_throttle_kbps(0);
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let t = mgr.get(&id).await.unwrap();
    assert_eq!(t.status, TransferStatus::Done, "{:?}", t.error);
    let want = {
        let Session::Ftp(f) = &*session else { unreachable!() };
        let _ = f;
        // Compare against the same file fetched over SFTP-free means: the
        // server's own copy via a plain single-connection download.
        let check = scratch("ftp-check");
        let mgr2 = Arc::new(TransferManager::new());
        let (t2, ..) = download(&mgr2, &ftp_session().await.unwrap(), remote, &check).await;
        assert_eq!(t2.status, TransferStatus::Done);
        let h = sha_file(&check.join("big.bin"));
        let _ = std::fs::remove_dir_all(&check);
        h
    };
    assert_eq!(sha_file(&target), want);
    println!("FTP: segmented download under a 3-login cap finished intact (peak {peak} connections)");
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
#[ignore]
async fn live_ftp_download_and_upload() {
    let Some(session) = ftp_session().await else { return };
    let dir = scratch("ftp");
    let mgr = Arc::new(TransferManager::new());
    let remote = "/home/faro/data/mid.bin";
    let (t, took, _) = download(&mgr, &session, remote, &dir).await;
    assert_eq!(t.status, TransferStatus::Done, "{:?}", t.error);
    println!("FTP download: {:.1} MiB/s", mbps(t.size, took));
    let local = dir.join("mid.bin");
    let back = "/home/faro/mid-copy.bin";
    let (t, took, _) = upload(&mgr, &session, &local, back).await;
    assert_eq!(t.status, TransferStatus::Done, "{:?}", t.error);
    println!("FTP upload: {:.1} MiB/s", mbps(t.size, took));
    // Round trip: download the copy and compare.
    let down = dir.join("d");
    std::fs::create_dir_all(&down).unwrap();
    let (t, ..) = download(&mgr, &session, back, &down).await;
    assert_eq!(t.status, TransferStatus::Done, "{:?}", t.error);
    assert_eq!(sha_file(&down.join("mid-copy.bin")), sha_file(&local));
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
#[ignore = "requires scripts/audit-gdrive.py"]
async fn live_gdrive_app_round_trip() {
    std::env::var("FARO_GDRIVE_MOCK_URL").expect("run scripts/audit-gdrive.py");
    let mut p = profile("gdrive", "127.0.0.1", 0, "", "");
    p.id = format!("drive-app-test-{}", Uuid::new_v4());
    let service = crate::session::gdrive::GDRIVE_SERVICE;
    crate::oauth::store_tokens(service,&p.id,&crate::oauth::TokenSet {
        access_token:"ACCESS1".into(),refresh_token:None,expires_at:i64::MAX,
    }).unwrap();
    let gd = crate::session::gdrive::gdrive_connect(&p).await.unwrap();
    // No refresh is needed; remove the isolated persisted credential immediately.
    crate::oauth::delete_tokens(service,&p.id);
    let session = Arc::new(Session::GDrive(Arc::new(gd)));
    let dir = scratch("gdrive-app");
    let local = dir.join("app.bin");
    random_file(&local,20);
    let mgr = Arc::new(TransferManager::new());
    let (t,..) = upload(&mgr,&session,&local,"/app.bin").await;
    assert_eq!(t.status,TransferStatus::Done,"{:?}",t.error);
    let down = dir.join("down");
    std::fs::create_dir(&down).unwrap();
    let (t,..) = download(&mgr,&session,"/app.bin",&down).await;
    assert_eq!(t.status,TransferStatus::Done,"{:?}",t.error);
    assert_eq!(sha_file(&local),sha_file(&down.join("app.bin")));
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
#[ignore = "requires scripts/audit-ftp-sftp.py --live"]
async fn live_ftp_sftp_overwrite_safety() {
    let ftp = ftp_session().await.expect("FTP fixture required");
    let sftp = sftp_session().await.expect("SFTP fixture required");
    for session in [&ftp, &sftp] {
        for policy in [OverwritePolicy::Skip, OverwritePolicy::Rename] {
            assert!(remote_resolve(session,"/guard/blocked/existing",policy).await.is_err(),
                "permission failure must not imply missing destination");
        }
    }
    let (_, skip) = remote_resolve(&sftp,"/dangling",OverwritePolicy::Skip).await.unwrap();
    assert!(skip,"a dangling link is still an existing destination");
}
