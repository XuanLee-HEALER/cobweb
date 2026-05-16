//! Connection state machine — see `docs/agent-impl-plan.md` §1.
//!
//! `run()` is the agent's main driver: dial → hello → pump (recv + heartbeat
//! + replay drain) → reconnect.

use std::{
    sync::Arc,
    time::Duration,
};

use anyhow::Result;
use futures_util::{SinkExt, StreamExt};
use rand::Rng;
use tokio::{
    sync::{Mutex, mpsc},
    time::{Instant, interval},
};
use tokio_tungstenite::tungstenite::Message;
use tracing::{debug, info, trace, warn};

use crate::{
    buffer::ReplayBuffer,
    collectors::{heartbeat::HeartbeatSampler, peer_view},
    config::Config,
    dispatcher::Dispatcher,
    protocol::{
        AgentMessage, Capability, EventKind, Hello, Os, PROTOCOL_VERSION, ServerMessage, now_ms,
    },
    transport,
};

/// Reconnect attempt → delay (ms) with 0-30% jitter.
///
/// Sequence (no jitter): 1 s, 2 s, 4 s, 8 s, 16 s, 32 s, 60 s, 60 s, …
#[must_use]
pub fn backoff_delay_ms(attempt: u32) -> u64 {
    let capped = attempt.min(6);
    let base = 1000_u64.saturating_mul(1_u64 << capped);
    let base = base.min(60_000);
    #[allow(clippy::cast_precision_loss, clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let jitter = {
        let mut rng = rand::thread_rng();
        let frac: f32 = rng.gen_range(0.0..0.3);
        (base as f32 * frac) as u64
    };
    base.saturating_add(jitter)
}

/// Lifecycle state — drives logging and "dead threshold" decisions.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnState {
    Connecting,
    Authenticating,
    Connected,
    /// Three consecutive reconnect failures → events go into replay buffer.
    Unreachable,
    Recovering,
    Stopping,
}

/// Number of consecutive failed reconnects after which we declare the server
/// `Unreachable` and start buffering events.
pub const DEAD_THRESHOLD: u32 = 3;

#[must_use]
pub const fn is_dead(attempt: u32) -> bool {
    attempt >= DEAD_THRESHOLD
}

#[derive(Debug, Clone, Copy)]
pub struct Watchdog {
    pub interval: Duration,
}

impl Watchdog {
    #[must_use]
    pub const fn new(interval: Duration) -> Self {
        Self { interval }
    }
    #[must_use]
    pub fn dead_threshold(self) -> Duration {
        self.interval.saturating_mul(3)
    }
}

/// Build the `Hello` frame from current process / OS state.
pub fn build_hello() -> Hello {
    let hostname = hostname::get()
        .ok()
        .and_then(|s| s.to_string_lossy().into_owned().into())
        .unwrap_or_else(|| "unknown".into());
    Hello {
        protocol_version: PROTOCOL_VERSION,
        agent_version: env!("CARGO_PKG_VERSION").to_string(),
        hostname,
        peer_id: String::new(), // server can infer from socket; future: read via easytier-cli
        os: Os::current(),
        capabilities: vec![
            Capability::Cli,
            Capability::Exec,
            Capability::File,
            Capability::Event,
        ],
    }
}

/// Long-running driver. Returns only on terminal shutdown.
pub async fn run(cfg: Arc<Config>, shutdown: tokio::sync::watch::Receiver<bool>) -> Result<()> {
    info!(
        url = %cfg.server_url,
        heartbeat_interval_ms = cfg.heartbeat_interval_ms,
        peer_view_interval_ms = cfg.peer_view_interval_ms,
        buffer_max_bytes = cfg.buffer_max_bytes,
        "connection::run entered (state=Connecting)"
    );
    let buffer = Arc::new(Mutex::new(ReplayBuffer::new(cfg.buffer_max_bytes)));
    let dispatcher = Arc::new(Dispatcher::new(cfg.clone()));

    let mut attempt: u32 = 0;
    let mut shutdown = shutdown;

    loop {
        if *shutdown.borrow() {
            info!("connection::run: shutdown observed before session start — exiting");
            break;
        }

        debug!(attempt, "spawning new session");
        let cfg2 = cfg.clone();
        let session = run_session(cfg2, buffer.clone(), dispatcher.clone(), shutdown.clone()).await;
        match session {
            Ok(()) => {
                info!(attempt, "session ended cleanly — state=Connecting (next loop)");
                attempt = 0;
            }
            Err(e) => {
                attempt = attempt.saturating_add(1);
                if is_dead(attempt) {
                    warn!(
                        attempt,
                        error = %e,
                        "session failed — state=Unreachable (collectors buffer to ring)"
                    );
                } else {
                    warn!(attempt, error = %e, "session failed — state=Reconnecting");
                }
            }
        }

        if *shutdown.borrow() {
            info!("connection::run: shutdown observed after session — exiting");
            break;
        }
        let delay = backoff_delay_ms(attempt);
        info!(attempt, delay_ms = delay, "backoff before next dial");
        tokio::select! {
            () = tokio::time::sleep(Duration::from_millis(delay)) => {}
            _ = shutdown.changed() => {
                info!("shutdown received during backoff");
            }
        }
    }
    info!("connection::run exited (state=Stopped)");
    Ok(())
}

