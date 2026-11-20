//! The file index (Plan 34 Phase 3): per-file facts — kind, date taken,
//! camera, size in pixels, GPS, a content hash when one is free — kept in
//! `faro.db` so a library can be browsed and searched without downloading it.
//!
//! - **Cheap reads.** Images are read only up to [`HEAD_BYTES`] (EXIF sits at
//!   the front of JPEG/TIFF/PNG/WebP), through the same bounded-read primitive
//!   the thumbnail cache uses. A file is re-read only when its change token
//!   (ETag, or size + mtime) moved.
//! - **Thumbnails** come from `preview.rs` in the same pass, cached under the
//!   connection (not a session) so they survive reconnects.
//! - **Roots** are the folders being indexed (`index_roots`): mounts with
//!   "Index files" on, plus any folder indexed once from the file pane. A
//!   background pass refreshes them every [`REFRESH_EVERY`].
//! - **Tags** live in `file_tags`; Phase 4 also writes them to object metadata.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use futures::StreamExt;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::Mutex;

use crate::db::Db;
use crate::scan::ScanEntry;
use crate::AppState;

/// Bytes read from the front of an image for EXIF + dimensions.
pub const HEAD_BYTES: u64 = 256 * 1024;
/// How often indexed folders are refreshed in the background.
const REFRESH_EVERY: Duration = Duration::from_secs(30 * 60);
/// Files read at once per indexing run.
const CONCURRENCY: usize = 4;

// ---------- classification + metadata (pure) ----------

/// Coarse file kind from the extension.
pub fn kind_of(name: &str) -> &'static str {
    let ext = name.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_default();
    match ext.as_str() {
        "jpg" | "jpeg" | "png" | "gif" | "webp" | "bmp" | "tif" | "tiff" | "heic" | "heif" | "avif" | "svg"
        | "ico" | "dng" | "cr2" | "cr3" | "nef" | "arw" | "orf" | "rw2" | "raf" | "psd" => "image",
        "mp4" | "mov" | "m4v" | "mkv" | "avi" | "webm" | "mts" | "m2ts" | "3gp" | "wmv" => "video",
        "mp3" | "wav" | "flac" | "aac" | "m4a" | "ogg" | "opus" | "aiff" | "wma" => "audio",
        "pdf" | "doc" | "docx" | "xls" | "xlsx" | "ppt" | "pptx" | "odt" | "ods" | "odp" | "txt" | "md" | "rtf"
        | "csv" | "key" | "pages" | "numbers" | "ai" | "indd" | "epub" => "document",
        "zip" | "tar" | "gz" | "tgz" | "bz2" | "xz" | "7z" | "rar" | "zst" => "archive",
        _ => "other",
    }
}

/// Image formats worth a header read (EXIF and/or dimensions).
fn reads_header(name: &str) -> bool {
    let ext = name.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_default();
    matches!(
        ext.as_str(),
        "jpg" | "jpeg" | "png" | "webp" | "tif" | "tiff" | "heic" | "heif" | "dng" | "gif" | "bmp"
    )
}

/// Formats the thumbnail decoder handles.
fn thumbnailable(name: &str) -> bool {
    let ext = name.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_default();
    matches!(ext.as_str(), "jpg" | "jpeg" | "png" | "webp" | "gif" | "bmp" | "tif" | "tiff")
}

/// What a header read tells us.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Meta {
    pub taken_ms: Option<i64>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub camera: Option<String>,
    pub lens: Option<String>,
    pub gps: Option<(f64, f64)>,
}

fn ascii(f: &exif::Field) -> Option<String> {
    match &f.value {
        exif::Value::Ascii(v) => {
            let s = v.iter().map(|b| String::from_utf8_lossy(b).trim().to_string()).collect::<Vec<_>>().join(" ");
            let s = s.trim_matches(char::from(0)).trim().to_string();
            (!s.is_empty()).then_some(s)
        }
        _ => None,
    }
}

fn dms(f: &exif::Field) -> Option<f64> {
    match &f.value {
        exif::Value::Rational(v) if v.len() >= 3 => {
            Some(v[0].to_f64() + v[1].to_f64() / 60.0 + v[2].to_f64() / 3600.0)
        }
        _ => None,
    }
}

