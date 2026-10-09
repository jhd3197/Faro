use super::{
    azure_namespace::AzureNamespace,
    s3_namespace::{Listing, S3Namespace},
};
use crate::profiles::ConnectionProfile;
use anyhow::Result;

pub enum Namespace {
    S3(S3Namespace),
    Azure(AzureNamespace),
}

impl Namespace {
    pub fn supported(protocol: &str) -> bool {
        matches!(protocol, "s3" | "azure")
    }
    pub fn new(profile: &ConnectionProfile) -> Result<Self> {
        match profile.protocol.as_str() {
            "s3" => Ok(Self::S3(S3Namespace::new(profile)?)),
            "azure" => Ok(Self::Azure(AzureNamespace::new(profile)?)),
            _ => anyhow::bail!("namespace operations unsupported for {}", profile.protocol),
        }
    }
    pub async fn list(&self, prefix: &str, delimiter: bool) -> Result<Listing> {
        match self {
            Self::S3(a) => a.list(prefix, delimiter).await,
            Self::Azure(a) => a.list(prefix, delimiter).await,
        }
    }
    pub async fn exists(&self, key: &str) -> Result<bool> {
        match self {
            Self::S3(a) => a.exists(key).await,
            Self::Azure(a) => a.exists(key).await,
        }
    }
    pub async fn mkdir(&self, key: &str) -> Result<()> {
        match self {
            Self::S3(a) => a.mkdir(key).await,
            Self::Azure(a) => a.mkdir(key).await,
        }
    }
    pub async fn delete(&self, key: &str) -> Result<()> {
        match self {
            Self::S3(a) => a.delete(key).await,
            Self::Azure(a) => a.delete(key).await,
        }
    }
    pub async fn copy(&self, from: &str, to: &str) -> Result<()> {
        match self {
            Self::S3(a) => a.copy(from, to).await,
            Self::Azure(a) => a.copy(from, to).await,
        }
    }
}
