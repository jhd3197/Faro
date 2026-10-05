//! WordPress over its REST API (Plan 25), authenticated with an Application
//! Password (Basic auth). No plugin: core routes give the media library and
//! plugin toggling, and every plugin that registers routes (Gravity Forms
//! `gf/v2`, WooCommerce `wc/v3`, …) is reachable as raw REST calls or as
//! editable JSON resources.

use crate::profiles::ConnectionProfile;
use crate::session::http_throttle::{send_retried, HttpThrottle};
use anyhow::{anyhow, Context, Result};
use base64::Engine as _;
use reqwest::{Client, Method, RequestBuilder, StatusCode};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};
use uuid::Uuid;

/// Keychain purpose prefix for a profile's WordPress Application Password
/// (`wordpress:{profile_id}`). Never stored in `profiles.json`.
pub const WORDPRESS_SERVICE: &str = "wordpress";

/// Gentle pacing: WordPress hosts are often small shared boxes, and security
/// plugins rate-limit bursts of authenticated requests.
const MIN_INTERVAL: Duration = Duration::from_millis(50);

/// How long a media/REST collection listing stays fresh.
const LISTING_TTL: Duration = Duration::from_secs(30);

/// Collections are paged 100 at a time; stop after this many pages.
const MAX_PAGES: u32 = 20;

/// Keychain purpose under which a profile's WordPress secret is stored. The
/// profile editor only ever `set`/`has` this — the value never crosses IPC.
pub fn credential_key(profile_id: &str) -> String {
    format!("{WORDPRESS_SERVICE}:{profile_id}")
}

/// Normalize what a user types as the site address: add `https://` when no
/// scheme is given, drop a trailing `/`, and strip a pasted `/wp-admin…` or
/// `/wp-json…` tail. Subdirectory installs (`example.com/blog`) keep their path.
pub fn site_base(raw: &str) -> Result<String> {
    let t = raw.trim();
    if t.is_empty() {
        return Err(anyhow!("WordPress site address is empty"));
    }
    let with_scheme = if t.contains("://") {
        t.to_string()
    } else {
        format!("https://{t}")
    };
    let mut url = reqwest::Url::parse(&with_scheme)
        .with_context(|| format!("not a valid site address: {raw}"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(anyhow!("site address must be http(s): {raw}"));
    }
    url.set_query(None);
    url.set_fragment(None);
    let mut path = url.path().to_string();
    for tail in ["/wp-admin", "/wp-json", "/wp-login.php", "/index.php"] {
        if let Some(i) = path.find(tail) {
            path.truncate(i);
        }
    }
    url.set_path(path.trim_end_matches('/'));
    Ok(url.as_str().trim_end_matches('/').to_string())
}

/// How REST URLs are spelled on this site: `/wp-json/…` (pretty permalinks)
/// or `/?rest_route=/…` (plain permalinks, or `/wp-json` blocked).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RestStyle {
    Pretty,
    Query,
}

/// Build the URL for a REST route (`/wp/v2/posts?per_page=100`) on `base`.
pub fn rest_url(base: &str, style: RestStyle, route: &str) -> String {
    let route = if route.starts_with('/') {
        route.to_string()
    } else {
        format!("/{route}")
    };
    match style {
        RestStyle::Pretty => format!("{base}/wp-json{route}"),
        RestStyle::Query => {
            let (path, query) = match route.split_once('?') {
                Some((p, q)) => (p, Some(q)),
                None => (route.as_str(), None),
            };
            let enc: String =
                url::form_urlencoded::byte_serialize(path.as_bytes()).collect::<String>();
            // Keep `/` readable — WordPress decodes either form.
            let enc = enc.replace("%2F", "/");
            match query {
                Some(q) => format!("{base}/?rest_route={enc}&{q}"),
                None => format!("{base}/?rest_route={enc}"),
            }
        }
    }
}

/// One REST route from the discovery index.
#[derive(Debug, Clone)]
pub struct RouteInfo {
    pub route: String,
    pub methods: Vec<String>,
}

/// One media library attachment.
#[derive(Debug, Clone)]
pub struct MediaItem {
    pub id: u64,
    /// Path under the uploads dir (`2026/10/photo.jpg`).
    pub path: String,
    pub size: u64,
    pub modified: Option<i64>,
    pub url: String,
}

/// One item of a REST collection, listed as `{id}.json`.
#[derive(Debug, Clone)]
pub struct RestItem {
    pub id: String,
    pub size: u64,
    pub modified: Option<i64>,
}

