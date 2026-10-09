use super::*;
use crate::profiles::ConnectionProfile;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

// Exercise S3 HTTP listings: an in-memory ObjectStore cannot represent
// trailing-slash marker keys because object_store::Path strips that slash.
async fn listing(path: &str, contents: &str) -> Vec<DirEntry> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let xml = format!("<ListBucketResult>{contents}</ListBucketResult>");
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = Vec::new();
        let mut buf = [0; 1024];
        while !request.windows(4).any(|w| w == b"\r\n\r\n") {
            let n = socket.read(&mut buf).await.unwrap();
            assert!(n > 0);
            request.extend_from_slice(&buf[..n]);
        }
        assert!(request.starts_with(b"GET /faro-test?"));
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/xml\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{xml}",
            xml.len()
        );
        socket.write_all(response.as_bytes()).await.unwrap();
    });
    let profile: ConnectionProfile = serde_json::from_value(serde_json::json!({
        "id": "s3-test", "name": "S3 test", "protocol": "s3",
        "host": "127.0.0.1", "port": 0, "username": "test",
        "auth": {"kind": "password", "password": "test"},
        "bucket": "faro-test", "region": "us-east-1", "endpoint": endpoint
    }))
    .unwrap();
    let session = crate::session::object::object_connect(&profile)
        .await
        .unwrap();
    let entries = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        ObjectFs::new(Arc::new(session)).list_dir(path),
    )
    .await
    .unwrap()
    .unwrap();
    server.await.unwrap();
    entries
}

fn object(key: &str, size: usize) -> String {
    format!("<Contents><Key>{key}</Key><Size>{size}</Size><LastModified>2026-10-08T00:00:00Z</LastModified><ETag>test</ETag></Contents>")
}

#[tokio::test]
async fn s3_folder_marker_is_not_a_downloadable_file() {
    let xml = format!(
        "{}{}<CommonPrefixes><Prefix>photos/nested/</Prefix></CommonPrefixes>",
        object("photos/", 0),
        object("photos/empty.txt", 0)
    );
    let entries = listing("/photos/", &xml).await;
    assert_eq!(
        entries.len(),
        2,
        "the directory's own marker must be excluded: {entries:?}"
    );
    assert!(entries
        .iter()
        .any(|e| e.path == "/photos/nested/" && e.kind == FileKind::Directory));
    assert!(entries
        .iter()
        .any(|e| e.path == "/photos/empty.txt" && e.kind == FileKind::File && e.size == 0));
}

#[tokio::test]
async fn s3_empty_marker_directory_has_no_children() {
    assert!(listing("/photos/empty", &object("photos/empty/", 0))
        .await
        .is_empty());
}

#[tokio::test]
async fn s3_implicit_prefix_and_same_named_file_are_both_preserved() {
    let xml = format!(
        "{}<CommonPrefixes><Prefix>photos/</Prefix></CommonPrefixes>",
        object("photos", 5)
    );
    let entries = listing("/", &xml).await;
    assert_eq!(entries.len(), 2);
    assert!(entries
        .iter()
        .any(|e| e.kind == FileKind::File && e.size == 5));
    assert!(entries.iter().any(|e| e.kind == FileKind::Directory));
    let entries = listing("/photos", &object("photos/image.jpg", 12)).await;
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].path, "/photos/image.jpg");
}
