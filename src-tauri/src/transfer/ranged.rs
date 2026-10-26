//! Ranged downloads (Plan 24 Phase 3).
//!
//! A backend that can read a byte range implements [`RangeSource`]; the
//! driver ([`segmented_download`]) splits the file across parallel ranges,
//! steals work for idle workers, ramps the connection count up and backs it
//! off on errors, retries each range on its own, and watches for stalls.
//! Everything lands in one preallocated [`PartFile`](super::partfile) at its
//! offset — no segment files, no merge step.
//!
//! Backends that can only stream from byte 0 implement the same trait with
//! `max_parallel() == 1` and `seekable() == false`; they run as one range.

use super::partfile::PartWriter;
use super::retry::{self, Budget, Exhausted, Transient, Verdict};
use super::speed::SpeedRing;
use anyhow::{anyhow, Result};
use async_trait::async_trait;
use bytes::Bytes;
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::Notify;
use tokio::task::JoinSet;

/// End of a range whose size isn't known (stream to EOF).
pub const UNBOUNDED: u64 = u64::MAX;

/// A byte source that can serve `[offset, offset + len)`.
#[async_trait]
pub trait RangeSource: Send + Sync {
    /// Stream bytes from `offset` into `sink` until it reports
    /// [`Flow::Stop`], `len` bytes have been pushed, or the source hits EOF.
    /// Ending before `len` bytes (when `len` isn't [`UNBOUNDED`]) is an error
    /// the driver detects; a source never reports a short read as success.
    async fn read_range(&self, offset: u64, len: u64, sink: &mut RangeSink) -> Result<()>;

    /// How many ranges this backend can serve at once (its ceiling).
    fn max_parallel(&self) -> usize {
        1
    }

    /// Can `read_range` start anywhere but byte 0? Sources that can't are
    /// never split or resumed.
    fn seekable(&self) -> bool {
        true
    }
}

/// What the sink needs from the transfer: throttle/pause and progress.
#[async_trait]
pub trait Ctl: Send + Sync {
    /// Charge `bytes` to the bandwidth cap; fails with the pause marker when
    /// the transfer is paused.
    async fn checkpoint(&self, bytes: u64) -> Result<()>;
    /// `bytes` more landed in the file.
    fn progressed(&self, bytes: u64);
    /// A non-seekable source restarted from byte 0: `bytes` counted so far
    /// no longer stand.
    fn rewound(&self, bytes: u64);
}

/// Whether the source should keep reading.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Flow {
    More,
    /// The range is complete or was shortened by a steal: stop cleanly.
    Stop,
}

#[derive(Debug)]
struct Bounds {
    /// Next byte not yet handed to a writer.
    claimed: u64,
    /// Exclusive end. Only ever shrinks (a steal).
    end: u64,
}

/// One range being downloaded. The owner claims bytes from `claimed`; a
/// stealer shortens `end`. Both happen under a tiny lock, so the owner can
/// never write past a steal and no byte is ever fetched twice.
#[derive(Debug)]
pub struct Range {
    pub start: u64,
    bounds: Mutex<Bounds>,
    /// Bytes `[start, done)` have been handed to the file writer.
    done: AtomicU64,
    /// When a byte last moved (stall watchdog), in [`Clock`] ms.
    last_progress: AtomicU64,
    /// Wakes the worker to abandon its current read (stall / slow kill).
    kill: Notify,
}

impl Range {
    pub fn new(start: u64, end: u64) -> Arc<Self> {
        Arc::new(Self {
            start,
            bounds: Mutex::new(Bounds {
                claimed: start,
                end,
            }),
            done: AtomicU64::new(start),
            last_progress: AtomicU64::new(Clock::now_ms()),
            kill: Notify::new(),
        })
    }

    /// Start over from `start` (non-seekable sources); returns the bytes
    /// that no longer count.
    fn rewind(&self) -> u64 {
        let mut b = self.bounds.lock().expect("range lock");
        let lost = self.done.load(Ordering::Acquire) - self.start;
        b.claimed = self.start;
        self.done.store(self.start, Ordering::Release);
        lost
    }

    fn touch(&self) {
        self.last_progress.store(Clock::now_ms(), Ordering::Relaxed);
    }

    fn idle(&self) -> Duration {
        Duration::from_millis(Clock::now_ms().saturating_sub(self.last_progress.load(Ordering::Relaxed)))
    }

    pub fn done(&self) -> u64 {
        self.done.load(Ordering::Acquire)
    }

    pub fn end(&self) -> u64 {
        self.bounds.lock().expect("range lock").end
    }