/// A WordPress REST error body (`{code, message, data: {status}}`).
fn wp_error(text: &str) -> Option<(String, String)> {
    let v: Value = serde_json::from_str(text).ok()?;
    let code = v.get("code")?.as_str()?.to_string();
    let message = v
        .get("message")
        .and_then(|m| m.as_str())
        .unwrap_or("")
        .to_string();
    Some((code, strip_tags(&message)))
}

/// WordPress error messages sometimes carry HTML (`<strong>Error:</strong>`).
fn strip_tags(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_tag = false;
    for c in s.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    out
}

/// The `<title>` of an HTML page, if the text is one.
fn html_title(text: &str) -> Option<String> {
    let lower = text.to_ascii_lowercase();
    if !lower.trim_start().starts_with("<!doctype html") && !lower.trim_start().starts_with("<html") {
        return None;
    }
    let start = lower.find("<title>")? + "<title>".len();
    let end = start + lower[start..].find("</title>")?;
    let title = text[start..end].trim();
    Some(if title.is_empty() { "untitled page".into() } else { strip_tags(title) })
}

/// An HTTP failure, phrased for a person: the WP error code + message when
/// the body has one; for an HTML page (a firewall, CDN or server rule in
/// front of WordPress answered, not WordPress) its title; else the raw text.
pub fn describe_failure(what: &str, status: StatusCode, text: &str) -> anyhow::Error {
    if let Some((code, msg)) = wp_error(text) {
        return anyhow!("{what}: {msg} ({code}, HTTP {})", status.as_u16());
    }
    if let Some(title) = html_title(text) {
        return anyhow!(
            "{what}: blocked before WordPress answered (HTTP {}, \"{title}\"). A firewall, \
             CDN or server security rule in front of the site refused the request — check \
             the host's panel (e.g. Plesk/cPanel security, ModSecurity, Cloudflare) or \
             security plugins for a rule blocking the REST API.",
            status.as_u16()
        );
    }
    let snippet: String = text.trim().chars().take(200).collect();
    if snippet.is_empty() {
        anyhow!("{what}: HTTP {}", status.as_u16())
    } else {
        anyhow!("{what}: HTTP {} — {snippet}", status.as_u16())
    }
}

/// The raw result of a REST call, for passthrough (`wp rest`, `fetch`).
#[derive(Debug, Clone, Serialize)]
pub struct RestResponse {
    pub status: u16,
    pub body: String,
}

/// Media listing cache: (fetched at, attachments).
type MediaCache = StdMutex<Option<(Instant, Arc<Vec<MediaItem>>)>>;

/// Collection listing cache: route → (fetched at, items).
type CollectionCache = StdMutex<HashMap<String, (Instant, Arc<Vec<RestItem>>)>>;

pub struct WordPressSession {
    pub id: String,
    pub profile: ConnectionProfile,
    pub client: Client,
    /// Site root URL, no trailing slash.
    pub base: String,
    style: RestStyle,
    /// `user:application-password`, sent as Basic auth.
    credential: String,
    throttle: HttpThrottle,
    /// `user@host`.
    pub label: String,
    /// The Application Password authorize endpoint, from discovery.
    pub authorize_url: Option<String>,
    media: MediaCache,
    collections: CollectionCache,
    /// Each REST resource as last opened: a save refuses when the resource
    /// changed underneath the editor, and core routes get only the fields
    /// that were edited.
    read_originals: StdMutex<HashMap<String, Value>>,
    /// Discovery index: namespaces + routes.
    namespaces: Vec<String>,
    routes: Vec<RouteInfo>,
}

impl WordPressSession {
    fn authed(&self, rb: RequestBuilder) -> RequestBuilder {
        let v = format!(
            "Basic {}",
            base64::engine::general_purpose::STANDARD.encode(self.credential.as_bytes())
        );
        rb.header("Authorization", v)
    }

    pub fn url(&self, route: &str) -> String {
        rest_url(&self.base, self.style, route)
    }

    /// An authenticated request builder for an absolute URL (`faro-cli fetch`).
    pub fn request_url(&self, method: Method, url: reqwest::Url) -> RequestBuilder {
        self.authed(self.client.request(method, url))
    }

    /// An authenticated request builder for a REST route.
    pub fn request(&self, method: Method, route: &str) -> RequestBuilder {
        self.authed(self.client.request(method, self.url(route)))
    }

    /// Send with pacing + 429/5xx retry. `body` is raw bytes with its content
    /// type; `headers` are extra headers (media upload's disposition).
    pub async fn send(
        &self,
        method: Method,
        route: &str,
        headers: &[(&str, String)],
        body: Option<(Vec<u8>, &str)>,
    ) -> Result<reqwest::Response> {
        let url = self.url(route);
        let headers: Vec<(String, String)> =
            headers.iter().map(|(k, v)| (k.to_string(), v.clone())).collect();
        let body = body.map(|(b, ct)| (bytes::Bytes::from(b), ct.to_string()));
        send_retried(&self.throttle, &format!("wordpress {route}"), move || {
            let mut rb = self.authed(self.client.request(method.clone(), &url));
            for (k, v) in &headers {
                rb = rb.header(k.as_str(), v.as_str());
            }
            if let Some((b, ct)) = &body {
                rb = rb.header("Content-Type", ct.as_str()).body(b.clone());
            }
            async move { Ok(rb) }
        })
        .await
    }

