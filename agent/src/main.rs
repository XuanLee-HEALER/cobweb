//! cobweb-agent — node-side daemon.
//!
//! Connects out over `EasyTier` mesh to the cobweb backend via `WebSocket`
//! and exposes capabilities the backend can call (`cli`, `exec`, `file_put`,
//! `log_tail`, `pty`, …) plus periodic pushes (`heartbeat`, `peer_view`).
//!
//! Protocol + capability set: see `docs/agent-design.md` at the repo root.
//! This file is a scaffold; the implementation lands in subsequent commits.

fn main() {
    println!("cobweb-agent {} — scaffold", env!("CARGO_PKG_VERSION"));
}