    /// Bytes not yet claimed by the owner.
    pub fn unclaimed(&self) -> u64 {
        let b = self.bounds.lock().expect("range lock");
        b.end.saturating_sub(b.claimed)
    }

    pub fn is_complete(&self) -> bool {
        self.done() >= self.end()
    }

    /// Owner: claim up to `want` bytes at the current position. Returns the
    /// offset and how many bytes may be written (0 once the range is done or
    /// was cut short).
    /// Drop any claim past `done`: a read killed while waiting on the writer
    /// leaves bytes claimed but never written, and the next attempt must
    /// start from what actually reached the file.
    fn rewind_claim(&self) {
        let done = self.done();
        let mut b = self.bounds.lock().expect("range lock");
        if b.claimed > done {
            b.claimed = done;
        }
    }

    fn claim(&self, want: u64) -> (u64, u64) {
        let mut b = self.bounds.lock().expect("range lock");
        let n = want.min(b.end.saturating_sub(b.claimed));
        let at = b.claimed;
        b.claimed += n;
        (at, n)
    }

    /// Stealer: cut off the back half of what is left, when more than
    /// `2 × min_split` remains. Returns the stolen `[from, to)`.
    pub fn split(&self, min_split: u64, align: u64) -> Option<(u64, u64)> {
        let mut b = self.bounds.lock().expect("range lock");
        if b.end == UNBOUNDED {
            return None;
        }
        let left = b.end.saturating_sub(b.claimed);
        if left <= 2 * min_split.max(1) {
            return None;
        }
        let mut mid = b.claimed + left / 2;
        if align > 1 {
            mid = mid / align * align;
        }
        if mid <= b.claimed || mid >= b.end {
            return None;
        }
        let stolen = (mid, b.end);
        b.end = mid;
        Some(stolen)
    }

}

/// Where a source pushes its bytes: clips them to the range, applies the
/// checkpoint, writes them at their offset and counts them.
pub struct RangeSink {
    range: Arc<Range>,
    writer: PartWriter,
    ctl: Arc<dyn Ctl>,
}

impl RangeSink {
    pub fn new(range: Arc<Range>, writer: PartWriter, ctl: Arc<dyn Ctl>) -> Self {
        Self { range, writer, ctl }
    }

    /// Push the next bytes of the stream (they continue at [`Self::offset`]).
    pub async fn push(&mut self, mut data: Bytes) -> Result<Flow> {
        if data.is_empty() {
            return Ok(if self.range.is_complete() { Flow::Stop } else { Flow::More });
        }
        self.ctl.checkpoint(data.len() as u64).await?;
        let (at, n) = self.range.claim(data.len() as u64);
        if n == 0 {
            return Ok(Flow::Stop);
        }
        if at != self.range.done() {
            return Err(anyhow!("range bookkeeping out of step at {at}"));
        }
        data.truncate(n as usize);
        self.writer.write(at, data).await?;
        self.range.done.store(at + n, Ordering::Release);
        self.range.touch();
        self.ctl.progressed(n);
        Ok(if self.range.is_complete() { Flow::Stop } else { Flow::More })
    }
}

/// Process-wide monotonic milliseconds (cheap to store in an atomic).
struct Clock;

impl Clock {
    fn now_ms() -> u64 {
        static START: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();
        START.get_or_init(Instant::now).elapsed().as_millis() as u64
    }
}

/// Knobs for [`segmented_download`].
#[derive(Debug, Clone)]
pub struct DriverConfig {
    /// File size, or [`UNBOUNDED`] when unknown.
    pub size: u64,
    /// Most parallel ranges (the `transferSegments` setting ∩ backend).
    pub cap: usize,
    /// `auto`: probe more connections beyond `cap`, up to the backend.
    pub auto_tune: bool,
    /// Files smaller than this run as one range.
    pub min_segmented: u64,
    pub ramp_every: Duration,
    /// No bytes for this long → "not responding".
    pub stall_warn: Duration,
    /// No bytes for this long → abort the range and re-run it.
    pub stall_kill: Duration,
    /// Smallest piece worth splitting off.
    pub min_split_floor: u64,
    /// Alignment of split points.
    pub split_align: u64,
    /// The driver's housekeeping tick.
    pub tick: Duration,
    /// How long a range must crawl before it is restarted near the end.
    pub slow_window: Duration,
    /// Auto-tune measurement window.
    pub probe_window: Duration,
    /// Wait between retries of a failed range (`None` = full-jitter backoff).
    pub fixed_backoff: Option<Duration>,
}

