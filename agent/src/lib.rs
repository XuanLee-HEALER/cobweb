//! cobweb-agent library root.
//!
//! See `docs/agent-design.md` for architecture and `docs/agent-impl-plan.md`
//! for the file-level rollout.

pub mod buffer;
pub mod capabilities;
pub mod collectors;
pub mod config;
pub mod connection;
pub mod dispatcher;
pub mod protocol;
pub mod transport;
