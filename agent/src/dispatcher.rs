//! Inbound message → capability handler routing.
//!
//! The connection loop owns the websocket pair `(Sink, Stream)` and a handful
//! of state objects (`ExecRegistry`, `PutSessions`, …). Each inbound
//! `ServerMessage` is matched here, dispatched onto the right async task, and
//! its outbound stream of frames is funneled back into the shared outbound
//! `mpsc::Sender<AgentMessage>`.

use std::{collections::HashMap, sync::Arc};

use anyhow::Result;
use base64::{Engine, prelude::BASE64_STANDARD};
use tokio::sync::{Mutex, mpsc};
use tracing::{debug, warn};

use crate::{
    capabilities::{
        cli::{self as cli_cap},
        exec::{ExecEvent, ExecRegistry},
        file::{self as file_cap, PutSession, TokenBucket},
    },
    config::Config,
    protocol::{
        AgentMessage, FilePutStart, ServerMessage,
    },
};

/// Live state shared across dispatcher invocations.
pub struct Dispatcher {
    pub cfg: Arc<Config>,
    pub exec: ExecRegistry,
    pub bucket: Arc<TokenBucket>,
    pub put_sessions: Arc<Mutex<HashMap<String, PutSession>>>,
}

impl Dispatcher {
    #[must_use]
    pub fn new(cfg: Arc<Config>) -> Self {
        let bucket = Arc::new(TokenBucket::new(cfg.rate_limit_bps));
        Self {
            cfg,
            exec: ExecRegistry::default(),
            bucket,
            put_sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Dispatch one inbound message. Outbound frames are pushed onto `out`.
    /// Returns `Ok(false)` when the message asks us to shut down.
    pub async fn handle(
        &self,
        msg: ServerMessage,
        out: &mpsc::Sender<AgentMessage>,
    ) -> Result<bool> {
        match msg {
            ServerMessage::HelloAck { .. } => Ok(true),

            ServerMessage::CliInvoke {
                request_id,
                args,
                json_output,
            } => {
                // `json_output` defaults to false on the wire; we always want
                // JSON from easytier-cli regardless.
                let _ = json_output;
                let result = cli_cap::invoke(
                    &self.cfg.easytier_cli,
                    &self.cfg.easytier_rpc,
                    request_id,
                    &args,
                    true,
                )
                .await;
                let _ = out.send(AgentMessage::CliResult(result)).await;
                Ok(true)
            }

            ServerMessage::ExecStart(start) => {
                let task_id = start.task_id.clone();
                match self.exec.start(start).await {
                    Ok(mut rx) => {
                        let out = out.clone();
                        tokio::spawn(async move {
                            while let Some(evt) = rx.recv().await {
                                let msg = match evt {
                                    ExecEvent::Stdout { data } => AgentMessage::ExecStdout {
                                        task_id: task_id.clone(),
                                        data,
                                    },
                                    ExecEvent::Stderr { data } => AgentMessage::ExecStderr {
                                        task_id: task_id.clone(),
                                        data,
                                    },
                                    ExecEvent::Exit { code, signal } => AgentMessage::ExecExit {
                                        task_id: task_id.clone(),
                                        code,
                                        signal,
                                    },
                                };
                                let _ = out.send(msg).await;
                            }
                        });
                    }
                    Err(e) => {
                        let _ = out
                            .send(AgentMessage::Error {
                                request_id: None,
                                message: format!("exec.start failed: {e:#}"),
                            })
                            .await;
                    }
                }
                Ok(true)
            }

            ServerMessage::ExecSignal { task_id, signal } => {
                if let Err(e) = self.exec.signal(&task_id, signal).await {
                    let _ = out
                        .send(AgentMessage::Error {
                            request_id: None,
                            message: format!("exec.signal: {e:#}"),
                        })
                        .await;
                }
                Ok(true)
            }

            ServerMessage::ExecStdin { task_id, data, close } => {
                let bytes = if data.is_empty() {
                    Vec::new()
                } else {
                    match BASE64_STANDARD.decode(data.as_bytes()) {
                        Ok(b) => b,
                        Err(e) => {
                            let _ = out
                                .send(AgentMessage::Error {
                                    request_id: None,
                                    message: format!("exec.stdin base64: {e}"),
                                })
                                .await;
                            return Ok(true);
                        }
                    }
                };
                let _ = self.exec.stdin(&task_id, bytes).await;
                if close {
                    let _ = self.exec.stdin(&task_id, Vec::new()).await;
                }
                Ok(true)
            }

            ServerMessage::FilePutStart(start) => self.handle_put_start(start, out).await,

            ServerMessage::FilePutChunk { task_id, seq, data } => {
                let mut sessions = self.put_sessions.lock().await;
                if let Some(sess) = sessions.get_mut(&task_id) {
                    if let Err(e) = sess.write_chunk(seq, &data).await {
                        let _ = out
                            .send(AgentMessage::FilePutDone {
                                task_id: task_id.clone(),
                                ok: false,
                                error: Some(format!("{e:#}")),
                            })
                            .await;
                        sessions.remove(&task_id);
                        return Ok(true);
                    }
                    let _ = out
                        .send(AgentMessage::FilePutProgress {
                            task_id,
                            bytes: sess.bytes_written,
                        })
                        .await;
                }
                Ok(true)
            }

            ServerMessage::FilePutEnd { task_id } => {
                let sess = {
                    let mut sessions = self.put_sessions.lock().await;
                    sessions.remove(&task_id)
                };
                if let Some(sess) = sess {
                    let id = sess.task_id.clone();
                    match sess.finish().await {
                        Ok(()) => {
                            let _ = out
                                .send(AgentMessage::FilePutDone {
                                    task_id: id,
                                    ok: true,
                                    error: None,
                                })
                                .await;
                        }
                        Err(e) => {
                            let _ = out
                                .send(AgentMessage::FilePutDone {
                                    task_id: id,
                                    ok: false,
                                    error: Some(format!("{e:#}")),
                                })
                                .await;
                        }
                    }
                }
                Ok(true)
            }

            ServerMessage::FileGetStart(start) => self.handle_get_start(start, out).await,

            ServerMessage::FileGetAckEnd { task_id: _, ok, error } => {
                if !ok {
                    warn!(?error, "server reported file.get.ack-end with error");
                }
                Ok(true)
            }

            ServerMessage::ReplayAck { up_to } => {
                debug!(up_to, "replay.ack");
                Ok(true)
            }

            ServerMessage::Shutdown { restart } => {
                debug!(restart, "shutdown requested");
                Ok(false)
            }
        }
    }

    async fn handle_put_start(
        &self,
        start: FilePutStart,
        out: &mpsc::Sender<AgentMessage>,
    ) -> Result<bool> {
        let task_id = start.task_id.clone();
        let sess_open = PutSession::open(&start, &self.cfg.incoming_dir, self.bucket.clone()).await;
        match sess_open {
            Ok((sess, resume_from)) => {
                let _ = out
                    .send(AgentMessage::FilePutAck {
                        task_id: task_id.clone(),
                        resume_from,
                    })
                    .await;
                self.put_sessions.lock().await.insert(task_id, sess);
            }
            Err(e) => {
                let _ = out
                    .send(AgentMessage::FilePutDone {
                        task_id,
                        ok: false,
                        error: Some(format!("{e:#}")),
                    })
                    .await;
            }
        }
        Ok(true)
    }

    async fn handle_get_start(
        &self,
        start: crate::protocol::FileGetStart,
        out: &mpsc::Sender<AgentMessage>,
    ) -> Result<bool> {
        let task_id = start.task_id.clone();
        let chunk_size = start.chunk_size.max(1);
        let bucket = self.bucket.clone();
        match file_cap::open_get(&start).await {
            Ok((meta, path)) => {
                let _ = out
                    .send(AgentMessage::FileGetAck {
                        task_id: task_id.clone(),
                        size: meta.size,
                        sha256: meta.sha256,
                        compression: meta.compression,
                    })
                    .await;
                let compression = meta.compression;
                let start_seq = u32::try_from(start.range_from / u64::from(chunk_size))
                    .unwrap_or(u32::MAX);
                let end_byte = start.range_to.unwrap_or(meta.size);
                let end_seq = u32::try_from((end_byte.saturating_sub(1)) / u64::from(chunk_size))
                    .unwrap_or(u32::MAX);
                let out_tx = out.clone();
                tokio::spawn(async move {
                    for seq in start_seq..=end_seq {
                        match file_cap::read_chunk(&path, seq, chunk_size, compression, &bucket).await {
                            Ok(Some(b64)) => {
                                if out_tx
                                    .send(AgentMessage::FileGetChunk {
                                        task_id: task_id.clone(),
                                        seq,
                                        data: b64,
                                    })
                                    .await
                                    .is_err()
                                {
                                    return;
                                }
                            }
                            Ok(None) => break,
                            Err(e) => {
                                let _ = out_tx
                                    .send(AgentMessage::Error {
                                        request_id: None,
                                        message: format!("file.get.read: {e:#}"),
                                    })
                                    .await;
                                return;
                            }
                        }
                    }
                    let _ = out_tx
                        .send(AgentMessage::FileGetEnd { task_id })
                        .await;
                });
            }
            Err(e) => {
                let _ = out
                    .send(AgentMessage::Error {
                        request_id: None,
                        message: format!("file.get.start: {e:#}"),
                    })
                    .await;
            }
        }
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{Compression, ExecStart};
    use std::collections::BTreeMap;
    use tempfile::TempDir;

    fn mk_cfg(dir: &Path) -> Arc<Config> {
        let mut cfg = Config::default();
        cfg.incoming_dir = dir.to_path_buf();
        cfg.rate_limit_bps = 0;
        Arc::new(cfg)
    }

    use std::path::Path;

    #[tokio::test]
    async fn dispatches_exec_start_and_stream() {
        let dir = TempDir::new().unwrap();
        let cfg = mk_cfg(dir.path());
        let d = Dispatcher::new(cfg);
        let (tx, mut rx) = mpsc::channel(64);

        let argv = if cfg!(windows) {
            vec!["cmd.exe".into(), "/c".into(), "echo dispatched".into()]
        } else {
            vec!["/bin/sh".into(), "-c".into(), "printf dispatched".into()]
        };
        let start = ExecStart {
            task_id: "td".into(),
            argv,
            cwd: None,
            env: BTreeMap::new(),
            user: None,
            timeout_ms: Some(10_000),
            stdin: None,
            mode: crate::protocol::ExecMode::Default,
        };
        d.handle(ServerMessage::ExecStart(start), &tx).await.unwrap();
        let mut saw_stdout = false;
        let mut saw_exit = false;
        for _ in 0..200u32 {
            match tokio::time::timeout(std::time::Duration::from_millis(2000), rx.recv()).await {
                Ok(Some(AgentMessage::ExecStdout { .. })) => saw_stdout = true,
                Ok(Some(AgentMessage::ExecExit { .. })) => {
                    saw_exit = true;
                    break;
                }
                _ => continue,
            }
        }
        assert!(saw_stdout && saw_exit);
    }

    #[tokio::test]
    async fn dispatches_file_put_end_to_end() {
        let dir = TempDir::new().unwrap();
        let cfg = mk_cfg(dir.path());
        let d = Dispatcher::new(cfg);
        let (tx, mut rx) = mpsc::channel(64);

        let target = dir.path().join("target.bin");
        let payload = b"hello dispatcher!";
        use sha2::Digest;
        let mut h = sha2::Sha256::new();
        h.update(payload);
        let sha256 = hex::encode(h.finalize());
        let start = FilePutStart {
            task_id: "tput".into(),
            path: target.to_string_lossy().into_owned(),
            mode: Some(0o644),
            size: payload.len() as u64,
            sha256,
            compression: Compression::None,
            chunk_size: 8,
        };
        d.handle(ServerMessage::FilePutStart(start), &tx).await.unwrap();
        let ack = rx.recv().await.unwrap();
        assert!(matches!(ack, AgentMessage::FilePutAck { resume_from: 0, .. }));

        let mut seq = 0u32;
        for chunk in payload.chunks(8) {
            d.handle(
                ServerMessage::FilePutChunk {
                    task_id: "tput".into(),
                    seq,
                    data: BASE64_STANDARD.encode(chunk),
                },
                &tx,
            )
            .await
            .unwrap();
            seq += 1;
        }
        d.handle(ServerMessage::FilePutEnd { task_id: "tput".into() }, &tx)
            .await
            .unwrap();

        // Drain at most a few progress frames and the final done.
        let mut got_done = false;
        for _ in 0..32u32 {
            match tokio::time::timeout(std::time::Duration::from_millis(2000), rx.recv()).await {
                Ok(Some(AgentMessage::FilePutProgress { .. })) => continue,
                Ok(Some(AgentMessage::FilePutDone { ok, .. })) => {
                    assert!(ok);
                    got_done = true;
                    break;
                }
                _ => continue,
            }
        }
        assert!(got_done);
        let got = std::fs::read(&target).unwrap();
        assert_eq!(got, payload);
    }
}
