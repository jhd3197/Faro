//! Main-window bounds and background across launches.
//!
//! The last normal (not maximized, not minimized) outer position and inner size,
//! plus the maximized flag, live in the `windowState` settings row. Saves are
//! debounced while the user drags; a close flushes at once. On launch the saved
//! rectangle is checked against the monitors that exist *now*: a rectangle that
//! no longer lands on any work area (unplugged monitor, changed layout) loses
//! its position and is centred, and one that overhangs is pulled back inside.
//!
//! `windowBackground` holds the last theme's page colour (written by the
//! frontend when the theme changes), so the native window paints that colour
//! before the webview loads instead of flashing white.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{PhysicalPosition, PhysicalSize, WebviewWindow, WindowEvent};

use crate::db::Db;

pub const STATE_KEY: &str = "windowState";
pub const BACKGROUND_KEY: &str = "windowBackground";
const VERSION: u32 = 1;
const SAVE_DEBOUNCE: Duration = Duration::from_millis(500);
/// Minimised windows on Windows report positions around -32000.
const OFFSCREEN_SENTINEL: i32 = -30000;
/// At least this much of the window's area must land on one work area for the
/// saved position to be kept (clamped inside it); less and it is dropped.
const MIN_VISIBLE_FRACTION: f64 = 0.5;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct SavedBounds {
    pub v: u32,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub maximized: bool,
}

/// A monitor's work area in physical pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Area {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// What to apply to the window at creation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Placement {
    pub size: (u32, u32),
    /// `None` → leave the OS/default placement (centred).
    pub position: Option<(i32, i32)>,
    pub maximized: bool,
}

/// Parse and sanity-check a stored row. Anything malformed, from another
/// version, or absurd is ignored rather than half-applied.
pub fn parse(raw: &str) -> Option<SavedBounds> {
    let b: SavedBounds = serde_json::from_str(raw).ok()?;
    if b.v != VERSION {
        return None;
    }
    if b.width < 200 || b.height < 150 || b.width > 32_000 || b.height > 32_000 {
        return None;
    }
    if b.x <= OFFSCREEN_SENTINEL || b.y <= OFFSCREEN_SENTINEL {
        return None;
    }
    Some(b)
}

fn overlap(b: &SavedBounds, a: &Area) -> u64 {
    let left = b.x.max(a.x) as i64;
    let top = b.y.max(a.y) as i64;
    let right = (b.x as i64 + b.width as i64).min(a.x as i64 + a.width as i64);
    let bottom = (b.y as i64 + b.height as i64).min(a.y as i64 + a.height as i64);
    if right <= left || bottom <= top {
        0
    } else {
        ((right - left) * (bottom - top)) as u64
    }
}

/// Fit saved bounds to the monitors present now. `areas` are work areas;
/// the first one is treated as primary when the position has to be dropped.
pub fn fit(saved: &SavedBounds, areas: &[Area]) -> Placement {
    let best = areas
        .iter()
        .map(|a| (overlap(saved, a), a))
        .max_by_key(|(o, _)| *o);
    let total = saved.width as u64 * saved.height as u64;
    match best {
        Some((o, area)) if total > 0 && o as f64 >= total as f64 * MIN_VISIBLE_FRACTION => {
            // Keep it on this monitor: shrink to the work area, then nudge it
            // fully inside so no edge (or the title bar) hangs off-screen.
            let w = saved.width.min(area.width);
            let h = saved.height.min(area.height);
            let max_x = area.x + area.width as i32 - w as i32;
            let max_y = area.y + area.height as i32 - h as i32;
            let x = saved.x.clamp(area.x, max_x);
            let y = saved.y.clamp(area.y, max_y);
            Placement { size: (w, h), position: Some((x, y)), maximized: saved.maximized }
        }
        _ => {
            // The monitor it was on is gone: keep the size if it fits the
            // primary work area, and let the window open centred.
            let (w, h) = match areas.first() {
                Some(a) => (saved.width.min(a.width), saved.height.min(a.height)),
                None => (saved.width, saved.height),
            };
            Placement { size: (w, h), position: None, maximized: saved.maximized }
        }
    }
}

/// `#rrggbb` → RGB. Anything else is ignored (no colour is better than a wrong one).
pub fn parse_hex_color(raw: &str) -> Option<(u8, u8, u8)> {
    let s: String = serde_json::from_str(raw).ok()?;
    let hex = s.strip_prefix('#')?;
    if hex.len() != 6 || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    let n = u32::from_str_radix(hex, 16).ok()?;
    Some(((n >> 16) as u8, (n >> 8) as u8, n as u8))
}