    /// `send` + status check + JSON parse.
    pub async fn json(&self, method: Method, route: &str, body: Option<&Value>) -> Result<Value> {
        let body = body.map(|b| (serde_json::to_vec(b).unwrap_or_default(), "application/json"));
        let resp = self.send(method, route, &[], body).await?;
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(describe_failure(&format!("wordpress {route}"), status, &text));
        }
        if text.trim().is_empty() {
            return Ok(Value::Null);
        }
        serde_json::from_str(&text).with_context(|| format!("parse wordpress {route} response"))
    }

    /// Like [`json`](Self::json) but also returns the response headers we use
    /// for paging (`X-WP-TotalPages`).
    async fn json_paged(&self, route: &str) -> Result<(Value, u32)> {
        let resp = self.send(Method::GET, route, &[], None).await?;
        let status = resp.status();
        let pages = resp
            .headers()
            .get("X-WP-TotalPages")
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.parse().ok())
            .unwrap_or(1);
        let text = resp.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(describe_failure(&format!("wordpress {route}"), status, &text));
        }
        let v = serde_json::from_str(&text).with_context(|| format!("parse wordpress {route}"))?;
        Ok((v, pages))
    }

    /// Raw passthrough for `wp rest` / the bridge: any method, any route, the
    /// status and body as they came (no error mapping).
    pub async fn rest(&self, method: Method, route: &str, body: Option<Vec<u8>>) -> Result<RestResponse> {
        let ct = match &body {
            Some(b) if serde_json::from_slice::<Value>(b).is_ok() => "application/json",
            _ => "application/octet-stream",
        };
        let resp = self
            .send(method, route, &[], body.map(|b| (b, ct)))
            .await?;
        let status = resp.status().as_u16();
        let body = resp.text().await.unwrap_or_default();
        Ok(RestResponse { status, body })
    }

    pub fn account_label(&self) -> String {
        self.label.clone()
    }

    pub fn namespaces(&self) -> Vec<String> {
        self.namespaces.clone()
    }

    pub fn routes(&self) -> Vec<RouteInfo> {
        self.routes.clone()
    }

    pub fn has_namespace(&self, ns: &str) -> bool {
        self.namespaces.iter().any(|n| n == ns)
    }

    // ---------- media library (core REST) ----------

    pub async fn media(&self) -> Result<Arc<Vec<MediaItem>>> {
        if let Some((at, list)) = &*self.media.lock().unwrap() {
            if at.elapsed() < LISTING_TTL {
                return Ok(list.clone());
            }
        }
        let mut out = Vec::new();
        let mut page = 1;
        loop {
            let (v, pages) = self
                .json_paged(&format!(
                    "/wp/v2/media?per_page=100&page={page}&context=edit&_fields=id,source_url,media_details,modified_gmt"
                ))
                .await?;
            if let Some(arr) = v.as_array() {
                out.extend(arr.iter().filter_map(media_from_json));
            }
            if page >= pages || page >= MAX_PAGES * 5 {
                break;
            }
            page += 1;
        }
        let list = Arc::new(out);
        *self.media.lock().unwrap() = Some((Instant::now(), list.clone()));
        Ok(list)
    }

    pub fn invalidate_media(&self) {
        *self.media.lock().unwrap() = None;
    }

    pub async fn media_read(&self, item: &MediaItem) -> Result<Vec<u8>> {
        let resp = self
            .authed(self.client.get(&item.url))
            .send()
            .await
            .with_context(|| format!("GET {}", item.url))?;
        let status = resp.status();
        if !status.is_success() {
            return Err(anyhow!("download {}: HTTP {}", item.path, status.as_u16()));
        }
        Ok(resp.bytes().await?.to_vec())
    }

    /// Upload into the media library. WordPress picks the folder (the
    /// current year/month), so only the file name is ours to choose.
    pub async fn media_upload(&self, name: &str, data: &[u8]) -> Result<()> {
        let mime = mime_for(name);
        let disp = format!(
            "attachment; filename=\"{}\"",
            name.replace(['"', '\\', '\r', '\n'], "_")
        );
        let resp = self
            .send(
                Method::POST,
                "/wp/v2/media",
                &[("Content-Disposition", disp)],
                Some((data.to_vec(), mime)),
            )
            .await?;
        let status = resp.status();
        if !status.is_success() {
            let text = resp.text().await.unwrap_or_default();
            return Err(describe_failure(&format!("upload {name}"), status, &text));
        }
        self.invalidate_media();
        Ok(())
    }

    pub async fn media_delete(&self, id: u64) -> Result<()> {
        self.json(Method::DELETE, &format!("/wp/v2/media/{id}?force=true"), None)
            .await?;
        self.invalidate_media();
        Ok(())
    }

    // ---------- plugins (core REST) ----------

    /// `GET /wp/v2/plugins` → `[{plugin, name, version, status}]`.
    pub async fn core_plugins(&self) -> Result<Vec<Value>> {
        let v = self
            .json(Method::GET, "/wp/v2/plugins?context=edit", None)
            .await?;
        Ok(v.as_array().cloned().unwrap_or_default())
    }

    /// Activate/deactivate via core REST. `which` is a slug (`akismet`) or a
    /// plugin id (`akismet/akismet`).
    pub async fn core_plugin_set(&self, which: &str, active: bool) -> Result<Value> {
        let plugins = self.core_plugins().await?;
        let id = resolve_plugin(&plugins, which)
            .ok_or_else(|| anyhow!("no installed plugin matches `{which}`"))?;
        self.json(
            Method::POST,
            &format!("/wp/v2/plugins/{id}"),
            Some(&serde_json::json!({ "status": if active { "active" } else { "inactive" } })),
        )
        .await
    }

    // ---------- REST resources as files ----------

    /// Items of a collection route (`/gf/v2/forms`), paged, cached briefly.
    pub async fn collection(&self, route: &str) -> Result<Arc<Vec<RestItem>>> {
        if let Some((at, list)) = self.collections.lock().unwrap().get(route) {
            if at.elapsed() < LISTING_TTL {
                return Ok(list.clone());
            }
        }
        let edit = edit_context(route);
        let mut out = Vec::new();
        let mut page = 1;
        loop {
            let sep = if route.contains('?') { '&' } else { '?' };
            let paged = format!("{route}{sep}per_page=100&page={page}{edit}");
            let (v, pages) = match self.json_paged(&paged).await {
                Ok(r) => r,
                // Some plugin routes reject unknown params — retry bare once.
                Err(_) if page == 1 => (self.json(Method::GET, route, None).await?, 1),
                Err(e) => return Err(e),
            };
            out.extend(items_from_json(&v));
            if page >= pages || page >= MAX_PAGES {
                break;
            }
            page += 1;
        }
        let list = Arc::new(out);
        self.collections
            .lock()
            .unwrap()
            .insert(route.to_string(), (Instant::now(), list.clone()));
        Ok(list)
    }

    pub fn invalidate_collection(&self, route: &str) {
        self.collections.lock().unwrap().remove(route);
    }

    /// GET one resource as pretty JSON, remembering it for the stale-save
    /// check and the changed-fields diff.
    pub async fn resource_read(&self, key: &str, route: &str) -> Result<Vec<u8>> {
        let v = self
            .json(Method::GET, &format!("{route}{}", edit_context_first(route)), None)
            .await?;
        let mut pretty = serde_json::to_vec_pretty(&v)?;
        pretty.push(b'\n');
        self.read_originals.lock().unwrap().insert(key.to_string(), v);
        Ok(pretty)
    }

    /// Save one resource: refuse when it changed since it was opened, then
    /// PUT (falling back to POST). Core `wp/v2` routes update only the fields
    /// sent, so they get just the edited fields (sending back untouched
    /// read-only or null fields is rejected); plugin routes such as Gravity
    /// Forms replace the whole object, so they get all of it. `create_in` is
    /// the collection route when this is a new item.
    pub async fn resource_write(
        &self,
        key: &str,
        route: &str,
        create_in: Option<&str>,
        data: &[u8],
    ) -> Result<()> {
        let mut v: Value = serde_json::from_slice(data)
            .map_err(|e| anyhow!("{key} is not valid JSON ({e}) — not saved"))?;
        let core = route.starts_with("/wp/v2/") || create_in.is_some_and(|c| c.starts_with("/wp/v2/"));
        if core {
            flatten_raw(&mut v);
        }
        if let Some(coll) = create_in {
            self.json(Method::POST, coll, Some(&v)).await?;
            self.invalidate_collection(coll);
            return Ok(());
        }
        let original = self.read_originals.lock().unwrap().get(key).cloned();
        if let Some(orig) = &original {
            let current = self
                .json(Method::GET, &format!("{route}{}", edit_context_first(route)), None)
                .await?;
            if &current != orig {
                return Err(anyhow!(
                    "{key} changed on the site since you opened it — not saved. Reopen it to \
                     get the current version, then reapply your edit."
                ));
            }
        }
        if let (true, Some(orig)) = (core, &original) {
            let mut orig = orig.clone();
            flatten_raw(&mut orig);
            v = changed_fields(&orig, &v);
            if v.as_object().is_some_and(|o| o.is_empty()) {
                return Ok(());
            }
        }
        let body = serde_json::to_vec(&v)?;
        let resp = self
            .send(Method::PUT, route, &[], Some((body.clone(), "application/json")))
            .await?;
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        if !status.is_success() {
            let no_put = status == StatusCode::METHOD_NOT_ALLOWED
                || wp_error(&text).is_some_and(|(c, _)| c == "rest_no_route");
            if !no_put {
                return Err(describe_failure(&format!("save {key}"), status, &text));
            }
            self.json(Method::POST, route, Some(&v)).await?;
        }
        self.read_originals.lock().unwrap().remove(key);
        if let Some((coll, _)) = route.rsplit_once('/') {
            self.invalidate_collection(coll);
        }
        Ok(())
    }

    pub async fn resource_delete(&self, route: &str) -> Result<()> {
        self.json(Method::DELETE, route, None).await?;
        if let Some((coll, _)) = route.rsplit_once('/') {
            self.invalidate_collection(coll);
        }
        Ok(())
    }
}

