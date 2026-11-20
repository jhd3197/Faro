//! Inert on-demand provider for every build that isn't Windows-with-`virtualfs`.
//!
//! Keeps the subsystem cross-platform: [`super::VirtualFs`] compiles and runs
//! everywhere, and an on-demand pair configured on an unsupported build degrades
//! to a clear "not available" (via `supported() == false`) instead of a compile
//! error. Mirrors the API surface of `windows.rs` exactly.

use std::path::Path;
use std::sync::Arc;

use anyhow::Result;

use super::{Hydrator, RootConfig};

/// On-demand virtual folders are never available on this build.
pub fn supported() -> bool {
    false
}

/// A no-op provider handle. Never actually constructed (`Provider::start`
/// errors first), but the type must exist so `VirtualFs::running` type-checks.
pub struct Provider;

impl Provider {
    pub async fn start(_config: RootConfig, _hydrator: Arc<dyn Hydrator>) -> Result<Provider> {
        anyhow::bail!("on-demand virtual folders need a Windows build with --features virtualfs")
    }

    pub async fn free_up_space(&self) -> Result<u32> {
        Ok(0)
    }

    /// Files edited locally that the remote doesn't have yet (none here).
    pub fn local_changes(&self) -> Vec<String> {
        Vec::new()
    }

    pub fn stop(self) {}
}

/// No placeholders exist on this build.
pub fn clear_placeholders(_root: &Path) -> u32 {
    0
}

/// Nothing was ever registered with the OS, so unregister is a no-op.
pub fn unregister_root(_pair_id: &str, _local_root: Option<&Path>) -> Result<()> {
    Ok(())
}