impl DriverConfig {
    pub fn new(size: u64, cap: usize, auto_tune: bool) -> Self {
        Self {
            size,
            cap: cap.max(1),
            auto_tune,
            min_segmented: 16 * 1024 * 1024,
            ramp_every: Duration::from_millis(500),
            stall_warn: Duration::from_secs(5),
            stall_kill: Duration::from_secs(20),
            min_split_floor: 4 * 1024 * 1024,
            split_align: 64 * 1024,
            tick: Duration::from_millis(250),
            slow_window: Duration::from_secs(10),
            probe_window: Duration::from_secs(8),
            fixed_backoff: None,
        }
    }
}

/// Live view of a running download, shared with the caller so it can
/// checkpoint resume state and show progress while the driver runs.
#[derive(Default)]
pub struct DriverState {
    completed: Mutex<Intervals>,
    active: Mutex<Vec<Arc<Range>>>,
    /// Active workers (for the row tooltip).
    pub workers: AtomicUsize,
    /// Some range is "not responding".
    pub stalled: AtomicBool,
}

impl DriverState {
    /// Everything handed to the writer so far: finished ranges plus the
    /// written prefix of running ones. Taken *before* a writer sync, this is
    /// what resume may claim once the sync returns.
    pub fn snapshot(&self) -> Intervals {
        let mut iv = self.completed.lock().expect("state lock").clone();
        for r in self.active.lock().expect("state lock").iter() {
            iv.add(r.start, r.done());
        }
        iv
    }

    /// Seed with what an earlier run already wrote.
    pub fn seed(&self, done: &Intervals) {
        let mut c = self.completed.lock().expect("state lock");
        for &(s, e) in &done.0 {
            c.add(s, e);
        }
    }
}