/// The top-level fields of `edited` that differ from `original`.
fn changed_fields(original: &Value, edited: &Value) -> Value {
    let (Some(o), Some(e)) = (original.as_object(), edited.as_object()) else {
        return edited.clone();
    };
    Value::Object(
        e.iter()
            .filter(|(k, v)| o.get(*k) != Some(*v))
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect(),
    )
}

/// Core routes need `context=edit` to return raw (editable) fields.
fn edit_context(route: &str) -> &'static str {
    if route.starts_with("/wp/v2/") {
        "&context=edit"
    } else {
        ""
    }
}

fn edit_context_first(route: &str) -> &'static str {
    if !route.starts_with("/wp/v2/") {
        ""
    } else if route.contains('?') {
        "&context=edit"
    } else {
        "?context=edit"
    }
}

/// Core REST returns `{raw, rendered}` pairs under `context=edit`; writing
/// them back expects the raw value. Also drops `_links`.
fn flatten_raw(v: &mut Value) {
    if let Some(obj) = v.as_object_mut() {
        obj.remove("_links");
        obj.remove("_embedded");
        for (_, field) in obj.iter_mut() {
            let raw = field
                .as_object()
                .filter(|o| o.contains_key("raw"))
                .and_then(|o| o.get("raw").cloned());
            if let Some(raw) = raw {
                *field = raw;
            }
        }
    }
}