async fn run_session(
    cfg: Arc<Config>,
    buffer: Arc<Mutex<ReplayBuffer>>,
    dispatcher: Arc<Dispatcher>,
    mut shutdown: tokio::sync::watch::Receiver<bool>,
) -> Result<()> {
    info!(url = %cfg.server_url, "state=Connecting · dialing");
    let mut ws = transport::connect(&cfg).await?;
    info!("state=Authenticating · WS handshake done, sending hello");

    // Send hello.
    let hello = AgentMessage::Hello(build_hello());
    let hello_json = serde_json::to_string(&hello)?;
    ws.send(Message::Text(hello_json.into())).await?;
    debug!("hello frame sent");

    // Drain replay buffer (if any).
    let pending = {
        let mut b = buffer.lock().await;
        let since = b.oldest_ts().unwrap_or_else(now_ms);
        let count = b.pending();
        if count > 0 {
            info!(count, since, "state=Recovering · replay.start");
            let start_msg = AgentMessage::ReplayStart { since, count };
            let s = serde_json::to_string(&start_msg)?;
            ws.send(Message::Text(s.into())).await?;
        } else {
            debug!("no backlog to replay");
        }
        b.drain()
    };
    let pending_len = pending.len();
    for entry in pending {
        ws.send(Message::Text(entry.into())).await?;
    }
    if pending_len > 0 {
        let end_msg = AgentMessage::ReplayEnd {
            count: u32::try_from(pending_len).unwrap_or(u32::MAX),
        };
        let s = serde_json::to_string(&end_msg)?;
        ws.send(Message::Text(s.into())).await?;
        info!(count = pending_len, "replay.end sent");
    }
    info!(replayed = pending_len, "state=Connected");

    // Outbound channel: dispatcher / collectors push AgentMessage frames here,
    // a dedicated task serialises + writes to ws.
    let (out_tx, mut out_rx) = mpsc::channel::<AgentMessage>(256);

    let mut heartbeat = HeartbeatSampler::new();
    let mut hb_interval = interval(Duration::from_millis(cfg.heartbeat_interval_ms));
    let mut pv_interval = interval(Duration::from_millis(cfg.peer_view_interval_ms));
    hb_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    pv_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    let mut last_inbound = Instant::now();
    let watchdog = Watchdog::new(Duration::from_millis(cfg.heartbeat_interval_ms));

    loop {
        tokio::select! {
            biased;
            _ = shutdown.changed() => {
                if *shutdown.borrow() {
                    info!("state=Stopping · shutdown signaled");
                    break;
                }
            }
            // Outbound writer.
            Some(msg) = out_rx.recv() => {
                let s = serde_json::to_string(&msg)?;
                trace!(bytes = s.len(), "outbound frame");
                ws.send(Message::Text(s.into())).await?;
            }
            // Heartbeat tick.
            _ = hb_interval.tick() => {
                let metrics = heartbeat.sample();
                trace!(
                    mem_used = metrics.mem_used_bytes,
                    cpu = metrics.cpu_percent,
                    uptime_secs = metrics.uptime_secs,
                    "heartbeat tick"
                );
                let frame = AgentMessage::Heartbeat { ts: now_ms(), metrics: metrics.clone() };
                buffer.lock().await.push_heartbeat(now_ms(), metrics);
                let s = serde_json::to_string(&frame)?;
                if ws.send(Message::Text(s.into())).await.is_err() {
                    warn!("heartbeat write failed — dropping session");
                    anyhow::bail!("heartbeat write failed");
                }
                if last_inbound.elapsed() > watchdog.dead_threshold() {
                    warn!(
                        silence = ?last_inbound.elapsed(),
                        threshold = ?watchdog.dead_threshold(),
                        "watchdog tripped — disconnecting"
                    );
                    anyhow::bail!("no inbound for {:?}, disconnecting", watchdog.dead_threshold());
                }
            }
            // Peer-view tick.
            _ = pv_interval.tick() => {
                let cli = cfg.easytier_cli.clone();
                let rpc = cfg.easytier_rpc;
                let buf = buffer.clone();
                let out = out_tx.clone();
                trace!("peer_view tick — spawning collector");
                tokio::spawn(async move {
                    match peer_view::collect(&cli, &rpc).await {
                        Ok(payload) => {
                            trace!("peer_view collected; pushing event");
                            let event = AgentMessage::Event(crate::protocol::Event {
                                kind: EventKind::PeerView,
                                ts: now_ms(),
                                payload: payload.clone(),
                            });
                            buf.lock().await.push_event(EventKind::PeerView, payload);
                            let _ = out.send(event).await;
                        }
                        Err(e) => debug!(error = %e, "peer_view collect failed"),
                    }
                });
            }
            // Inbound frame.
            next = ws.next() => {
                let Some(msg) = next else {
                    info!("inbound stream ended (None)");
                    break;
                };
                let frame = msg?;
                last_inbound = Instant::now();
                match frame {
                    Message::Text(t) => {
                        trace!(bytes = t.len(), "inbound text frame");
                        let parsed: ServerMessage = match serde_json::from_str(&t) {
                            Ok(p) => p,
                            Err(e) => {
                                warn!(error = %e, raw = %t, "drop unparsable inbound frame");
                                continue;
                            }
                        };
                        debug!(type_name = msg_type_name(&parsed), "dispatch inbound");
                        let go_on = dispatcher.handle(parsed, &out_tx).await?;
                        if !go_on {
                            info!("state=Stopping · dispatcher requested shutdown");
                            break;
                        }
                    }
                    Message::Close(c) => {
                        info!(?c, "server closed connection");
                        break;
                    }
                    Message::Ping(_) | Message::Pong(_) | Message::Frame(_) => {
                        trace!("ping/pong/raw frame (auto-handled)");
                    }
                    Message::Binary(_) => warn!("ignoring unexpected binary frame"),
                }
            }
        }
    }

    debug!("closing ws");
    transport::close(ws).await;
    Ok(())
}