/// Parse EXIF (date taken, camera, lens, GPS, pixel size) and fall back to the
/// image header for dimensions. Never fails: a file without metadata just
/// yields an empty [`Meta`].
pub fn parse_meta(bytes: &[u8]) -> Meta {
    let mut m = Meta::default();
    if let Ok(ex) = exif::Reader::new().read_from_container(&mut std::io::Cursor::new(bytes)) {
        let get = |t| ex.get_field(t, exif::In::PRIMARY);
        let date = get(exif::Tag::DateTimeOriginal).or_else(|| get(exif::Tag::DateTime));
        if let Some(exif::Value::Ascii(v)) = date.map(|f| &f.value) {
            if let Some(dt) = v.first().and_then(|b| exif::DateTime::from_ascii(b).ok()) {
                m.taken_ms = chrono::NaiveDate::from_ymd_opt(dt.year as i32, dt.month as u32, dt.day as u32)
                    .and_then(|d| d.and_hms_opt(dt.hour as u32, dt.minute as u32, dt.second as u32))
                    .map(|t| t.and_utc().timestamp_millis());
            }
        }
        let make = get(exif::Tag::Make).and_then(ascii);
        let model = get(exif::Tag::Model).and_then(ascii);
        m.camera = match (make, model) {
            (Some(mk), Some(md)) if md.to_lowercase().starts_with(&mk.to_lowercase()) => Some(md),
            (Some(mk), Some(md)) => Some(format!("{mk} {md}")),
            (a, b) => a.or(b),
        };
        m.lens = get(exif::Tag::LensModel).and_then(ascii);
        m.width = get(exif::Tag::PixelXDimension).and_then(|f| f.value.get_uint(0));
        m.height = get(exif::Tag::PixelYDimension).and_then(|f| f.value.get_uint(0));
        if let (Some(lat), Some(lon)) =
            (get(exif::Tag::GPSLatitude).and_then(dms), get(exif::Tag::GPSLongitude).and_then(dms))
        {
            let south = get(exif::Tag::GPSLatitudeRef).and_then(ascii).is_some_and(|r| r.starts_with('S'));
            let west = get(exif::Tag::GPSLongitudeRef).and_then(ascii).is_some_and(|r| r.starts_with('W'));
            m.gps = Some((if south { -lat } else { lat }, if west { -lon } else { lon }));
        }
    }
    if m.width.is_none() {
        if let Some((w, h)) = jpeg_dims(bytes) {
            m.width = Some(w);
            m.height = Some(h);
        }
    }
    if m.width.is_none() {
        if let Ok((w, h)) = image::ImageReader::new(std::io::Cursor::new(bytes))
            .with_guessed_format()
            .map_err(anyhow::Error::from)
            .and_then(|r| r.into_dimensions().map_err(anyhow::Error::from))
        {
            m.width = Some(w);
            m.height = Some(h);
        }
    }
    m
}

/// A JPEG's pixel size from its SOF marker, walking segment headers only —
/// works on a truncated head read where a full decoder gives up.
fn jpeg_dims(b: &[u8]) -> Option<(u32, u32)> {
    if b.len() < 4 || b[0] != 0xFF || b[1] != 0xD8 {
        return None;
    }
    let mut i = 2;
    while i + 4 <= b.len() {
        if b[i] != 0xFF {
            return None;
        }
        let marker = b[i + 1];
        if marker == 0xFF {
            i += 1; // fill byte
            continue;
        }
        let len = u16::from_be_bytes([b[i + 2], b[i + 3]]) as usize;
        // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC).
        if (0xC0..=0xCF).contains(&marker) && !matches!(marker, 0xC4 | 0xC8 | 0xCC) {
            if i + 9 > b.len() {
                return None;
            }
            let h = u16::from_be_bytes([b[i + 5], b[i + 6]]) as u32;
            let w = u16::from_be_bytes([b[i + 7], b[i + 8]]) as u32;
            return (w > 0 && h > 0).then_some((w, h));
        }
        if marker == 0xDA || marker == 0xD9 {
            return None; // start of scan / end: no SOF before it
        }
        i += 2 + len;
    }
    None
}

/// The token that says "this file changed": the ETag when the backend has
/// one, else size + mtime.
pub fn change_token(e: &ScanEntry) -> String {
    match &e.etag {
        // A metadata-only update keeps an object's ETag but moves its
        // modified time, so both are in the token.
        Some(t) if !t.is_empty() => format!("etag:{t}:{}", e.modified),
        _ => format!("{}:{}", e.size, e.modified),
    }
}

/// An S3/R2 single-part ETag is the content MD5; a multipart one (`…-N`) is
/// not, so it's never treated as a hash.
pub fn hash_from_etag(etag: Option<&str>) -> Option<String> {
    let t = etag?.trim_matches('"');
    (t.len() == 32 && t.chars().all(|c| c.is_ascii_hexdigit())).then(|| format!("md5:{}", t.to_ascii_lowercase()))
}

fn as_ms(t: i64) -> i64 {
    if t != 0 && t.abs() < 100_000_000_000 {
        t * 1000
    } else {
        t
    }
}

// ---------- rows + queries ----------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct IndexRow {
    pub connection_id: String,
    pub path: String,
    pub root: String,
    pub name: String,
    pub size: u64,
    pub change_token: String,
    pub kind: String,
    pub taken_ms: Option<i64>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub camera: Option<String>,
    pub lens: Option<String>,
    pub gps_lat: Option<f64>,
    pub gps_lon: Option<f64>,
    pub content_hash: Option<String>,
    pub mtime_ms: Option<i64>,
    #[serde(default)]
    pub tags: Vec<String>,
    /// Tags read from the object's metadata during indexing (object stores
    /// only); they replace the stored tags for that file.
    #[serde(skip)]
    pub remote_tags: Option<Vec<String>>,
}