fn mime_for(name: &str) -> &'static str {
    let ext = name.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase());
    match ext.as_deref() {
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("png") => "image/png",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("avif") => "image/avif",
        Some("svg") => "image/svg+xml",
        Some("pdf") => "application/pdf",
        Some("mp4") => "video/mp4",
        Some("mp3") => "audio/mpeg",
        Some("zip") => "application/zip",
        Some("txt") => "text/plain",
        Some("csv") => "text/csv",
        Some("json") => "application/json",
        Some("doc") => "application/msword",
        Some("docx") => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        _ => "application/octet-stream",
    }
}

fn parse_time(s: &str) -> Option<i64> {
    // `modified_gmt` is `2026-10-05T12:34:56` with no zone (UTC).
    let (date, time) = s.get(..19)?.split_once('T')?;
    let mut d = date.split('-').map(|x| x.parse::<i64>().ok());
    let (y, m, day) = (d.next()??, d.next()??, d.next()??);
    let mut t = time.split(':').map(|x| x.parse::<i64>().ok());
    let (hh, mm, ss) = (t.next()??, t.next()??, t.next()??);
    // Days from civil (Howard Hinnant's algorithm).
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (m + if m > 2 { -3 } else { 9 }) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(days * 86_400 + hh * 3600 + mm * 60 + ss)
}

fn media_from_json(v: &Value) -> Option<MediaItem> {
    let id = v.get("id")?.as_u64()?;
    let url = v.get("source_url")?.as_str()?.to_string();
    let details = v.get("media_details");
    let file = details
        .and_then(|d| d.get("file"))
        .and_then(|f| f.as_str())
        .map(|s| s.to_string())
        .or_else(|| {
            url.split_once("/uploads/")
                .map(|(_, rest)| rest.to_string())
        })
        .unwrap_or_else(|| url.rsplit('/').next().unwrap_or("file").to_string());
    let size = details
        .and_then(|d| d.get("filesize"))
        .and_then(|s| s.as_u64())
        .unwrap_or(0);
    let modified = v
        .get("modified_gmt")
        .and_then(|m| m.as_str())
        .and_then(parse_time);
    Some(MediaItem {
        id,
        path: file.trim_start_matches('/').to_string(),
        size,
        modified,
        url,
    })
}