/// Download the `todo` holes of a file through `source` into `writer`.
///
/// One range per worker. Workers ramp up one every `ramp_every` until the
/// cap; an idle slot steals the back half of the largest remaining range
/// once it is worth splitting (`max(floor, per-worker speed × 6 s)`). A
/// failed range retries on its own with backoff; its failure also lowers the
/// cap by one and doubles the ramp interval (servers that limit connections
/// per user). A range with no bytes for `stall_kill` is aborted and re-run
/// from where it got to. Near the end, a range crawling below 10 % of the
/// median worker speed for `slow_window` is restarted on a fresh connection.
pub async fn segmented_download(
    source: Arc<dyn RangeSource>,
    writer: PartWriter,
    ctl: Arc<dyn Ctl>,
    state: Arc<DriverState>,
    todo: Vec<(u64, u64)>,
    cfg: DriverConfig,
) -> Result<()> {
    let known = cfg.size != UNBOUNDED;
    let ceiling = source.max_parallel().max(1);
    let segmented = ceiling > 1 && source.seekable() && known && cfg.size >= cfg.min_segmented;
    let mut cap = if segmented { cfg.cap.min(ceiling) } else { 1 };
    let probe_limit = if cfg.auto_tune { ceiling } else { cap };
    let mut target = 1usize;
    let mut ramp_every = cfg.ramp_every;
    let mut next_ramp = Instant::now() + ramp_every;
    let mut pending: VecDeque<(u64, u64)> = todo.into();
    let mut workers: JoinSet<(Arc<Range>, Result<()>)> = JoinSet::new();
    let (fail_tx, mut fail_rx) = tokio::sync::mpsc::unbounded_channel::<()>();
    let mut tick = tokio::time::interval(cfg.tick);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut speed = SpeedRing::default();
    let mut probe = Probe::Ramping;
    // Per-range done offset sampled at the start of its slow window.
    let mut slow_marks: HashMap<usize, (Instant, u64)> = HashMap::new();
    let mut per_worker_speed = 0u64;

    let result: Result<()> = loop {
        // Fill free slots: queued holes first, then steal.
        while workers.len() < target.min(cap) {
            let work = pending.pop_front().or_else(|| {
                if !segmented {
                    return None;
                }
                let min_split = cfg
                    .min_split_floor
                    .max(per_worker_speed.saturating_mul(6));
                let active = state.active.lock().expect("state lock");
                let victim = active
                    .iter()
                    .filter(|r| !r.is_complete())
                    .max_by_key(|r| r.unclaimed())?;
                victim.split(min_split, cfg.split_align)
            });
            let Some((s, e)) = work else { break };
            let range = Range::new(s, e);
            state.active.lock().expect("state lock").push(Arc::clone(&range));
            workers.spawn(run_range(
                Arc::clone(&source),
                Arc::clone(&range),
                writer.clone(),
                Arc::clone(&ctl),
                fail_tx.clone(),
                cfg.fixed_backoff,
            ));
        }
        state.workers.store(workers.len(), Ordering::Relaxed);
        if workers.is_empty() {
            break Ok(());
        }

        tokio::select! {
            joined = workers.join_next() => {
                let Some(joined) = joined else { continue };
                let (range, res) = match joined {
                    Ok(v) => v,
                    Err(e) => break Err(anyhow!("download worker failed: {e}")),
                };
                state.active.lock().expect("state lock").retain(|r| !Arc::ptr_eq(r, &range));
                slow_marks.remove(&(Arc::as_ptr(&range) as usize));
                state.completed.lock().expect("state lock").add(range.start, range.done());
                if let Err(e) = res {
                    break Err(e);
                }
            }
            Some(()) = fail_rx.recv() => {
                // A range hit a retryable error: be gentler with the server.
                if segmented && cap > 1 {
                    cap -= 1;
                    probe = Probe::Done;
                }
                ramp_every = (ramp_every * 2).min(Duration::from_secs(30));
                next_ramp = Instant::now() + ramp_every;
            }
            _ = tick.tick() => {
                let now = Instant::now();
                let total = state.snapshot().total();
                let rate = speed.sample(total, now).unwrap_or(0);
                let active: Vec<Arc<Range>> = state.active.lock().expect("state lock").clone();
                per_worker_speed = rate / active.len().max(1) as u64;

                // Ramp-up, then (auto) probe one more connection.
                if segmented && now >= next_ramp && target < cap {
                    target += 1;
                    next_ramp = now + ramp_every;
                }
                if segmented && target >= cap {
                    probe = probe.step(now, rate, &mut cap, &mut target, probe_limit, cfg.probe_window);
                }

                // Stall watchdog.
                let mut any_stalled = false;
                for r in &active {
                    let idle = r.idle();
                    if idle >= cfg.stall_kill {
                        r.touch();
                        // notify_waiters, not notify_one: a range idle in its
                        // retry backoff must not bank a kill for its next try.
                        r.kill.notify_waiters();
                    } else if idle >= cfg.stall_warn {
                        any_stalled = true;
                    }
                }
                state.stalled.store(any_stalled, Ordering::Relaxed);

                // Near the end, restart a crawling range on a fresh
                // connection rather than wait on it.
                let min_split = cfg.min_split_floor.max(per_worker_speed.saturating_mul(6));
                let nothing_to_steal = pending.is_empty()
                    && active.iter().all(|r| r.unclaimed() <= 2 * min_split);
                if segmented && nothing_to_steal && active.len() >= 2 {
                    let speeds: Vec<(usize, u64)> = active
                        .iter()
                        .map(|r| {
                            let key = Arc::as_ptr(r) as usize;
                            let (at, from) = *slow_marks.entry(key).or_insert((now, r.done()));
                            let secs = now.duration_since(at).as_secs_f64().max(0.001);
                            (key, (r.done().saturating_sub(from) as f64 / secs) as u64)
                        })
                        .collect();
                    let mut sorted: Vec<u64> = speeds.iter().map(|s| s.1).collect();
                    sorted.sort_unstable();
                    let median = sorted[sorted.len() / 2];
                    for (r, (key, sp)) in active.iter().zip(speeds) {
                        let (at, _) = slow_marks[&key];
                        if now.duration_since(at) >= cfg.slow_window {
                            if median > 0 && sp < median / 10 && !r.is_complete() {
                                tracing::info!("restarting slow range {}..{}", r.done(), r.end());
                                r.kill.notify_waiters();
                            }
                            slow_marks.insert(key, (now, r.done()));
                        }
                    }
                }
            }
        }
    };

    // Whatever is still running stops here; record how far it got.
    workers.shutdown().await;
    for r in state.active.lock().expect("state lock").drain(..) {
        state.completed.lock().expect("state lock").add(r.start, r.done());
    }
    state.workers.store(0, Ordering::Relaxed);
    state.stalled.store(false, Ordering::Relaxed);
    result?;
    let got = state.snapshot();
    if known && !got.covers_exactly(cfg.size) {
        return Err(anyhow!(
            "download incomplete: ranges cover {} of {} bytes",
            got.total(),
            cfg.size
        ));
    }
    Ok(())
}

/// Auto-tune: once ramped to the cap, add one connection and keep it only if
/// throughput rises by more than 10 % over the measurement window.
#[derive(Debug, Clone, Copy)]
enum Probe {
    Ramping,
    /// Measuring the current cap: started at, rate sum, samples.
    Baseline(Instant, u64, u32),
    /// Measuring cap + 1: started at, baseline, rate sum, samples.
    Trial(Instant, u64, u64, u32),
    Done,
}

