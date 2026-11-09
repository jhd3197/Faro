//! Usage: faro-relay ADDRESS IDENTITY_FILE ALLOWED_KEYS_JSON
use anyhow::{Context, Result};
use faro_agent_proto::Identity;
use std::{collections::HashSet, path::Path};
#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    anyhow::ensure!(args.len() == 3, "usage: faro-relay ADDRESS IDENTITY_FILE ALLOWED_KEYS_JSON");
    let identity = Identity::load_or_create(Path::new(&args[1]))?;
    let allowed: HashSet<String> = serde_json::from_slice(&std::fs::read(&args[2]).context("read allowed public keys")?)?;
    anyhow::ensure!(!allowed.is_empty(), "relay allowlist must not be empty");
    for key in &allowed { faro_agent_proto::decode_public(key)?; }
    let listener = tokio::net::TcpListener::bind(&args[0]).await?;
    println!("Relay public key: {}", identity.public_b64());
    println!("Listening: {}", listener.local_addr()?);
    faro_agentd::relay::serve(listener, identity, allowed).await
}
