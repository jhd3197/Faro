use super::{Capabilities, ChangeSignal, DirEntry, FileKind, RemoteFs};
use crate::session::gdrive::normalize;
use crate::session::wordpress::{RouteInfo, WordPressSession};
use anyhow::{anyhow, Result};
use async_trait::async_trait;
use std::collections::BTreeSet;
use std::sync::Arc;

/// RemoteFs over a WordPress site's REST API. The root holds two virtual
/// directories:
///
/// - `media/` — the media library, foldered by each attachment's path under
///   `uploads/` (`2026/10/photo.jpg`). Read, upload (WordPress picks the
///   year/month folder) and delete; no rename or mkdir.
/// - `rest/` — every REST namespace the site registers (`wp/v2`, `gf/v2`,
///   `wc/v3`…). A route with an `/{id}` sibling is a collection directory
///   of `{id}.json` items; a plain GET route is a single `{name}.json`.
///   Saving a file PUTs it back (refused when the resource changed since it
///   was opened); writing a new name into a collection POSTs a new item.
pub struct WordPressFs {
    session: Arc<WordPressSession>,
}

impl WordPressFs {
    pub fn new(session: Arc<WordPressSession>) -> Self {
        Self { session }
    }
}

pub const MEDIA_DIR: &str = "media";
pub const REST_DIR: &str = "rest";

/// Where a Faro path lands.
#[derive(Debug, PartialEq, Eq)]
pub enum Loc {
    Root,
    /// `media/…` — the inner path ("" for the media root).
    Media(String),
    /// `rest/…` — the inner segments (empty for the rest root).
    Rest(Vec<String>),
}

pub fn locate(faro_path: &str) -> Result<Loc> {
    let norm = normalize(faro_path);
    let t = norm.trim_start_matches('/');
    if t.is_empty() {
        return Ok(Loc::Root);
    }
    let (root, rest) = t.split_once('/').unwrap_or((t, ""));
    match root {
        MEDIA_DIR => Ok(Loc::Media(rest.trim_matches('/').to_string())),
        REST_DIR => Ok(Loc::Rest(
            rest.split('/').filter(|s| !s.is_empty()).map(String::from).collect(),
        )),
        _ => Err(anyhow!(
            "{faro_path}: unknown WordPress root — expected /{MEDIA_DIR} or /{REST_DIR}"
        )),
    }
}

/// One resource under a namespace: a collection directory or a single
/// `{name}.json` file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Resource {
    pub name: String,
    pub collection: bool,
}