impl Probe {
    fn step(
        self,
        now: Instant,
        rate: u64,
        cap: &mut usize,
        target: &mut usize,
        limit: usize,
        window: Duration,
    ) -> Probe {
        match self {
            Probe::Ramping if *cap < limit => Probe::Baseline(now, 0, 0),
            Probe::Ramping => Probe::Done,
            Probe::Baseline(start, sum, n) => {
                if now.duration_since(start) < window {
                    return Probe::Baseline(start, sum + rate, n + 1);
                }
                let baseline = sum / u64::from(n.max(1));
                *cap += 1;
                *target = *cap;
                Probe::Trial(now, baseline, 0, 0)
            }
            Probe::Trial(start, baseline, sum, n) => {
                if now.duration_since(start) < window {
                    return Probe::Trial(start, baseline, sum + rate, n + 1);
                }
                let trial = sum / u64::from(n.max(1));
                if trial > baseline + baseline / 10 {
                    // Worth it: keep it, and try one more if allowed.
                    if *cap < limit {
                        Probe::Baseline(now, 0, 0)
                    } else {
                        Probe::Done
                    }
                } else {
                    *cap -= 1;
                    *target = *cap;
                    Probe::Done
                }
            }
            Probe::Done => Probe::Done,
        }
    }
}

/// One worker: read its range to the end, retrying on its own. The budget
/// resets whenever bytes moved; a server-requested wait doesn't count.
async fn run_range(
    source: Arc<dyn RangeSource>,
    range: Arc<Range>,
    writer: PartWriter,
    ctl: Arc<dyn Ctl>,
    fail_tx: tokio::sync::mpsc::UnboundedSender<()>,
    fixed_backoff: Option<Duration>,
) -> (Arc<Range>, Result<()>) {
    let mut budget = Budget::new();
    let res = loop {
        range.rewind_claim();
        let at = range.done();
        let end = range.end();
        if at >= end {
            break Ok(());
        }
        let len = if end == UNBOUNDED { UNBOUNDED } else { end - at };
        range.touch();
        let mut sink = RangeSink::new(Arc::clone(&range), writer.clone(), Arc::clone(&ctl));
        let attempt = tokio::select! {
            r = source.read_range(at, len, &mut sink) => r,
            _ = range.kill.notified() => Err(Transient(
                "no data for a while; reconnecting".into(),
            ).into()),
        };
        drop(sink);
        let err = match attempt {
            Ok(()) if end == UNBOUNDED || range.is_complete() => break Ok(()),
            Ok(()) => anyhow::Error::new(Transient(format!(
                "connection closed early ({} of {} bytes)",
                range.done() - range.start,
                range.end() - range.start
            ))),
            Err(e) => e,
        };
        if retry::classify(&err) == Verdict::Fatal {
            break Err(err);
        }
        let server_wait = retry::retry_after(&err);
        let attempt_no = match server_wait {
            Some(_) => Some(budget.attempts().max(1)),
            None => budget.fail(range.done()),
        };
        let Some(attempt_no) = attempt_no else {
            break Err(anyhow::Error::new(Exhausted(format!("{err:#}"))));
        };
        tracing::warn!(
            "range {}..{} failed (attempt {attempt_no}): {err:#}",
            range.done(),
            range.end()
        );
        let _ = fail_tx.send(());
        if !source.seekable() && range.done() > range.start {
            ctl.rewound(range.rewind());
        }
        let wait = server_wait
            .or(fixed_backoff)
            .unwrap_or_else(|| retry::backoff(attempt_no));
        tokio::time::sleep(wait).await;
    };
    (range, res)
}

/// Sorted, merged `[start, end)` intervals — the "what's on disk" record
/// resume needs.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Intervals(pub Vec<(u64, u64)>);

impl Intervals {
    pub fn add(&mut self, start: u64, end: u64) {
        if start >= end {
            return;
        }
        self.0.push((start, end));
        self.0.sort_unstable();
        let mut merged: Vec<(u64, u64)> = Vec::with_capacity(self.0.len());
        for &(s, e) in &self.0 {
            match merged.last_mut() {
                Some(last) if s <= last.1 => last.1 = last.1.max(e),
                _ => merged.push((s, e)),
            }
        }
        self.0 = merged;
    }

    pub fn total(&self) -> u64 {
        self.0.iter().map(|(s, e)| e - s).sum()
    }

