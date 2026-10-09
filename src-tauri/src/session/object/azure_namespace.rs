//! Azure Blob namespace operations preserving trailing-slash directory markers.
use super::s3_namespace::{Listing, Object, Prefix};
use crate::profiles::{AuthMethod, ConnectionProfile};
use anyhow::{bail, Context, Result};
use object_store::azure::{AzureAccessKey, AzureAuthorizer, AzureCredential};
use reqwest::{Client, Method, StatusCode};
use serde::Deserialize;
use std::{collections::HashSet, time::Duration};
use url::Url;

#[cfg(test)]
mod tests;

pub struct AzureNamespace {
    client: Client,
    container: Url,
    account: String,
    credential: AzureCredential,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct Page {
    blobs: Blobs,
    #[serde(default)]
    next_marker: String,
}

#[derive(Default, Deserialize)]
struct Blobs {
    #[serde(default, rename = "Blob")]
    objects: Vec<Blob>,
    #[serde(default, rename = "BlobPrefix")]
    prefixes: Vec<BlobPrefix>,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct Blob {
    name: Name,
    properties: Properties,
}

#[derive(Deserialize)]
struct BlobPrefix {
    #[serde(rename = "Name")]
    name: Name,
}

#[derive(Deserialize)]
struct Name {
    #[serde(rename = "$text")]
    value: String,
    #[serde(default, rename = "@Encoded")]
    encoded: bool,
}

impl Name {
    fn decode(self) -> Result<String> {
        if self.encoded {
            Ok(percent_encoding::percent_decode_str(&self.value)
                .decode_utf8()?
                .into_owned())
        } else {
            Ok(self.value)
        }
    }
}

#[derive(Deserialize)]
struct Properties {
    #[serde(rename = "Content-Length")]
    size: u64,
    #[serde(rename = "Last-Modified")]
    modified: String,
    #[serde(rename = "Etag")]
    etag: Option<String>,
}

impl AzureNamespace {
    pub fn new(profile: &ConnectionProfile) -> Result<Self> {
        let account = profile
            .account
            .clone()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| profile.username.clone());
        if account.is_empty() {
            bail!("missing Azure account");
        }
        let endpoint = profile
            .endpoint
            .clone()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| format!("https://{account}.blob.core.windows.net"));
        let mut container = Url::parse(&endpoint)?;
        container
            .path_segments_mut()
            .map_err(|_| anyhow::anyhow!("invalid Azure endpoint"))?
            .pop_if_empty()
            .push(
                profile
                    .bucket
                    .as_deref()
                    .context("missing Azure container")?,
            );
        let AuthMethod::Password { password } = &profile.auth else {
            bail!("Azure requires an account key");
        };
        Ok(Self {
            client: Client::builder()
                .connect_timeout(Duration::from_secs(10))
                .timeout(Duration::from_secs(60))
                .redirect(reqwest::redirect::Policy::none())
                .build()?,
            container,
            account,
            credential: AzureCredential::AccessKey(AzureAccessKey::try_new(password)?),
        })
    }

    fn url(&self, key: &str) -> Result<Url> {
        object_store::path::Path::parse(key)?;
        let mut url = self.container.clone();
        if !key.is_empty() {
            url.path_segments_mut().unwrap().extend(key.split('/'));
        }
        Ok(url)
    }

