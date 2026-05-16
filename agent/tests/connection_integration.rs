//! End-to-end integration test: spin up an in-process plaintext WebSocket
//! "server", drive the agent's `connection::run` against it, and verify the
//! protocol handshake (`hello` → `heartbeat`) actually happens on the wire.
//!
//! TLS / cert-pin is exercised at the unit level in `transport::tests`.
//! Running a real WSS handshake here would require fabricating a CA + cert
//! and that's expensive — out of scope per the user's "证书相关的如果不能
//! 模拟可以跳过" directive.

use std::{sync::Arc, time::Duration};

use anyhow::Result;
use cobweb_agent::{
    config::Config,
    connection,
    protocol::{AgentMessage, PROTOCOL_VERSION, ServerMessage, now_ms},
};
use futures_util::{SinkExt, StreamExt};
use tokio::{
    net::TcpListener,
    sync::{mpsc, watch},
    time::timeout,
};
use tokio_tungstenite::{accept_async, tungstenite::Message};

#[tokio::test]
async fn agent_connects_and_sends_hello_then_heartbeat() -> Result<()> {
    // ── boot a tiny ws server on a random port ────────────────────────
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let addr = listener.local_addr()?;
    let url = format!("ws://{addr}/agent/ws");

    let (server_msg_tx, mut server_msg_rx) = mpsc::channel::<AgentMessage>(64);
    let (send_to_agent_tx, mut send_to_agent_rx) = mpsc::channel::<ServerMessage>(8);

    tokio::spawn(async move {
        let (sock, _peer) = listener.accept().await.unwrap();
        let mut ws = accept_async(sock).await.unwrap();
        loop {
            tokio::select! {
                Some(out) = send_to_agent_rx.recv() => {
                    let s = serde_json::to_string(&out).unwrap();
                    if ws.send(Message::Text(s.into())).await.is_err() { break; }
                }
                next = ws.next() => {
                    let Some(msg) = next else { break };
                    let Ok(msg) = msg else { break };
                    match msg {
                        Message::Text(t) => {
                            if let Ok(parsed) = serde_json::from_str::<AgentMessage>(&t) {
                                let _ = server_msg_tx.send(parsed).await;
                            }
                        }
                        Message::Close(_) => break,
                        _ => {}
                    }
                }
            }
        }
    });

    // ── boot the agent ────────────────────────────────────────────────
    let mut cfg = Config::default();
    cfg.server_url = url;
    cfg.heartbeat_interval_ms = 250; // fast for test
    cfg.peer_view_interval_ms = 60_000; // disable for test
    cfg.rate_limit_bps = 0;
    let cfg = Arc::new(cfg);

    let (sd_tx, sd_rx) = watch::channel(false);
    let agent_handle = tokio::spawn(connection::run(cfg, sd_rx));

    // ── verify ────────────────────────────────────────────────────────
    let first = timeout(Duration::from_secs(5), server_msg_rx.recv())
        .await
        .expect("hello within timeout")
        .expect("agent sent something");
    match first {
        AgentMessage::Hello(h) => {
            assert_eq!(h.protocol_version, PROTOCOL_VERSION);
            assert!(!h.hostname.is_empty());
        }
        other => panic!("expected hello first, got {other:?}"),
    }

    // Wait for at least one heartbeat.
    let mut saw_hb = false;
    for _ in 0..10u32 {
        let Ok(Some(m)) = timeout(Duration::from_secs(3), server_msg_rx.recv()).await else {
            break;
        };
        if matches!(m, AgentMessage::Heartbeat { .. }) {
            saw_hb = true;
            break;
        }
    }
    assert!(saw_hb, "no heartbeat observed");

    // Tell the agent to shut down.
    let _ = send_to_agent_tx
        .send(ServerMessage::Shutdown { restart: false })
        .await;
    sd_tx.send(true).unwrap();

    let _ = timeout(Duration::from_secs(5), agent_handle).await;
    let _ = now_ms(); // touch the import
    Ok(())
}