    /// The holes in `[0, size)`.
    pub fn gaps(&self, size: u64) -> Vec<(u64, u64)> {
        let mut out = Vec::new();
        let mut at = 0;
        for &(s, e) in &self.0 {
            if s > at {
                out.push((at, s.min(size)));
            }
            at = at.max(e);
            if at >= size {
                break;
            }
        }
        if at < size {
            out.push((at, size));
        }
        out.retain(|(s, e)| s < e);
        out
    }

    /// Does this cover `[0, size)` exactly, with nothing past the end?
    pub fn covers_exactly(&self, size: u64) -> bool {
        match self.0.as_slice() {
            [] => size == 0,
            [(0, e)] => *e == size,
            _ => false,
        }
    }

    /// Bytes from offset 0 with no hole (single-stream resume point).
    pub fn prefix(&self) -> u64 {
        match self.0.first() {
            Some(&(0, e)) => e,
            _ => 0,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn intervals_merge_and_gaps() {
        let mut iv = Intervals::default();
        iv.add(10, 20);
        iv.add(0, 5);
        iv.add(18, 30);
        iv.add(5, 10);
        assert_eq!(iv.0, vec![(0, 30)]);
        iv.add(40, 50);
        assert_eq!(iv.gaps(60), vec![(30, 40), (50, 60)]);
        assert_eq!(iv.total(), 40);
        assert_eq!(iv.prefix(), 30);
        assert!(!iv.covers_exactly(50));
        iv.add(30, 40);
        assert!(iv.covers_exactly(50));
        assert_eq!(Intervals::default().gaps(5), vec![(0, 5)]);
    }

    #[test]
    fn split_never_crosses_the_claim() {
        let r = Range::new(0, 1000);
        assert_eq!(r.claim(100), (0, 100));
        // 900 left, min split 100 → back half [550, 1000).
        assert_eq!(r.split(100, 1), Some((550, 1000)));
        assert_eq!(r.end(), 550);
        // The owner can't claim past the new end.
        assert_eq!(r.claim(1000), (100, 450));
        assert_eq!(r.claim(10), (550, 0));
        // Too little left to split.
        let r = Range::new(0, 150);
        assert_eq!(r.split(100, 1), None);
    }

    // ---------- driver, against a fake source ----------

    use crate::transfer::partfile::PartFile;

    #[derive(Debug, Clone, Copy)]
    enum Fault {
        /// Fail once when a read reaches this offset.
        FailAt(u64),
        /// Hang forever (once) when a read reaches this offset.
        HangAt(u64),
        /// Every read fails before sending a byte.
        Always { fatal: bool },
    }

    struct Fake {
        data: Arc<Vec<u8>>,
        chunk: usize,
        delay: Duration,
        parallel: usize,
        seekable: bool,
        faults: Mutex<Vec<Fault>>,
        calls: Mutex<Vec<(u64, u64)>>,
        active: AtomicUsize,
        peak: AtomicUsize,
    }

    impl Fake {
        fn new(size: usize, parallel: usize) -> Self {
            Self {
                data: Arc::new((0..size).map(|i| (i * 31 % 253) as u8).collect()),
                chunk: 16 * 1024,
                delay: Duration::from_millis(1),
                parallel,
                seekable: true,
                faults: Mutex::new(Vec::new()),
                calls: Mutex::new(Vec::new()),
                active: AtomicUsize::new(0),
                peak: AtomicUsize::new(0),
            }
        }

        fn fault_for(&self, from: u64, to: u64) -> Option<Fault> {
            let mut faults = self.faults.lock().unwrap();
            let hit = faults.iter().position(|f| match *f {
                Fault::FailAt(o) | Fault::HangAt(o) => o >= from && o < to,
                Fault::Always { .. } => true,
            })?;
            let f = faults[hit];
            if !matches!(f, Fault::Always { .. }) {
                faults.remove(hit);
            }
            Some(f)
        }
    }

    #[async_trait]
    impl RangeSource for Fake {
        async fn read_range(&self, offset: u64, len: u64, sink: &mut RangeSink) -> Result<()> {
            self.calls.lock().unwrap().push((offset, len));
            let now = self.active.fetch_add(1, Ordering::SeqCst) + 1;
            self.peak.fetch_max(now, Ordering::SeqCst);
            let res = async {
                let size = self.data.len() as u64;
                let end = if len == UNBOUNDED { size } else { (offset + len).min(size) };
                let mut at = offset;
                while at < end {
                    let n = (self.chunk as u64).min(end - at);
                    match self.fault_for(at, at + n) {
                        Some(Fault::FailAt(_)) => {
                            return Err(anyhow!("connection reset by peer"));
                        }
                        Some(Fault::HangAt(_)) => {
                            std::future::pending::<()>().await;
                        }
                        Some(Fault::Always { fatal: true }) => {
                            return Err(anyhow!("No such file or directory"));
                        }
                        Some(Fault::Always { fatal: false }) => {
                            return Err(anyhow!("connection reset by peer"));
                        }
                        None => {}
                    }
                    tokio::time::sleep(self.delay).await;
                    let bytes = Bytes::copy_from_slice(&self.data[at as usize..(at + n) as usize]);
                    if sink.push(bytes).await? == Flow::Stop {
                        return Ok(());
                    }
                    at += n;
                }
                Ok(())
            }
            .await;
            self.active.fetch_sub(1, Ordering::SeqCst);
            res
        }

        fn max_parallel(&self) -> usize {
            self.parallel
        }

        fn seekable(&self) -> bool {
            self.seekable
        }
    }

    #[derive(Default)]
    struct TestCtl {
        bytes: AtomicU64,
    }

    #[async_trait]
    impl Ctl for TestCtl {
        async fn checkpoint(&self, _bytes: u64) -> Result<()> {
            Ok(())
        }
        fn progressed(&self, bytes: u64) {
            self.bytes.fetch_add(bytes, Ordering::SeqCst);
        }
        fn rewound(&self, bytes: u64) {
            self.bytes.fetch_sub(bytes, Ordering::SeqCst);
        }
    }

    fn fast_cfg(size: u64, cap: usize) -> DriverConfig {
        let mut cfg = DriverConfig::new(size, cap, false);
        cfg.min_segmented = 0;
        cfg.min_split_floor = 64 * 1024;
        cfg.split_align = 1;
        cfg.ramp_every = Duration::from_millis(10);
        cfg.tick = Duration::from_millis(10);
        cfg.stall_warn = Duration::from_millis(100);
        cfg.stall_kill = Duration::from_millis(300);
        cfg.fixed_backoff = Some(Duration::from_millis(2));
        cfg
    }

    async fn run(fake: Arc<Fake>, cfg: DriverConfig, todo: Vec<(u64, u64)>) -> (Result<()>, Vec<u8>, Arc<TestCtl>, Arc<DriverState>) {
        let dir = std::env::temp_dir().join(format!("faro-ranged-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("f.faro-part");
        let size = fake.data.len() as u64;
        let part = PartFile::open(&path, Some(size), false, false).await.unwrap();
        let ctl = Arc::new(TestCtl::default());
        let state = Arc::new(DriverState::default());
        let res = segmented_download(
            fake.clone(),
            part.writer(),
            ctl.clone(),
            state.clone(),
            todo,
            cfg,
        )
        .await;
        part.finish().await.unwrap();
        let bytes = std::fs::read(&path).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
        (res, bytes, ctl, state)
    }

    #[tokio::test]
    async fn parallel_ranges_rebuild_the_file_exactly() {
        let fake = Arc::new(Fake::new(3 * 1024 * 1024 + 77, 4));
        let size = fake.data.len() as u64;
        let (res, bytes, ctl, state) = run(fake.clone(), fast_cfg(size, 4), vec![(0, size)]).await;
        res.unwrap();
        assert_eq!(bytes, *fake.data);
        // Every byte counted exactly once: nothing written twice or skipped.
        assert_eq!(ctl.bytes.load(Ordering::SeqCst), size);
        assert!(state.snapshot().covers_exactly(size));
        // Work stealing kicked in: ranges started past byte 0, in parallel.
        assert!(fake.calls.lock().unwrap().iter().any(|&(o, _)| o > 0));
        assert!(fake.peak.load(Ordering::SeqCst) > 1);
        assert!(fake.peak.load(Ordering::SeqCst) <= 4);
    }

    #[tokio::test]
    async fn small_or_single_connection_sources_stay_one_range() {
        let fake = Arc::new(Fake::new(1024 * 1024, 4));
        let size = fake.data.len() as u64;
        let mut cfg = fast_cfg(size, 4);
        cfg.min_segmented = 16 * 1024 * 1024;
        let (res, bytes, ..) = run(fake.clone(), cfg, vec![(0, size)]).await;
        res.unwrap();
        assert_eq!(bytes, *fake.data);
        assert_eq!(fake.calls.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn failed_ranges_retry_from_where_they_stopped() {
        let fake = Arc::new(Fake::new(2 * 1024 * 1024, 4));
        let size = fake.data.len() as u64;
        fake.faults.lock().unwrap().extend([
            Fault::FailAt(100_000),
            Fault::FailAt(900_000),
            Fault::FailAt(1_500_000),
            Fault::FailAt(1_500_000),
        ]);
        let (res, bytes, ctl, _) = run(fake.clone(), fast_cfg(size, 4), vec![(0, size)]).await;
        res.unwrap();
        assert_eq!(bytes, *fake.data);
        assert_eq!(ctl.bytes.load(Ordering::SeqCst), size, "progress kept across retries");
    }

    #[tokio::test]
    async fn stalled_range_is_aborted_and_rerun() {
        let fake = Arc::new(Fake::new(1024 * 1024, 2));
        let size = fake.data.len() as u64;
        fake.faults.lock().unwrap().push(Fault::HangAt(300_000));
        let (res, bytes, ..) = run(fake.clone(), fast_cfg(size, 2), vec![(0, size)]).await;
        res.unwrap();
        assert_eq!(bytes, *fake.data);
        // The hung read was abandoned and its range re-requested past 0.
        assert!(fake.calls.lock().unwrap().len() >= 2);
    }

    #[tokio::test]
    async fn resume_fetches_only_the_holes() {
        let fake = Arc::new(Fake::new(1024 * 1024, 4));
        let size = fake.data.len() as u64;
        // Pretend [0, 600k) is already on disk from an earlier run: write it
        // through a plain driver run first, then fetch only the rest.
        let mut done = Intervals::default();
        done.add(0, 600_000);
        let dir = std::env::temp_dir().join(format!("faro-ranged-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("f.faro-part");
        std::fs::write(&path, &fake.data[..600_000]).unwrap();
        let part = PartFile::open(&path, Some(size), true, false).await.unwrap();
        let ctl = Arc::new(TestCtl::default());
        let state = Arc::new(DriverState::default());
        state.seed(&done);
        segmented_download(fake.clone(), part.writer(), ctl.clone(), state.clone(), done.gaps(size), fast_cfg(size, 4))
            .await
            .unwrap();
        part.finish().await.unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), *fake.data);
        assert_eq!(ctl.bytes.load(Ordering::SeqCst), size - 600_000);
        assert!(fake.calls.lock().unwrap().iter().all(|&(o, _)| o >= 600_000));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn budget_runs_out_without_progress() {
        let fake = Arc::new(Fake::new(256 * 1024, 1));
        let size = fake.data.len() as u64;
        fake.faults.lock().unwrap().push(Fault::Always { fatal: false });
        let (res, ..) = run(fake.clone(), fast_cfg(size, 1), vec![(0, size)]).await;
        let err = res.unwrap_err();
        assert!(format!("{err:#}").contains("gave up after"), "{err:#}");
        assert_eq!(fake.calls.lock().unwrap().len() as u32, retry::MAX_ATTEMPTS + 1);
    }

    #[tokio::test]
    async fn fatal_errors_are_not_retried() {
        let fake = Arc::new(Fake::new(256 * 1024, 1));
        let size = fake.data.len() as u64;
        fake.faults.lock().unwrap().push(Fault::Always { fatal: true });
        let (res, ..) = run(fake.clone(), fast_cfg(size, 1), vec![(0, size)]).await;
        assert!(res.is_err());
        assert_eq!(fake.calls.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn errors_lower_the_connection_cap() {
        let fake = Arc::new(Fake::new(4 * 1024 * 1024, 8));
        let size = fake.data.len() as u64;
        // Every second range fails once early: the cap backs off from 8.
        fake.faults.lock().unwrap().extend((1..12).map(|i| Fault::FailAt(i * 300_000)));
        let mut cfg = fast_cfg(size, 8);
        cfg.ramp_every = Duration::from_millis(30);
        let (res, bytes, ..) = run(fake.clone(), cfg, vec![(0, size)]).await;
        res.unwrap();
        assert_eq!(bytes, *fake.data);
        assert!(fake.peak.load(Ordering::SeqCst) < 8, "peak {}", fake.peak.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn non_seekable_source_restarts_from_zero() {
        let mut f = Fake::new(512 * 1024, 4);
        f.seekable = false;
        let fake = Arc::new(f);
        let size = fake.data.len() as u64;
        fake.faults.lock().unwrap().push(Fault::FailAt(200_000));
        let (res, bytes, ctl, _) = run(fake.clone(), fast_cfg(size, 4), vec![(0, size)]).await;
        res.unwrap();
        assert_eq!(bytes, *fake.data);
        assert!(fake.calls.lock().unwrap().iter().all(|&(o, _)| o == 0));
        assert_eq!(ctl.bytes.load(Ordering::SeqCst), size);
    }
}