    async fn request(
        &self,
        method: Method,
        url: Url,
        headers: &[(&str, String)],
    ) -> Result<reqwest::Response> {
        let mut builder = self.client.request(method.clone(), url);
        if method == Method::PUT {
            builder = builder
                .header(reqwest::header::CONTENT_LENGTH, "0")
                .body(Vec::new());
        }
        for (key, value) in headers {
            builder = builder.header(*key, value);
        }
        let mut request = builder.build()?;
        AzureAuthorizer::new(&self.credential, &self.account).authorize(&mut request);
        let response = self
            .client
            .execute(request)
            .await
            .context("Azure namespace request")?;
        if response.status() == StatusCode::NOT_FOUND {
            return Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "Azure blob or container not found",
            )
            .into());
        }
        let code = response
            .headers()
            .get("x-ms-error-code")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("unknown")
            .to_string();
        Ok(response
            .error_for_status()
            .with_context(|| format!("Azure namespace response ({code})"))?)
    }

    pub async fn list(&self, prefix: &str, delimiter: bool) -> Result<Listing> {
        let mut result = Listing::default();
        let mut marker = String::new();
        let mut seen = HashSet::new();
        loop {
            let mut url = self.container.clone();
            {
                let mut query = url.query_pairs_mut();
                query
                    .append_pair("restype", "container")
                    .append_pair("comp", "list")
                    .append_pair("prefix", prefix)
                    .append_pair("maxresults", "1000");
                if delimiter {
                    query.append_pair("delimiter", "/");
                }
                if !marker.is_empty() {
                    query.append_pair("marker", &marker);
                }
            }
            let text = self.request(Method::GET, url, &[]).await?.text().await?;
            let page: Page = quick_xml::de::from_str(&text).context("decode Azure listing")?;
            for blob in page.blobs.objects {
                result.objects.push(Object {
                    key: blob.name.decode()?,
                    size: blob.properties.size,
                    etag: blob.properties.etag,
                    last_modified: chrono::DateTime::parse_from_rfc2822(&blob.properties.modified)?
                        .to_rfc3339(),
                });
            }
            for entry in page.blobs.prefixes {
                result.prefixes.push(Prefix {
                    prefix: entry.name.decode()?,
                });
            }
            marker = page.next_marker;
            if marker.is_empty() {
                break;
            }
            if !seen.insert(marker.clone()) {
                bail!("Azure repeated a listing marker");
            }
        }
        Ok(result)
    }

    pub async fn exists(&self, key: &str) -> Result<bool> {
        match self.request(Method::HEAD, self.url(key)?, &[]).await {
            Ok(_) => Ok(true),
            Err(e)
                if e.downcast_ref::<std::io::Error>()
                    .is_some_and(|e| e.kind() == std::io::ErrorKind::NotFound) =>
            {
                Ok(false)
            }
            Err(e) => Err(e),
        }
    }

    pub async fn mkdir(&self, key: &str) -> Result<()> {
        self.request(
            Method::PUT,
            self.url(key)?,
            &[("x-ms-blob-type", "BlockBlob".into())],
        )
        .await?;
        Ok(())
    }

    pub async fn delete(&self, key: &str) -> Result<()> {
        self.request(Method::DELETE, self.url(key)?, &[]).await?;
        Ok(())
    }

    pub async fn copy(&self, from: &str, to: &str) -> Result<()> {
        let target = self.url(to)?;
        let response = self
            .request(
                Method::PUT,
                target.clone(),
                &[("x-ms-copy-source", self.url(from)?.to_string())],
            )
            .await?;
        let copy_id = response
            .headers()
            .get("x-ms-copy-id")
            .context("Azure copy has no ID")?
            .to_str()?
            .to_string();
        tokio::time::timeout(Duration::from_secs(60), async {
            let mut response = response;
            loop {
                if response
                    .headers()
                    .get("x-ms-copy-id")
                    .and_then(|v| v.to_str().ok())
                    != Some(copy_id.as_str())
                {
                    bail!("Azure destination copy changed while waiting");
                }
                match response
                    .headers()
                    .get("x-ms-copy-status")
                    .and_then(|v| v.to_str().ok())
                {
                    Some("success") => return Ok(()),
                    Some("pending") => {}
                    _ => bail!("Azure copy failed or returned an invalid status; source retained"),
                }
                tokio::time::sleep(Duration::from_millis(200)).await;
                response = self.request(Method::HEAD, target.clone(), &[]).await?;
            }
        })
        .await
        .context("Azure copy still pending; source retained")?
    }
}
