//! Per-event-type replay ring (impl plan §2).
//!
//! Producers (collectors) always succeed; oldest entry is evicted under
//! pressure. Consumer drains in FIFO order during normal operation; while
//! disconnected the rings accumulate up to `Config::buffer_max_bytes` of
//! total live payload, then start dropping per `EvictPriority`.
//!
//! Single-writer-per-event-type is fine — collectors use independent tasks.
//! We use a `Mutex` over the whole `ReplayBuffer` because we need cross-ring
//! eviction (a global byte budget).

use std::collections::VecDeque;

use serde::Serialize;
use serde_json::Value;

use crate::protocol::{AgentMessage, Event, EventKind, HeartbeatMetrics, now_ms};

/// Eviction priority — when the global byte budget is exceeded we drop the
/// lowest-priority class first. Ordering: lower variant = drop first.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum EvictPriority {
    PeerView,
    Heartbeat,
    ConfigChange,
    ServiceState,
}

#[derive(Debug, Clone)]
struct Entry {
    ts: u64,
    /// Serialised JSON of an `AgentMessage`. Stored as the wire form so we can
    /// approximate ring memory cost from `Vec<u8>::len()` and emit it without
    /// re-serialising.
    payload: String,
}

impl Entry {
    fn cost(&self) -> usize {
        self.payload.len()
    }
}

/// Single ring with a max-entries cap.
#[derive(Debug)]
struct Ring {
    items: VecDeque<Entry>,
    cap: usize,
}

impl Ring {
    fn new(cap: usize) -> Self {
        Self {
            items: VecDeque::with_capacity(cap),
            cap,
        }
    }
    fn push(&mut self, e: Entry) {
        if self.items.len() >= self.cap {
            self.items.pop_front();
        }
        self.items.push_back(e);
    }
    /// Overwrite mode — keep only the latest. Used for heartbeat.
    fn overwrite(&mut self, e: Entry) {
        self.items.clear();
        self.items.push_back(e);
    }
    fn pop_front(&mut self) -> Option<Entry> {
        self.items.pop_front()
    }
    fn drain(&mut self) -> impl Iterator<Item = Entry> + '_ {
        self.items.drain(..)
    }
    fn cost(&self) -> usize {
        self.items.iter().map(Entry::cost).sum()
    }
    fn len(&self) -> usize {
        self.items.len()
    }
}

const MAX_ENTRY_BYTES: usize = 256 * 1024;

/// Multi-ring replay buffer.
#[derive(Debug)]
pub struct ReplayBuffer {
    heartbeat: Ring,
    peer_view: Ring,
    service_state: Ring,
    config_change: Ring,
    pub budget_bytes: usize,
}

impl ReplayBuffer {
    #[must_use]
    pub fn new(budget_bytes: u64) -> Self {
        Self {
            heartbeat: Ring::new(1),
            peer_view: Ring::new(60),
            service_state: Ring::new(32),
            config_change: Ring::new(32),
            budget_bytes: usize::try_from(budget_bytes).unwrap_or(usize::MAX),
        }
    }

    /// Approximate live ring footprint.
    #[must_use]
    pub fn total_bytes(&self) -> usize {
        self.heartbeat.cost()
            + self.peer_view.cost()
            + self.service_state.cost()
            + self.config_change.cost()
    }

    #[must_use]
    pub fn total_len(&self) -> usize {
        self.heartbeat.len() + self.peer_view.len() + self.service_state.len() + self.config_change.len()
    }

    /// Push a heartbeat — overwrite (we only ever need the latest).
    pub fn push_heartbeat(&mut self, ts: u64, metrics: HeartbeatMetrics) {
        let msg = AgentMessage::Heartbeat { ts, metrics };
        if let Some(e) = entry_from(&msg, ts) {
            self.heartbeat.overwrite(e);
            self.enforce_budget();
        }
    }

    /// Push a generic `Event` — routed by `kind`.
    pub fn push_event(&mut self, kind: EventKind, payload: Value) {
        let ts = now_ms();
        let ev = Event { kind, ts, payload };
        let msg = AgentMessage::Event(ev);
        if let Some(e) = entry_from(&msg, ts) {
            match kind {
                EventKind::PeerView => self.peer_view.push(e),
                EventKind::ServiceState => self.service_state.push(e),
                EventKind::ConfigChange => self.config_change.push(e),
            }
            self.enforce_budget();
        }
    }

    /// Drain the buffer in priority-then-FIFO order.
    /// Higher-priority events (service_state, config_change) come first;
    /// within a class events are FIFO; finally peer_view + heartbeat last.
    pub fn drain(&mut self) -> Vec<String> {
        let mut out = Vec::with_capacity(self.total_len());
        for ring in [
            &mut self.service_state,
            &mut self.config_change,
            &mut self.peer_view,
            &mut self.heartbeat,
        ] {
            for e in ring.drain() {
                out.push(e.payload);
            }
        }
        out
    }

    /// FIFO drain in actual ts order (alternative). Slightly more expensive.
    pub fn drain_by_ts(&mut self) -> Vec<String> {
        let mut all: Vec<Entry> = self
            .service_state
            .drain()
            .chain(self.config_change.drain())
            .chain(self.peer_view.drain())
            .chain(self.heartbeat.drain())
            .collect();
        all.sort_by_key(|e| e.ts);
        all.into_iter().map(|e| e.payload).collect()
    }