/// Search filters. Every field is optional; all given ones must match.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct IndexQuery {
    pub connection_id: Option<String>,
    /// Under this folder (prefix match on the path).
    pub under: Option<String>,
    /// Words that must all appear in the name or path.
    pub text: Option<String>,
    pub kinds: Vec<String>,
    pub taken_from_ms: Option<i64>,
    pub taken_to_ms: Option<i64>,
    pub camera: Option<String>,
    pub tag: Option<String>,
    pub has_gps: Option<bool>,
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexRootView {
    pub connection_id: String,
    pub root: String,
    pub files: u64,
    pub last_run_ms: Option<i64>,
    pub running: bool,
    pub done: u64,
    pub total: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexFacets {
    pub cameras: Vec<String>,
    pub tags: Vec<String>,
    pub files: u64,
}

fn row_from(r: &rusqlite::Row<'_>) -> rusqlite::Result<IndexRow> {
    Ok(IndexRow {
        connection_id: r.get(0)?,
        path: r.get(1)?,
        root: r.get(2)?,
        name: r.get(3)?,
        size: r.get::<_, i64>(4)? as u64,
        change_token: r.get(5)?,
        kind: r.get(6)?,
        taken_ms: r.get(7)?,
        width: r.get::<_, Option<i64>>(8)?.map(|v| v as u32),
        height: r.get::<_, Option<i64>>(9)?.map(|v| v as u32),
        camera: r.get(10)?,
        lens: r.get(11)?,
        gps_lat: r.get(12)?,
        gps_lon: r.get(13)?,
        content_hash: r.get(14)?,
        mtime_ms: r.get(15)?,
        tags: Vec::new(),
        remote_tags: None,
    })
}

const COLS: &str = "connection_id, path, root, name, size, change_token, kind, taken_ms, width, height, \
                    camera, lens, gps_lat, gps_lon, content_hash, mtime_ms";

impl Db {
    pub fn index_tokens(&self, connection_id: &str, root: &str) -> Result<HashMap<String, String>> {
        self.with_conn(|c| {
            let mut st = c.prepare("SELECT path, change_token FROM file_index WHERE connection_id = ?1 AND root = ?2")?;
            let rows = st
                .query_map(params![connection_id, root], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
                .collect::<rusqlite::Result<HashMap<_, _>>>()?;
            Ok(rows)
        })
    }

    pub fn index_upsert(&self, rows: &[IndexRow]) -> Result<()> {
        let now = crate::db::now_ms();
        self.with_conn(|c| {
            let tx = c.unchecked_transaction()?;
            {
                let mut st = tx.prepare(&format!(
                    "INSERT OR REPLACE INTO file_index ({COLS}, indexed_ms) \
                     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17)"
                ))?;
                for r in rows {
                    st.execute(params![
                        r.connection_id,
                        r.path,
                        r.root,
                        r.name,
                        r.size as i64,
                        r.change_token,
                        r.kind,
                        r.taken_ms,
                        r.width.map(i64::from),
                        r.height.map(i64::from),
                        r.camera,
                        r.lens,
                        r.gps_lat,
                        r.gps_lon,
                        r.content_hash,
                        r.mtime_ms,
                        now
                    ])?;
                }
            }
            tx.commit()?;
            Ok(())
        })?;
        for r in rows {
            if let Some(tags) = &r.remote_tags {
                self.tags_set(&r.connection_id, &r.path, tags)?;
            }
        }
        Ok(())
    }

    /// Drop rows under `root` whose files are gone. Tags go with them.
    pub fn index_remove(&self, connection_id: &str, paths: &[String]) -> Result<()> {
        self.with_conn(|c| {
            let tx = c.unchecked_transaction()?;
            for p in paths {
                tx.execute("DELETE FROM file_index WHERE connection_id = ?1 AND path = ?2", params![connection_id, p])?;
                tx.execute("DELETE FROM file_tags WHERE connection_id = ?1 AND path = ?2", params![connection_id, p])?;
            }
            tx.commit()?;
            Ok(())
        })
    }

    pub fn index_root_add(&self, connection_id: &str, root: &str) -> Result<()> {
        self.with_conn(|c| {
            c.execute(
                "INSERT OR IGNORE INTO index_roots (connection_id, root) VALUES (?1, ?2)",
                params![connection_id, root],
            )?;
            Ok(())
        })
    }

    pub fn index_root_done(&self, connection_id: &str, root: &str, files: u64) -> Result<()> {
        self.with_conn(|c| {
            c.execute(
                "UPDATE index_roots SET last_run_ms = ?3, files = ?4 WHERE connection_id = ?1 AND root = ?2",
                params![connection_id, root, crate::db::now_ms(), files as i64],
            )?;
            Ok(())
        })
    }

    /// Stop indexing a folder and forget what was learned about it.
    pub fn index_root_forget(&self, connection_id: &str, root: &str) -> Result<()> {
        self.with_conn(|c| {
            let tx = c.unchecked_transaction()?;
            tx.execute(
                "DELETE FROM file_tags WHERE connection_id = ?1 AND path IN \
                 (SELECT path FROM file_index WHERE connection_id = ?1 AND root = ?2)",
                params![connection_id, root],
            )?;
            tx.execute("DELETE FROM file_index WHERE connection_id = ?1 AND root = ?2", params![connection_id, root])?;
            tx.execute("DELETE FROM index_roots WHERE connection_id = ?1 AND root = ?2", params![connection_id, root])?;
            tx.commit()?;
            Ok(())
        })
    }

    pub fn index_roots(&self) -> Result<Vec<(String, String, Option<i64>, u64)>> {
        self.with_conn(|c| {
            let mut st = c.prepare("SELECT connection_id, root, last_run_ms, files FROM index_roots ORDER BY root")?;
            let rows = st
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get::<_, i64>(3)? as u64)))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })
    }

    pub fn index_search(&self, q: &IndexQuery) -> Result<Vec<IndexRow>> {
        use rusqlite::types::Value as V;
        let mut sql = format!("SELECT {COLS} FROM file_index f WHERE 1=1");
        let mut args: Vec<V> = Vec::new();
        // Append `clause`, numbering each `?` as the next bound argument.
        fn bind(sql: &mut String, args: &mut Vec<V>, clause: &str, vals: Vec<V>) {
            let mut vals = vals.into_iter();
            for (i, part) in clause.split('?').enumerate() {
                if i > 0 {
                    args.push(vals.next().expect("one value per ?"));
                    sql.push_str(&format!("?{}", args.len()));
                }
                sql.push_str(part);
            }
        }
        if let Some(c) = &q.connection_id {
            bind(&mut sql, &mut args, " AND f.connection_id = ?", vec![V::Text(c.clone())]);
        }
        if let Some(u) = q.under.as_ref().filter(|u| !u.is_empty() && u.as_str() != "/") {
            let prefix = format!("{}/", u.trim_end_matches('/'));
            bind(&mut sql, &mut args, " AND substr(f.path, 1, length(?)) = ?", vec![V::Text(prefix.clone()), V::Text(prefix)]);
        }
        if let Some(t) = &q.text {
            for word in t.split_whitespace() {
                bind(&mut sql, &mut args, " AND lower(f.path) LIKE ?", vec![V::Text(format!("%{}%", word.to_lowercase()))]);
            }
        }
        if !q.kinds.is_empty() {
            let marks = vec!["?"; q.kinds.len()].join(",");
            bind(&mut sql, &mut args, &format!(" AND f.kind IN ({marks})"), q.kinds.iter().map(|k| V::Text(k.clone())).collect());
        }
        if let Some(t) = q.taken_from_ms {
            bind(&mut sql, &mut args, " AND f.taken_ms >= ?", vec![V::Integer(t)]);
        }
        if let Some(t) = q.taken_to_ms {
            bind(&mut sql, &mut args, " AND f.taken_ms <= ?", vec![V::Integer(t)]);
        }
        if let Some(c) = q.camera.as_ref().filter(|c| !c.is_empty()) {
            bind(&mut sql, &mut args, " AND f.camera = ?", vec![V::Text(c.clone())]);
        }
        if let Some(t) = q.tag.as_ref().filter(|t| !t.is_empty()) {
            bind(
                &mut sql,
                &mut args,
                " AND EXISTS (SELECT 1 FROM file_tags t WHERE t.connection_id = f.connection_id AND t.path = f.path AND t.tag = ?)",
                vec![V::Text(t.trim().to_lowercase())],
            );
        }
        match q.has_gps {
            Some(true) => sql.push_str(" AND f.gps_lat IS NOT NULL"),
            Some(false) => sql.push_str(" AND f.gps_lat IS NULL"),
            None => {}
        }
        sql.push_str(" ORDER BY COALESCE(f.taken_ms, f.mtime_ms, 0) DESC, f.path");
        bind(&mut sql, &mut args, " LIMIT ?", vec![V::Integer(q.limit.unwrap_or(500).min(5000) as i64)]);

        self.with_conn(|c| {
            let mut st = c.prepare(&sql)?;
            let mut rows = st
                .query_map(rusqlite::params_from_iter(args.iter()), row_from)?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            let mut tag_st = c.prepare("SELECT tag FROM file_tags WHERE connection_id = ?1 AND path = ?2 ORDER BY tag")?;
            for r in &mut rows {
                r.tags = tag_st
                    .query_map(params![r.connection_id, r.path], |x| x.get(0))?
                    .collect::<rusqlite::Result<Vec<String>>>()?;
            }
            Ok(rows)
        })
    }

    pub fn index_get(&self, connection_id: &str, path: &str) -> Result<Option<IndexRow>> {
        self.with_conn(|c| {
            let mut row = c
                .query_row(
                    &format!("SELECT {COLS} FROM file_index WHERE connection_id = ?1 AND path = ?2"),
                    params![connection_id, path],
                    row_from,
                )
                .optional()?;
            if let Some(r) = row.as_mut() {
                let mut st = c.prepare("SELECT tag FROM file_tags WHERE connection_id = ?1 AND path = ?2 ORDER BY tag")?;
                r.tags = st.query_map(params![connection_id, path], |x| x.get(0))?.collect::<rusqlite::Result<_>>()?;
            }
            Ok(row)
        })
    }

    pub fn index_facets(&self, connection_id: Option<&str>) -> Result<IndexFacets> {
        self.with_conn(|c| {
            let cid = connection_id.unwrap_or("");
            let all = connection_id.is_none();
            let mut st = c.prepare(
                "SELECT DISTINCT camera FROM file_index WHERE camera IS NOT NULL AND (?2 OR connection_id = ?1) ORDER BY camera",
            )?;
            let cameras = st.query_map(params![cid, all], |r| r.get(0))?.collect::<rusqlite::Result<Vec<String>>>()?;
            let mut st = c.prepare("SELECT DISTINCT tag FROM file_tags WHERE (?2 OR connection_id = ?1) ORDER BY tag")?;
            let tags = st.query_map(params![cid, all], |r| r.get(0))?.collect::<rusqlite::Result<Vec<String>>>()?;
            let files: i64 = c.query_row(
                "SELECT COUNT(*) FROM file_index WHERE (?2 OR connection_id = ?1)",
                params![cid, all],
                |r| r.get(0),
            )?;
            Ok(IndexFacets { cameras, tags, files: files as u64 })
        })
    }

    /// Replace a file's tags (lower-cased, trimmed, de-duplicated).
    pub fn tags_set(&self, connection_id: &str, path: &str, tags: &[String]) -> Result<Vec<String>> {
        let clean = normalize_tags(tags);
        self.with_conn(|c| {
            let tx = c.unchecked_transaction()?;
            tx.execute("DELETE FROM file_tags WHERE connection_id = ?1 AND path = ?2", params![connection_id, path])?;
            for t in &clean {
                tx.execute(
                    "INSERT OR IGNORE INTO file_tags (connection_id, path, tag) VALUES (?1, ?2, ?3)",
                    params![connection_id, path, t],
                )?;
            }
            tx.commit()?;
            Ok(())
        })?;
        Ok(clean)
    }

    pub fn tags_get(&self, connection_id: &str, path: &str) -> Result<Vec<String>> {
        self.with_conn(|c| {
            let mut st = c.prepare("SELECT tag FROM file_tags WHERE connection_id = ?1 AND path = ?2 ORDER BY tag")?;
            let v = st.query_map(params![connection_id, path], |r| r.get(0))?.collect::<rusqlite::Result<Vec<String>>>()?;
            Ok(v)
        })
    }
}