/// Resources of a namespace, from the discovery routes. `/{ns}/{name}` with a
/// sibling `/{ns}/{name}/(?P<id>…)` is a collection; a GET-able `/{ns}/{name}`
/// without one is a single resource. Deeper routes are left to `wp rest`.
pub fn resources(ns: &str, routes: &[RouteInfo]) -> Vec<Resource> {
    let prefix = format!("/{ns}/");
    let mut singles = BTreeSet::new();
    let mut collections = BTreeSet::new();
    for r in routes {
        let Some(tail) = r.route.strip_prefix(&prefix) else { continue };
        let segs: Vec<&str> = tail.split('/').collect();
        let first = segs[0];
        if first.is_empty() || first.contains('(') || first.contains('?') {
            continue;
        }
        match segs.len() {
            1 if r.methods.iter().any(|m| m == "GET") => {
                singles.insert(first.to_string());
            }
            2 if segs[1].starts_with("(?P<") => {
                collections.insert(first.to_string());
            }
            _ => {}
        }
    }
    let mut out: Vec<Resource> = collections
        .iter()
        .map(|n| Resource { name: n.clone(), collection: true })
        .collect();
    out.extend(
        singles
            .difference(&collections)
            .map(|n| Resource { name: n.clone(), collection: false }),
    );
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// What a `rest/…` path is.
#[derive(Debug, PartialEq, Eq)]
pub enum RestLoc {
    /// A namespace prefix (`rest/wp`): child segments.
    Dir(Vec<String>),
    /// A full namespace (`rest/wp/v2`): its resources plus any deeper
    /// namespace segments.
    Namespace { ns: String, more: Vec<String> },
    /// `rest/gf/v2/forms` → route `/gf/v2/forms`.
    Collection { route: String },
    /// `rest/gf/v2/forms/1.json` → `/gf/v2/forms/1`, in collection `coll`.
    Item { route: String, coll: String, id: String },
    /// `rest/wp/v2/settings.json` → `/wp/v2/settings`.
    Single { route: String },
}

/// Next segments of namespaces below `prefix` (all segments when empty).
fn child_segments(namespaces: &[String], prefix: &[String]) -> Vec<String> {
    let mut set = BTreeSet::new();
    for ns in namespaces {
        let segs: Vec<&str> = ns.split('/').collect();
        if segs.len() > prefix.len() && segs.iter().zip(prefix).all(|(a, b)| *a == b) {
            set.insert(segs[prefix.len()].to_string());
        }
    }
    set.into_iter().collect()
}

pub fn resolve_rest(namespaces: &[String], routes: &[RouteInfo], segs: &[String]) -> Result<RestLoc> {
    let display = || format!("/{REST_DIR}/{}", segs.join("/"));
    // Longest namespace that prefixes the path.
    let ns = namespaces
        .iter()
        .filter(|ns| {
            let n: Vec<&str> = ns.split('/').collect();
            n.len() <= segs.len() && n.iter().zip(segs).all(|(a, b)| *a == b)
        })
        .max_by_key(|ns| ns.split('/').count());
    let Some(ns) = ns else {
        let kids = child_segments(namespaces, segs);
        if kids.is_empty() && !segs.is_empty() {
            return Err(anyhow!("{}: no such REST namespace", display()));
        }
        return Ok(RestLoc::Dir(kids));
    };
    let depth = ns.split('/').count();
    let rest = &segs[depth..];
    let res = resources(ns, routes);
    let find = |name: &str| res.iter().find(|r| r.name == name);
    match rest {
        [] => Ok(RestLoc::Namespace {
            ns: ns.clone(),
            more: child_segments(namespaces, segs),
        }),
        [name] => {
            if let Some(r) = find(name).filter(|r| r.collection) {
                return Ok(RestLoc::Collection { route: format!("/{ns}/{}", r.name) });
            }
            if let Some(stem) = name.strip_suffix(".json") {
                if find(stem).is_some_and(|r| !r.collection) {
                    return Ok(RestLoc::Single { route: format!("/{ns}/{stem}") });
                }
            }
            Err(anyhow!("{}: not found", display()))
        }
        [coll, item] => {
            let id = item
                .strip_suffix(".json")
                .filter(|id| !id.is_empty())
                .ok_or_else(|| anyhow!("{}: items are `{{id}}.json` files", display()))?;
            if !find(coll).is_some_and(|r| r.collection) {
                return Err(anyhow!("{}: not found", display()));
            }
            let coll = format!("/{ns}/{coll}");
            Ok(RestLoc::Item { route: format!("{coll}/{id}"), coll, id: id.to_string() })
        }
        _ => Err(anyhow!(
            "{}: too deep — use `faro-cli wp <connection> rest GET <route>` for nested routes",
            display()
        )),
    }
}

fn dir_entry(base: &str, name: &str) -> DirEntry {
    DirEntry {
        name: name.to_string(),
        path: join(base, name),
        kind: FileKind::Directory,
        size: 0,
        modified: None,
        mode: None,
        etag: None,
    }
}

fn file_entry(base: &str, name: &str, size: u64, modified: Option<i64>) -> DirEntry {
    DirEntry {
        name: name.to_string(),
        path: join(base, name),
        kind: FileKind::File,
        size,
        modified,
        mode: None,
        etag: None,
    }
}

fn join(base: &str, name: &str) -> String {
    if base == "/" {
        format!("/{name}")
    } else {
        format!("{base}/{name}")
    }
}

/// Children of a media folder (`inner` = "" or `2026` or `2026/10`).
fn media_children(base: &str, inner: &str, items: &[crate::session::wordpress::MediaItem]) -> Vec<DirEntry> {
    let prefix = if inner.is_empty() { String::new() } else { format!("{inner}/") };
    let mut dirs = BTreeSet::new();
    let mut files = Vec::new();
    for m in items {
        let Some(rest) = m.path.strip_prefix(&prefix) else { continue };
        match rest.split_once('/') {
            Some((d, _)) => {
                dirs.insert(d.to_string());
            }
            None if !rest.is_empty() => files.push(file_entry(base, rest, m.size, m.modified)),
            None => {}
        }
    }
    let mut out: Vec<DirEntry> = dirs.iter().map(|d| dir_entry(base, d)).collect();
    out.extend(files);
    out
}

async fn media_item(
    session: &WordPressSession,
    inner: &str,
) -> Result<Option<crate::session::wordpress::MediaItem>> {
    Ok(session.media().await?.iter().find(|m| m.path == inner).cloned())
}

/// Read one file's bytes, for the transfer + editor + preview arms.
pub async fn read_file(session: &WordPressSession, faro_path: &str) -> Result<Vec<u8>> {
    match locate(faro_path)? {
        Loc::Root => Err(anyhow!("/ is a directory")),
        Loc::Media(inner) => {
            let item = media_item(session, &inner)
                .await?
                .ok_or_else(|| anyhow!("{faro_path}: not found"))?;
            session.media_read(&item).await
        }
        Loc::Rest(segs) => {
            match resolve_rest(&session.namespaces(), &session.routes(), &segs)? {
                RestLoc::Item { route, .. } | RestLoc::Single { route } => {
                    session.resource_read(&normalize(faro_path), &route).await
                }
                _ => Err(anyhow!("{faro_path} is a directory, not a file")),
            }
        }
    }
}

/// Write one file (editor save, upload).
pub async fn write_file(session: &WordPressSession, faro_path: &str, data: &[u8]) -> Result<()> {
    match locate(faro_path)? {
        Loc::Root => Err(anyhow!("/ is a directory")),
        Loc::Media(inner) => {
            if inner.is_empty() {
                return Err(anyhow!("pick a file name under /{MEDIA_DIR}"));
            }
            if let Some(existing) = media_item(session, &inner).await? {
                return Err(anyhow!(
                    "{faro_path} already exists — the media library can't replace a file in \
                     place. Delete it first (attachment {}), then upload.",
                    existing.id
                ));
            }
            let name = inner.rsplit('/').next().unwrap_or(&inner);
            session.media_upload(name, data).await
        }
        Loc::Rest(segs) => {
            let key = normalize(faro_path);
            match resolve_rest(&session.namespaces(), &session.routes(), &segs)? {
                RestLoc::Single { route } => session.resource_write(&key, &route, None, data).await,
                RestLoc::Item { route, coll, id } => {
                    let exists = session.collection(&coll).await?.iter().any(|i| i.id == id);
                    if exists {
                        session.resource_write(&key, &route, None, data).await
                    } else {
                        session.resource_write(&key, &route, Some(&coll), data).await
                    }
                }
                _ => Err(anyhow!("{faro_path} is a directory, not a file")),
            }
        }
    }
}

/// Best-effort size (0 when unknown — REST items are sized from the listing).
pub async fn file_size(session: &WordPressSession, faro_path: &str) -> u64 {
    match locate(faro_path) {
        Ok(Loc::Media(inner)) => media_item(session, &inner)
            .await
            .ok()
            .flatten()
            .map(|m| m.size)
            .unwrap_or(0),
        Ok(Loc::Rest(segs)) => match resolve_rest(&session.namespaces(), &session.routes(), &segs) {
            Ok(RestLoc::Item { coll, id, .. }) => session
                .collection(&coll)
                .await
                .ok()
                .and_then(|l| l.iter().find(|i| i.id == id).map(|i| i.size))
                .unwrap_or(0),
            _ => 0,
        },
        _ => 0,
    }
}

pub async fn file_exists(session: &WordPressSession, faro_path: &str) -> bool {
    match locate(faro_path) {
        Ok(Loc::Media(inner)) => media_item(session, &inner).await.ok().flatten().is_some(),
        Ok(Loc::Rest(segs)) => match resolve_rest(&session.namespaces(), &session.routes(), &segs) {
            Ok(RestLoc::Item { coll, id, .. }) => session
                .collection(&coll)
                .await
                .map(|l| l.iter().any(|i| i.id == id))
                .unwrap_or(false),
            Ok(RestLoc::Single { .. }) => true,
            _ => false,
        },
        _ => false,
    }
}

#[async_trait]
impl RemoteFs for WordPressFs {
    async fn list_dir(&self, path: &str) -> Result<Vec<DirEntry>> {
        let base = normalize(path);
        match locate(path)? {
            Loc::Root => Ok(vec![dir_entry("/", MEDIA_DIR), dir_entry("/", REST_DIR)]),
            Loc::Media(inner) => {
                let items = self.session.media().await?;
                let out = media_children(&base, &inner, &items);
                if out.is_empty() && !inner.is_empty() {
                    return Err(anyhow!("{base}: not found"));
                }
                Ok(out)
            }
            Loc::Rest(segs) => {
                let ns = self.session.namespaces();
                let routes = self.session.routes();
                match resolve_rest(&ns, &routes, &segs)? {
                    RestLoc::Dir(kids) => Ok(kids.iter().map(|k| dir_entry(&base, k)).collect()),
                    RestLoc::Namespace { ns, more } => {
                        let mut out: Vec<DirEntry> =
                            more.iter().map(|k| dir_entry(&base, k)).collect();
                        for r in resources(&ns, &routes) {
                            if r.collection {
                                out.push(dir_entry(&base, &r.name));
                            } else {
                                out.push(file_entry(&base, &format!("{}.json", r.name), 0, None));
                            }
                        }
                        Ok(out)
                    }
                    RestLoc::Collection { route } => {
                        let items = self.session.collection(&route).await?;
                        Ok(items
                            .iter()
                            .map(|i| file_entry(&base, &format!("{}.json", i.id), i.size, i.modified))
                            .collect())
                    }
                    RestLoc::Item { .. } | RestLoc::Single { .. } => {
                        Err(anyhow!("{base} is a file, not a directory"))
                    }
                }
            }
        }
    }

    async fn rename(&self, _from: &str, _to: &str) -> Result<()> {
        Err(anyhow!(
            "WordPress media and REST resources can't be renamed from Faro — edit the \
             resource's own name/title field instead"
        ))
    }

    async fn delete(&self, path: &str, _recursive: bool) -> Result<()> {
        match locate(path)? {
            Loc::Root => Err(anyhow!("the root can't be deleted")),
            Loc::Media(inner) => {
                let item = media_item(&self.session, &inner)
                    .await?
                    .ok_or_else(|| anyhow!("{path}: not found (folders can't be deleted)"))?;
                self.session.media_delete(item.id).await
            }
            Loc::Rest(segs) => {
                match resolve_rest(&self.session.namespaces(), &self.session.routes(), &segs)? {
                    RestLoc::Item { route, .. } => self.session.resource_delete(&route).await,
                    _ => Err(anyhow!("{path}: only collection items can be deleted")),
                }
            }
        }
    }

    async fn create_dir(&self, path: &str) -> Result<()> {
        Err(anyhow!(
            "{path}: WordPress decides media folders (year/month) and REST routes are fixed — \
             no new folders"
        ))
    }

    async fn chmod(&self, _path: &str, _mode: u32) -> Result<()> {
        Err(anyhow!("not supported"))
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            can_chmod: false,
            can_symlink: false,
            can_rename: false,
            has_directories: true,
            has_shell: false,
            has_commands: true,
            change_signal: ChangeSignal::MtimeSize,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(route: &str, methods: &[&str]) -> RouteInfo {
        RouteInfo { route: route.into(), methods: methods.iter().map(|s| s.to_string()).collect() }
    }

    fn fixture() -> (Vec<String>, Vec<RouteInfo>) {
        (
            vec!["oembed/1.0".into(), "wp/v2".into(), "gf/v2".into()],
            vec![
                r("/wp/v2", &["GET"]),
                r("/wp/v2/posts", &["GET", "POST"]),
                r("/wp/v2/posts/(?P<id>[\\d]+)", &["GET", "POST", "PUT", "PATCH", "DELETE"]),
                r("/wp/v2/posts/(?P<parent>[\\d]+)/revisions", &["GET"]),
                r("/wp/v2/settings", &["GET", "POST", "PUT", "PATCH"]),
                r("/gf/v2/forms", &["GET", "POST"]),
                r("/gf/v2/forms/(?P<form_id>[\\d]+)", &["GET", "PUT", "DELETE"]),
                r("/gf/v2/feeds", &["GET", "POST"]),
                r("/gf/v2/feeds/(?P<feed_id>[\\d]+)", &["GET", "PUT", "DELETE"]),
            ],
        )
    }

    fn segs(p: &str) -> Vec<String> {
        p.split('/').filter(|s| !s.is_empty()).map(String::from).collect()
    }

    #[test]
    fn locate_roots() {
        assert_eq!(locate("/").unwrap(), Loc::Root);
        assert_eq!(locate("/media/2026/10").unwrap(), Loc::Media("2026/10".into()));
        assert_eq!(locate("/rest/gf/v2").unwrap(), Loc::Rest(segs("gf/v2")));
        assert!(locate("/nope").is_err());
    }

    #[test]
    fn resources_split_collections_and_singles() {
        let (_, routes) = fixture();
        let res = resources("wp/v2", &routes);
        assert_eq!(
            res,
            vec![
                Resource { name: "posts".into(), collection: true },
                Resource { name: "settings".into(), collection: false },
            ]
        );
    }

    #[test]
    fn rest_paths_resolve() {
        let (ns, routes) = fixture();
        assert_eq!(
            resolve_rest(&ns, &routes, &[]).unwrap(),
            RestLoc::Dir(vec!["gf".into(), "oembed".into(), "wp".into()])
        );
        assert_eq!(resolve_rest(&ns, &routes, &segs("gf")).unwrap(), RestLoc::Dir(vec!["v2".into()]));
        assert!(matches!(
            resolve_rest(&ns, &routes, &segs("gf/v2")).unwrap(),
            RestLoc::Namespace { .. }
        ));
        assert_eq!(
            resolve_rest(&ns, &routes, &segs("gf/v2/forms")).unwrap(),
            RestLoc::Collection { route: "/gf/v2/forms".into() }
        );
        assert_eq!(
            resolve_rest(&ns, &routes, &segs("gf/v2/forms/1.json")).unwrap(),
            RestLoc::Item {
                route: "/gf/v2/forms/1".into(),
                coll: "/gf/v2/forms".into(),
                id: "1".into()
            }
        );
        assert_eq!(
            resolve_rest(&ns, &routes, &segs("wp/v2/settings.json")).unwrap(),
            RestLoc::Single { route: "/wp/v2/settings".into() }
        );
        assert!(resolve_rest(&ns, &routes, &segs("wp/v2/nope")).is_err());
        assert!(resolve_rest(&ns, &routes, &segs("zz")).is_err());
    }

    #[test]
    fn media_tree() {
        use crate::session::wordpress::MediaItem;
        let m = |p: &str| MediaItem { id: 1, path: p.into(), size: 5, modified: None, url: String::new() };
        let items = vec![m("2026/10/a.jpg"), m("2026/09/b.png"), m("logo.svg")];
        let root: Vec<_> = media_children("/media", "", &items).into_iter().map(|e| e.name).collect();
        assert_eq!(root, vec!["2026", "logo.svg"]);
        let oct: Vec<_> = media_children("/media/2026/10", "2026/10", &items)
            .into_iter()
            .map(|e| e.path)
            .collect();
        assert_eq!(oct, vec!["/media/2026/10/a.jpg"]);
    }

    /// Round trip against a real WordPress (see `src-tauri/tests/wordpress/`):
    /// discovery, REST resources as files (read → edit → PUT, stale refusal,
    /// create, delete), a single resource (settings), the media library and
    /// the plugin toggle. Env: FARO_WP_TEST_URL, FARO_WP_TEST_USER,
    /// FARO_WP_TEST_PASSWORD (an Application Password).
    #[tokio::test]
    #[ignore = "requires a live WordPress (FARO_WP_TEST_URL)"]
    async fn live_wordpress_rest() {
        use crate::profiles::{AuthMethod, ConnectionProfile};
        use crate::session::wordpress::{credential_key, wordpress_connect};
        use reqwest::Method;

        let (Ok(url), Ok(user), Ok(pw)) = (
            std::env::var("FARO_WP_TEST_URL"),
            std::env::var("FARO_WP_TEST_USER"),
            std::env::var("FARO_WP_TEST_PASSWORD"),
        ) else {
            eprintln!("skip: FARO_WP_TEST_URL/USER/PASSWORD unset");
            return;
        };
        let profile = ConnectionProfile {
            icon: None,
            id: "wordpress-live-test".into(),
            name: "wp".into(),
            protocol: "wordpress".into(),
            host: String::new(),
            port: 443,
            username: user,
            auth: AuthMethod::Password { password: String::new() },
            default_remote_path: None,
            color: None,
            auto_connect: None,
            bucket: None,
            region: None,
            endpoint: Some(url),
            account: None,
            agent_key: None,
            group: None,
            sort_order: None,
            jump_host: None,
            jump_port: None,
            jump_username: None,
            ftp_encoding: None,
            ftp_active_mode: None,
            ftp_max_connections: None,
            ftp_segments: None,
        };
        let key = credential_key(&profile.id);
        crate::credentials::set_secret(&key, &pw).expect("seed secret");
        let session = Arc::new(wordpress_connect(&profile).await.expect("connect"));
        let fs = WordPressFs::new(session.clone());
        let names = |v: Vec<DirEntry>| v.into_iter().map(|e| e.name).collect::<Vec<_>>();

        // Discovery → directories.
        assert_eq!(names(fs.list_dir("/").await.unwrap()), vec!["media", "rest"]);
        let rest = names(fs.list_dir("/rest").await.unwrap());
        assert!(rest.contains(&"wp".to_string()) && rest.contains(&"faro-test".to_string()), "{rest:?}");
        let ns = names(fs.list_dir("/rest/faro-test/v1").await.unwrap());
        assert_eq!(ns, vec!["items"]);
        let wpv2 = names(fs.list_dir("/rest/wp/v2").await.unwrap());
        assert!(wpv2.contains(&"posts".to_string()) && wpv2.contains(&"settings.json".to_string()), "{wpv2:?}");

        // Edit an item in place: read → change → save (PUT).
        let items = names(fs.list_dir("/rest/faro-test/v1/items").await.unwrap());
        assert!(items.contains(&"1.json".to_string()), "{items:?}");
        let path = "/rest/faro-test/v1/items/1.json";
        let raw = read_file(&session, path).await.unwrap();
        let mut v: serde_json::Value = serde_json::from_slice(&raw).unwrap();
        v["notifications"][0]["to"] = "new@example.com".into();
        write_file(&session, path, &serde_json::to_vec_pretty(&v).unwrap()).await.unwrap();
        let back = session.json(Method::GET, "/faro-test/v1/items/1", None).await.unwrap();
        assert_eq!(back["notifications"][0]["to"], "new@example.com");

        // Stale save is refused.
        let _ = read_file(&session, path).await.unwrap();
        let mut other = back.clone();
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        other["title"] = format!("Changed elsewhere {stamp}").into();
        session.json(Method::PUT, "/faro-test/v1/items/1", Some(&other)).await.unwrap();
        let err = write_file(&session, path, &serde_json::to_vec(&back).unwrap()).await.unwrap_err();
        assert!(err.to_string().contains("changed on the site"), "{err}");

        // Invalid JSON never leaves Faro.
        let _ = read_file(&session, path).await.unwrap();
        assert!(write_file(&session, path, b"{not json").await.is_err());

        // A new name in a collection creates an item; delete removes it.
        let before = fs.list_dir("/rest/faro-test/v1/items").await.unwrap().len();
        write_file(&session, "/rest/faro-test/v1/items/new.json", br#"{"title":"Made by Faro"}"#)
            .await
            .unwrap();
        let after = names(fs.list_dir("/rest/faro-test/v1/items").await.unwrap());
        assert_eq!(after.len(), before + 1, "{after:?}");
        let made = after.iter().max_by_key(|n| n.trim_end_matches(".json").parse::<u64>().unwrap_or(0)).unwrap().clone();
        fs.delete(&format!("/rest/faro-test/v1/items/{made}"), false).await.unwrap();
        assert_eq!(fs.list_dir("/rest/faro-test/v1/items").await.unwrap().len(), before);

        // Core resources: settings (single) and a post (collection item, raw fields).
        let settings_path = "/rest/wp/v2/settings.json";
        let mut st: serde_json::Value =
            serde_json::from_slice(&read_file(&session, settings_path).await.unwrap()).unwrap();
        st["description"] = "Edited by Faro".into();
        if let Err(e) = write_file(&session, settings_path, &serde_json::to_vec(&st).unwrap()).await {
            panic!("settings save: {e:#}");
        }
        let st2 = session.json(Method::GET, "/wp/v2/settings", None).await.unwrap();
        assert_eq!(st2["description"], "Edited by Faro");

        let posts = names(fs.list_dir("/rest/wp/v2/posts").await.unwrap());
        let first = posts.first().expect("the install has a Hello world post").clone();
        let post_path = format!("/rest/wp/v2/posts/{first}");
        let mut post: serde_json::Value =
            serde_json::from_slice(&read_file(&session, &post_path).await.unwrap()).unwrap();
        post["title"]["raw"] = "Retitled by Faro".into();
        write_file(&session, &post_path, &serde_json::to_vec(&post).unwrap()).await.unwrap();
        let id = first.trim_end_matches(".json");
        let p2 = session
            .json(Method::GET, &format!("/wp/v2/posts/{id}?context=edit"), None)
            .await
            .unwrap();
        assert_eq!(p2["title"]["raw"], "Retitled by Faro");

        // Media: upload, find it in the tree, read the same bytes, delete.
        let png: &[u8] = &[
            0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0x0D, 0x49, 0x48, 0x44, 0x52, 0, 0,
            0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 0x1F, 0x15, 0xC4, 0x89, 0, 0, 0, 0x0D, 0x49, 0x44, 0x41,
            0x54, 0x78, 0x9C, 0x63, 0x60, 0, 0, 0, 0x02, 0, 0x01, 0xE2, 0x21, 0xBC, 0x33, 0, 0, 0, 0,
            0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
        ];
        write_file(&session, "/media/faro-dot.png", png).await.unwrap();
        let media = session.media().await.unwrap();
        let item = media
            .iter()
            .find(|m| m.path.ends_with("faro-dot.png"))
            .expect("uploaded media listed")
            .clone();
        let media_path = format!("/media/{}", item.path);
        assert!(file_exists(&session, &media_path).await);
        assert_eq!(read_file(&session, &media_path).await.unwrap(), png);
        fs.delete(&media_path, false).await.unwrap();
        assert!(!file_exists(&session, &media_path).await);

        // Plugin toggle through core REST.
        let on = session.core_plugin_set("hello", true).await.unwrap();
        assert_eq!(on["status"], "active");
        let off = session.core_plugin_set("hello", false).await.unwrap();
        assert_eq!(off["status"], "inactive");

        // Raw passthrough keeps non-2xx statuses for the caller.
        let missing = session.rest(Method::GET, "/faro-test/v1/items/999", None).await.unwrap();
        assert_eq!(missing.status, 404);

        // The "Create an application password" page comes from public discovery.
        let (base, authorize) =
            crate::session::wordpress::authorize_endpoint(
                crate::session::wordpress::profile_site(&profile),
            )
            .await
            .unwrap();
        assert_eq!(base, session.base);
        assert!(authorize.ends_with("/wp-admin/authorize-application.php"), "{authorize}");

        crate::credentials::delete_secret(&key);
        eprintln!("live_wordpress_rest: OK");
    }
}
