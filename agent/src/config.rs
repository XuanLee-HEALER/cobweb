//! Configuration loading — CLI args > env > toml file > defaults.
//!
//! See `docs/agent-design.md` §9 and `docs/agent-impl-plan.md` §7 (stage A2).

use std::{net::SocketAddr, path::PathBuf};

use clap::Parser;
use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ConfigError {
    #[error("read {path:?}: {source}")]
    Read {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("parse {path:?}: {source}")]
    Parse {
        path: PathBuf,
        #[source]
        source: toml::de::Error,
    },
}

/// Top-level runtime config. Built by `Config::load()` from CLI / env / toml.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    /// WebSocket URL the agent dials. Should be `wss://…` in production.
    pub server_url: String,

    /// `tracing_subscriber` `EnvFilter` directive (e.g. `info` or `debug,hyper=warn`).
    #[serde(default = "default_log_level")]
    pub log_level: String,

    /// Lowercase hex SHA-256 of the expected server certificate (DER-encoded).
    /// When set, agent rejects any handshake with a mismatching peer cert.
    /// Empty string disables the check (NOT recommended outside tests).
    #[serde(default)]
    pub server_cert_fingerprint: String,

    /// File transfer rate limit (bytes/sec). 0 disables the limit.
    #[serde(default = "default_rate_limit")]
    pub rate_limit_bps: u64,

    /// Heartbeat period (ms). Default 10_000.
    #[serde(default = "default_heartbeat_ms")]
    pub heartbeat_interval_ms: u64,

    /// Peer-view collector period (ms). Default 5_000.
    #[serde(default = "default_peer_view_ms")]
    pub peer_view_interval_ms: u64,

    /// `easytier-cli` binary location.
    #[serde(default = "default_easytier_cli")]
    pub easytier_cli: PathBuf,

    /// `easytier-core` RPC endpoint.
    #[serde(default = "default_easytier_rpc")]
    pub easytier_rpc: SocketAddr,

    /// Where partial uploads live before atomic rename.
    #[serde(default = "default_incoming_dir")]
    pub incoming_dir: PathBuf,

    /// Total ring-buffer byte budget across all event types.
    #[serde(default = "default_buffer_bytes")]
    pub buffer_max_bytes: u64,

    /// PEM bytes of the trusted CA (optional override; otherwise embedded CA used).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trust_ca_path: Option<PathBuf>,
}

fn default_log_level() -> String {
    "info".into()
}
const fn default_rate_limit() -> u64 {
    10 * 1024 * 1024
} // 10 MB/s
const fn default_heartbeat_ms() -> u64 {
    10_000
}
const fn default_peer_view_ms() -> u64 {
    5_000
}
const fn default_buffer_bytes() -> u64 {
    8 * 1024 * 1024
} // 8 MiB

fn default_easytier_cli() -> PathBuf {
    if cfg!(windows) {
        PathBuf::from(r"C:\Program Files\easytier\easytier-cli.exe")
    } else {
        PathBuf::from("/usr/local/bin/easytier-cli")
    }
}

fn default_easytier_rpc() -> SocketAddr {
    "127.0.0.1:15888".parse().expect("hard-coded valid")
}

fn default_incoming_dir() -> PathBuf {
    if cfg!(windows) {
        let pd = std::env::var_os("ProgramData")
            .map_or_else(|| PathBuf::from(r"C:\ProgramData"), PathBuf::from);
        pd.join("cobweb-agent").join("incoming")
    } else {
        PathBuf::from("/var/lib/cobweb-agent/incoming")
    }
}

fn default_server_url() -> String {
    "wss://10.177.0.1:8088/agent/ws".into()
}

impl Default for Config {
    fn default() -> Self {
        Self {
            server_url: default_server_url(),
            log_level: default_log_level(),
            server_cert_fingerprint: String::new(),
            rate_limit_bps: default_rate_limit(),
            heartbeat_interval_ms: default_heartbeat_ms(),
            peer_view_interval_ms: default_peer_view_ms(),
            easytier_cli: default_easytier_cli(),
            easytier_rpc: default_easytier_rpc(),
            incoming_dir: default_incoming_dir(),
            buffer_max_bytes: default_buffer_bytes(),
            trust_ca_path: None,
        }
    }
}

/// CLI surface — every long-form arg also reads from the matching env var.
#[derive(Debug, Parser)]
#[command(name = "cobweb-agent", version, about = "node-side agent for cobweb mesh")]
pub struct Cli {
    /// Path to TOML config file.
    #[arg(short, long, env = "COBWEB_AGENT_CONFIG")]
    pub config: Option<PathBuf>,

