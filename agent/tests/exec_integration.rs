//! End-to-end exec: mock server pushes `exec.start`, agent runs the command,
//! we observe `exec.stdout` + `exec.exit` on the wire.

use std::{collections::BTreeMap, sync::Arc, time::Duration};

use anyhow::Result;
use base64::{Engine, prelude::BASE64_STANDARD};
use cobweb_agent::{
    config::Config,
    connection,
    protocol::{AgentMessage, ExecMode, ExecStart, ServerMessage},
};
use futures_util::{SinkExt, StreamExt};
use tokio::{
    net::TcpListener,
    sync::{mpsc, watch},
    time::timeout,
};
use tokio_tungstenite::{accept_async, tungstenite::Message};

#[tokio::test]
async fn server_drives_exec_and_collects_stdout() -> Result<()> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let addr = listener.local_addr()?;
    let url = format!("ws://{addr}/agent/ws");

    let (agent_msg_tx, mut agent_msg_rx) = mpsc::channel::<AgentMessage>(64);

    tokio::spawn(async move {
        let (sock, _) = listener.accept().await.unwrap();
        let mut ws = accept_async(sock).await.unwrap();
        let mut sent = false;
        while let Some(Ok(msg)) = ws.next().await {
            if let Message::Text(t) = msg {
                if let Ok(parsed) = serde_json::from_str::<AgentMessage>(&t) {
                    if !sent && matches!(parsed, AgentMessage::Hello(_)) {
                        let argv = if cfg!(windows) {
                            vec![
                                "cmd.exe".into(),
                                "/c".into(),
                                "echo integration".into(),
                            ]
                        } else {
                            vec![
                                "/bin/sh".into(),
                                "-c".into(),
                                "printf integration".into(),
                            ]
                        };
                        let start = ExecStart {
                            task_id: "x1".into(),
                            argv,
                            cwd: None,
                            env: BTreeMap::new(),
                            user: None,
                            timeout_ms: Some(10_000),
                            stdin: None,
                            mode: ExecMode::Default,
                        };
                        let m = ServerMessage::ExecStart(start);
                        let s = serde_json::to_string(&m).unwrap();
                        let _ = ws.send(Message::Text(s.into())).await;
                        sent = true;
                    }
                    let _ = agent_msg_tx.send(parsed).await;
                }
            }
        }
    });

    let mut cfg = Config::default();
    cfg.server_url = url;
    cfg.heartbeat_interval_ms = 30_000;
    cfg.peer_view_interval_ms = 60_000;
    cfg.rate_limit_bps = 0;
    let cfg = Arc::new(cfg);

    let (sd_tx, sd_rx) = watch::channel(false);
    let agent_handle = tokio::spawn(connection::run(cfg, sd_rx));

    let mut saw_stdout_with_integration = false;
    let mut saw_exit = false;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    while !(saw_exit && saw_stdout_with_integration)
        && tokio::time::Instant::now() < deadline
    {
        let Ok(Some(m)) = timeout(Duration::from_secs(5), agent_msg_rx.recv()).await else {
            break;
        };
        match m {
            AgentMessage::ExecStdout { data, .. } => {
                if let Ok(decoded) = BASE64_STANDARD.decode(data.as_bytes()) {
                    if String::from_utf8_lossy(&decoded).contains("integration") {
                        saw_stdout_with_integration = true;
                    }
                }
            }
            AgentMessage::ExecExit { .. } => saw_exit = true,
            _ => {}
        }
    }
    assert!(saw_stdout_with_integration, "did not capture stdout");
    assert!(saw_exit, "did not see exec.exit");

    sd_tx.send(true).unwrap();
    let _ = timeout(Duration::from_secs(5), agent_handle).await;
    Ok(())
}
