//! Exact-key S3 namespace operations. object_store::Path intentionally strips
//! trailing slashes, so it cannot represent folder markers for PUT/COPY/DELETE.
//! File streaming stays in object_store; signing uses its public SigV4 signer.
use crate::profiles::{AuthMethod, ConnectionProfile};
use anyhow::{bail, Context, Result};
use object_store::aws::{AwsAuthorizer, AwsCredential};
use reqwest::{Client, Method, StatusCode};
use serde::Deserialize;
use std::time::Duration;
use url::Url;

pub struct S3Namespace {
    client: Client,
    bucket_url: Url,
    bucket: String,
    region: String,
    credentials: AwsCredential,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct Listing {
    #[serde(default, rename = "Contents")]
    pub objects: Vec<Object>,
    #[serde(default, rename = "CommonPrefixes")]
    pub prefixes: Vec<Prefix>,
    #[serde(default)]
    next_continuation_token: Option<String>,
    #[serde(default)]
    is_truncated: bool,
    #[serde(default)]
    encoding_type: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct Object {
    pub key: String,
    pub size: u64,
    pub last_modified: String,
    #[serde(rename = "ETag")]
    pub etag: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct Prefix {
    pub prefix: String,
}

impl S3Namespace {
    pub fn new(profile: &ConnectionProfile) -> Result<Self> {
        let bucket = profile.bucket.clone().context("missing S3 bucket")?;
        let region = profile.region.clone().unwrap_or_else(|| "us-east-1".into());
        let endpoint = profile
            .endpoint
            .as_deref()
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| {
                let suffix = if region.starts_with("cn-") {
                    "amazonaws.com.cn"
                } else {
                    "amazonaws.com"
                };
                format!("https://s3.{region}.{suffix}")
            });
        let mut bucket_url = Url::parse(&endpoint).context("invalid S3 endpoint")?;
        bucket_url
            .path_segments_mut()
            .map_err(|_| anyhow::anyhow!("invalid S3 endpoint"))?
            .pop_if_empty()
            .push(&bucket);
        let AuthMethod::Password { password } = &profile.auth else {
            bail!("S3 requires password authentication")
        };
        Ok(Self {
            client: Client::builder()
                .connect_timeout(Duration::from_secs(10))
                .timeout(Duration::from_secs(60))
                .redirect(reqwest::redirect::Policy::none())
                .build()?,
            bucket_url,
            bucket,
            region,
            credentials: AwsCredential {
                key_id: profile.username.clone(),
                secret_key: password.clone(),
                token: None,
            },
        })
    }

    fn object_url(&self, key: &str) -> Result<Url> {
        // Validate without using the normalized return value: the trailing slash
        // is significant. Reject dot segments rather than letting Url erase them.
        if !key.is_empty() {
            object_store::path::Path::parse(key)?;
        }
        let mut url = self.bucket_url.clone();
        if !key.is_empty() {
            url.path_segments_mut().unwrap().extend(key.split('/'));
        }
        Ok(url)
    }

    async fn request(
        &self,
        method: Method,
        url: Url,
        copy_source: Option<&str>,
    ) -> Result<reqwest::Response> {
        let mut builder = self.client.request(method.clone(), url);
        if method == Method::PUT {
            builder = builder.body(Vec::new());
        }
        if let Some(source) = copy_source {
            let encoded: String = url::form_urlencoded::byte_serialize(
                format!("/{}/{source}", self.bucket).as_bytes(),
            )
            .collect::<String>()
            .replace('+', "%20");
            builder = builder.header("x-amz-copy-source", encoded);
        }
        let mut request = builder.build()?;
        AwsAuthorizer::new(&self.credentials, "s3", &self.region).authorize(&mut request, None);
        let response = self
            .client
            .execute(request)
            .await
            .context("S3 namespace request")?;
        if response.status() == StatusCode::NOT_FOUND {
            return Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "S3 object or bucket not found",
            )
            .into());
        }
        Ok(response
            .error_for_status()
            .context("S3 namespace response")?)
    }

    pub async fn list(&self, prefix: &str, delimiter: bool) -> Result<Listing> {
        let mut listing = Listing::default();
        let mut token: Option<String> = None;
        loop {
            let mut url = self.bucket_url.clone();
            {
                let mut query = url.query_pairs_mut();
                query
                    .append_pair("list-type", "2")
                    .append_pair("encoding-type", "url")
                    .append_pair("prefix", prefix);
                if delimiter {
                    query.append_pair("delimiter", "/");
                }
                if let Some(t) = &token {
                    query.append_pair("continuation-token", t);
                }
            }
            let xml = self.request(Method::GET, url, None).await?.text().await?;
            let mut page: Listing = quick_xml::de::from_str(&xml).context("decode S3 listing")?;
            if page.encoding_type.as_deref() == Some("url") {
                for object in &mut page.objects {
                    object.key = percent_encoding::percent_decode_str(&object.key)
                        .decode_utf8()?
                        .into_owned();
                }
                for prefix in &mut page.prefixes {
                    prefix.prefix = percent_encoding::percent_decode_str(&prefix.prefix)
                        .decode_utf8()?
                        .into_owned();
                }
            }
            listing.objects.extend(page.objects);
            listing.prefixes.extend(page.prefixes);
            if !page.is_truncated {
                break;
            }
            let next = page
                .next_continuation_token
                .context("truncated S3 listing has no continuation token")?;
            if token.as_ref() == Some(&next) {
                bail!("S3 listing repeated a continuation token");
            }
            token = Some(next);
        }
        Ok(listing)
    }

    pub async fn exists(&self, key: &str) -> Result<bool> {
        match self
            .request(Method::HEAD, self.object_url(key)?, None)
            .await
        {
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
        self.request(Method::PUT, self.object_url(key)?, None)
            .await?;
        Ok(())
    }

    pub async fn delete(&self, key: &str) -> Result<()> {
        self.request(Method::DELETE, self.object_url(key)?, None)
            .await?;
        Ok(())
    }

    pub async fn copy(&self, from: &str, to: &str) -> Result<()> {
        let xml = self
            .request(Method::PUT, self.object_url(to)?, Some(from))
            .await?
            .text()
            .await?;
        // S3 CopyObject may return HTTP 200 with an embedded error.
        #[derive(Deserialize)]
        struct CopySuccess {
            #[serde(rename = "ETag")]
            etag: String,
        }
        let result: CopySuccess =
            quick_xml::de::from_str(&xml).context("S3 copy did not return a successful result")?;
        if result.etag.is_empty() {
            bail!("S3 copy returned an empty ETag");
        }
        Ok(())
    }
}
