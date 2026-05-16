//! Wire protocol — JSON messages over WebSocket.
//!
//! Mirrors `docs/agent-design.md` §3 + `docs/agent-impl-plan.md` §6 (extension
//! set). All message variants share `type` as the discriminator.
//!
//! `request_id` ↔ one-shot RPC (`cli.invoke` / `file.get`).
//! `task_id`    ↔ long-lived task with multiple frames (`exec.*`, `file.*`).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

pub const PROTOCOL_VERSION: u32 = 1;

/// `os` field reported in the hello frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Os {
    Linux,
    Macos,
    Windows,
}

impl Os {
    #[must_use]
    pub const fn current() -> Self {
        #[cfg(target_os = "linux")]
        {
            Self::Linux
        }
        #[cfg(target_os = "macos")]
        {
            Self::Macos
        }
        #[cfg(target_os = "windows")]
        {
            Self::Windows
        }
    }
}

/// Capability advertisement bit in the hello frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Capability {
    Cli,
    Exec,
    File,
    Log,
    Pty,
    Event,
}

/// Lightweight system metrics shipped on `heartbeat`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HeartbeatMetrics {
    /// Memory used in bytes.
    pub mem_used_bytes: u64,
    /// Total memory in bytes.
    pub mem_total_bytes: u64,
    /// CPU usage 0.0–100.0 averaged across cores.
    pub cpu_percent: f32,
    /// Process uptime in seconds.
    pub uptime_secs: u64,
}

/// Compression on the wire for file frames.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Compression {
    #[default]
    None,
    Gzip,
}

/// Stream mode for `exec.start`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExecMode {
    #[default]
    Default,
    /// `unbounded mpsc + ring truncate` instead of natural back-pressure.
    Lossy,
}

/// Cross-platform signal name.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Signal {
    Interrupt,
    Terminate,
    Kill,
    Quit,
    Usr1,
    Usr2,
}

/// Tag for `event` frames pushed asynchronously by the agent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EventKind {
    PeerView,
    ServiceState,
    ConfigChange,
}