/// Lower-case, trim, drop empties and commas, de-duplicate, sort.
pub fn normalize_tags(tags: &[String]) -> Vec<String> {
    let mut v: Vec<String> = tags
        .iter()
        .flat_map(|t| t.split(','))
        .map(|t| t.trim().to_lowercase())
        .filter(|t| !t.is_empty())
        .collect();
    v.sort();
    v.dedup();
    v
}

// ---------- running ----------

#[derive(Debug, Clone, Default)]
struct Progress {
    done: u64,
    total: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexEvent {
    pub connection_id: String,
    pub root: String,
    pub running: bool,
    pub done: u64,
    pub total: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Default)]
pub struct IndexManager {
    running: Mutex<HashMap<(String, String), Progress>>,
}

/// Index run options.
#[derive(Debug, Clone, Copy)]
pub struct RunOptions {
    pub thumbnails: bool,
}

impl IndexManager {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn views(&self, db: &Db) -> Vec<IndexRootView> {
        let running = self.running.lock().await;
        db.index_roots()
            .unwrap_or_default()
            .into_iter()
            .map(|(cid, root, last, files)| {
                let p = running.get(&(cid.clone(), root.clone()));
                IndexRootView {
                    running: p.is_some(),
                    done: p.map(|p| p.done).unwrap_or(0),
                    total: p.map(|p| p.total).unwrap_or(0),
                    connection_id: cid,
                    root,
                    files,
                    last_run_ms: last,
                }
            })
            .collect()
    }

