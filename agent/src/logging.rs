//! File-based tracing with daily rotation + age-based purge.
//!
//! Defaults: write to `<log_dir>/cobweb-agent.YYYY-MM-DD`, rotate at midnight
//! local time, delete files older than `max_age_days` (default 7). Expired
//! files are removed outright — there is no archive directory.
//!
//! When the configured `log_dir` cannot be created (read-only filesystem,
//! permission denied, etc.) we fall back to stderr-only so the agent stays
//! observable instead of dying silently.
//!
//! The returned `LogGuard` MUST be kept alive for the whole process — it
//! owns the background flush worker that the non-blocking appender pumps
//! its buffer through.

use std::{fs, path::Path, time::Duration};

use anyhow::Result;
use time::{OffsetDateTime, macros::format_description};
use tracing::{info, warn};
use tracing_appender::{
    non_blocking::WorkerGuard,
    rolling::{RollingFileAppender, Rotation},
};
use tracing_subscriber::{EnvFilter, fmt, prelude::*};

/// Default filename prefix — daily rotation appends `.YYYY-MM-DD`.
pub const FILE_PREFIX: &str = "cobweb-agent";

/// Returned by `init`; drop = stop flushing.
pub struct LogGuard {
    _file: Option<WorkerGuard>,
    _purge: Option<tokio::task::JoinHandle<()>>,
}

/// Initialise tracing.
///
/// * `log_dir` — directory to write rotated files into. Created if missing.
/// * `level_directive` — EnvFilter string (e.g. `"info"`, `"info,hyper=warn"`).
/// * `max_age_days` — retention; files older than this are deleted on start
///   and every 6 h thereafter. 0 disables the purge sweep.
/// * `also_stderr` — when true, the layer is teed to stderr (useful in dev /
///   foreground systemd unit). Production daemons leave this off.
pub fn init(
    log_dir: &Path,
    level_directive: &str,
    max_age_days: u32,
    also_stderr: bool,
) -> Result<LogGuard> {
    let filter = || {
        EnvFilter::try_new(level_directive)
            .unwrap_or_else(|_| EnvFilter::new("info"))
    };

    // Try to create the log dir; fall back to stderr-only if we can't.
    let dir_ready = fs::create_dir_all(log_dir).is_ok();
    if !dir_ready {
        eprintln!(
            "cobweb-agent: cannot write to log dir {log_dir:?} — falling back to stderr-only"
        );
        let stderr_layer = fmt::layer().with_writer(std::io::stderr).with_ansi(false);
        tracing_subscriber::registry()
            .with(filter())
            .with(stderr_layer)
            .init();
        return Ok(LogGuard {
            _file: None,
            _purge: None,
        });
    }

    // Daily rolling appender — names files `cobweb-agent.YYYY-MM-DD`.
    let appender = RollingFileAppender::builder()
        .rotation(Rotation::DAILY)
        .filename_prefix(FILE_PREFIX)
        .build(log_dir)?;
    let (nb_writer, file_guard) = tracing_appender::non_blocking(appender);

    let file_layer = fmt::layer()
        .with_writer(nb_writer)
        .with_ansi(false)
        .with_target(true)
        .with_thread_ids(false)
        .with_thread_names(false);

    let registry = tracing_subscriber::registry().with(filter()).with(file_layer);
    if also_stderr {
        let stderr_layer = fmt::layer().with_writer(std::io::stderr).with_ansi(true);
        registry.with(stderr_layer).init();
    } else {
        registry.init();
    }

    // Run an initial sweep + schedule the periodic one.
    let purge = if max_age_days > 0 {
        let initial = purge_old(log_dir, max_age_days);
        info!(
            dir = %log_dir.display(),
            removed = initial,
            max_age_days,
            "log retention: initial sweep done"
        );
        let dir = log_dir.to_path_buf();
        Some(tokio::spawn(async move {
            // Every 6 h re-sweep. Short enough that a long-running daemon
            // doesn't pile up months of logs, long enough not to thrash.
            let mut t = tokio::time::interval(Duration::from_secs(6 * 60 * 60));
            t.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            t.tick().await; // immediate, already swept
            loop {
                t.tick().await;
                let n = purge_old(&dir, max_age_days);
                if n > 0 {
                    info!(removed = n, "log retention sweep");
                }
            }
        }))
    } else {
        None
    };

    Ok(LogGuard {
        _file: Some(file_guard),
        _purge: purge,
    })
}

