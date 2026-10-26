//! Retry policy for transfers (Plan 24 Phase 5).
//!
//! Each range (or a whole single-stream transfer) gets a budget of attempts
//! with exponential backoff and full jitter. The budget resets whenever bytes
//! moved since the last failure, so a long transfer over a flaky link never
//! runs out of retries as long as it keeps making progress. Errors are
//! classified from typed backend errors first (object_store, SFTP status
//! codes, FTP reply codes, HTTP statuses, I/O kinds) and only then from the
//! message. Auth, not-found, permission and out-of-space never retry.

use rand::Rng;
use std::time::Duration;

/// Attempts per range before the transfer fails.
pub const MAX_ATTEMPTS: u32 = 8;
const BACKOFF_BASE: Duration = Duration::from_secs(1);
const BACKOFF_CAP: Duration = Duration::from_secs(30);

/// The server asked us to wait this long (HTTP `Retry-After`, S3
/// `SlowDown`). Such waits don't use up an attempt.
#[derive(Debug)]
pub struct RetryAfter(pub Duration);

impl std::fmt::Display for RetryAfter {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "server asked to retry after {:?}", self.0)
    }
}

impl std::error::Error for RetryAfter {}

/// The remote file is not the one the transfer started on (ETag/mtime/size
/// changed). Never stitched: the caller restarts from byte 0.
#[derive(Debug)]
pub struct RemoteChanged;

impl std::fmt::Display for RemoteChanged {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("the remote file changed during the transfer")
    }
}

impl std::error::Error for RemoteChanged {}

/// A failure known to be worth retrying (connection cut short, stall).
#[derive(Debug)]
pub struct Transient(pub String);

impl std::fmt::Display for Transient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Transient {}

/// A range ran out of retries (carries the last error's text); the runner
/// must not retry it again.
#[derive(Debug)]
pub struct Exhausted(pub String);

impl std::fmt::Display for Exhausted {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} (gave up after {MAX_ATTEMPTS} attempts)", self.0)
    }
}

impl std::error::Error for Exhausted {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    Retry,
    Fatal,
}

/// Should this error be retried?
pub fn classify(e: &anyhow::Error) -> Verdict {
    use Verdict::*;
    for cause in e.chain() {
        if cause.is::<super::Paused>()
            || cause.is::<RemoteChanged>()
            || cause.is::<Exhausted>()
            || cause.is::<super::verify::VerifyFailed>()
        {
            return Fatal;
        }
        if cause.is::<Transient>() || cause.is::<RetryAfter>() {
            return Retry;
        }
        if let Some(e) = cause.downcast_ref::<object_store::Error>() {
            use object_store::Error as O;
            return match e {
                O::NotFound { .. }
                | O::PermissionDenied { .. }
                | O::Unauthenticated { .. }
                | O::Precondition { .. }
                | O::NotModified { .. }
                | O::InvalidPath { .. }
                | O::NotSupported { .. }
                | O::NotImplemented
                | O::AlreadyExists { .. }
                | O::UnknownConfigurationKey { .. } => Fatal,
                _ => by_message(&e.to_string()),
            };
        }
        if let Some(russh_sftp::client::error::Error::Status(s)) =
            cause.downcast_ref::<russh_sftp::client::error::Error>()
        {
            use russh_sftp::protocol::StatusCode as S;
            return match s.status_code {
                S::NoSuchFile | S::PermissionDenied | S::OpUnsupported | S::BadMessage => Fatal,
                _ => Retry,
            };
        }
        if let Some(suppaftp::FtpError::UnexpectedResponse(r)) = cause.downcast_ref::<suppaftp::FtpError>() {
            return match r.status.code() {
                // Service unavailable / too many connections, data
                // connection trouble, transient file-busy errors.
                421 | 425 | 426 | 450 | 451 => Retry,
                // Not logged in, file unavailable, out of space, bad name.
                530 | 532 | 550 | 552 | 553 => Fatal,
                c if (400..500).contains(&c) => Retry,
                _ => Fatal,
            };
        }
        if let Some(e) = cause.downcast_ref::<reqwest::Error>() {
            if let Some(status) = e.status() {
                return http_status(status.as_u16());
            }
            if e.is_timeout() || e.is_connect() || e.is_body() || e.is_request() {
                return Retry;
            }
        }
        if let Some(e) = cause.downcast_ref::<std::io::Error>() {
            use std::io::ErrorKind as K;
            match e.kind() {
                K::NotFound | K::PermissionDenied | K::AlreadyExists | K::InvalidInput => {
                    return Fatal
                }
                _ if is_no_space(e) => return Fatal,
                K::TimedOut
                | K::ConnectionReset
                | K::ConnectionAborted
                | K::ConnectionRefused
                | K::BrokenPipe
                | K::UnexpectedEof
                | K::Interrupted => return Retry,
                _ => {}
            }
        }
    }
    by_message(&format!("{e:#}"))
}

/// Retry policy for an HTTP status.
pub fn http_status(code: u16) -> Verdict {
    match code {
        408 | 425 | 429 | 500..=599 => Verdict::Retry,
        _ => Verdict::Fatal,
    }
}

