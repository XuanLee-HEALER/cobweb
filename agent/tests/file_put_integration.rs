//! End-to-end file.put: mock server pushes the chunks, agent writes to disk,
//! we verify the resulting file byte-for-byte.

use std::{sync::Arc, time::Duration};

use anyhow::Result;
use base64::{Engine, prelude::BASE64_STANDARD};
use cobweb_agent::{
    config::Config,
    connection,
    protocol::{AgentMessage, Compression, FilePutStart, ServerMessage},
};
use futures_util::{SinkExt, StreamExt};
use sha2::{Digest, Sha256};
use tempfile::TempDir;
use tokio::{
    net::TcpListener,
    sync::{mpsc, watch},
    time::timeout,
};
use tokio_tungstenite::{accept_async, tungstenite::Message};

#[tokio::test]
async fn server_puts_file_via_agent() -> Result<()> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let addr = listener.local_addr()?;
    let url = format!("ws://{addr}/agent/ws");

    let tmp = TempDir::new()?;
    let target_path = tmp.path().join("uploaded.bin");
    let incoming_dir = tmp.path().join("incoming");
    let payload: Vec<u8> = (0..1024u32).map(|i| (i & 0xff) as u8).collect();

    let mut hasher = Sha256::new();
    hasher.update(&payload);
    let sha = hex::encode(hasher.finalize());

    let (agent_msg_tx, mut agent_msg_rx) = mpsc::channel::<AgentMessage>(64);
    let (_server_msg_tx, mut server_msg_rx) = mpsc::channel::<ServerMessage>(64);

    let payload_for_server = payload.clone();
    let target_for_server = target_path.clone();

    tokio::spawn(async move {
        let (sock, _) = listener.accept().await.unwrap();
        let mut ws = accept_async(sock).await.unwrap();
        let mut sent_start = false;
        loop {
            tokio::select! {
                Some(out) = server_msg_rx.recv() => {
                    let s = serde_json::to_string(&out).unwrap();
                    if ws.send(Message::Text(s.into())).await.is_err() { break; }
                }
                next = ws.next() => {
                    let Some(msg) = next else { break };
                    let Ok(msg) = msg else { break };
                    if let Message::Text(t) = msg {
                        if let Ok(parsed) = serde_json::from_str::<AgentMessage>(&t) {
                            // After hello, push file.put.start.
                            if !sent_start && matches!(parsed, AgentMessage::Hello(_)) {
                                let start = FilePutStart {
                                    task_id: "t1".into(),
                                    path: target_for_server.to_string_lossy().into_owned(),
                                    mode: Some(0o644),
                                    size: payload_for_server.len() as u64,
                                    sha256: sha.clone(),
                                    compression: Compression::None,
                                    chunk_size: 64,
                                };
                                let m = ServerMessage::FilePutStart(start);
                                let s = serde_json::to_string(&m).unwrap();
                                let _ = ws.send(Message::Text(s.into())).await;
                                sent_start = true;
                            } else if let AgentMessage::FilePutAck { resume_from, .. } = &parsed {
                                let resume_from = *resume_from;
                                for (seq, chunk) in payload_for_server.chunks(64).enumerate().skip(resume_from as usize) {
                                    let m = ServerMessage::FilePutChunk {
                                        task_id: "t1".into(),
                                        seq: u32::try_from(seq).unwrap(),
                                        data: BASE64_STANDARD.encode(chunk),
                                    };
                                    let s = serde_json::to_string(&m).unwrap();
                                    let _ = ws.send(Message::Text(s.into())).await;
                                }
                                let s = serde_json::to_string(&ServerMessage::FilePutEnd { task_id: "t1".into() }).unwrap();
                                let _ = ws.send(Message::Text(s.into())).await;
                            }
                            let _ = agent_msg_tx.send(parsed).await;
                        }
                    }
                }
            }
        }
    });

    let mut cfg = Config::default();
    cfg.server_url = url;
    cfg.heartbeat_interval_ms = 5_000;
    cfg.peer_view_interval_ms = 60_000;
    cfg.incoming_dir = incoming_dir;
    cfg.rate_limit_bps = 0;
    let cfg = Arc::new(cfg);

    let (sd_tx, sd_rx) = watch::channel(false);
    let agent_handle = tokio::spawn(connection::run(cfg, sd_rx));

    let mut got_done = false;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    while !got_done && tokio::time::Instant::now() < deadline {
        let Ok(Some(m)) = timeout(Duration::from_secs(5), agent_msg_rx.recv()).await else {
            break;
        };
        if let AgentMessage::FilePutDone { ok, error, .. } = m {
            assert!(ok, "put failed: {error:?}");
            got_done = true;
        }
    }
    assert!(got_done, "file.put.done not observed");

    let got = std::fs::read(&target_path)?;
    assert_eq!(got, payload);

    sd_tx.send(true).unwrap();
    let _ = timeout(Duration::from_secs(5), agent_handle).await;
    Ok(())
}