pub fn saved_background(db: &Db) -> Option<tauri::window::Color> {
    let raw = db.settings_get(BACKGROUND_KEY).ok()??;
    let (r, g, b) = parse_hex_color(&raw)?;
    Some(tauri::window::Color(r, g, b, 255))
}

fn work_areas(win: &WebviewWindow) -> Vec<Area> {
    let mut out = Vec::new();
    let primary = win.primary_monitor().ok().flatten();
    if let Some(m) = &primary {
        let r = m.work_area();
        out.push(Area { x: r.position.x, y: r.position.y, width: r.size.width, height: r.size.height });
    }
    for m in win.available_monitors().unwrap_or_default() {
        let r = m.work_area();
        let a = Area { x: r.position.x, y: r.position.y, width: r.size.width, height: r.size.height };
        if !out.contains(&a) {
            out.push(a);
        }
    }
    out
}

struct Tracker {
    db: Arc<Db>,
    /// Last committed normal (restored) bounds, plus the maximized flag.
    last: Mutex<Option<SavedBounds>>,
    generation: AtomicU64,
}

impl Tracker {
    /// Read the window now and fold it into `last`. Called once things have
    /// settled (debounced, or at close): during a maximize/restore animation
    /// the OS reports the maximized rectangle before the maximized state, so
    /// reading on every event would save the full-screen rect as "normal".
    fn commit(&self, win: &WebviewWindow) {
        if win.is_minimized().unwrap_or(false) {
            return;
        }
        let maximized = win.is_maximized().unwrap_or(false);
        let mut last = self.last.lock().unwrap();
        if maximized {
            // Keep the normal bounds underneath; only remember the flag.
            if let Some(b) = last.as_mut() {
                b.maximized = true;
            }
            return;
        }
        let (Ok(pos), Ok(size)) = (win.outer_position(), win.inner_size()) else { return };
        if pos.x <= OFFSCREEN_SENTINEL || pos.y <= OFFSCREEN_SENTINEL || size.width == 0 || size.height == 0 {
            return;
        }
        *last = Some(SavedBounds {
            v: VERSION,
            x: pos.x,
            y: pos.y,
            width: size.width,
            height: size.height,
            maximized: false,
        });
    }

    fn write(&self) {
        let Some(b) = *self.last.lock().unwrap() else { return };
        if let Ok(json) = serde_json::to_string(&b) {
            let _ = self.db.settings_set(STATE_KEY, &json);
        }
    }

    fn schedule(self: &Arc<Self>, win: WebviewWindow) {
        let gen = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let me = self.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(SAVE_DEBOUNCE).await;
            if me.generation.load(Ordering::SeqCst) == gen {
                me.commit(&win);
                me.write();
            }
        });
    }
}

