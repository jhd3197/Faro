use super::*;
use bytes::Bytes;
use std::{future::Future, path::Path};
use tokio::io::{AsyncReadExt, AsyncSeekExt};

const CHUNK: usize = 8 * 1024 * 1024;

impl GDriveSession {
    /// Upload with bounded memory. The checkpoint controls cancellation and
    /// progress; server acknowledgements determine the next byte after a retry.
    pub async fn upload_file<F, Fut>(
        &self,
        local: &Path,
        remote: &str,
        mut checkpoint: F,
    ) -> Result<u64>
    where
        F: FnMut(u64) -> Fut,
        Fut: Future<Output = Result<()>>,
    {
        self.upload_file_inner(local, remote, false, &mut checkpoint)
            .await
    }

    pub async fn upload_existing_file<F, Fut>(
        &self,
        local: &Path,
        remote: &str,
        mut checkpoint: F,
    ) -> Result<u64>
    where
        F: FnMut(u64) -> Fut,
        Fut: Future<Output = Result<()>>,
    {
        self.upload_file_inner(local, remote, true, &mut checkpoint)
            .await
    }

    async fn upload_file_inner<F, Fut>(
        &self,
        local: &Path,
        remote: &str,
        existing_only: bool,
        checkpoint: &mut F,
    ) -> Result<u64>
    where
        F: FnMut(u64) -> Fut,
        Fut: Future<Output = Result<()>>,
    {
        let mut file = tokio::fs::File::open(local).await?;
        let metadata = file.metadata().await?;
        let size = metadata.len();
        checkpoint(0).await?;
        let norm = normalize(remote);
        if norm == "/" {
            anyhow::bail!("cannot upload over the Drive root");
        }
        let parent = self.folder_id(&parent_of(&norm)).await?;
        let name = basename(&norm);
        let existing = self.find_child(&parent, name).await?;
        let (method, url, body) = match existing {
            Some((_, true)) => anyhow::bail!("upload destination is a directory: {remote}"),
            Some((id, false)) => (
                Method::PATCH,
                format!(
                    "{}/files/{id}?uploadType=resumable&supportsAllDrives=true",
                    self.upload_base
                ),
                serde_json::json!({}),
            ),
            None if existing_only => anyhow::bail!("Drive file no longer exists: {remote}"),
            None => (
                Method::POST,
                format!(
                    "{}/files?uploadType=resumable&supportsAllDrives=true",
                    self.upload_base
                ),
                serde_json::json!({"name":name,"parents":[parent]}),
            ),
        };
        let mut attempt = 0;
        let init = loop {
            let response = self
                .client
                .request(method.clone(), &url)
                .bearer_auth(self.access_token().await?)
                .header("X-Upload-Content-Type", "application/octet-stream")
                .header("X-Upload-Content-Length", size)
                .json(&body)
                .send()
                .await?;
            if response.status().as_u16() == 401 && attempt == 0 {
                self.force_refresh().await?;
                attempt += 1;
                continue;
            }
            break response.error_for_status().context("start Drive upload")?;
        };
        let location = init
            .headers()
            .get(reqwest::header::LOCATION)
            .context("Drive upload has no session URL")?
            .to_str()?;
        let upload = url::Url::parse(location).context("invalid Drive upload session URL")?;
        if upload.origin() != url::Url::parse(&self.upload_base)?.origin() {
            anyhow::bail!("Drive returned an unexpected upload session host");
        }
        let mut offset = 0;
        let mut retries = 0;
        loop {
            checkpoint(offset).await?;
            let current = file.metadata().await?;
            if current.len() != size || current.modified().ok() != metadata.modified().ok() {
                anyhow::bail!("local file changed during Drive upload");
            }
            file.seek(std::io::SeekFrom::Start(offset)).await?;
            let length = (size - offset).min(CHUNK as u64) as usize;
            let mut chunk = vec![0; length];
            file.read_exact(&mut chunk).await?;
            let range = if size == 0 {
                "bytes */0".to_string()
            } else {
                format!("bytes {offset}-{}/{size}", offset + length as u64 - 1)
            };
            let sent = offset + length as u64;
            let result = self.upload_put(&upload, &range, Bytes::from(chunk)).await;
            let response = match result {
                Ok(r) if !r.status().is_server_error() && r.status().as_u16() != 429 => r,
                _ => {
                    retries += 1;
                    if retries > 3 {
                        anyhow::bail!("Drive upload retry limit reached");
                    }
                    checkpoint(offset).await?;
                    tokio::time::sleep(Duration::from_millis(250 * (1 << retries))).await;
                    self.upload_put(&upload, &format!("bytes */{size}"), Bytes::new())
                        .await?
                }
            };
            match response.status().as_u16() {
                200 | 201 => {
                    if sent != size {
                        anyhow::bail!("Drive completed upload before all bytes were sent");
                    }
                    let result: Value = response
                        .json()
                        .await
                        .context("read completed Drive upload")?;
                    result
                        .get("id")
                        .and_then(Value::as_str)
                        .filter(|s| !s.is_empty())
                        .context("completed Drive upload has no file ID")?;
                    // Completion has already occurred; don't turn a late cancel
                    // into a retry that could create another file.
                    return Ok(size);
                }
                308 => {
                    let accepted = accepted_offset(response.headers())?;
                    if accepted < offset || accepted > sent || accepted >= size {
                        anyhow::bail!("Drive returned an invalid upload offset");
                    }
                    if accepted == offset {
                        retries += 1;
                        if retries > 3 {
                            anyhow::bail!("Drive upload made no progress");
                        }
                    } else {
                        retries = 0;
                    }
                    offset = accepted;
                }
                404 | 410 => anyhow::bail!("Drive upload session expired; retry the transfer"),
                code => anyhow::bail!("Drive upload failed ({code})"),
            }
        }
    }

    async fn upload_put(
        &self,
        url: &url::Url,
        range: &str,
        body: Bytes,
    ) -> Result<reqwest::Response> {
        for attempt in 0..2 {
            let response = self
                .client
                .put(url.clone())
                .bearer_auth(self.access_token().await?)
                .header(reqwest::header::CONTENT_LENGTH, body.len())
                .header(reqwest::header::CONTENT_RANGE, range)
                .body(body.clone())
                .send()
                .await?;
            if response.status().as_u16() == 401 && attempt == 0 {
                self.force_refresh().await?;
            } else {
                return Ok(response);
            }
        }
        unreachable!()
    }
}

fn accepted_offset(headers: &reqwest::header::HeaderMap) -> Result<u64> {
    match headers.get(reqwest::header::RANGE) {
        None => Ok(0),
        Some(range) => range
            .to_str()?
            .strip_prefix("bytes=0-")
            .context("invalid Drive upload range")?
            .parse::<u64>()?
            .checked_add(1)
            .context("invalid Drive upload range"),
    }
}