    /// Index `root` on the connection `connection_id` now, in the background.
    /// A run already going for the same folder is left alone.
    pub async fn start(self: &Arc<Self>, app: AppHandle, connection_id: String, root: String, opts: RunOptions) {
        let key = (connection_id.clone(), root.clone());
        {
            let mut running = self.running.lock().await;
            if running.contains_key(&key) {
                return;
            }
            running.insert(key.clone(), Progress::default());
        }
        let this = self.clone();
        tauri::async_runtime::spawn(async move {
            let res = this.run(&app, &connection_id, &root, opts).await;
            let p = this.running.lock().await.remove(&key).unwrap_or_default();
            if let Err(e) = &res {
                tracing::warn!("index {root}: {e:#}");
            }
            let _ = app.emit(
                "index://progress",
                IndexEvent {
                    connection_id,
                    root,
                    running: false,
                    done: p.done,
                    total: p.total,
                    error: res.err().map(|e| format!("{e:#}")),
                },
            );
        });
    }

    async fn progress(&self, app: &AppHandle, cid: &str, root: &str, done: u64, total: u64) {
        if let Some(p) = self.running.lock().await.get_mut(&(cid.to_string(), root.to_string())) {
            p.done = done;
            p.total = total;
        }
        let _ = app.emit(
            "index://progress",
            IndexEvent { connection_id: cid.into(), root: root.into(), running: true, done, total, error: None },
        );
    }

    async fn run(&self, app: &AppHandle, cid: &str, root: &str, opts: RunOptions) -> Result<()> {
        let state = app.state::<AppState>();
        let db = state.db.clone();
        db.index_root_add(cid, root)?;
        let (session_id, session) = crate::copyto::session_for_profile(app, cid).await?;
        let fs = crate::commands::fs_for_session(&session);
        let tree = crate::scan::walk_tree(fs.as_ref(), root).await.with_context(|| format!("scan {root}"))?;
        let known = db.index_tokens(cid, root)?;

        // Changed or new files only; rows for vanished files are dropped.
        let seen: HashSet<&String> = tree.files.values().map(|e| &e.absolute).collect();
        let gone: Vec<String> = known.keys().filter(|p| !seen.contains(p)).cloned().collect();
        db.index_remove(cid, &gone)?;
        let todo: Vec<ScanEntry> = tree
            .files
            .values()
            .filter(|e| known.get(&e.absolute) != Some(&change_token(e)))
            .cloned()
            .collect();
        let total = todo.len() as u64;
        self.progress(app, cid, root, 0, total).await;

        let thumb_key = format!("idx:{cid}");
        let preview = state.preview.clone();
        let mut done = 0u64;
        let mut batch: Vec<IndexRow> = Vec::new();
        // Each file's future owns what it needs (no borrows across the
        // spawned task's await points).
        let mut stream = futures::stream::iter(todo.into_iter().map(|e| {
            let session = session.clone();
            let thumb_key = thumb_key.clone();
            let preview = preview.clone();
            let db = db.clone();
            let (cid, root) = (cid.to_string(), root.to_string());
            async move { index_one(e, cid, root, session, preview, db, thumb_key, opts).await }
        }))
        .buffer_unordered(CONCURRENCY);
        while let Some(row) = stream.next().await {
            batch.push(row);
            done += 1;
            if batch.len() >= 50 {
                db.index_upsert(&batch)?;
                batch.clear();
                self.progress(app, cid, root, done, total).await;
            }
        }
        db.index_upsert(&batch)?;
        drop(stream);
        db.index_root_done(cid, root, tree.files.len() as u64)?;
        let _ = session_id;
        Ok(())
    }
}