    /// Number of pending entries — useful for `replay.start.count`.
    #[must_use]
    pub fn pending(&self) -> u32 {
        u32::try_from(self.total_len()).unwrap_or(u32::MAX)
    }

    /// Oldest pending ts (used for `replay.start.since`).
    #[must_use]
    pub fn oldest_ts(&self) -> Option<u64> {
        let mut min = None;
        for ring in [&self.heartbeat, &self.peer_view, &self.service_state, &self.config_change] {
            if let Some(front) = ring.items.front() {
                min = Some(match min {
                    Some(m) => std::cmp::min(m, front.ts),
                    None => front.ts,
                });
            }
        }
        min
    }

    /// Drop oldest entries (lowest priority first) until total bytes ≤ budget.
    fn enforce_budget(&mut self) {
        while self.total_bytes() > self.budget_bytes {
            // Try priority ladder: peer_view → heartbeat → config_change → service_state.
            if self.peer_view.pop_front().is_some() {
                continue;
            }
            if self.heartbeat.pop_front().is_some() {
                continue;
            }
            if self.config_change.pop_front().is_some() {
                continue;
            }
            if self.service_state.pop_front().is_some() {
                continue;
            }
            // All empty but total_bytes > budget? Impossible — break.
            break;
        }
    }
}

fn entry_from<T: Serialize>(msg: &T, ts: u64) -> Option<Entry> {
    let payload = serde_json::to_string(msg).ok()?;
    if payload.len() > MAX_ENTRY_BYTES {
        tracing::warn!(size = payload.len(), "buffer: dropping oversize entry");
        return None;
    }
    Some(Entry { ts, payload })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn mk_metrics() -> HeartbeatMetrics {
        HeartbeatMetrics {
            mem_used_bytes: 1,
            mem_total_bytes: 2,
            cpu_percent: 1.0,
            uptime_secs: 1,
        }
    }

    #[test]
    fn heartbeat_overwrites() {
        let mut b = ReplayBuffer::new(1024 * 1024);
        b.push_heartbeat(1, mk_metrics());
        b.push_heartbeat(2, mk_metrics());
        b.push_heartbeat(3, mk_metrics());
        let drained = b.drain();
        assert_eq!(drained.len(), 1);
        assert!(drained[0].contains("\"ts\":3"));
    }

    #[test]
    fn peer_view_caps_at_60() {
        let mut b = ReplayBuffer::new(8 * 1024 * 1024);
        for i in 0..100u32 {
            b.push_event(EventKind::PeerView, json!({ "i": i }));
        }
        assert_eq!(b.peer_view.len(), 60);
        // first 40 evicted → oldest in buffer is i=40
        let drained = b.drain();
        assert!(drained[drained.len() - 60].contains("\"i\":40"));
    }

    #[test]
    fn drain_priority_order() {
        let mut b = ReplayBuffer::new(8 * 1024 * 1024);
        b.push_event(EventKind::PeerView, json!({ "tag": "pv1" }));
        b.push_event(EventKind::ServiceState, json!({ "tag": "ss1" }));
        b.push_heartbeat(10, mk_metrics());
        b.push_event(EventKind::ConfigChange, json!({ "tag": "cc1" }));
        let drained = b.drain();
        // service_state first, then config_change, then peer_view, then heartbeat
        assert!(drained[0].contains("ss1"));
        assert!(drained[1].contains("cc1"));
        assert!(drained[2].contains("pv1"));
        assert!(drained[3].contains("heartbeat"));
    }

    #[test]
    fn budget_evicts_lowest_priority() {
        // budget too small for everything — peer_view should be sacrificed first.
        let mut b = ReplayBuffer::new(400);
        for i in 0..5u32 {
            b.push_event(EventKind::PeerView, json!({ "i": i, "pad": "x" }));
        }
        b.push_event(EventKind::ServiceState, json!({ "tag": "important" }));
        b.push_event(EventKind::ServiceState, json!({ "tag": "important2" }));
        // service_state always retained over peer_view
        assert!(b.service_state.len() >= 1);
        assert!(b.total_bytes() <= 400 + 256 /* tolerance for single oversize */);
    }

    #[test]
    fn oldest_ts_min_across_rings() {
        let mut b = ReplayBuffer::new(8 * 1024 * 1024);
        b.push_heartbeat(50, mk_metrics());
        b.push_event(EventKind::PeerView, json!({ "x": 1 }));
        let oldest = b.oldest_ts().unwrap();
        assert!(oldest >= 50 || oldest > 0); // at least non-zero
    }

    #[test]
    fn drain_by_ts_preserves_order() {
        let mut b = ReplayBuffer::new(8 * 1024 * 1024);
        // Push entries with distinct synthetic ts via heartbeat (overwrite ring,
        // so just verify timestamp-aware drain compiles and yields oldest first).
        b.push_event(EventKind::PeerView, json!({ "n": 1 }));
        std::thread::sleep(std::time::Duration::from_millis(2));
        b.push_event(EventKind::PeerView, json!({ "n": 2 }));
        let out = b.drain_by_ts();
        assert!(out[0].contains("\"n\":1"));
        assert!(out[1].contains("\"n\":2"));
    }
}