/// Delete every `cobweb-agent.YYYY-MM-DD` file in `dir` whose date is more
/// than `max_age_days` ago. Returns count removed.
pub fn purge_old(dir: &Path, max_age_days: u32) -> usize {
    let Ok(read) = fs::read_dir(dir) else {
        return 0;
    };
    // UTC date is fine for retention math — rolling file appender also uses
    // UTC for its filename suffix, so dates line up.
    let today = OffsetDateTime::now_utc().date();
    let cutoff = today - time::Duration::days(i64::from(max_age_days));
    let mut removed = 0usize;

    for entry in read.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|s| s.to_str()) else {
            continue;
        };
        let Some(date) = parse_rotation_date(name) else {
            continue;
        };
        if date < cutoff {
            match fs::remove_file(&path) {
                Ok(()) => removed += 1,
                Err(e) => warn!(file = %path.display(), error = %e, "purge: remove failed"),
            }
        }
    }
    removed
}

/// `cobweb-agent.2026-05-09` → `2026-05-09`.
fn parse_rotation_date(name: &str) -> Option<time::Date> {
    let suffix = name.strip_prefix(FILE_PREFIX)?.strip_prefix('.')?;
    // Accept both bare date (`2026-05-09`) and date-with-extra (`2026-05-09.gz`).
    let date_str = suffix.get(..10)?;
    let fmt = format_description!("[year]-[month]-[day]");
    time::Date::parse(date_str, fmt).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn touch(path: &Path) {
        fs::write(path, "x").unwrap();
    }

    #[test]
    fn parse_date_in_rotation_filename() {
        let d = parse_rotation_date("cobweb-agent.2026-05-09").unwrap();
        assert_eq!(d.to_string(), "2026-05-09");
    }

    #[test]
    fn parse_date_rejects_non_log() {
        assert!(parse_rotation_date("other.2026-05-09").is_none());
        assert!(parse_rotation_date("cobweb-agent.notadate").is_none());
        assert!(parse_rotation_date("cobweb-agent").is_none());
    }

    #[test]
    fn parse_date_handles_extra_suffix() {
        // Some appenders gzip rotated files; our purge should still recognise them.
        let d = parse_rotation_date("cobweb-agent.2026-05-09.gz").unwrap();
        assert_eq!(d.to_string(), "2026-05-09");
    }

    #[test]
    fn purge_deletes_old_keeps_recent() {
        let dir = TempDir::new().unwrap();
        let today = OffsetDateTime::now_utc().date();
        let old = today - time::Duration::days(30);
        let recent = today - time::Duration::days(3);
        let old_file = dir.path().join(format!("cobweb-agent.{old}"));
        let recent_file = dir.path().join(format!("cobweb-agent.{recent}"));
        let unrelated = dir.path().join("readme.txt");
        touch(&old_file);
        touch(&recent_file);
        touch(&unrelated);

        let removed = purge_old(dir.path(), 7);
        assert_eq!(removed, 1);
        assert!(!old_file.exists());
        assert!(recent_file.exists());
        assert!(unrelated.exists());
    }

    #[test]
    fn purge_disabled_when_dir_missing() {
        let dir = std::env::temp_dir().join("cobweb-agent-nonexistent-XYZ");
        let _ = fs::remove_dir_all(&dir);
        assert_eq!(purge_old(&dir, 7), 0);
    }

}