/// Read one file's header (and thumbnail) into an [`IndexRow`].
#[allow(clippy::too_many_arguments)]
async fn index_one(
    e: ScanEntry,
    cid: String,
    root: String,
    session: Arc<crate::session::Session>,
    preview: Arc<crate::preview::PreviewManager>,
    db: Arc<Db>,
    thumb_key: String,
    opts: RunOptions,
) -> IndexRow {
    let name = e.absolute.rsplit(['/', '\\']).next().unwrap_or(&e.absolute).to_string();
    let kind = kind_of(&name);
    let meta = if reads_header(&name) {
        match crate::preview::read_head(Some(&session), &e.absolute, HEAD_BYTES).await {
            Ok(bytes) => tokio::task::spawn_blocking(move || parse_meta(&bytes)).await.unwrap_or_default(),
            Err(err) => {
                tracing::debug!("index header {}: {err:#}", e.absolute);
                Meta::default()
            }
        }
    } else {
        Meta::default()
    };
    let token = change_token(&e);
    let remote_tags = match &*session {
        crate::session::Session::Object(obj) => crate::remotefs::object::ObjectFs::new(obj.clone())
            .object_tags(&e.absolute)
            .await
            .unwrap_or(None),
        _ => None,
    };
    if opts.thumbnails && thumbnailable(&name) && e.size <= crate::preview::MAX_PREVIEW_FILE_BYTES {
        let _ = preview.thumbnail(&db, Some(session.clone()), &thumb_key, &e.absolute, e.size, &token).await;
    }
    IndexRow {
        connection_id: cid,
        path: e.absolute.clone(),
        root,
        name,
        size: e.size,
        change_token: token,
        kind: kind.to_string(),
        taken_ms: meta.taken_ms,
        width: meta.width,
        height: meta.height,
        camera: meta.camera,
        lens: meta.lens,
        gps_lat: meta.gps.map(|g| g.0),
        gps_lon: meta.gps.map(|g| g.1),
        content_hash: hash_from_etag(e.etag.as_deref()),
        mtime_ms: (e.modified != 0).then(|| as_ms(e.modified)),
        tags: Vec::new(),
        remote_tags,
    }
}

/// Every 30 minutes, refresh each indexed folder (needs its connection's
/// credentials; a folder whose connection is gone is skipped).
pub fn spawn_background(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(60)).await;
        loop {
            let state = app.state::<AppState>();
            let roots = state.db.index_roots().unwrap_or_default();
            for (cid, root, _, _) in roots {
                if state.profiles.get(&cid).await.ok().flatten().is_none() {
                    continue;
                }
                state.fileindex.start(app.clone(), cid, root, RunOptions { thumbnails: true }).await;
            }
            tokio::time::sleep(REFRESH_EVERY).await;
        }
    });
}

// ---------- Tauri commands ----------

fn e<E: std::fmt::Display>(e: E) -> String {
    format!("{e:#}")
}

/// Index a folder now (and keep it indexed). `session_id` names the
/// connection; the index is stored against its saved profile.
#[tauri::command]
pub async fn index_start(
    session_id: String,
    path: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let session = state.sessions.get(&session_id).await.ok_or("connection is closed")?;
    let cid = session.profile().id.clone();
    state.db.index_root_add(&cid, &path).map_err(e)?;
    state.fileindex.start(app, cid, path, RunOptions { thumbnails: true }).await;
    Ok(())
}

#[tauri::command]
pub async fn index_roots(state: State<'_, AppState>) -> Result<Vec<IndexRootView>, String> {
    Ok(state.fileindex.views(&state.db).await)
}

#[tauri::command]
pub async fn index_refresh(
    connection_id: String,
    root: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.fileindex.start(app, connection_id, root, RunOptions { thumbnails: true }).await;
    Ok(())
}

#[tauri::command]
pub async fn index_forget(connection_id: String, root: String, state: State<'_, AppState>) -> Result<(), String> {
    state.db.index_root_forget(&connection_id, &root).map_err(e)
}

#[tauri::command]
pub async fn index_search(query: IndexQuery, state: State<'_, AppState>) -> Result<Vec<IndexRow>, String> {
    state.db.index_search(&query).map_err(e)
}

#[tauri::command]
pub async fn index_facets(connection_id: Option<String>, state: State<'_, AppState>) -> Result<IndexFacets, String> {
    state.db.index_facets(connection_id.as_deref()).map_err(e)
}