    /// Override `server_url` from config / env.
    #[arg(long, env = "COBWEB_AGENT_SERVER_URL")]
    pub server_url: Option<String>,

    /// Override `log_level`.
    #[arg(long, env = "COBWEB_AGENT_LOG_LEVEL")]
    pub log_level: Option<String>,

    /// Override server cert SHA-256 fingerprint (hex).
    #[arg(long, env = "COBWEB_AGENT_CERT_FINGERPRINT")]
    pub cert_fingerprint: Option<String>,
}

impl Cli {
    /// Returns the canonical default-config search paths for the host OS.
    /// Returned in priority order — the first existing file wins.
    #[must_use]
    pub fn default_config_paths() -> Vec<PathBuf> {
        if cfg!(windows) {
            let pd = std::env::var_os("ProgramData")
                .map_or_else(|| PathBuf::from(r"C:\ProgramData"), PathBuf::from);
            vec![pd.join("cobweb-agent").join("config.toml")]
        } else {
            vec![
                PathBuf::from("/etc/cobweb-agent/config.toml"),
                PathBuf::from("/usr/local/etc/cobweb-agent/config.toml"),
            ]
        }
    }

    /// Materialise a `Config` by layering file (if found) → env (via clap) → CLI overrides.
    pub fn into_config(self) -> Result<Config, ConfigError> {
        let mut cfg = if let Some(path) = self
            .config
            .as_ref()
            .cloned()
            .or_else(|| Self::default_config_paths().into_iter().find(|p| p.exists()))
        {
            Config::from_file(&path)?
        } else {
            Config::default()
        };

        if let Some(v) = self.server_url {
            cfg.server_url = v;
        }
        if let Some(v) = self.log_level {
            cfg.log_level = v;
        }
        if let Some(v) = self.cert_fingerprint {
            cfg.server_cert_fingerprint = v;
        }
        Ok(cfg)
    }
}

impl Config {
    pub fn from_file(path: &std::path::Path) -> Result<Self, ConfigError> {
        let raw = std::fs::read_to_string(path).map_err(|e| ConfigError::Read {
            path: path.into(),
            source: e,
        })?;
        toml::from_str(&raw).map_err(|e| ConfigError::Parse {
            path: path.into(),
            source: e,
        })
    }

    /// Lower-cased fingerprint with `:` and whitespace stripped. Returns
    /// `None` when no pinning is configured.
    #[must_use]
    pub fn normalised_fingerprint(&self) -> Option<String> {
        let trimmed: String = self
            .server_cert_fingerprint
            .chars()
            .filter(|c| !c.is_whitespace() && *c != ':')
            .collect::<String>()
            .to_ascii_lowercase();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_round_trip_via_toml() {
        let c = Config::default();
        let s = toml::to_string(&c).unwrap();
        let back: Config = toml::from_str(&s).unwrap();
        assert_eq!(back.server_url, c.server_url);
        assert_eq!(back.rate_limit_bps, c.rate_limit_bps);
    }

    #[test]
    fn cli_overrides_take_precedence() {
        let cli = Cli {
            config: None,
            server_url: Some("wss://override/agent/ws".into()),
            log_level: Some("debug".into()),
            cert_fingerprint: None,
        };
        let cfg = cli.into_config().unwrap();
        assert_eq!(cfg.server_url, "wss://override/agent/ws");
        assert_eq!(cfg.log_level, "debug");
    }

    #[test]
    fn fingerprint_normalisation() {
        let mut c = Config::default();
        c.server_cert_fingerprint = "AB:CD: ef 12  ".into();
        assert_eq!(c.normalised_fingerprint().unwrap(), "abcdef12");

        c.server_cert_fingerprint = "   ".into();
        assert!(c.normalised_fingerprint().is_none());
    }

    #[test]
    fn loads_from_file() {
        let tmp = tempfile::NamedTempFile::new().unwrap();
        let toml_data = r#"
            server_url = "wss://example/ws"
            log_level = "trace"
            server_cert_fingerprint = "deadbeef"
            rate_limit_bps = 0
        "#;
        std::fs::write(tmp.path(), toml_data).unwrap();
        let cfg = Config::from_file(tmp.path()).unwrap();
        assert_eq!(cfg.server_url, "wss://example/ws");
        assert_eq!(cfg.log_level, "trace");
        assert_eq!(cfg.rate_limit_bps, 0);
    }
}