// ── Server → Agent ────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerMessage {
    HelloAck {
        request_id: Option<String>,
        server_version: String,
    },
    CliInvoke {
        request_id: String,
        args: Vec<String>,
        #[serde(default)]
        json_output: bool,
    },
    #[serde(rename = "exec.start")]
    ExecStart(ExecStart),
    #[serde(rename = "exec.signal")]
    ExecSignal {
        task_id: String,
        signal: Signal,
    },
    #[serde(rename = "exec.stdin")]
    ExecStdin {
        task_id: String,
        data: String,
        #[serde(default)]
        close: bool,
    },
    #[serde(rename = "file.put.start")]
    FilePutStart(FilePutStart),
    #[serde(rename = "file.put.chunk")]
    FilePutChunk {
        task_id: String,
        seq: u32,
        data: String,
    },
    #[serde(rename = "file.put.end")]
    FilePutEnd {
        task_id: String,
    },
    #[serde(rename = "file.get.start")]
    FileGetStart(FileGetStart),
    #[serde(rename = "file.get.ack_end")]
    FileGetAckEnd {
        task_id: String,
        ok: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    #[serde(rename = "replay.ack")]
    ReplayAck {
        up_to: u64,
    },
    Shutdown {
        #[serde(default)]
        restart: bool,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecStart {
    pub task_id: String,
    pub argv: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub env: BTreeMap<String, String>,
    /// `null` (or omitted) → inherit (root); otherwise drop privileges.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stdin: Option<String>,
    #[serde(default)]
    pub mode: ExecMode,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FilePutStart {
    pub task_id: String,
    pub path: String,
    /// POSIX mode in octal (e.g. 0o644 = 420). Ignored on Windows.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<u32>,
    /// Expected total file size after decompression.
    pub size: u64,
    /// Expected full-file sha256 (lowercase hex).
    pub sha256: String,
    #[serde(default)]
    pub compression: Compression,
    pub chunk_size: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileGetStart {
    pub task_id: String,
    pub path: String,
    #[serde(default)]
    pub range_from: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub range_to: Option<u64>,
    pub chunk_size: u32,
    #[serde(default)]
    pub prefer_compression: Compression,
    /// On resume, the sha256 the server already computed for the file. agent
    /// must verify the on-disk file still matches.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
}

// ── Agent → Server ────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AgentMessage {
    Hello(Hello),
    Heartbeat {
        ts: u64,
        metrics: HeartbeatMetrics,
    },
    #[serde(rename = "replay.start")]
    ReplayStart {
        since: u64,
        count: u32,
    },
    #[serde(rename = "replay.end")]
    ReplayEnd {
        count: u32,
    },
    #[serde(rename = "cli.result")]
    CliResult(CliResult),
    #[serde(rename = "exec.stdout")]
    ExecStdout {
        task_id: String,
        data: String,
    },
    #[serde(rename = "exec.stderr")]
    ExecStderr {
        task_id: String,
        data: String,
    },
    #[serde(rename = "exec.exit")]
    ExecExit {
        task_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        code: Option<i32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        signal: Option<String>,
    },
    #[serde(rename = "file.put.ack")]
    FilePutAck {
        task_id: String,
        resume_from: u32,
    },
    #[serde(rename = "file.put.progress")]
    FilePutProgress {
        task_id: String,
        bytes: u64,
    },
    #[serde(rename = "file.put.done")]
    FilePutDone {
        task_id: String,
        ok: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    #[serde(rename = "file.get.ack")]
    FileGetAck {
        task_id: String,
        size: u64,
        sha256: String,
        compression: Compression,
    },
    #[serde(rename = "file.get.chunk")]
    FileGetChunk {
        task_id: String,
        seq: u32,
        data: String,
    },
    #[serde(rename = "file.get.end")]
    FileGetEnd {
        task_id: String,
    },
    Event(Event),
    Error {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        request_id: Option<String>,
        message: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Hello {
    pub protocol_version: u32,
    pub agent_version: String,
    pub hostname: String,
    pub peer_id: String,
    pub os: Os,
    pub capabilities: Vec<Capability>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum CliResult {
    Ok {
        request_id: String,
        ok: bool,
        json: serde_json::Value,
    },
    Err {
        request_id: String,
        ok: bool,
        error: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Event {
    pub kind: EventKind,
    pub ts: u64,
    pub payload: serde_json::Value,
}

// ── helpers ───────────────────────────────────────────────────────────

/// Best-effort milliseconds since unix epoch.
#[must_use]
pub fn now_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn round_trip<T: Serialize + for<'de> Deserialize<'de> + std::fmt::Debug>(v: &T) -> T {
        let s = serde_json::to_string(v).expect("ser");
        serde_json::from_str(&s).expect("de")
    }

    #[test]
    fn hello_serde() {
        let m = AgentMessage::Hello(Hello {
            protocol_version: PROTOCOL_VERSION,
            agent_version: "0.1.0".into(),
            hostname: "test".into(),
            peer_id: "1234".into(),
            os: Os::Linux,
            capabilities: vec![Capability::Cli, Capability::Exec],
        });
        let s = serde_json::to_value(&m).unwrap();
        assert_eq!(s["type"], "hello");
        assert_eq!(s["protocol_version"], 1);
        let back: AgentMessage = serde_json::from_value(s).unwrap();
        assert!(matches!(back, AgentMessage::Hello(_)));
    }

    #[test]
    fn heartbeat_serde() {
        let m = AgentMessage::Heartbeat {
            ts: 1,
            metrics: HeartbeatMetrics {
                mem_used_bytes: 1,
                mem_total_bytes: 2,
                cpu_percent: 3.0,
                uptime_secs: 4,
            },
        };
        let v = serde_json::to_value(&m).unwrap();
        assert_eq!(v["type"], "heartbeat");
        let _back = round_trip(&m);
    }

    #[test]
    fn exec_start_serde() {
        let v = serde_json::json!({
            "type": "exec.start",
            "task_id": "t1",
            "argv": ["echo", "hi"],
            "mode": "default"
        });
        let m: ServerMessage = serde_json::from_value(v).unwrap();
        match m {
            ServerMessage::ExecStart(s) => {
                assert_eq!(s.task_id, "t1");
                assert_eq!(s.argv, vec!["echo", "hi"]);
                assert!(matches!(s.mode, ExecMode::Default));
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn file_put_chunk_seq() {
        let v = serde_json::json!({
            "type": "file.put.chunk",
            "task_id": "t",
            "seq": 7,
            "data": "AAAA"
        });
        let m: ServerMessage = serde_json::from_value(v).unwrap();
        match m {
            ServerMessage::FilePutChunk { seq, .. } => assert_eq!(seq, 7),
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn replay_messages_round_trip() {
        let start = AgentMessage::ReplayStart {
            since: 100,
            count: 3,
        };
        let end = AgentMessage::ReplayEnd { count: 3 };
        let ack = ServerMessage::ReplayAck { up_to: 100 };
        let _s1 = round_trip(&start);
        let _s2 = round_trip(&end);
        let _s3 = round_trip(&ack);
    }

    #[test]
    fn shutdown_default_restart() {
        let v = serde_json::json!({ "type": "shutdown" });
        let m: ServerMessage = serde_json::from_value(v).unwrap();
        match m {
            ServerMessage::Shutdown { restart } => assert!(!restart),
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn signal_serde() {
        for (name, sig) in [
            ("interrupt", Signal::Interrupt),
            ("terminate", Signal::Terminate),
            ("kill", Signal::Kill),
            ("quit", Signal::Quit),
            ("usr1", Signal::Usr1),
            ("usr2", Signal::Usr2),
        ] {
            let v = serde_json::json!({ "type": "exec.signal", "task_id": "t", "signal": name });
            let m: ServerMessage = serde_json::from_value(v).unwrap();
            match m {
                ServerMessage::ExecSignal { signal, .. } => assert_eq!(signal, sig),
                _ => panic!("wrong variant"),
            }
        }
    }
}