/// Items of a collection response: an array of objects with `id`, or (as
/// Gravity Forms answers) an object keyed by id.
pub fn items_from_json(v: &Value) -> Vec<RestItem> {
    let item = |key: Option<&str>, o: &Value| -> Option<RestItem> {
        let id = match o.get("id") {
            Some(Value::Number(n)) => n.to_string(),
            Some(Value::String(s)) if !s.is_empty() => s.clone(),
            _ => key?.to_string(),
        };
        if id.contains('/') {
            return None;
        }
        let size = serde_json::to_vec_pretty(o).map(|b| b.len() as u64 + 1).unwrap_or(0);
        let modified = o
            .get("modified_gmt")
            .or_else(|| o.get("date_updated"))
            .and_then(|m| m.as_str())
            .and_then(|s| parse_time(s.get(..19).unwrap_or(s).replace(' ', "T").as_str()));
        Some(RestItem { id, size, modified })
    };
    match v {
        Value::Array(arr) => arr.iter().filter(|o| o.is_object()).filter_map(|o| item(None, o)).collect(),
        Value::Object(map) => map
            .iter()
            .filter(|(_, o)| o.is_object())
            .filter_map(|(k, o)| item(Some(k), o))
            .collect(),
        _ => Vec::new(),
    }
}

/// Match a slug or plugin id against `GET /wp/v2/plugins` rows; returns the
/// id as the route wants it (`akismet/akismet`, no `.php`).
pub fn resolve_plugin(plugins: &[Value], which: &str) -> Option<String> {
    let want = which.trim().trim_end_matches(".php");
    plugins.iter().find_map(|p| {
        let id = p.get("plugin")?.as_str()?;
        let slug = id.split('/').next().unwrap_or(id);
        (id == want || slug == want).then(|| id.to_string())
    })
}

/// GET the discovery index, trying `/wp-json/` then `/?rest_route=/`.
async fn fetch_index(client: &Client, base: &str, style: Option<RestStyle>) -> Result<(Value, RestStyle)> {
    let styles = match style {
        Some(s) => vec![s],
        None => vec![RestStyle::Pretty, RestStyle::Query],
    };
    let mut last_err = None;
    for st in styles {
        let url = rest_url(base, st, "/");
        match client.get(&url).send().await {
            Ok(resp) if resp.status().is_success() => {
                let text = resp.text().await.unwrap_or_default();
                match serde_json::from_str::<Value>(&text) {
                    Ok(v) if v.get("namespaces").is_some() => return Ok((v, st)),
                    _ => last_err = Some(anyhow!("{url} did not return the REST index")),
                }
            }
            Ok(resp) => last_err = Some(anyhow!("{url}: HTTP {}", resp.status().as_u16())),
            Err(e) => last_err = Some(anyhow!("{url}: {e}")),
        }
    }
    Err(last_err.unwrap_or_else(|| anyhow!("no REST index")))
}

/// Namespaces, routes and the Application Password authorize URL from the
/// discovery index.
pub fn parse_index(v: &Value) -> (Vec<String>, Vec<RouteInfo>, Option<String>) {
    let namespaces = v
        .get("namespaces")
        .and_then(|n| n.as_array())
        .map(|a| a.iter().filter_map(|s| s.as_str().map(String::from)).collect())
        .unwrap_or_default();
    let routes = v
        .get("routes")
        .and_then(|r| r.as_object())
        .map(|m| {
            m.iter()
                .map(|(route, info)| RouteInfo {
                    route: route.clone(),
                    methods: info
                        .get("methods")
                        .and_then(|x| x.as_array())
                        .map(|a| a.iter().filter_map(|s| s.as_str().map(String::from)).collect())
                        .unwrap_or_default(),
                })
                .collect()
        })
        .unwrap_or_default();
    let authorize = v
        .pointer("/authentication/application-passwords/endpoints/authorization")
        .and_then(|a| a.as_str())
        .map(String::from);
    (namespaces, routes, authorize)
}

/// The site address a profile stores: the full URL in `endpoint` (scheme and
/// subdirectory), falling back to `host`.
pub fn profile_site(profile: &ConnectionProfile) -> &str {
    profile
        .endpoint
        .as_deref()
        .filter(|e| !e.trim().is_empty())
        .unwrap_or(&profile.host)
}

