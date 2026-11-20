//! Settings › Rules (Plan 34 Phase 5): rename, sort and view rules, grouped
//! into rule sets kept in `rules.json` (shared by the app and `faro-cli`).
//!
//! - **Rename** (first match wins) gives a file a new name from a template:
//!   `{taken:yyyy-MM-dd}_{camera}_{seq:4}{ext}`.
//! - **Sort** (first match wins) puts it in a folder from a template:
//!   `{taken:yyyy}/{taken:MM}`.
//! - **View** rules never move anything: every matching file also shows in
//!   a folder named by the rule (in a mount's `Views` folder, and in the
//!   Indexed files search).
//!
//! Rules apply through [`Namer`]s handed to the Copy to… planner, or to an
//! in-place rename plan ([`plan_in_place`]). Facts a template needs (date
//! taken, camera, tags) come from a [`FactsFn`]: the file index for remote
//! files, the file's own header for files on this PC.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::Path;
use std::sync::{Arc, Mutex};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use crate::scan::{ScanEntry, ScanTree};

// ---------- model ----------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RuleKind {
    Rename,
    Sort,
    View,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Condition {
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub kinds: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name_glob: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tag: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub camera: Option<String>,
    /// `yyyy-mm-dd`, inclusive.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub taken_from: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub taken_to: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min_size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_size: Option<u64>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Cleanup {
    pub lowercase_ext: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub spaces_to: Option<String>,
    pub strip_illegal: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rule {
    pub id: String,
    pub kind: RuleKind,
    #[serde(default = "yes")]
    pub enabled: bool,
    #[serde(default)]
    pub when: Condition,
    pub template: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cleanup: Option<Cleanup>,
    /// Stands in for a token with no value (no date, no camera).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fallback: Option<String>,
}

fn yes() -> bool {
    true
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleSet {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub rules: Vec<Rule>,
}

/// What a rule can know about a file beyond its path and size.
#[derive(Debug, Clone, Default)]
pub struct FileFacts {
    pub taken_ms: Option<i64>,
    pub camera: Option<String>,
    pub tags: Vec<String>,
}

pub type FactsFn = Arc<dyn Fn(&ScanEntry) -> FileFacts + Send + Sync>;

// ---------- storage ----------

fn rules_path(data_dir: &Path) -> std::path::PathBuf {
    data_dir.join("rules.json")
}

pub fn load_sets(data_dir: &Path) -> Vec<RuleSet> {
    std::fs::read(rules_path(data_dir))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

pub fn save_sets(data_dir: &Path, sets: &[RuleSet]) -> Result<()> {
    std::fs::create_dir_all(data_dir).ok();
    crate::fsutil::write_atomic(&rules_path(data_dir), &serde_json::to_vec_pretty(sets)?)
        .context("write rules.json")
}

/// A rule set by id or (case-insensitive) name.
pub fn find_set(data_dir: &Path, id_or_name: &str) -> Result<RuleSet> {
    load_sets(data_dir)
        .into_iter()
        .find(|s| s.id == id_or_name || s.name.eq_ignore_ascii_case(id_or_name))
        .ok_or_else(|| anyhow::anyhow!("no rule set named {id_or_name:?} (Settings › Rules)"))
}

// ---------- matching + templates (pure) ----------

/// `*` and `?` glob on a file name, case-insensitive.
pub fn glob_match(pattern: &str, name: &str) -> bool {
    fn m(p: &[char], n: &[char]) -> bool {
        match (p.first(), n.first()) {
            (None, None) => true,
            (Some('*'), _) => m(&p[1..], n) || (!n.is_empty() && m(p, &n[1..])),
            (Some('?'), Some(_)) => m(&p[1..], &n[1..]),
            (Some(a), Some(b)) => a == b && m(&p[1..], &n[1..]),
            _ => false,
        }
    }
    let p: Vec<char> = pattern.to_lowercase().chars().collect();
    let n: Vec<char> = name.to_lowercase().chars().collect();
    m(&p, &n)
}

fn day_ms(iso: &str, end: bool) -> Option<i64> {
    let d = chrono::NaiveDate::parse_from_str(iso.trim(), "%Y-%m-%d").ok()?;
    let t = if end { d.and_hms_opt(23, 59, 59)? } else { d.and_hms_opt(0, 0, 0)? };
    Some(t.and_utc().timestamp_millis())
}

fn file_name(rel: &str) -> &str {
    rel.rsplit('/').next().unwrap_or(rel)
}

/// Whether `cond` matches a file. An empty condition matches everything.
pub fn matches(cond: &Condition, rel: &str, entry: &ScanEntry, facts: &FileFacts) -> bool {
    let name = file_name(rel);
    if !cond.kinds.is_empty() && !cond.kinds.iter().any(|k| k == crate::fileindex::kind_of(name)) {
        return false;
    }
    if let Some(g) = cond.name_glob.as_deref().filter(|g| !g.trim().is_empty()) {
        if !g.split(',').any(|g| glob_match(g.trim(), name)) {
            return false;
        }
    }
    if let Some(t) = cond.tag.as_deref().filter(|t| !t.trim().is_empty()) {
        if !facts.tags.iter().any(|x| x.eq_ignore_ascii_case(t.trim())) {
            return false;
        }
    }
    if let Some(c) = cond.camera.as_deref().filter(|c| !c.trim().is_empty()) {
        if !facts.camera.as_deref().is_some_and(|x| x.to_lowercase().contains(&c.trim().to_lowercase())) {
            return false;
        }
    }
    if let Some(from) = cond.taken_from.as_deref().and_then(|d| day_ms(d, false)) {
        if !facts.taken_ms.is_some_and(|t| t >= from) {
            return false;
        }
    }
    if let Some(to) = cond.taken_to.as_deref().and_then(|d| day_ms(d, true)) {
        if !facts.taken_ms.is_some_and(|t| t <= to) {
            return false;
        }
    }
    !(cond.min_size.is_some_and(|m| entry.size < m) || cond.max_size.is_some_and(|m| entry.size > m))
}

/// `yyyy-MM-dd HH:mm:ss`-style format → chrono's. Unknown letters pass through.
fn fmt_date(ms: i64, pattern: &str) -> String {
    let Some(t) = chrono::DateTime::from_timestamp_millis(ms) else { return String::new() };
    let spec = pattern
        .replace("yyyy", "%Y")
        .replace("yy", "%y")
        .replace("MM", "%m")
        .replace("dd", "%d")
        .replace("HH", "%H")
        .replace("mm", "%M")
        .replace("ss", "%S");
    t.format(&spec).to_string()
}

/// Everything a template can reference for one file.
pub struct TokenCtx<'a> {
    pub rel: &'a str,
    pub entry: &'a ScanEntry,
    pub facts: &'a FileFacts,
    pub seq: u32,
    pub fallback: &'a str,
}

fn as_ms(t: i64) -> i64 {
    if t != 0 && t.abs() < 100_000_000_000 {
        t * 1000
    } else {
        t
    }
}

/// Render `{token}` / `{token:arg}` placeholders.
pub fn render(template: &str, cx: &TokenCtx<'_>) -> String {
    let name = file_name(cx.rel);
    let (stem, ext) = match name.rfind('.').filter(|&i| i > 0) {
        Some(i) => (&name[..i], &name[i..]),
        None => (name, ""),
    };
    let parent = cx.rel.rsplit_once('/').map(|(p, _)| p.rsplit('/').next().unwrap_or(p)).unwrap_or("");
    let mut out = String::new();
    let mut rest = template;
    while let Some(open) = rest.find('{') {
        out.push_str(&rest[..open]);
        let Some(close) = rest[open..].find('}') else {
            out.push_str(&rest[open..]);
            return out;
        };
        let token = &rest[open + 1..open + close];
        let (key, arg) = token.split_once(':').unwrap_or((token, ""));
        let value = match key {
            "name" => stem.to_string(),
            "ext" => ext.to_string(),
            "parent" => parent.to_string(),
            "kind" => crate::fileindex::kind_of(name).to_string(),
            "size" => cx.entry.size.to_string(),
            "camera" => cx.facts.camera.clone().unwrap_or_default(),
            "tag" => cx.facts.tags.first().cloned().unwrap_or_default(),
            "taken" => cx.facts.taken_ms.map(|t| fmt_date(t, if arg.is_empty() { "yyyy-MM-dd" } else { arg })).unwrap_or_default(),
            "mtime" if cx.entry.modified != 0 => {
                fmt_date(as_ms(cx.entry.modified), if arg.is_empty() { "yyyy-MM-dd" } else { arg })
            }
            "mtime" => String::new(),
            // {date:…}: taken, else the file's modified time.
            "date" => cx
                .facts
                .taken_ms
                .or((cx.entry.modified != 0).then(|| as_ms(cx.entry.modified)))
                .map(|t| fmt_date(t, if arg.is_empty() { "yyyy-MM-dd" } else { arg }))
                .unwrap_or_default(),
            "seq" => {
                let width = arg.parse::<usize>().unwrap_or(1);
                format!("{:0width$}", cx.seq)
            }
            _ => format!("{{{token}}}"),
        };
        out.push_str(if value.is_empty() { cx.fallback } else { &value });
        rest = &rest[open + close + 1..];
    }
    out.push_str(rest);
    out
}

const ILLEGAL: &[char] = &['<', '>', ':', '"', '\\', '|', '?', '*'];

/// Apply a rule's cleanup to one path segment (a file name or folder name).
pub fn clean_segment(seg: &str, c: Option<&Cleanup>, is_file: bool) -> String {
    let mut s = seg.to_string();
    if let Some(c) = c {
        if c.strip_illegal {
            s = s.chars().filter(|ch| !ILLEGAL.contains(ch) && !ch.is_control()).collect();
        }
        if let Some(to) = &c.spaces_to {
            s = s.split_whitespace().collect::<Vec<_>>().join(to);
        }
        if c.lowercase_ext && is_file {
            if let Some(i) = s.rfind('.').filter(|&i| i > 0) {
                s = format!("{}{}", &s[..i], s[i..].to_lowercase());
            }
        }
    }
    // Never produce an empty or dot-only segment.
    let trimmed = s.trim().trim_end_matches('.').to_string();
    if trimmed.is_empty() { "_".into() } else { trimmed }
}

/// Where one file goes under a rule set: `(new relative path, view folders)`.
pub struct Evaluator {
    set: RuleSet,
    facts: FactsFn,
    /// `{seq}` counters, per destination folder.
    seq: Mutex<HashMap<String, u32>>,
}

impl Evaluator {
    pub fn new(set: RuleSet, facts: FactsFn) -> Self {
        Self { set, facts, seq: Mutex::new(HashMap::new()) }
    }

    pub fn facts(&self, entry: &ScanEntry) -> FileFacts {
        (self.facts)(entry)
    }

    /// New relative path for `rel` (identity when no rename/sort rule matches).
    pub fn place(&self, rel: &str, entry: &ScanEntry) -> String {
        let facts = self.facts(entry);
        self.place_with(rel, entry, &facts)
    }

    pub fn place_with(&self, rel: &str, entry: &ScanEntry, facts: &FileFacts) -> String {
        self.place_scoped(rel, rel, entry, facts)
    }

    /// Place `inner` (the path being moved) while tokens like `{parent}` see
    /// `context` (the path including the folder the user picked).
    pub fn place_scoped(&self, context: &str, inner: &str, entry: &ScanEntry, facts: &FileFacts) -> String {
        let rel = context;
        let live = |k: RuleKind| {
            self.set.rules.iter().find(|r| r.enabled && r.kind == k && matches(&r.when, rel, entry, facts))
        };
        let dir = inner.rsplit_once('/').map(|(d, _)| d.to_string()).unwrap_or_default();
        let name = file_name(inner).to_string();

        let dir = match live(RuleKind::Sort) {
            Some(r) => {
                let cx = TokenCtx { rel, entry, facts, seq: 0, fallback: r.fallback.as_deref().unwrap_or("unsorted") };
                render(&r.template, &cx)
                    .split(['/', '\\'])
                    .filter(|s| !s.trim().is_empty())
                    .map(|s| clean_segment(s, r.cleanup.as_ref(), false))
                    .collect::<Vec<_>>()
                    .join("/")
            }
            None => dir,
        };
        let name = match live(RuleKind::Rename) {
            Some(r) => {
                let seq = {
                    let mut m = self.seq.lock().unwrap();
                    let n = m.entry(dir.clone()).or_insert(0);
                    *n += 1;
                    *n
                };
                let cx = TokenCtx { rel, entry, facts, seq, fallback: r.fallback.as_deref().unwrap_or("") };
                // A rename template names the file, never a folder.
                let rendered = render(&r.template, &cx).replace(['/', '\\'], "-");
                clean_segment(&rendered, r.cleanup.as_ref(), true)
            }
            None => name,
        };
        if dir.is_empty() { name } else { format!("{dir}/{name}") }
    }

    /// View folders a file shows in.
    pub fn views(&self, rel: &str, entry: &ScanEntry, facts: &FileFacts) -> Vec<String> {
        self.set
            .rules
            .iter()
            .filter(|r| r.enabled && r.kind == RuleKind::View && matches(&r.when, rel, entry, facts))
            .map(|r| {
                let cx = TokenCtx { rel, entry, facts, seq: 0, fallback: r.fallback.as_deref().unwrap_or("other") };
                clean_segment(&render(&r.template, &cx).replace(['/', '\\'], "-"), Some(&Cleanup { strip_illegal: true, ..Default::default() }), false)
            })
            .collect()
    }

    pub fn has_views(&self) -> bool {
        self.set.rules.iter().any(|r| r.enabled && r.kind == RuleKind::View)
    }
}

/// A destination-path mapper handed to [`crate::copyto::plan`].
pub type BoxNamer = Box<dyn Fn(&str, &ScanEntry) -> String + Send + Sync>;

fn identity() -> BoxNamer {
    Box::new(|rel: &str, _: &ScanEntry| rel.to_string())
}

/// Copy planning keeps the top folder the user picked (`lib/…`) and applies
/// rules beneath it.
fn namer_from(eval: Evaluator) -> BoxNamer {
    Box::new(move |rel: &str, entry: &ScanEntry| {
        let facts = eval.facts(entry);
        match rel.split_once('/') {
            Some((top, inner)) => format!("{top}/{}", eval.place_scoped(rel, inner, entry, &facts)),
            None => eval.place_with(rel, entry, &facts),
        }
    })
}

/// The namer for an optional rule set (by id or name) from `rules.json` in
/// `data_dir`. Identity when none is attached.
pub fn load_namer(data_dir: &Path, rule_set: Option<&str>, facts: FactsFn) -> Result<BoxNamer> {
    match rule_set.filter(|s| !s.is_empty()) {
        None => Ok(identity()),
        Some(id) => Ok(namer_from(Evaluator::new(find_set(data_dir, id)?, facts))),
    }
}

/// Facts for files on this PC: read the image header from disk.
pub fn facts_local() -> FactsFn {
    Arc::new(|e: &ScanEntry| {
        use std::io::Read;
        let mut buf = Vec::new();
        let name = file_name(&e.absolute.replace('\\', "/")).to_string();
        if crate::fileindex::kind_of(&name) != "image" {
            return FileFacts::default();
        }
        if let Ok(f) = std::fs::File::open(&e.absolute) {
            let _ = f.take(crate::fileindex::HEAD_BYTES).read_to_end(&mut buf);
        }
        let m = crate::fileindex::parse_meta(&buf);
        FileFacts { taken_ms: m.taken_ms, camera: m.camera, tags: vec![] }
    })
}

/// Facts for remote files: what the file index knows.
pub fn facts_from_index(db: Arc<crate::db::Db>, connection_id: String) -> FactsFn {
    Arc::new(move |e: &ScanEntry| match db.index_get(&connection_id, &e.absolute) {
        Ok(Some(r)) => FileFacts { taken_ms: r.taken_ms, camera: r.camera, tags: r.tags },
        _ => FileFacts::default(),
    })
}

/// Facts that know nothing (rules on name, kind and size still work).
pub fn facts_none() -> FactsFn {
    Arc::new(|_: &ScanEntry| FileFacts::default())
}

// ---------- in-place renames (pure) ----------

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameOp {
    pub from: String,
    pub to: String,
}

/// Renames that bring `tree` (relative paths under `root`) in line with the
/// rule set. Targets that clash — with each other or with a file that isn't
/// moving — get `-1`, `-2` suffixes.
pub fn plan_in_place(root: &str, tree: &ScanTree, eval: &Evaluator) -> Vec<RenameOp> {
    let wanted: BTreeMap<&String, String> = tree.files.iter().map(|(rel, e)| (rel, eval.place(rel, e))).collect();
    let staying: BTreeSet<String> =
        wanted.iter().filter(|(rel, to)| rel.as_str() == to.as_str()).map(|(rel, _)| (*rel).clone()).collect();
    let mut taken = staying.clone();
    let mut ops = Vec::new();
    for (rel, to) in &wanted {
        if rel.as_str() == to.as_str() {
            continue;
        }
        let mut target = to.clone();
        let mut n = 1;
        while taken.contains(&target) {
            target = crate::copyto::with_suffix_pub(to, n);
            n += 1;
        }
        taken.insert(target.clone());
        let join = |r: &str| format!("{}/{r}", root.trim_end_matches('/'));
        ops.push(RenameOp { from: join(rel), to: join(&target) });
    }
    ops
}

// ---------- Tauri commands ----------

fn data_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    use tauri::Manager;
    app.path().app_data_dir().map_err(|e| e.to_string())
}

/// [`load_namer`] against the app's data dir, with facts for the source.
pub async fn namer_for(app: &tauri::AppHandle, rule_set: Option<&str>, facts: FactsFn) -> Result<BoxNamer> {
    use tauri::Manager;
    let dir = app.path().app_data_dir()?;
    load_namer(&dir, rule_set, facts)
}

#[tauri::command]
pub async fn rules_list(app: tauri::AppHandle) -> Result<Vec<RuleSet>, String> {
    Ok(load_sets(&data_dir(&app)?))
}

#[tauri::command]
pub async fn rules_save(set: RuleSet, app: tauri::AppHandle) -> Result<Vec<RuleSet>, String> {
    let dir = data_dir(&app)?;
    let mut set = set;
    if set.id.is_empty() {
        set.id = uuid::Uuid::new_v4().to_string();
    }
    for r in &mut set.rules {
        if r.id.is_empty() {
            r.id = uuid::Uuid::new_v4().to_string();
        }
    }
    let mut sets = load_sets(&dir);
    match sets.iter_mut().find(|s| s.id == set.id) {
        Some(s) => *s = set,
        None => sets.push(set),
    }
    save_sets(&dir, &sets).map_err(|e| format!("{e:#}"))?;
    Ok(sets)
}

#[tauri::command]
pub async fn rules_delete(id: String, app: tauri::AppHandle) -> Result<Vec<RuleSet>, String> {
    let dir = data_dir(&app)?;
    let mut sets = load_sets(&dir);
    sets.retain(|s| s.id != id);
    save_sets(&dir, &sets).map_err(|e| format!("{e:#}"))?;
    Ok(sets)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleSample {
    pub from: String,
    pub to: String,
    pub views: Vec<String>,
}

/// Facts for files on a session: the index for remote, the header for local.
async fn facts_for_session(
    state: &crate::AppState,
    session_id: &str,
) -> Result<(Option<Arc<crate::session::Session>>, FactsFn), String> {
    if session_id == crate::commands::LOCAL_SESSION {
        return Ok((None, facts_local()));
    }
    let s = state.sessions.get(session_id).await.ok_or("connection is closed")?;
    let cid = s.profile().id.clone();
    Ok((Some(s), facts_from_index(state.db.clone(), cid)))
}

async fn tree_of(session: Option<&Arc<crate::session::Session>>, path: &str) -> Result<ScanTree, String> {
    let fs: Box<dyn crate::remotefs::RemoteFs> = match session {
        Some(s) => crate::commands::fs_for_session(s),
        None => Box::new(crate::remotefs::local::LocalFs),
    };
    crate::scan::walk_tree(fs.as_ref(), path).await.map_err(|e| format!("{e:#}"))
}

/// The editor's live test: run `set` (unsaved edits included) over up to
/// 50 files under `path`.
#[tauri::command]
pub async fn rules_test(
    set: RuleSet,
    session_id: String,
    path: String,
    state: tauri::State<'_, crate::AppState>,
) -> Result<Vec<RuleSample>, String> {
    let (session, facts) = facts_for_session(&state, &session_id).await?;
    let tree = tree_of(session.as_ref(), &path).await?;
    let eval = Evaluator::new(set, facts);
    Ok(tree
        .files
        .iter()
        .take(50)
        .map(|(rel, e)| {
            let f = eval.facts(e);
            RuleSample { from: rel.clone(), to: eval.place_with(rel, e, &f), views: eval.views(rel, e, &f) }
        })
        .collect())
}

/// Preview renaming files under `path` in place with a rule set.
#[tauri::command]
pub async fn rules_plan_in_place(
    set_id: String,
    session_id: String,
    path: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::AppState>,
) -> Result<Vec<RenameOp>, String> {
    let set = find_set(&data_dir(&app)?, &set_id).map_err(|e| format!("{e:#}"))?;
    let (session, facts) = facts_for_session(&state, &session_id).await?;
    let tree = tree_of(session.as_ref(), &path).await?;
    Ok(plan_in_place(&path, &tree, &Evaluator::new(set, facts)))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyResult {
    pub renamed: u32,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub errors: Vec<String>,
}

/// Apply in-place renames (re-planned, so the result matches what's there).
#[tauri::command]
pub async fn rules_apply_in_place(
    set_id: String,
    session_id: String,
    path: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::AppState>,
) -> Result<ApplyResult, String> {
    let set = find_set(&data_dir(&app)?, &set_id).map_err(|e| format!("{e:#}"))?;
    let (session, facts) = facts_for_session(&state, &session_id).await?;
    let fs: Box<dyn crate::remotefs::RemoteFs> = match &session {
        Some(s) => crate::commands::fs_for_session(s),
        None => Box::new(crate::remotefs::local::LocalFs),
    };
    let tree = crate::scan::walk_tree(fs.as_ref(), &path).await.map_err(|e| format!("{e:#}"))?;
    let ops = plan_in_place(&path, &tree, &Evaluator::new(set, facts));
    let mut out = ApplyResult { renamed: 0, errors: vec![] };
    let mut made: BTreeSet<String> = BTreeSet::new();
    for op in ops {
        // Create the target's folders (sort rules) first.
        if let Some((parent, _)) = op.to.rsplit_once('/') {
            let mut acc = String::new();
            for seg in parent.split('/') {
                acc = if acc.is_empty() && seg.is_empty() { "/".into() } else if acc == "/" { format!("/{seg}") } else if acc.is_empty() { seg.to_string() } else { format!("{acc}/{seg}") };
                if acc.len() > path.trim_end_matches('/').len() && made.insert(acc.clone()) {
                    let _ = fs.create_dir(&acc).await;
                }
            }
        }
        match fs.rename_no_replace(&op.from, &op.to).await {
            Ok(()) => out.renamed += 1,
            Err(e) => out.errors.push(format!("{}: {e:#}", op.from)),
        }
    }
    Ok(out)
}

/// Indexed files that a rule set's view rules put in each view folder.
#[tauri::command]
pub async fn rules_views(
    set_id: String,
    connection_id: Option<String>,
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::AppState>,
) -> Result<BTreeMap<String, Vec<crate::fileindex::IndexRow>>, String> {
    let set = find_set(&data_dir(&app)?, &set_id).map_err(|e| format!("{e:#}"))?;
    let rows = state
        .db
        .index_search(&crate::fileindex::IndexQuery { connection_id, limit: Some(5000), ..Default::default() })
        .map_err(|e| format!("{e:#}"))?;
    Ok(views_of_rows(&set, rows))
}

/// Group index rows into a rule set's view folders.
pub fn views_of_rows(set: &RuleSet, rows: Vec<crate::fileindex::IndexRow>) -> BTreeMap<String, Vec<crate::fileindex::IndexRow>> {
    let eval = Evaluator::new(set.clone(), facts_none());
    let mut out: BTreeMap<String, Vec<crate::fileindex::IndexRow>> = BTreeMap::new();
    for r in rows {
        let entry = ScanEntry { absolute: r.path.clone(), size: r.size, modified: r.mtime_ms.unwrap_or(0), etag: None };
        let facts = FileFacts { taken_ms: r.taken_ms, camera: r.camera.clone(), tags: r.tags.clone() };
        let rel = r.path.strip_prefix(&r.root).unwrap_or(&r.path).trim_start_matches('/').to_string();
        for v in eval.views(&rel, &entry, &facts) {
            out.entry(v).or_default().push(r.clone());
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(path: &str, size: u64, modified: i64) -> ScanEntry {
        ScanEntry { absolute: path.into(), size, modified, etag: None }
    }

    fn rule(kind: RuleKind, template: &str, when: Condition) -> Rule {
        Rule { id: String::new(), kind, enabled: true, when, template: template.into(), cleanup: None, fallback: None }
    }

    fn facts(taken: &str, camera: &str, tags: &[&str]) -> FactsFn {
        let taken_ms = day_ms(taken, false).map(|t| t + 13 * 3600 * 1000);
        let camera = (!camera.is_empty()).then(|| camera.to_string());
        let tags: Vec<String> = tags.iter().map(|t| t.to_string()).collect();
        Arc::new(move |_| FileFacts { taken_ms, camera: camera.clone(), tags: tags.clone() })
    }

    #[test]
    fn templates_render_dates_names_and_sequences() {
        let set = RuleSet {
            id: "s".into(),
            name: "Photos".into(),
            rules: vec![
                rule(RuleKind::Sort, "{taken:yyyy}/{taken:MM}", Condition { kinds: vec!["image".into()], ..Default::default() }),
                Rule {
                    cleanup: Some(Cleanup { lowercase_ext: true, spaces_to: Some("_".into()), strip_illegal: true }),
                    ..rule(RuleKind::Rename, "{taken:yyyy-MM-dd}_{camera}_{seq:3}{ext}", Condition::default())
                },
            ],
        };
        let eval = Evaluator::new(set, facts("2024-06-01", "Canon EOS R6", &[]));
        assert_eq!(eval.place("dump/IMG 1.JPG", &entry("/x", 1, 0)), "2024/06/2024-06-01_Canon_EOS_R6_001.jpg");
        assert_eq!(eval.place("dump/IMG 2.JPG", &entry("/y", 1, 0)), "2024/06/2024-06-01_Canon_EOS_R6_002.jpg");
        // Not an image: no sort, rename still applies (first-match rename).
        assert_eq!(eval.place("notes.txt", &entry("/z", 1, 0)), "2024-06-01_Canon_EOS_R6_001.txt");
    }

    #[test]
    fn missing_values_use_the_fallback() {
        let set = RuleSet {
            id: "s".into(),
            name: "n".into(),
            rules: vec![Rule { fallback: Some("undated".into()), ..rule(RuleKind::Sort, "{taken:yyyy}", Condition::default()) }],
        };
        let eval = Evaluator::new(set, facts_none());
        assert_eq!(eval.place("a/b.jpg", &entry("/b", 1, 0)), "undated/b.jpg");
    }

    #[test]
    fn conditions_glob_tag_camera_dates_size() {
        let e = entry("/a", 500, 0);
        let f = FileFacts { taken_ms: day_ms("2023-03-04", false), camera: Some("FUJIFILM X100V".into()), tags: vec!["client-x".into()] };
        let c = |c: Condition| matches(&c, "dir/IMG_9.jpg", &e, &f);
        assert!(c(Condition { name_glob: Some("img_*.JPG".into()), ..Default::default() }));
        assert!(!c(Condition { name_glob: Some("*.png".into()), ..Default::default() }));
        assert!(c(Condition { tag: Some("Client-X".into()), ..Default::default() }));
        assert!(c(Condition { camera: Some("x100".into()), ..Default::default() }));
        assert!(c(Condition { taken_from: Some("2023-01-01".into()), taken_to: Some("2023-12-31".into()), ..Default::default() }));
        assert!(!c(Condition { taken_from: Some("2024-01-01".into()), ..Default::default() }));
        assert!(!c(Condition { min_size: Some(1000), ..Default::default() }));
        assert!(c(Condition { kinds: vec!["image".into()], ..Default::default() }));
    }

    #[test]
    fn views_never_move_files() {
        let set = RuleSet {
            id: "s".into(),
            name: "n".into(),
            rules: vec![rule(RuleKind::View, "Client {tag}", Condition { tag: Some("client-x".into()), ..Default::default() })],
        };
        let eval = Evaluator::new(set, facts("2024-01-01", "", &["client-x"]));
        let e = entry("/a", 1, 0);
        assert_eq!(eval.place("a/b.jpg", &e), "a/b.jpg");
        assert_eq!(eval.views("a/b.jpg", &e, &eval.facts(&e)), vec!["Client client-x"]);
    }

    #[test]
    fn in_place_plan_avoids_clashing_with_files_that_stay() {
        let mut tree = ScanTree::default();
        for (rel, m) in [("x.jpg", 0), ("y.jpg", 0), ("photo.jpg", 0)] {
            tree.files.insert(rel.into(), entry(&format!("/r/{rel}"), 1, m));
        }
        // Rename every file to photo.jpg: photo.jpg stays, the others number.
        let set = RuleSet {
            id: "s".into(),
            name: "n".into(),
            rules: vec![rule(RuleKind::Rename, "photo{ext}", Condition::default())],
        };
        let ops = plan_in_place("/r", &tree, &Evaluator::new(set, facts_none()));
        assert_eq!(
            ops,
            vec![
                RenameOp { from: "/r/x.jpg".into(), to: "/r/photo-1.jpg".into() },
                RenameOp { from: "/r/y.jpg".into(), to: "/r/photo-2.jpg".into() },
            ]
        );
    }

    #[test]
    fn copy_namer_keeps_the_top_folder() {
        let dir = std::env::temp_dir().join(format!("faro-rules-{}", std::process::id()));
        let set = RuleSet { id: "id1".into(), name: "Lower".into(), rules: vec![rule(RuleKind::Rename, "{name}-x{ext}", Condition::default())] };
        save_sets(&dir, &[set]).unwrap();
        let namer = load_namer(&dir, Some("lower"), facts_none()).unwrap();
        assert_eq!(namer("lib/sub/a.jpg", &entry("/a", 1, 0)), "lib/sub/a-x.jpg");
        // {parent} of a top-level file is the folder being copied.
        let set = RuleSet { id: "id2".into(), name: "Parent".into(), rules: vec![rule(RuleKind::Rename, "{parent}_{name}{ext}", Condition::default())] };
        save_sets(&dir, &[set]).unwrap();
        let namer = load_namer(&dir, Some("parent"), facts_none()).unwrap();
        assert_eq!(namer("lib/a.jpg", &entry("/a", 1, 0)), "lib/lib_a.jpg");
        assert!(load_namer(&dir, Some("missing"), facts_none()).is_err());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn segments_are_cleaned() {
        let c = Cleanup { lowercase_ext: true, spaces_to: Some("-".into()), strip_illegal: true };
        assert_eq!(clean_segment("My: File?.JPG", Some(&c), true), "My-File.jpg");
        assert_eq!(clean_segment("...", Some(&c), false), "_");
    }
}
