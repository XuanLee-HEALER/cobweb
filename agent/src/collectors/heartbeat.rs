//! Heartbeat collector — push `mem_used/total`, `cpu_percent`, `uptime`
//! every `Config::heartbeat_interval_ms`.
//!
//! Backed by `sysinfo` for cross-platform metrics. Lightweight refresh —
//! we don't ask for per-process or per-disk data.

use std::time::Duration;

use sysinfo::System;
use tokio::time::Instant;

use crate::protocol::HeartbeatMetrics;

/// Snapshot of system stats — produced once per tick.
pub struct HeartbeatSampler {
    sys: System,
    started_at: Instant,
}

impl HeartbeatSampler {
    #[must_use]
    pub fn new() -> Self {
        let mut sys = System::new();
        sys.refresh_memory();
        sys.refresh_cpu_usage();
        Self {
            sys,
            started_at: Instant::now(),
        }
    }

    /// Take a fresh sample. Note: CPU usage needs ≥ 200 ms between refreshes
    /// to be meaningful — schedule callers with `≥ refresh_interval()`.
    pub fn sample(&mut self) -> HeartbeatMetrics {
        self.sys.refresh_memory();
        self.sys.refresh_cpu_usage();
        let cpus = self.sys.cpus();
        let cpu_percent = if cpus.is_empty() {
            0.0
        } else {
            cpus.iter().map(sysinfo::Cpu::cpu_usage).sum::<f32>() / cpus.len() as f32
        };
        HeartbeatMetrics {
            mem_used_bytes: self.sys.used_memory(),
            mem_total_bytes: self.sys.total_memory(),
            cpu_percent,
            uptime_secs: self.started_at.elapsed().as_secs(),
        }
    }

    #[must_use]
    pub const fn refresh_interval() -> Duration {
        Duration::from_millis(200)
    }
}

impl Default for HeartbeatSampler {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sample_yields_reasonable_numbers() {
        let mut s = HeartbeatSampler::new();
        let m = s.sample();
        assert!(m.mem_total_bytes > 0);
        assert!(m.mem_used_bytes <= m.mem_total_bytes);
        assert!(m.cpu_percent >= 0.0 && m.cpu_percent < 1000.0);
    }

    #[tokio::test]
    async fn uptime_increases() {
        let mut s = HeartbeatSampler::new();
        let m0 = s.sample();
        tokio::time::sleep(Duration::from_millis(1100)).await;
        let m1 = s.sample();
        assert!(m1.uptime_secs >= m0.uptime_secs);
    }
}
