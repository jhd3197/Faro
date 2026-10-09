use super::*;
use crate::remotefs::{gdrive::GDriveFs, RemoteFs};
use serde_json::json;
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

struct Server {
    session: Arc<GDriveSession>,
    requests: Arc<Mutex<Vec<String>>>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for Server {
    fn drop(&mut self) { self.task.abort(); }
}

async fn server(replies: Vec<(u16, Value)>) -> Server {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let requests = Arc::new(Mutex::new(Vec::new()));
    let seen = requests.clone();
    let task = tokio::spawn(async move {
        let mut replies = VecDeque::from(replies);
        loop {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut buf = [0; 4096];
            while !request.windows(4).any(|w| w == b"\r\n\r\n") {
                let n = socket.read(&mut buf).await.unwrap();
                if n == 0 { break; }
                request.extend_from_slice(&buf[..n]);
            }
            seen.lock().unwrap().push(String::from_utf8_lossy(&request).lines().next().unwrap_or("").to_string());
            let (code, body) = replies.pop_front().unwrap_or((500, json!({"error":"unexpected request"})));
            let body = body.to_string();
            let response = format!("HTTP/1.1 {code} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
            let _ = socket.write_all(response.as_bytes()).await;
        }
    });
    let profile: ConnectionProfile = serde_json::from_value(json!({
        "id":"drive-test", "name":"drive-test", "protocol":"gdrive", "host":"127.0.0.1",
        "port":0, "username":"", "auth":{"kind":"password","password":""}
    })).unwrap();
    let session = Arc::new(GDriveSession {
        id: "test".into(), profile,
        client: Client::builder().timeout(Duration::from_secs(3)).build().unwrap(),
        api_base: endpoint.clone(), upload_base: endpoint,
        token: RefreshingToken::new("test", "drive-test", gdrive_config(), oauth::TokenSet {
            access_token: "synthetic".into(), refresh_token: None, expires_at: i64::MAX,
        }),
    });
    Server { session, requests, task }
}

fn file(id: &str, name: &str, folder: bool) -> Value {
    json!({"id":id,"name":name,"mimeType":if folder { FOLDER_MIME } else { "text/plain" },"size":"4"})
}

fn page(files: Vec<Value>) -> (u16, Value) { (200, json!({"files":files})) }

fn no_mutations(s: &Server) {
    assert!(s.requests.lock().unwrap().iter().all(|r| r.starts_with("GET ")), "unexpected mutation: {:?}", s.requests);
}

#[tokio::test]
async fn duplicate_names_cannot_resolve_to_an_arbitrary_item() {
    let s = server(vec![page(vec![file("a","same",false),file("b","same",false)])]).await;
    assert!(s.session.resolve_item("/same").await.is_err());
    no_mutations(&s);
}

#[tokio::test]
async fn duplicate_names_on_later_pages_are_rejected() {
    let s = server(vec![(200,json!({"files":[file("a","same",false)],"nextPageToken":"next"})),
        page(vec![file("b","same",false)])]).await;
    assert!(s.session.resolve_item("/same").await.is_err());
}

#[tokio::test]
async fn nonrecursive_folder_delete_preserves_children() {
    let s = server(vec![page(vec![file("dir","folder",true)]),
        page(vec![file("child","keep",false)]), (204,json!({}))]).await;
    assert!(GDriveFs::new(s.session.clone()).delete("/folder",false).await.is_err());
    no_mutations(&s);
}

#[tokio::test]
async fn invalid_listing_is_not_an_empty_source() {
    let s = server(vec![(200,json!({"unexpected":[]}))]).await;
    assert!(GDriveFs::new(s.session.clone()).list_dir("/").await.is_err());
}

#[tokio::test]
async fn duplicate_listing_cannot_be_collapsed_by_sync() {
    let s = server(vec![page(vec![file("a","same",false),file("b","same",false)])]).await;
    let fs = GDriveFs::new(s.session.clone());
    assert!(crate::scan::walk_tree(&fs,"/").await.is_err());
}

#[tokio::test]
async fn incomplete_search_is_not_a_complete_listing() {
    let s = server(vec![(200,json!({"files":[],"incompleteSearch":true}))]).await;
    assert!(GDriveFs::new(s.session.clone()).list_dir("/").await.is_err());
}

#[tokio::test]
async fn warmed_folder_is_revalidated_before_delete() {
    let s = server(vec![page(vec![file("old","folder",true)]),
        page(vec![file("old","folder",true), file("other","folder",true)]),
        page(vec![file("child","keep",false)]), (204,json!({}))]).await;
    let fs = GDriveFs::new(s.session.clone());
    fs.list_dir("/").await.unwrap();
    assert!(fs.delete("/folder/keep",false).await.is_err());
    no_mutations(&s);
}

#[tokio::test]
async fn mkdir_existing_folder_does_not_create_a_duplicate() {
    let s = server(vec![page(vec![file("existing","folder",true)]), (200,file("duplicate","folder",true))]).await;
    GDriveFs::new(s.session.clone()).create_dir("/folder").await.unwrap();
    no_mutations(&s);
}

#[tokio::test]
async fn empty_folder_delete_succeeds_after_checking_children() {
    let s = server(vec![page(vec![file("dir","empty",true)]),page(vec![]),(204,json!({}))]).await;
    GDriveFs::new(s.session.clone()).delete("/empty",false).await.unwrap();
    let requests = s.requests.lock().unwrap();
    assert_eq!(requests.len(),3);
    assert!(requests[2].starts_with("DELETE /files/dir?"));
}

#[tokio::test]
async fn unreadable_child_prevents_recursive_delete_and_mirror() {
    for mirror in [false,true] {
        let s = server(vec![page(vec![file("dir","folder",true)]),
            page(vec![file("dir","folder",true)]), (403,json!({"error":"denied"}))]).await;
        let fs = GDriveFs::new(s.session.clone());
        if mirror {
            let local = std::env::temp_dir().join(format!("faro-drive-test-{}", Uuid::new_v4()));
            std::fs::create_dir(&local).unwrap();
            std::fs::write(local.join("keep.txt"),b"keep").unwrap();
            let result = crate::sync::plan(&crate::remotefs::local::LocalFs,&fs,
                local.to_str().unwrap(),"/folder",crate::sync::SyncDirection::RemoteToLocal,
                crate::sync::SyncStrategy::Mirror).await;
            assert!(result.is_err());
            assert_eq!(std::fs::read(local.join("keep.txt")).unwrap(),b"keep");
            std::fs::remove_dir_all(local).unwrap();
        } else { assert!(fs.delete("/folder",true).await.is_err()); }
        no_mutations(&s);
    }
}

#[tokio::test]
async fn listing_follows_empty_pages_and_preserves_exact_names() {
    let s = server(vec![(200,json!({"files":[],"nextPageToken":"p2"})),
        page(vec![file("a"," café %.txt ",false)])]).await;
    let entries = GDriveFs::new(s.session.clone()).list_dir("/").await.unwrap();
    assert_eq!(entries[0].path,"/ café %.txt ");
    assert_eq!(normalize(&entries[0].path),entries[0].path);
    assert!(s.requests.lock().unwrap()[1].contains("pageToken=p2"));
}

#[tokio::test]
async fn repeated_page_token_and_later_failure_are_errors() {
    for last in [(200,json!({"files":[],"nextPageToken":"p2"})),(403,json!({"error":"denied"}))] {
        let s = server(vec![(200,json!({"files":[file("a","keep",false)],"nextPageToken":"p2"})),last]).await;
        assert!(GDriveFs::new(s.session.clone()).list_dir("/").await.is_err());
        assert_eq!(s.requests.lock().unwrap().len(),2);
    }
}

#[tokio::test]
async fn permission_errors_are_not_missing_files_or_zero_sizes() {
    let s = server(vec![(403,json!({"error":"denied"})),(403,json!({"error":"denied"}))]).await;
    assert!(s.session.exists("/file").await.is_err());
    assert!(s.session.size("/file").await.is_err());
}

#[tokio::test]
async fn root_mutations_are_rejected_without_requests() {
    let s = server(vec![]).await;
    let fs = GDriveFs::new(s.session.clone());
    assert!(fs.delete("/",true).await.is_err());
    assert!(fs.rename("/","/new").await.is_err());
    assert!(s.requests.lock().unwrap().is_empty());
}

#[tokio::test]
async fn rename_refuses_existing_destination_without_mutation() {
    let s = server(vec![page(vec![file("src","source",false)]),page(vec![file("dst","target",false)])]).await;
    assert!(GDriveFs::new(s.session.clone()).rename("/source","/target").await.is_err());
    no_mutations(&s);
}