fn msg_type_name(m: &ServerMessage) -> &'static str {
    match m {
        ServerMessage::HelloAck { .. } => "hello_ack",
        ServerMessage::CliInvoke { .. } => "cli.invoke",
        ServerMessage::ExecStart(_) => "exec.start",
        ServerMessage::ExecSignal { .. } => "exec.signal",
        ServerMessage::ExecStdin { .. } => "exec.stdin",
        ServerMessage::FilePutStart(_) => "file.put.start",
        ServerMessage::FilePutChunk { .. } => "file.put.chunk",
        ServerMessage::FilePutEnd { .. } => "file.put.end",
        ServerMessage::FileGetStart(_) => "file.get.start",
        ServerMessage::FileGetAckEnd { .. } => "file.get.ack_end",
        ServerMessage::ReplayAck { .. } => "replay.ack",
        ServerMessage::Shutdown { .. } => "shutdown",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_growth() {
        let d0 = backoff_delay_ms(0);
        assert!((1000..=1300).contains(&d0), "got {d0}");
        let d3 = backoff_delay_ms(3);
        assert!((8000..=10400).contains(&d3), "got {d3}");
    }

    #[test]
    fn backoff_caps_at_60s() {
        for attempt in 7..20 {
            let d = backoff_delay_ms(attempt);
            assert!(d <= 78_000, "attempt {attempt}: {d}");
            assert!(d >= 60_000, "attempt {attempt}: {d}");
        }
    }

    #[test]
    fn dead_threshold_value() {
        assert!(!is_dead(0));
        assert!(!is_dead(2));
        assert!(is_dead(3));
        assert!(is_dead(10));
    }

    #[test]
    fn watchdog_dead_is_3x_interval() {
        let w = Watchdog::new(Duration::from_secs(10));
        assert_eq!(w.dead_threshold(), Duration::from_secs(30));
    }

    #[test]
    fn hello_has_required_fields() {
        let h = build_hello();
        assert_eq!(h.protocol_version, PROTOCOL_VERSION);
        assert!(!h.agent_version.is_empty());
        assert!(!h.hostname.is_empty());
        assert!(h.capabilities.contains(&Capability::Cli));
    }
}
