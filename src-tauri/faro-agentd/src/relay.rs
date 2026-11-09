//! Self-hosted relay and outbound daemon listener. Only allowed identities can
//! register or connect. The relay sees traffic volume, never Agent payloads.
use anyhow::{Context, Result};
use faro_agent_proto::{relay::{Registration, Reply, RelayConfig}, Auth, Identity, Role, SecureChannel};
use std::{collections::{HashMap, HashSet}, sync::Arc, time::Duration};
use tokio::{net::{TcpListener, TcpStream}, sync::{Mutex, Semaphore, oneshot}};

type Waiting = Arc<Mutex<HashMap<String, oneshot::Sender<SecureChannel<TcpStream>>>>>;

pub async fn serve(listener: TcpListener, identity: Identity, allowed: HashSet<String>) -> Result<()> {
    let identity = Arc::new(identity);
    let allowed = Arc::new(allowed);
    let waiting: Waiting = Default::default();
    let limit = Arc::new(Semaphore::new(128));
    loop {
        let (stream, _) = listener.accept().await?;
        let Ok(permit) = limit.clone().try_acquire_owned() else { continue };
        let (identity, allowed, waiting) = (identity.clone(), allowed.clone(), waiting.clone());
        tokio::spawn(async move {
            let _permit = permit;
            if let Err(e) = handle(stream, &identity, &allowed, waiting).await {
                tracing::debug!("relay connection closed: {e}");
            }
        });
    }
}

async fn handle(stream: TcpStream, identity: &Identity, allowed: &HashSet<String>, waiting: Waiting) -> Result<()> {
    let (mut channel, request) = tokio::time::timeout(Duration::from_secs(10), async {
        let mut channel = SecureChannel::establish(stream, Role::Responder, &identity.private_bytes()?, Auth::Paired { expect_remote: None }).await?;
        if !allowed.contains(&channel.remote_static_b64()) {
            channel.send(&Reply::Denied).await?;
            anyhow::bail!("identity is not allowed");
        }
        let request = channel.recv::<Registration>().await?;
        Ok::<_, anyhow::Error>((channel, request))
    }).await.context("relay registration timeout")??;
    match request {
        Registration::Listen => {
            channel.send(&Reply::Waiting).await?;
            let key = channel.remote_static_b64();
            let (tx, rx) = oneshot::channel();
            {
                let mut map = waiting.lock().await;
                if map.contains_key(&key) { channel.send(&Reply::Denied).await?; return Ok(()) }
                map.insert(key.clone(), tx);
            }
            let remote = tokio::time::timeout(Duration::from_secs(30), rx).await;
            // Connect removes the slot before handing off. Never remove a newer slot.
            if remote.is_err() { let mut map = waiting.lock().await; if map.get(&key).is_some_and(|sender| sender.is_closed()) { map.remove(&key); } }
            let mut remote = match remote {
                Ok(Ok(remote)) => remote,
                _ => { channel.send(&Reply::Unavailable).await?; return Ok(()) }
            };
            channel.send(&Reply::Ready).await?;
            remote.send(&Reply::Ready).await?;
            let (mut host, mut client) = (channel.into_inner(), remote.into_inner());
            // Bound a single tunnel's lifetime; the Agent client reconnects.
            let _ = tokio::time::timeout(Duration::from_secs(24 * 3600), tokio::io::copy_bidirectional(&mut host, &mut client)).await;
        }
        Registration::Connect { target } => {
            let tx = waiting.lock().await.remove(&target);
            if let Some(tx) = tx {
                if let Err(mut channel) = tx.send(channel) { channel.send(&Reply::Unavailable).await?; }
            } else { channel.send(&Reply::Unavailable).await?; }
        }
    }
    Ok(())
}

/// Maintain an outbound waiting socket, replenishing it as each client arrives.
/// Aborting this future drops its active connections as well.
pub async fn listen(config: RelayConfig, daemon: crate::Daemon) {
    listen_monitored(config, daemon, Arc::new(std::sync::atomic::AtomicBool::new(false))).await;
}

pub async fn listen_monitored(config: RelayConfig, daemon: crate::Daemon, online: Arc<std::sync::atomic::AtomicBool>) {
    let mut connections = tokio::task::JoinSet::new();
    loop {
        while connections.try_join_next().is_some() {}
        if connections.len() >= 32 { connections.join_next().await; continue; }
        match faro_agent_proto::relay::connect_monitored(&config, &daemon.identity, Registration::Listen, Some(&online)).await {
            Ok(stream) => {
                let daemon = daemon.clone();
                connections.spawn(async move { let _ = crate::server::dispatch(stream, daemon).await; });
            }
            Err(_) => { online.store(false, std::sync::atomic::Ordering::Relaxed); tokio::time::sleep(Duration::from_secs(2)).await; },
        }
    }
}