/// Apply the saved placement to a window built hidden, show it, and start
/// tracking moves/resizes. Always shows the window, even with nothing saved.
pub fn restore_and_track(win: &WebviewWindow, db: Arc<Db>) {
    let saved = db.settings_get(STATE_KEY).ok().flatten().and_then(|raw| parse(&raw));
    let mut start = None;
    if let Some(saved) = saved {
        let placement = fit(&saved, &work_areas(win));
        let _ = win.set_size(PhysicalSize::new(placement.size.0, placement.size.1));
        match placement.position {
            Some((x, y)) => {
                let _ = win.set_position(PhysicalPosition::new(x, y));
            }
            None => {
                let _ = win.center();
            }
        }
        let _ = win.show();
        if placement.maximized {
            let _ = win.maximize();
        }
        if let Some((x, y)) = placement.position {
            start = Some(SavedBounds {
                v: VERSION,
                x,
                y,
                width: placement.size.0,
                height: placement.size.1,
                maximized: placement.maximized,
            });
        }
    } else {
        let _ = win.show();
    }

    let tracker = Arc::new(Tracker {
        db,
        last: Mutex::new(start),
        generation: AtomicU64::new(0),
    });
    let handle = win.clone();
    win.on_window_event(move |event| match event {
        WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
            tracker.schedule(handle.clone());
        }
        WindowEvent::CloseRequested { .. } => {
            // Flush now; the window may be gone before a debounce fires.
            tracker.generation.fetch_add(1, Ordering::SeqCst);
            tracker.commit(&handle);
            tracker.write();
        }
        _ => {}
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn b(x: i32, y: i32, w: u32, h: u32) -> SavedBounds {
        SavedBounds { v: 1, x, y, width: w, height: h, maximized: false }
    }
    const MAIN: Area = Area { x: 0, y: 0, width: 1920, height: 1040 };
    const RIGHT: Area = Area { x: 1920, y: 0, width: 2560, height: 1400 };

    #[test]
    fn keeps_a_rect_that_fits() {
        let p = fit(&b(100, 80, 1280, 800), &[MAIN]);
        assert_eq!(p.position, Some((100, 80)));
        assert_eq!(p.size, (1280, 800));
    }

    #[test]
    fn keeps_a_rect_on_a_secondary_monitor() {
        let p = fit(&b(2200, 100, 1600, 900), &[MAIN, RIGHT]);
        assert_eq!(p.position, Some((2200, 100)));
    }

    #[test]
    fn drops_position_when_its_monitor_is_gone() {
        let p = fit(&b(2200, 100, 1600, 900), &[MAIN]);
        assert_eq!(p.position, None);
        assert_eq!(p.size, (1600, 900));
    }

    #[test]
    fn drops_position_when_mostly_off_screen() {
        let p = fit(&b(1700, 900, 1280, 800), &[MAIN]);
        assert_eq!(p.position, None);
    }

    #[test]
    fn pulls_a_slightly_overhanging_rect_inside() {
        let p = fit(&b(-20, -10, 1280, 800), &[MAIN]);
        assert_eq!(p.position, Some((0, 0)));
        let p = fit(&b(700, 300, 1280, 800), &[MAIN]);
        assert_eq!(p.position, Some((640, 240)));
    }

    #[test]
    fn shrinks_a_rect_larger_than_the_work_area() {
        let p = fit(&b(0, 0, 2400, 1300), &[MAIN]);
        assert_eq!(p.size, (1920, 1040));
        assert_eq!(p.position, Some((0, 0)));
        let p = fit(&b(5000, 5000, 2400, 1300), &[MAIN]);
        assert_eq!(p.size, (1920, 1040));
        assert_eq!(p.position, None);
    }

    #[test]
    fn keeps_maximized_flag() {
        let mut s = b(10, 10, 1280, 800);
        s.maximized = true;
        assert!(fit(&s, &[MAIN]).maximized);
        assert!(fit(&s, &[]).maximized);
    }

    #[test]
    fn no_monitors_reported_drops_position_only() {
        let p = fit(&b(10, 10, 1280, 800), &[]);
        assert_eq!(p.position, None);
        assert_eq!(p.size, (1280, 800));
    }

    #[test]
    fn parse_rejects_bad_rows() {
        assert!(parse(r#"{"v":1,"x":10,"y":10,"width":1280,"height":800,"maximized":false}"#).is_some());
        assert!(parse(r#"{"v":2,"x":10,"y":10,"width":1280,"height":800,"maximized":false}"#).is_none());
        assert!(parse(r#"{"v":1,"x":-32000,"y":-32000,"width":1280,"height":800,"maximized":false}"#).is_none());
        assert!(parse(r#"{"v":1,"x":0,"y":0,"width":0,"height":800,"maximized":false}"#).is_none());
        assert!(parse("not json").is_none());
        assert!(parse(r#"{"x":1}"#).is_none());
    }

    #[test]
    fn parses_background_colours() {
        assert_eq!(parse_hex_color("\"#0d1117\""), Some((0x0d, 0x11, 0x17)));
        assert_eq!(parse_hex_color("\"#FFFFFF\""), Some((255, 255, 255)));
        assert_eq!(parse_hex_color("\"0d1117\""), None);
        assert_eq!(parse_hex_color("\"#fff\""), None);
        assert_eq!(parse_hex_color("\"rgb(1,2,3)\""), None);
        assert_eq!(parse_hex_color("#0d1117"), None);
    }

    #[test]
    fn background_round_trips_through_the_settings_table() {
        let db = Db::open_in_memory().unwrap();
        assert!(saved_background(&db).is_none());
        db.settings_set(BACKGROUND_KEY, "\"#102030\"").unwrap();
        let c = saved_background(&db).unwrap();
        assert_eq!((c.0, c.1, c.2, c.3), (0x10, 0x20, 0x30, 255));
    }
}