/// ERROR_DISK_FULL / ERROR_HANDLE_DISK_FULL on Windows, ENOSPC elsewhere.
pub(super) fn is_no_space(e: &std::io::Error) -> bool {
    #[cfg(windows)]
    return matches!(e.raw_os_error(), Some(112) | Some(39));
    #[cfg(unix)]
    return e.raw_os_error() == Some(libc::ENOSPC);
}

fn by_message(msg: &str) -> Verdict {
    use crate::error::ErrorKind as K;
    let lower = msg.to_ascii_lowercase();
    if lower.contains("not enough disk space") || lower.contains("no space left") {
        return Verdict::Fatal;
    }
    match crate::error::classify_message(msg) {
        K::Auth | K::Permission | K::NotFound | K::Unsupported | K::Conflict => Verdict::Fatal,
        K::Network | K::Timeout | K::Other => Verdict::Retry,
    }
}

/// The wait the server asked for, if any.
pub fn retry_after(e: &anyhow::Error) -> Option<Duration> {
    e.chain()
        .find_map(|c| c.downcast_ref::<RetryAfter>())
        .map(|r| r.0)
}

/// Full-jitter exponential backoff for the `attempt`-th retry (1-based):
/// a random wait in `[0, min(30 s, 1 s × 2^(attempt-1))]`.
pub fn backoff(attempt: u32) -> Duration {
    let cap = BACKOFF_BASE
        .saturating_mul(1u32 << attempt.saturating_sub(1).min(16))
        .min(BACKOFF_CAP);
    let ms = rand::thread_rng().gen_range(0..=cap.as_millis() as u64);
    Duration::from_millis(ms)
}

/// Attempts left for one range. Progress since the last failure refills it.
#[derive(Debug)]
pub struct Budget {
    used: u32,
    /// Position at the last failure.
    last_at: Option<u64>,
}

impl Budget {
    pub fn new() -> Self {
        Self {
            used: 0,
            last_at: None,
        }
    }

    /// Record a failure at byte position `at`. Returns the attempt number to
    /// back off for, or `None` when the budget is spent.
    pub fn fail(&mut self, at: u64) -> Option<u32> {
        if self.last_at.is_some_and(|prev| at > prev) {
            self.used = 0;
        }
        self.last_at = Some(at);
        self.used += 1;
        (self.used <= MAX_ATTEMPTS).then_some(self.used)
    }

    pub fn attempts(&self) -> u32 {
        self.used
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn budget_resets_when_bytes_moved() {
        let mut b = Budget::new();
        for i in 1..=MAX_ATTEMPTS {
            assert_eq!(b.fail(0), Some(i));
        }
        assert_eq!(b.fail(0), None, "spent without progress");

        let mut b = Budget::new();
        // A flaky link that always moves a little: never runs out.
        for at in 0..100u64 {
            assert!(b.fail(at * 10).is_some());
        }
    }

    #[test]
    fn backoff_is_bounded_full_jitter() {
        for attempt in 1..20 {
            let d = backoff(attempt);
            let cap = Duration::from_secs(1u64 << (attempt - 1).min(5)).min(BACKOFF_CAP);
            assert!(d <= cap, "attempt {attempt}: {d:?} > {cap:?}");
        }
    }

    #[test]
    fn classifies_typed_and_untyped_errors() {
        use Verdict::*;
        let nf = anyhow::Error::new(object_store::Error::NotFound {
            path: "k".into(),
            source: "gone".into(),
        });
        assert_eq!(classify(&nf), Fatal);
        let generic = anyhow::Error::new(object_store::Error::Generic {
            store: "S3",
            source: "connection reset by peer".into(),
        });
        assert_eq!(classify(&generic), Retry);
        assert_eq!(classify(&anyhow::anyhow!("connection reset by peer")), Retry);
        assert_eq!(classify(&anyhow::anyhow!("operation timed out")), Retry);
        assert_eq!(classify(&anyhow::anyhow!("authentication failed")), Fatal);
        assert_eq!(classify(&anyhow::anyhow!("Permission denied (os error 13)")), Fatal);
        assert_eq!(classify(&anyhow::anyhow!("No such file or directory")), Fatal);
        assert_eq!(classify(&anyhow::anyhow!("not enough disk space in C:\\")), Fatal);
        let io = std::io::Error::from(std::io::ErrorKind::ConnectionReset);
        assert_eq!(classify(&anyhow::Error::new(io).context("read")), Retry);
        let after = anyhow::Error::new(RetryAfter(Duration::from_secs(3))).context("GET");
        assert_eq!(classify(&after), Retry);
        assert_eq!(retry_after(&after), Some(Duration::from_secs(3)));
        assert_eq!(classify(&anyhow::Error::new(RemoteChanged)), Fatal);
        assert_eq!(classify(&anyhow::Error::new(super::super::Paused)), Fatal);
        assert_eq!(http_status(503), Retry);
        assert_eq!(http_status(404), Fatal);
    }
}
