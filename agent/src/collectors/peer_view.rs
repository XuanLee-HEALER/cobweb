//! Peer-view collector — every `Config::peer_view_interval_ms` shell out to
//! `easytier-cli peer` and push the JSON as `event { kind: "peer_view" }`.
//!
//! The collector doesn't push raw frames itself — it's a pure async function
//! returning a JSON value that the connection loop wraps into a buffered event.

use std::{net::SocketAddr, path::Path, time::Duration};

use anyhow::Result;
use serde_json::Value;
use tokio::process::Command;

/// Default time-budget for the underlying `easytier-cli peer` call.
pub const PEER_TIMEOUT: Duration = Duration::from_secs(10);

/// Run `easytier-cli -p <rpc> -o json peer` and return the parsed JSON.
pub async fn collect(cli_path: &Path, rpc: &SocketAddr) -> Result<Value> {
    let mut cmd = Command::new(cli_path);
    cmd.arg("-p").arg(rpc.to_string());
    cmd.arg("-o").arg("json");
    cmd.arg("peer");
    cmd.kill_on_drop(true);
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());

    let child = cmd.spawn()?;
    let output = tokio::time::timeout(PEER_TIMEOUT, child.wait_with_output())
        .await
        .map_err(|_| anyhow::anyhow!("peer_view timeout"))?
        .map_err(|e| anyhow::anyhow!("peer_view spawn: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!("peer_view exit={}: {}", output.status, stderr.trim());
    }
    let stdout = std::str::from_utf8(&output.stdout)?.trim();
    Ok(serde_json::from_str(stdout)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn collect_returns_err_for_missing_cli() {
        let rpc: SocketAddr = "127.0.0.1:65000".parse().unwrap();
        let result = collect(Path::new("/nonexistent/easytier-cli"), &rpc).await;
        assert!(result.is_err());
    }
}
