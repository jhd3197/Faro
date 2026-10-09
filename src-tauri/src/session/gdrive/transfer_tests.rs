use super::*;
use crate::remotefs::{gdrive::GDriveFs, RemoteFs};
use serde_json::json;
use std::{path::PathBuf, process::Command, sync::Arc};

struct Scratch {
    dir: PathBuf,
    id: String,
}
impl Drop for Scratch {
    fn drop(&mut self) {
        oauth::delete_tokens(GDRIVE_SERVICE, &self.id);
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

#[tokio::test]
#[ignore = "requires scripts/audit-gdrive.py and a built faro-cli"]
async fn live_gdrive_transfers() {
    let endpoint = std::env::var("FARO_GDRIVE_MOCK_URL").expect("run scripts/audit-gdrive.py");
    let id = format!("faro-drive-test-{}", Uuid::new_v4());
    let dir = std::env::temp_dir().join(&id);
    std::fs::create_dir(&dir).unwrap();
    let scratch = Scratch { dir, id };
    let profile: ConnectionProfile =
        serde_json::from_value(json!({"id":scratch.id,"name":"lab","protocol":"gdrive",
        "host":"127.0.0.1","port":0,"username":"","auth":{"kind":"password","password":""}}))
        .unwrap();
    let tokens = oauth::TokenSet {
        access_token: "ACCESS1".into(),
        refresh_token: None,
        expires_at: i64::MAX,
    };
    oauth::store_tokens(GDRIVE_SERVICE, &scratch.id, &tokens).unwrap();
    std::fs::write(
        scratch.dir.join("profiles.json"),
        serde_json::to_vec(&vec![&profile]).unwrap(),
    )
    .unwrap();
    let session = Arc::new(GDriveSession {
        id: scratch.id.clone(),
        profile,
        client: Client::builder()
            .timeout(Duration::from_secs(10))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap(),
        api_base: endpoint.clone(),
        upload_base: endpoint.clone(),
        token: RefreshingToken::new(GDRIVE_SERVICE, &scratch.id, gdrive_config(), tokens),
    });
    let fs = GDriveFs::new(session.clone());
    fs.create_dir("/transfers").await.unwrap();
    let local = scratch.dir.join("large.bin");
    let payload: Vec<u8> = (0..17 * 1024 * 1024 + 7).map(|i| (i % 251) as u8).collect();
    std::fs::write(&local, &payload).unwrap();
    let mut progress = Vec::new();
    session
        .upload_file(&local, "/transfers/retry.bin", |n| {
            progress.push(n);
            std::future::ready(Ok(()))
        })
        .await
        .unwrap();
    assert!(
        progress.contains(&(8 * 1024 * 1024)),
        "retry should resume from server acknowledgement"
    );
    let (fid, _) = session
        .resolve_item("/transfers/retry.bin")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        session
            .get_stream(&format!("/files/{fid}?alt=media"))
            .await
            .unwrap()
            .bytes()
            .await
            .unwrap()
            .as_ref(),
        payload
    );
    assert!(session
        .upload_file(&local, "/transfers/expired.bin", |_| std::future::ready(
            Ok(())
        ))
        .await
        .is_err());
    let mut seen = 0;
    assert!(session
        .upload_file(&local, "/transfers/canceled.bin", |_| {
            seen += 1;
            std::future::ready(if seen > 2 {
                Err(anyhow!("canceled"))
            } else {
                Ok(())
            })
        })
        .await
        .is_err());
    assert!(!session.exists("/transfers/canceled.bin").await.unwrap());
    let cli = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("target/debug")
        .join(if cfg!(windows) {
            "faro-cli.exe"
        } else {
            "faro-cli"
        });
    assert!(cli.is_file(), "build faro-cli first");
    let run = |args: &[&str], success: bool| {
        let output = Command::new(&cli)
            .args(args)
            .env("FARO_DATA_DIR", &scratch.dir)
            .env("FARO_GDRIVE_API_BASE", &endpoint)
            .env("FARO_GDRIVE_UPLOAD_BASE", &endpoint)
            .current_dir(&scratch.dir)
            .output()
            .unwrap();
        assert_eq!(
            output.status.success(),
            success,
            "{args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    };
    run(
        &["cp", local.to_str().unwrap(), "lab:/transfers/café %.bin"],
        true,
    );
    let download = scratch.dir.join("download.bin");
    run(
        &[
            "cp",
            "lab:/transfers/café %.bin",
            download.to_str().unwrap(),
        ],
        true,
    );
    assert_eq!(std::fs::read(&download).unwrap(), payload);
    std::fs::write(&local, b"updated\r\n").unwrap();
    run(
        &["cp", local.to_str().unwrap(), "lab:/transfers/café %.bin"],
        true,
    );
    run(
        &[
            "cp",
            "lab:/transfers/café %.bin",
            download.to_str().unwrap(),
        ],
        true,
    );
    assert_eq!(std::fs::read(&download).unwrap(), b"updated\r\n");
    std::fs::write(&local, b"").unwrap();
    run(
        &["cp", local.to_str().unwrap(), "lab:/transfers/empty.txt"],
        true,
    );
    run(
        &["cp", "lab:/transfers/empty.txt", download.to_str().unwrap()],
        true,
    );
    assert!(std::fs::read(&download).unwrap().is_empty());
    run(
        &[
            "cp",
            "lab:/transfers/missing.txt",
            download.to_str().unwrap(),
        ],
        false,
    );
    assert!(std::fs::read(&download).unwrap().is_empty());
    let events = session
        .rpc(Method::GET, "/_test/uploads", None)
        .await
        .unwrap();
    let events = events["events"].as_array().unwrap();
    assert!(events
        .iter()
        .all(|e| e["length"].as_u64().unwrap() <= 8 * 1024 * 1024));
    assert!(events
        .iter()
        .any(|e| e["name"] == "retry.bin" && e["range"].as_str().unwrap().starts_with("bytes */")));
    assert_eq!(
        fs.list_dir("/transfers")
            .await
            .unwrap()
            .iter()
            .filter(|e| e.name == "café %.bin")
            .count(),
        1
    );
    println!("Drive: chunked upload, retry/status recovery, cancellation, expired session, CLI create/update/download, exact bytes and zero-byte files passed");
}
