use super::*;
use crate::remotefs::{local::LocalFs, Capabilities, DirEntry};
use async_trait::async_trait;

struct Scratch(std::path::PathBuf);
impl Scratch {
    fn new() -> Self {
        let p = std::env::temp_dir().join(format!("faro-stage-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&p).unwrap();
        Self(p)
    }
    fn root(&self) -> &str {
        self.0.to_str().unwrap()
    }
}
impl Drop for Scratch {
    fn drop(&mut self) {
        assert_eq!(self.0.parent(), Some(std::env::temp_dir().as_path()));
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

async fn replacement(dir: &Scratch) -> StagedReplacement {
    std::fs::write(dir.0.join("file"), b"original").unwrap();
    StagedReplacement {
        destination_key: None,
        root: dir.root().into(),
        batch: new_batch(),
        relative: "file".into(),
        expected: current_state(&LocalFs, dir.root(), "file")
            .await
            .unwrap()
            .unwrap(),
        size: 3,
    }
}

#[tokio::test]
async fn staged_replacement_keeps_original_until_verified_and_preserves_history() {
    let dir = Scratch::new();
    let stage = replacement(&dir).await;
    stage.prepare(&LocalFs).await.unwrap();
    std::fs::write(stage.path(), b"n").unwrap();
    assert!(stage.publish(&LocalFs).await.is_err());
    assert_eq!(std::fs::read(dir.0.join("file")).unwrap(), b"original");
    std::fs::write(stage.path(), b"new").unwrap();
    stage.publish(&LocalFs).await.unwrap();
    assert_eq!(std::fs::read(dir.0.join("file")).unwrap(), b"new");
    assert!(!std::path::Path::new(&stage.path()).exists());
    let versions = list(&LocalFs, dir.root()).await.unwrap();
    assert_eq!(versions.len(), 1);
    let restored = restore(&LocalFs, dir.root(), &versions[0]).await.unwrap();
    assert_eq!(std::fs::read(restored).unwrap(), b"original");
}

#[tokio::test]
async fn staged_replacement_refuses_destination_changed_during_transfer() {
    let dir = Scratch::new();
    let stage = replacement(&dir).await;
    stage.prepare(&LocalFs).await.unwrap();
    std::fs::write(stage.path(), b"new").unwrap();
    std::fs::write(dir.0.join("file"), b"someone else changed this").unwrap();
    assert!(stage.publish(&LocalFs).await.is_err());
    assert_eq!(
        std::fs::read(dir.0.join("file")).unwrap(),
        b"someone else changed this"
    );
}

enum Failure {
    Publish,
    PreserveLostReply,
    Rollback,
    LostReply,
    Collision,
}
struct FaultFs(Failure);
#[async_trait]
impl RemoteFs for FaultFs {
    async fn list_dir(&self, p: &str) -> Result<Vec<DirEntry>> {
        LocalFs.list_dir(p).await
    }
    async fn rename(&self, a: &str, b: &str) -> Result<()> {
        LocalFs.rename(a, b).await?;
        if matches!(self.0, Failure::PreserveLostReply) && b.contains(DIRECTORY) {
            bail!("injected lost preservation reply");
        }
        Ok(())
    }
    async fn rename_no_replace(&self, a: &str, b: &str) -> Result<()> {
        if a.contains(STAGING) {
            match self.0 {
                Failure::LostReply => {
                    LocalFs.rename_no_replace(a, b).await?;
                }
                Failure::Collision => {
                    std::fs::write(b, b"concurrent writer")?;
                }
                _ => {}
            }
            bail!("injected publication failure")
        }
        if matches!(self.0, Failure::Rollback) {
            bail!("injected rollback failure")
        }
        LocalFs.rename_no_replace(a, b).await
    }
    async fn delete(&self, p: &str, r: bool) -> Result<()> {
        LocalFs.delete(p, r).await
    }
    async fn create_dir(&self, p: &str) -> Result<()> {
        LocalFs.create_dir(p).await
    }
    async fn chmod(&self, p: &str, m: u32) -> Result<()> {
        LocalFs.chmod(p, m).await
    }
    fn capabilities(&self) -> Capabilities {
        LocalFs.capabilities()
    }
}

#[tokio::test]
async fn staged_replacement_rolls_back_failed_publication() {
    let dir = Scratch::new();
    let stage = replacement(&dir).await;
    stage.prepare(&LocalFs).await.unwrap();
    std::fs::write(stage.path(), b"new").unwrap();
    let error = stage.publish(&FaultFs(Failure::Publish)).await.unwrap_err();
    assert!(error.is::<PublicationError>());
    assert!(error.to_string().contains("previous file restored"));
    assert_eq!(std::fs::read(dir.0.join("file")).unwrap(), b"original");
    assert_eq!(std::fs::read(stage.path()).unwrap(), b"new");
}

#[tokio::test]
async fn staged_replacement_retains_both_versions_if_rollback_fails() {
    let dir = Scratch::new();
    let stage = replacement(&dir).await;
    stage.prepare(&LocalFs).await.unwrap();
    std::fs::write(stage.path(), b"new").unwrap();
    let error = stage
        .publish(&FaultFs(Failure::Rollback))
        .await
        .unwrap_err();
    assert!(error.to_string().contains("automatic restore failed"));
    assert_eq!(list(&LocalFs, dir.root()).await.unwrap().len(), 1);
    assert_eq!(std::fs::read(stage.path()).unwrap(), b"new");
}

#[tokio::test]
async fn staged_replacement_never_rolls_back_over_an_existing_destination() {
    for (failure, expected) in [
        (Failure::LostReply, b"new".as_slice()),
        (Failure::Collision, b"concurrent writer".as_slice()),
    ] {
        let dir = Scratch::new();
        let stage = replacement(&dir).await;
        stage.prepare(&LocalFs).await.unwrap();
        std::fs::write(stage.path(), b"new").unwrap();
        assert!(stage.publish(&FaultFs(failure)).await.is_err());
        assert_eq!(std::fs::read(dir.0.join("file")).unwrap(), expected);
        assert_eq!(list(&LocalFs, dir.root()).await.unwrap().len(), 1);
    }
}

#[tokio::test]
async fn staged_files_are_never_sync_inputs() {
    let dir = Scratch::new();
    let stage = replacement(&dir).await;
    stage.prepare(&LocalFs).await.unwrap();
    std::fs::write(stage.path(), b"new").unwrap();
    let tree = crate::scan::sync_tree(&LocalFs, dir.root(), false)
        .await
        .unwrap();
    assert_eq!(tree.files.len(), 1);
    assert!(tree.directories.iter().all(|p| !p.contains(STAGING)));
    assert!(validate_root(&stage.path()).is_err());
}

#[tokio::test]
async fn local_publication_refuses_late_collision() {
    let dir = Scratch::new();
    std::fs::write(dir.0.join("source"), b"new").unwrap();
    std::fs::write(dir.0.join("target"), b"keep").unwrap();
    assert!(LocalFs
        .rename_no_replace(
            dir.0.join("source").to_str().unwrap(),
            dir.0.join("target").to_str().unwrap()
        )
        .await
        .is_err());
    assert_eq!(std::fs::read(dir.0.join("target")).unwrap(), b"keep");
}

#[tokio::test]
async fn staged_replacement_recovers_a_lost_preservation_reply() {
    let dir = Scratch::new();
    let stage = replacement(&dir).await;
    stage.prepare(&LocalFs).await.unwrap();
    std::fs::write(stage.path(), b"new").unwrap();
    let error = stage
        .publish(&FaultFs(Failure::PreserveLostReply))
        .await
        .unwrap_err();
    assert!(error.to_string().contains("previous file restored"));
    assert_eq!(std::fs::read(dir.0.join("file")).unwrap(), b"original");
    assert_eq!(std::fs::read(stage.path()).unwrap(), b"new");
}
