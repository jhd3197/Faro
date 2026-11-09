//! Authenticated rendezvous. After Ready, the stream carries the original
//! end-to-end Agent handshake; relay authentication never replaces peer pins.
use crate::{decode_public, Auth, Identity, Role, SecureChannel};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tokio::net::TcpStream;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayConfig {
    pub address: String,
    pub public_key: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Registration {
    Listen,
    Connect { target: String },
}

#[derive(Debug, Serialize, Deserialize)]
pub enum Reply { Waiting, Ready, Unavailable, Denied }

pub async fn connect(config: &RelayConfig, identity: &Identity, request: Registration) -> Result<TcpStream> {
    connect_monitored(config, identity, request, None).await
}

pub async fn connect_monitored(config: &RelayConfig, identity: &Identity, request: Registration, online: Option<&std::sync::atomic::AtomicBool>) -> Result<TcpStream> {
    let listening = matches!(request, Registration::Listen);
    let expect = decode_public(&config.public_key)?;
    anyhow::ensure!(expect.len() == 32, "relay public key must be 32 bytes");
    let mut channel = tokio::time::timeout(Duration::from_secs(15), async {
        let stream = TcpStream::connect(&config.address).await.context("connect to relay")?;
        let mut channel = SecureChannel::establish(stream, Role::Initiator, &identity.private_bytes()?,
            Auth::Paired { expect_remote: Some(expect) }).await?;
        channel.send(&request).await?;
        Ok::<_, anyhow::Error>(channel)
    }).await.context("relay connection timed out")??;
    loop { match tokio::time::timeout(Duration::from_secs(35), channel.recv::<Reply>()).await.context("relay rendezvous timed out")?? {
        Reply::Waiting if listening => { if let Some(online) = online { online.store(true, std::sync::atomic::Ordering::Relaxed); } },
        Reply::Waiting => bail!("unexpected relay registration reply"),
        Reply::Ready => return Ok(channel.into_inner()),
        Reply::Unavailable => bail!("remote Agent is not waiting at the relay; check its relay connection"),
        Reply::Denied => bail!("relay access denied; ask its administrator to allow this identity"),
    }}
}
