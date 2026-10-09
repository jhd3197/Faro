use super::*;
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

async fn fixture(
    replies: Vec<(u16, &'static str, &'static str)>,
) -> (
    AzureNamespace,
    Arc<Mutex<Vec<String>>>,
    tokio::task::JoinHandle<()>,
) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/account", listener.local_addr().unwrap());
    let requests = Arc::new(Mutex::new(Vec::new()));
    let seen = requests.clone();
    let task = tokio::spawn(async move {
        for (status, headers, body) in replies {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut data = Vec::new();
            let mut buf = [0; 4096];
            while !data.windows(4).any(|w| w == b"\r\n\r\n") {
                let n = socket.read(&mut buf).await.unwrap();
                if n == 0 {
                    break;
                }
                data.extend_from_slice(&buf[..n]);
            }
            seen.lock().unwrap().push(
                String::from_utf8_lossy(&data)
                    .lines()
                    .next()
                    .unwrap()
                    .to_string(),
            );
            let wire = format!("HTTP/1.1 {status} Test\r\nContent-Length: {}\r\nConnection: close\r\n{headers}\r\n{body}", body.len());
            socket.write_all(wire.as_bytes()).await.unwrap();
        }
    });
    let profile = serde_json::from_value(serde_json::json!({"id":"azure-test", "name":"test", "protocol":"azure",
        "host":"127.0.0.1", "port":0, "username":"account", "auth":{"kind":"password","password":"dGVzdA=="},
        "bucket":"container", "endpoint":endpoint})).unwrap();
    (AzureNamespace::new(&profile).unwrap(), requests, task)
}

#[tokio::test]
async fn copy_waits_for_matching_success() {
    let (api, requests, task) = fixture(vec![
        (
            202,
            "x-ms-copy-id: one\r\nx-ms-copy-status: pending\r\n",
            "",
        ),
        (
            200,
            "x-ms-copy-id: one\r\nx-ms-copy-status: success\r\n",
            "",
        ),
    ])
    .await;
    tokio::time::timeout(Duration::from_secs(3), api.copy("src/", "dst/"))
        .await
        .unwrap()
        .unwrap();
    task.await.unwrap();
    let requests = requests.lock().unwrap();
    assert!(requests[0].starts_with("PUT /account/container/dst/ "));
    assert!(requests[1].starts_with("HEAD /account/container/dst/ "));
}

#[tokio::test]
async fn copy_rejects_failure_and_replaced_copy_id() {
    for headers in [
        "x-ms-copy-id: one\r\nx-ms-copy-status: failed\r\n",
        "x-ms-copy-id: other\r\nx-ms-copy-status: success\r\n",
    ] {
        let (api, _, task) = fixture(vec![
            (
                202,
                "x-ms-copy-id: one\r\nx-ms-copy-status: pending\r\n",
                "",
            ),
            (200, headers, ""),
        ])
        .await;
        assert!(
            tokio::time::timeout(Duration::from_secs(3), api.copy("src", "dst"))
                .await
                .unwrap()
                .is_err()
        );
        task.await.unwrap();
    }
}

#[tokio::test]
async fn repeated_listing_marker_is_an_error() {
    let page = "<EnumerationResults><Blobs/><NextMarker>again</NextMarker></EnumerationResults>";
    let (api, _, task) = fixture(vec![(200, "", page), (200, "", page)]).await;
    assert!(api.list("", false).await.is_err());
    task.await.unwrap();
}

#[tokio::test]
async fn only_encoded_names_are_percent_decoded() {
    let (api, _, task) = fixture(vec![(200,"", "<EnumerationResults><Blobs><BlobPrefix><Name>100%25/</Name></BlobPrefix><BlobPrefix><Name Encoded=\"true\">caf%C3%A9%2F</Name></BlobPrefix></Blobs><NextMarker/></EnumerationResults>")]).await;
    let listing = api.list("", true).await.unwrap();
    assert_eq!(listing.prefixes[0].prefix, "100%25/");
    assert_eq!(listing.prefixes[1].prefix, "café/");
    task.await.unwrap();
}
