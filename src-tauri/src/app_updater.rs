//! Release discovery when the signed updater feed is unavailable. This never
//! installs an asset: installation and signature verification stay with Tauri.
use std::time::Duration;

use futures::StreamExt;
use serde::{Deserialize, Serialize};

const RELEASE_API: &str = "https://api.github.com/repos/jhd3197/Faro/releases/latest";
// Newest first; 50 covers months of patch releases at the current cadence.
const RELEASES_API: &str = "https://api.github.com/repos/jhd3197/Faro/releases?per_page=50";
const MAX_METADATA: usize = 2 * 1024 * 1024;

#[derive(Debug, Serialize)]
pub struct UpdateCheckError {
    message: String,
    detail: String,
}

fn failure(message: &str, detail: impl ToString) -> UpdateCheckError {
    UpdateCheckError {
        message: message.into(),
        detail: detail.to_string(),
    }
}

#[derive(Deserialize)]
struct Release {
    tag_name: String,
    body: Option<String>,
    draft: bool,
    prerelease: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateRelease {
    version: String,
    current_version: String,
    notes: Option<String>,
    url: String,
    newer: bool,
}

fn parse_release(bytes: &[u8], current: &str) -> Result<UpdateRelease, UpdateCheckError> {
    let invalid = |e| {
        failure(
            "GitHub returned incomplete release information. Try again later.",
            e,
        )
    };
    let release: Release = serde_json::from_slice(bytes).map_err(|e| invalid(e.to_string()))?;
    let version = semver::Version::parse(
        release
            .tag_name
            .strip_prefix('v')
            .unwrap_or(&release.tag_name),
    )
    .map_err(|e| invalid(e.to_string()))?;
    if release.draft || release.prerelease || !version.pre.is_empty() {
        return Err(invalid("Expected a published stable release".into()));
    }
    let current_version = semver::Version::parse(current).map_err(|e| invalid(e.to_string()))?;
    // Construct the link ourselves; never open a URL supplied by release prose.
    let url = format!(
        "https://github.com/jhd3197/Faro/releases/tag/{}",
        release.tag_name
    );
    Ok(UpdateRelease {
        newer: version > current_version,
        version: version.to_string(),
        current_version: current.into(),
        notes: release.body,
        url,
    })
}

async fn fetch_release(
    client: &reqwest::Client,
    url: &str,
) -> Result<Vec<u8>, (UpdateCheckError, bool)> {
    let network = |e: reqwest::Error| {
        let transient = e.is_timeout() || e.is_connect() || e.is_body();
        (
            failure(
                "Couldn't reach GitHub. Check your connection and try again.",
                e,
            ),
            transient,
        )
    };
    let response = client.get(url).send().await.map_err(network)?;
    let status = response.status();
    if !status.is_success() {
        let message = match status.as_u16() {
            403 | 429 => {
                "GitHub is limiting or refusing update checks. Try again later, or open Downloads."
            }
            404 => "No published Faro release is available yet. Try again later.",
            _ => "GitHub couldn't complete the update check. Try again shortly.",
        };
        return Err((
            failure(message, format!("Release API returned HTTP {status}")),
            status.is_server_error(),
        ));
    }
    let too_large = || {
        (
            failure(
                "GitHub returned unexpected release information. Try again later.",
                "Release metadata exceeds 2 MB",
            ),
            false,
        )
    };
    if response
        .content_length()
        .is_some_and(|n| n > MAX_METADATA as u64)
    {
        return Err(too_large());
    }
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(network)?;
        if chunk.len() > MAX_METADATA - bytes.len() {
            return Err(too_large());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

async fn fetch_with_retry(url: &str) -> Result<Vec<u8>, UpdateCheckError> {
    let client = reqwest::Client::builder()
        .user_agent(concat!("Faro/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| failure("Couldn't start the update check.", e))?;
    for attempt in 0..3 {
        match fetch_release(&client, url).await {
            Ok(bytes) => return Ok(bytes),
            Err((error, retry)) => {
                if !retry || attempt == 2 {
                    return Err(error);
                }
                tokio::time::sleep(Duration::from_millis(500 * (1 << attempt))).await;
            }
        }
    }
    Err(failure(
        "Couldn't complete the update check.",
        "Retry limit reached",
    ))
}

#[tauri::command]
pub async fn app_update_release() -> Result<UpdateRelease, UpdateCheckError> {
    parse_release(
        &fetch_with_retry(RELEASE_API).await?,
        env!("CARGO_PKG_VERSION"),
    )
}

#[derive(Debug, Serialize, PartialEq)]
pub struct ReleaseNote {
    version: String,
    notes: Option<String>,
}

/// Published stable releases with `from < version <= to`, newest first. With no
/// `from` (an upgrade from a build that never recorded one), only `to` itself.
fn parse_releases_since(
    bytes: &[u8],
    from: Option<&str>,
    to: &str,
) -> Result<Vec<ReleaseNote>, UpdateCheckError> {
    let invalid = |e: String| {
        failure(
            "GitHub returned incomplete release information. Try again later.",
            e,
        )
    };
    let to = semver::Version::parse(to).map_err(|e| invalid(e.to_string()))?;
    let from = from
        .map(semver::Version::parse)
        .transpose()
        .map_err(|e| invalid(e.to_string()))?;
    let releases: Vec<Release> =
        serde_json::from_slice(bytes).map_err(|e| invalid(e.to_string()))?;
    let mut notes: Vec<(semver::Version, Option<String>)> = releases
        .into_iter()
        .filter(|r| !r.draft && !r.prerelease)
        .filter_map(|r| {
            let v = semver::Version::parse(r.tag_name.strip_prefix('v').unwrap_or(&r.tag_name))
                .ok()
                .filter(|v| v.pre.is_empty())?;
            let in_range = match &from {
                Some(from) => *from < v && v <= to,
                None => v == to,
            };
            in_range.then_some((v, r.body))
        })
        .collect();
    notes.sort_by(|a, b| b.0.cmp(&a.0));
    notes.dedup_by(|a, b| a.0 == b.0);
    Ok(notes
        .into_iter()
        .map(|(v, notes)| ReleaseNote {
            version: v.to_string(),
            notes,
        })
        .collect())
}

/// Release notes for every version between the last one the user saw and the
/// one now running, so skipping updates doesn't lose what changed.
#[tauri::command]
pub async fn app_release_notes_since(
    from: Option<String>,
    to: String,
) -> Result<Vec<ReleaseNote>, UpdateCheckError> {
    parse_releases_since(
        &fetch_with_retry(RELEASES_API).await?,
        from.as_deref(),
        &to,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    async fn respond_once(response: String) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/release", listener.local_addr().unwrap());
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = [0; 4096];
            let _request_len = stream.read(&mut request).await.unwrap();
            // The client can close early when the response exceeds its limit.
            let _ = stream.write_all(response.as_bytes()).await;
        });
        url
    }

    #[tokio::test]
    async fn http_failures_preserve_status_and_only_retry_transient_errors() {
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        for (status, retry) in [(404, false), (403, false), (429, false), (503, true)] {
            let url = respond_once(format!(
                "HTTP/1.1 {status} Failure\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            ))
            .await;
            let (error, retryable) = fetch_release(&client, &url).await.unwrap_err();
            assert_eq!(retryable, retry);
            assert!(error.detail.contains(&status.to_string()));
        }
    }

    #[tokio::test]
    async fn bounds_metadata_with_and_without_content_length() {
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let url = respond_once(format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            MAX_METADATA + 1
        ))
        .await;
        let (error, retry) = fetch_release(&client, &url).await.unwrap_err();
        assert!(error.detail.contains("exceeds 2 MB"));
        assert!(!retry);
        let url = respond_once(format!(
            "HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n{}",
            "x".repeat(MAX_METADATA + 1)
        ))
        .await;
        assert!(fetch_release(&client, &url)
            .await
            .unwrap_err()
            .0
            .detail
            .contains("exceeds 2 MB"));
        let url = respond_once(
            "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}".into(),
        )
        .await;
        assert_eq!(fetch_release(&client, &url).await.unwrap(), b"{}");
    }

    fn fixture(tag: &str) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({
            "tag_name": tag, "body": "Fixes", "draft": false, "prerelease": false,
            "html_url": "https://untrusted.example/download"
        }))
        .unwrap()
    }

    #[test]
    fn discovers_releases_without_updater_artifacts() {
        let release = parse_release(&fixture("v1.3.49"), "1.3.43").unwrap();
        assert!(release.newer);
        assert_eq!(
            release.url,
            "https://github.com/jhd3197/Faro/releases/tag/v1.3.49"
        );
        assert_eq!(release.version, "1.3.49");
    }

    #[test]
    fn compares_versions_numerically_and_never_offers_downgrades() {
        assert!(parse_release(&fixture("v1.3.100"), "1.3.99").unwrap().newer);
        assert!(!parse_release(&fixture("v1.3.49"), "1.3.49").unwrap().newer);
        assert!(!parse_release(&fixture("v1.3.49"), "1.4.0").unwrap().newer);
    }

    #[test]
    fn lists_only_published_releases_in_range_newest_first() {
        let list = serde_json::to_vec(&serde_json::json!([
            { "tag_name": "v1.4.8", "body": "eight", "draft": false, "prerelease": false },
            { "tag_name": "v1.4.9", "body": "draft", "draft": true, "prerelease": false },
            { "tag_name": "v1.4.6", "body": "six", "draft": false, "prerelease": false },
            { "tag_name": "v1.4.7-beta.1", "body": "beta", "draft": false, "prerelease": false },
            { "tag_name": "v1.4.7", "body": null, "draft": false, "prerelease": false },
            { "tag_name": "v1.4.5", "body": "five", "draft": false, "prerelease": false },
            { "tag_name": "nightly", "body": "x", "draft": false, "prerelease": false },
        ]))
        .unwrap();
        let since = parse_releases_since(&list, Some("1.4.5"), "1.4.8").unwrap();
        let versions: Vec<_> = since.iter().map(|r| r.version.as_str()).collect();
        assert_eq!(versions, ["1.4.8", "1.4.7", "1.4.6"]);
        assert_eq!(since[1].notes, None);
        let only = parse_releases_since(&list, None, "1.4.6").unwrap();
        assert_eq!(
            only,
            [ReleaseNote {
                version: "1.4.6".into(),
                notes: Some("six".into())
            }]
        );
        assert!(parse_releases_since(&list, Some("1.4.8"), "1.4.5")
            .unwrap()
            .is_empty());
        assert!(parse_releases_since(&list, Some("junk"), "1.4.8").is_err());
        assert!(parse_releases_since(b"{}", None, "1.4.8").is_err());
    }

    #[test]
    fn rejects_invalid_or_unpublished_metadata() {
        for bytes in [
            b"Not Found".to_vec(),
            fixture("v1.4.0-beta.1"),
            fixture("../../other"),
        ] {
            assert!(parse_release(&bytes, "1.3.43").is_err());
        }
        for field in ["draft", "prerelease"] {
            let mut release: serde_json::Value =
                serde_json::from_slice(&fixture("v1.4.0")).unwrap();
            release[field] = true.into();
            assert!(parse_release(&serde_json::to_vec(&release).unwrap(), "1.3.43").is_err());
        }
    }
}