/// A result's thumbnail (base64 PNG) from the index's cache; generates it
/// (connecting if needed) on a miss.
#[tauri::command]
pub async fn index_thumbnail(
    connection_id: String,
    path: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let row = state.db.index_get(&connection_id, &path).map_err(e)?.ok_or("not in the index")?;
    let (_, session) = crate::copyto::session_for_profile(&app, &connection_id).await.map_err(e)?;
    state
        .preview
        .thumbnail(&state.db, Some(session), &format!("idx:{connection_id}"), &path, row.size, &row.change_token)
        .await
        .map_err(e)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagsResult {
    /// Files whose tags changed.
    pub updated: u32,
    /// Of those, written into the object's metadata too.
    pub stored_remote: u32,
    /// The connection can't hold tags itself; they're kept on this PC only.
    pub local_only: bool,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub errors: Vec<String>,
}

/// Add and/or remove tags on files. On S3-compatible and Azure connections
/// the tags are also written into each object's metadata (server-side, no
/// bytes move), so another PC — or a rebuilt index — gets them back.
#[tauri::command]
pub async fn tags_apply(
    connection_id: String,
    paths: Vec<String>,
    add: Vec<String>,
    remove: Vec<String>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<TagsResult, String> {
    let add = normalize_tags(&add);
    let remove = normalize_tags(&remove);
    let profile = state.profiles.get(&connection_id).await.map_err(e)?.ok_or("that connection no longer exists")?;
    let object_store = crate::session::object::namespace::Namespace::supported(&profile.protocol);
    let session = if object_store {
        Some(crate::copyto::session_for_profile(&app, &connection_id).await.map_err(e)?.1)
    } else {
        None
    };
    let mut out = TagsResult { updated: 0, stored_remote: 0, local_only: !object_store, errors: vec![] };
    for path in &paths {
        let current = state.db.tags_get(&connection_id, path).map_err(e)?;
        let mut next: Vec<String> = current.iter().filter(|t| !remove.contains(t)).cloned().collect();
        next.extend(add.iter().cloned());
        let next = normalize_tags(&next);
        if next == current {
            continue;
        }
        if let Some(crate::session::Session::Object(obj)) = session.as_deref() {
            match crate::remotefs::object::ObjectFs::new(obj.clone()).set_object_tags(path, &next).await {
                Ok(true) => out.stored_remote += 1,
                Ok(false) => {}
                Err(err) => {
                    out.errors.push(format!("{path}: {err:#}"));
                    continue;
                }
            }
        }
        state.db.tags_set(&connection_id, path, &next).map_err(e)?;
        out.updated += 1;
    }
    Ok(out)
}

/// A file's tags. `connection_id` is the saved profile id.
#[tauri::command]
pub async fn tags_get(connection_id: String, path: String, state: State<'_, AppState>) -> Result<Vec<String>, String> {
    state.db.tags_get(&connection_id, &path).map_err(e)
}

/// The saved-profile id behind a live session (tags and the index are kept
/// per connection, not per session).
#[tauri::command]
pub async fn connection_of_session(session_id: String, state: State<'_, AppState>) -> Result<String, String> {
    let session = state.sessions.get(&session_id).await.ok_or("connection is closed")?;
    Ok(session.profile().id.clone())
}

/// Group indexed files by a key (for the "by month" / "by camera" views).
#[tauri::command]
pub async fn index_group(
    query: IndexQuery,
    by: String,
    state: State<'_, AppState>,
) -> Result<BTreeMap<String, u64>, String> {
    let rows = state.db.index_search(&IndexQuery { limit: Some(5000), ..query }).map_err(e)?;
    let mut out = BTreeMap::new();
    for r in rows {
        let key = match by.as_str() {
            "month" => r
                .taken_ms
                .and_then(chrono::DateTime::from_timestamp_millis)
                .map(|d| d.format("%Y-%m").to_string())
                .unwrap_or_else(|| "undated".into()),
            "camera" => r.camera.unwrap_or_else(|| "unknown".into()),
            _ => r.kind,
        };
        *out.entry(key).or_insert(0) += 1;
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A minimal JPEG: SOI + APP1/EXIF (Make, Model, DateTimeOriginal, GPS) +
    /// a 4×3 SOF0 header. Built by hand so the test needs no fixture file.
    fn jpeg_with_exif() -> Vec<u8> {
        // TIFF, little endian.
        let mut t: Vec<u8> = b"II*\0".to_vec();
        t.extend(8u32.to_le_bytes()); // IFD0 at 8
        // IFD0: Make, Model, ExifIFD ptr, GPS ptr (4 entries)
        let ifd0_entries = 4u16;
        let ifd0_size = 2 + 12 * ifd0_entries as u32 + 4;
        let data0 = 8 + ifd0_size; // where IFD0 out-of-line data starts
        let make = b"Canon\0";
        let model = b"Canon EOS R6\0";
        let make_off = data0;
        let model_off = make_off + make.len() as u32;
        let exif_ifd = model_off + model.len() as u32;
        let exif_entries = 1u16;
        let exif_size = 2 + 12 * exif_entries as u32 + 4;
        let date = b"2024:06:01 12:30:00\0";
        let date_off = exif_ifd + exif_size;
        let gps_ifd = date_off + date.len() as u32;
        let gps_entries = 4u16;
        let gps_size = 2 + 12 * gps_entries as u32 + 4;
        let lat_off = gps_ifd + gps_size;
        let lon_off = lat_off + 24;

        let entry = |t: &mut Vec<u8>, tag: u16, typ: u16, count: u32, val: u32| {
            t.extend(tag.to_le_bytes());
            t.extend(typ.to_le_bytes());
            t.extend(count.to_le_bytes());
            t.extend(val.to_le_bytes());
        };
        t.extend(ifd0_entries.to_le_bytes());
        entry(&mut t, 0x010F, 2, make.len() as u32, make_off);
        entry(&mut t, 0x0110, 2, model.len() as u32, model_off);
        entry(&mut t, 0x8769, 4, 1, exif_ifd);
        entry(&mut t, 0x8825, 4, 1, gps_ifd);
        t.extend(0u32.to_le_bytes());
        t.extend(make);
        t.extend(model);
        t.extend(exif_entries.to_le_bytes());
        entry(&mut t, 0x9003, 2, date.len() as u32, date_off);
        t.extend(0u32.to_le_bytes());
        t.extend(date);
        t.extend(gps_entries.to_le_bytes());
        entry(&mut t, 0x0001, 2, 2, u32::from_le_bytes(*b"S\0\0\0")); // LatitudeRef
        entry(&mut t, 0x0002, 5, 3, lat_off);
        entry(&mut t, 0x0003, 2, 2, u32::from_le_bytes(*b"W\0\0\0")); // LongitudeRef
        entry(&mut t, 0x0004, 5, 3, lon_off);
        t.extend(0u32.to_le_bytes());
        for (n, d) in [(33u32, 1u32), (30, 1), (0, 1)] {
            t.extend(n.to_le_bytes());
            t.extend(d.to_le_bytes());
        }
        for (n, d) in [(70u32, 1u32), (15, 1), (0, 1)] {
            t.extend(n.to_le_bytes());
            t.extend(d.to_le_bytes());
        }

        let mut j = vec![0xFF, 0xD8];
        let app1_len = (2 + 6 + t.len()) as u16;
        j.extend([0xFF, 0xE1]);
        j.extend(app1_len.to_be_bytes());
        j.extend(b"Exif\0\0");
        j.extend(&t);
        // SOF0: 8-bit, 3 high, 4 wide, 1 component.
        j.extend([0xFF, 0xC0, 0x00, 0x0B, 0x08, 0x00, 0x03, 0x00, 0x04, 0x01, 0x01, 0x11, 0x00]);
        j.extend([0xFF, 0xD9]);
        j
    }

    #[test]
    fn reads_date_camera_gps_and_size_from_a_jpeg_header() {
        let m = parse_meta(&jpeg_with_exif());
        assert_eq!(m.camera.as_deref(), Some("Canon EOS R6"));
        let taken = chrono::DateTime::from_timestamp_millis(m.taken_ms.unwrap()).unwrap();
        assert_eq!(taken.format("%Y-%m-%d %H:%M").to_string(), "2024-06-01 12:30");
        let (lat, lon) = m.gps.unwrap();
        assert!((lat + 33.5).abs() < 1e-9 && (lon + 70.25).abs() < 1e-9, "{lat},{lon}");
        assert_eq!((m.width, m.height), (Some(4), Some(3)));
    }

    #[test]
    fn junk_yields_empty_meta() {
        assert_eq!(parse_meta(b"not an image"), Meta::default());
    }

    #[test]
    fn kinds_tokens_and_hashes() {
        assert_eq!(kind_of("IMG_1.JPG"), "image");
        assert_eq!(kind_of("clip.mov"), "video");
        assert_eq!(kind_of("README"), "other");
        let e = ScanEntry { absolute: "/a".into(), size: 3, modified: 9, etag: None };
        assert_eq!(change_token(&e), "3:9");
        let tagged = ScanEntry { etag: Some("abc".into()), ..e };
        assert_eq!(change_token(&tagged), "etag:abc:9");
        assert_eq!(hash_from_etag(Some("\"0123456789ABCDEF0123456789abcdef\"")).unwrap(), "md5:0123456789abcdef0123456789abcdef");
        assert_eq!(hash_from_etag(Some("0123456789abcdef0123456789abcdef-3")), None);
    }

    fn row(path: &str, kind: &str, taken: Option<i64>, camera: Option<&str>) -> IndexRow {
        IndexRow {
            connection_id: "c".into(),
            path: path.into(),
            root: "/lib".into(),
            name: path.rsplit('/').next().unwrap().into(),
            size: 1,
            change_token: "t".into(),
            kind: kind.into(),
            taken_ms: taken,
            width: None,
            height: None,
            camera: camera.map(Into::into),
            lens: None,
            gps_lat: None,
            gps_lon: None,
            content_hash: None,
            mtime_ms: None,
            tags: vec![],
            remote_tags: None,
        }
    }

    #[test]
    fn search_filters_and_tags() {
        let db = Db::open_in_memory().unwrap();
        db.index_upsert(&[
            row("/lib/2024/a.jpg", "image", Some(1_717_000_000_000), Some("R6")),
            row("/lib/2023/b.jpg", "image", Some(1_680_000_000_000), Some("X100")),
            row("/lib/notes.pdf", "document", None, None),
            IndexRow { root: "/other".into(), ..row("/other/c.jpg", "image", None, None) },
        ])
        .unwrap();
        db.tags_set("c", "/lib/2023/b.jpg", &["Client-X, hero ".into(), "client-x".into()]).unwrap();

        let q = |f: IndexQuery| db.index_search(&f).unwrap().into_iter().map(|r| r.path).collect::<Vec<_>>();
        assert_eq!(q(IndexQuery { kinds: vec!["image".into()], under: Some("/lib".into()), ..Default::default() }).len(), 2);
        assert_eq!(q(IndexQuery { camera: Some("R6".into()), ..Default::default() }), vec!["/lib/2024/a.jpg"]);
        assert_eq!(q(IndexQuery { tag: Some("Client-X".into()), ..Default::default() }), vec!["/lib/2023/b.jpg"]);
        assert_eq!(
            q(IndexQuery { taken_from_ms: Some(1_700_000_000_000), ..Default::default() }),
            vec!["/lib/2024/a.jpg"]
        );
        assert_eq!(q(IndexQuery { text: Some("NOTES".into()), ..Default::default() }), vec!["/lib/notes.pdf"]);
        let got = db.index_search(&IndexQuery { tag: Some("hero".into()), ..Default::default() }).unwrap();
        assert_eq!(got[0].tags, vec!["client-x", "hero"]);
        let facets = db.index_facets(Some("c")).unwrap();
        assert_eq!(facets.cameras, vec!["R6", "X100"]);
        assert_eq!(facets.files, 4);

        db.index_root_add("c", "/lib").unwrap();
        db.index_root_forget("c", "/lib").unwrap();
        assert_eq!(q(IndexQuery::default()), vec!["/other/c.jpg"]);
        assert!(db.tags_get("c", "/lib/2023/b.jpg").unwrap().is_empty());
    }
}