/// The Application Password authorize page for a site (from the public
/// discovery index — no login needed), for "Create an application password".
/// Returns `(site base, authorize URL)`.
pub async fn authorize_endpoint(site: &str) -> Result<(String, String)> {
    let base = site_base(site)?;
    let client = Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .timeout(Duration::from_secs(60))
        .user_agent(concat!("Faro/", env!("CARGO_PKG_VERSION")))
        .build()?;
    let (index, _) = fetch_index(&client, &base, None)
        .await
        .map_err(|e| anyhow!("Couldn't reach the WordPress REST API at {base} ({e})"))?;
    let (_, _, authorize) = parse_index(&index);
    let authorize = authorize.ok_or_else(|| {
        anyhow!(
            "{base} doesn't offer Application Passwords (WordPress 5.6+, HTTPS, and not \
             disabled by a security plugin). Enter an application password manually instead."
        )
    })?;
    Ok((base, authorize))
}

pub async fn wordpress_connect(profile: &ConnectionProfile) -> Result<WordPressSession> {
    let base = site_base(profile_site(profile))?;
    let secret = crate::credentials::get_secret(&credential_key(&profile.id))?
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| {
            anyhow!(
                "This WordPress connection has no saved password. Open it in the connection \
                 editor and paste an Application Password."
            )
        })?;
    let secret = secret.trim().to_string();
    if profile.username.trim().is_empty() {
        return Err(anyhow!("WordPress connection needs a username"));
    }
    let credential = format!("{}:{}", profile.username.trim(), secret);

    let client = Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .timeout(Duration::from_secs(300))
        .user_agent(concat!("Faro/", env!("CARGO_PKG_VERSION")))
        .build()
        .context("building WordPress HTTP client")?;

    let (index, style) = fetch_index(&client, &base, None).await.map_err(|e| {
        anyhow!(
            "Couldn't reach the WordPress REST API at {base} ({e}). Check the site address; \
             a security plugin may also be blocking the REST API."
        )
    })?;
    let (namespaces, routes, authorize_url) = parse_index(&index);
    let host = reqwest::Url::parse(&base)
        .ok()
        .and_then(|u| u.host_str().map(String::from))
        .unwrap_or_else(|| base.clone());

    let session = WordPressSession {
        id: Uuid::new_v4().to_string(),
        profile: profile.clone(),
        client,
        base,
        style,
        credential,
        throttle: HttpThrottle::new(MIN_INTERVAL),
        label: host.clone(),
        namespaces,
        routes,
        authorize_url,
        media: StdMutex::new(None),
        collections: StdMutex::new(HashMap::new()),
        read_originals: StdMutex::new(HashMap::new()),
    };

    // Are we an admin? `/wp/v2/settings` needs `manage_options`, so one GET
    // proves both the login and the role. (Not `/wp/v2/users/me`: hosting
    // panels and hardening plugins often block the users endpoints outright
    // to stop user enumeration, which would fail the whole connect.)
    let resp = session.send(Method::GET, "/wp/v2/settings", &[], None).await?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        let code = wp_error(&text).map(|(c, _)| c).unwrap_or_default();
        return Err(match code.as_str() {
            "incorrect_password" | "invalid_username" | "invalid_email" => anyhow!(
                "WordPress rejected the username or password. Use an Application Password \
                 (Users → Profile → Application Passwords), not your login password."
            ),
            "application_passwords_disabled" => anyhow!(
                "Application Passwords are turned off on this site. A security plugin \
                 (Wordfence: Login Security → Settings → Disable application passwords) or a \
                 non-HTTPS site can do this. Turn them back on, then reconnect."
            ),
            // Logged in, but not allowed to manage options.
            "rest_forbidden" | "rest_cannot_view" if status == StatusCode::FORBIDDEN => anyhow!(
                "This WordPress user isn't an administrator. Faro needs an admin account \
                 (manage_options)."
            ),
            // The route answered as if no one were logged in. WordPress gives
            // the same answer for a wrong password, an unknown user and a
            // stripped Authorization header, so name both causes.
            "rest_not_logged_in" | "rest_forbidden" | "rest_cannot_view" => anyhow!(
                "WordPress didn't accept the login. Check the username and that the password \
                 is an Application Password (Users → Profile → Application Passwords), not \
                 your login password. If both are right, the host may strip the \
                 Authorization header; on Apache, adding `SetEnvIf Authorization \"(.*)\" \
                 HTTP_AUTHORIZATION=$1` to .htaccess usually fixes it."
            ),
            _ => describe_failure("WordPress login check", status, &text),
        });
    }

    // The display name is a nicety: if the users endpoint is blocked, fall
    // back to the profile's username.
    let login = match session
        .json(Method::GET, "/wp/v2/users/me?context=edit", None)
        .await
    {
        Ok(me) => me
            .get("username")
            .or_else(|| me.get("slug"))
            .and_then(|u| u.as_str())
            .unwrap_or("")
            .to_string(),
        Err(_) => session.profile.username.trim().to_string(),
    };
    let mut session = session;
    session.label = if login.is_empty() { host } else { format!("{login}@{host}") };

    Ok(session)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn site_base_normalizes() {
        assert_eq!(site_base("example.com").unwrap(), "https://example.com");
        assert_eq!(site_base("http://example.com/").unwrap(), "http://example.com");
        assert_eq!(
            site_base("https://example.com/blog/wp-admin/index.php").unwrap(),
            "https://example.com/blog"
        );
        assert_eq!(site_base("https://ex.com/wp-json/wp/v2").unwrap(), "https://ex.com");
        assert!(site_base("ftp://x").is_err());
    }

    #[test]
    fn rest_url_styles() {
        assert_eq!(
            rest_url("https://e.com", RestStyle::Pretty, "/wp/v2/posts?page=2"),
            "https://e.com/wp-json/wp/v2/posts?page=2"
        );
        assert_eq!(
            rest_url("https://e.com", RestStyle::Query, "/wp/v2/posts?page=2"),
            "https://e.com/?rest_route=/wp/v2/posts&page=2"
        );
    }

    #[test]
    fn items_from_array_and_keyed_object() {
        let arr = serde_json::json!([{"id": 3, "title": "a"}, {"id": 7}]);
        let ids: Vec<_> = items_from_json(&arr).into_iter().map(|i| i.id).collect();
        assert_eq!(ids, vec!["3", "7"]);
        let gf = serde_json::json!({"1": {"id": "1", "title": "Contact"}, "2": {"title": "x"}});
        let ids: Vec<_> = items_from_json(&gf).into_iter().map(|i| i.id).collect();
        assert_eq!(ids, vec!["1", "2"]);
    }

    #[test]
    fn flatten_raw_takes_raw() {
        let mut v = serde_json::json!({
            "title": {"raw": "Hi", "rendered": "Hi"},
            "status": "publish",
            "_links": {}
        });
        flatten_raw(&mut v);
        assert_eq!(v, serde_json::json!({"title": "Hi", "status": "publish"}));
    }

    #[test]
    fn firewall_pages_are_summarized_not_dumped() {
        let page = "<!DOCTYPE html>\n<html><head><title>403 Forbidden</title></head><body>nope</body></html>";
        let msg = describe_failure("check", StatusCode::FORBIDDEN, page).to_string();
        assert!(msg.contains("blocked before WordPress answered"), "{msg}");
        assert!(msg.contains("403 Forbidden") && !msg.contains("<html"), "{msg}");
        let wp = r#"{"code":"rest_forbidden","message":"Sorry","data":{"status":401}}"#;
        assert!(describe_failure("check", StatusCode::UNAUTHORIZED, wp).to_string().contains("rest_forbidden"));
    }

    #[test]
    fn diff_keeps_only_edited_fields() {
        let o = serde_json::json!({"title": "a", "site_logo": null, "n": 1});
        let e = serde_json::json!({"title": "b", "site_logo": null, "n": 1});
        assert_eq!(changed_fields(&o, &e), serde_json::json!({"title": "b"}));
    }

    #[test]
    fn resolves_plugins_by_slug_or_id() {
        let p = vec![serde_json::json!({"plugin": "akismet/akismet"})];
        assert_eq!(resolve_plugin(&p, "akismet").as_deref(), Some("akismet/akismet"));
        assert_eq!(resolve_plugin(&p, "akismet/akismet.php").as_deref(), Some("akismet/akismet"));
        assert!(resolve_plugin(&p, "nope").is_none());
    }

    #[test]
    fn parses_gmt_times() {
        assert_eq!(parse_time("1970-01-01T00:00:00"), Some(0));
        assert_eq!(parse_time("2026-10-05T12:34:56"), Some(1_791_203_696));
        assert_eq!(parse_time("garbage"), None);
    }

    #[test]
    fn index_parsing() {
        let v = serde_json::json!({
            "namespaces": ["wp/v2", "gf/v2"],
            "routes": {"/gf/v2/forms": {"methods": ["GET", "POST"]}},
            "authentication": {"application-passwords": {"endpoints": {
                "authorization": "https://e.com/wp-admin/authorize-application.php"}}}
        });
        let (ns, routes, auth) = parse_index(&v);
        assert_eq!(ns, vec!["wp/v2", "gf/v2"]);
        assert_eq!(routes[0].methods, vec!["GET", "POST"]);
        assert!(auth.unwrap().ends_with("authorize-application.php"));
    }
}
