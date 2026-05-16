//! `easytier-cli` invocation capability — see `docs/agent-design.md` §4.
//!
//! Server sends `cli.invoke {request_id, args}` → we spawn the binary with
//! `-p <rpc> -o json` plus the requested args, return the parsed JSON or the
//! captured stderr.

use std::{path::Path, time::Duration};

use anyhow::{Context, Result};
use serde_json::Value;
use tokio::process::Command;

use crate::protocol::CliResult;

/// Default timeout — easytier RPC calls are fast (<1 s), 30 s gives slow
/// boxes plenty of headroom while still bounding stuck child processes.
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);

/// Invoke `easytier-cli -p <rpc> -o json [args...]`. Returns a `CliResult`
/// ready to push over the websocket.
pub async fn invoke(
    cli_path: &Path,
    rpc: &std::net::SocketAddr,
    request_id: String,
    args: &[String],
    json_output: bool,
) -> CliResult {
    match run(cli_path, rpc, args, json_output).await {
        Ok(json) => CliResult::Ok {
            request_id,
            ok: true,
            json,
        },
        Err(e) => CliResult::Err {
            request_id,
            ok: false,
            error: format!("{e:#}"),
        },
    }
}

async fn run(
    cli_path: &Path,
    rpc: &std::net::SocketAddr,
    args: &[String],
    json_output: bool,
) -> Result<Value> {
    let mut full = Vec::with_capacity(args.len() + 4);
    full.push("-p".to_string());
    full.push(rpc.to_string());
    if json_output {
        full.push("-o".to_string());
        full.push("json".to_string());
    }
    for a in args {
        full.push(a.clone());
    }
    run_raw(cli_path, &full, json_output).await
}

/// Lower-level entry — no `-p`/`-o` injection. Used by tests and by callers
/// that want to drive arbitrary binaries through the same pipeline.
async fn run_raw(bin: &Path, args: &[String], parse_json: bool) -> Result<Value> {
    let mut cmd = Command::new(bin);
    for a in args {
        cmd.arg(a);
    }
    cmd.kill_on_drop(true);

    let child = cmd
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .with_context(|| format!("spawn {bin:?}"))?;

    let output = tokio::time::timeout(DEFAULT_TIMEOUT, child.wait_with_output())
        .await
        .map_err(|_| anyhow::anyhow!("easytier-cli timeout after {:?}", DEFAULT_TIMEOUT))?
        .with_context(|| "wait easytier-cli")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!("easytier-cli exit={}: {}", output.status, stderr.trim());
    }
    let stdout = std::str::from_utf8(&output.stdout)
        .with_context(|| "easytier-cli stdout not utf-8")?
        .trim();

    if parse_json {
        Ok(serde_json::from_str(stdout).with_context(|| "easytier-cli stdout not JSON")?)
    } else {
        Ok(Value::String(stdout.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Build a synthetic "cli" — on Windows we shell out to `cmd /c echo`,
    // on POSIX we use `echo` directly. Both emit JSON we can parse.

    #[tokio::test]
    async fn run_raw_parses_json() {
        let v = if cfg!(windows) {
            let path = Path::new("powershell.exe");
            run_raw(
                path,
                &[
                    "-NoProfile".into(),
                    "-Command".into(),
                    "Write-Output '{\"k\":1}'".into(),
                ],
                true,
            )
            .await
        } else {
            let path = Path::new("/bin/sh");
            run_raw(path, &["-c".into(), "printf '{\"k\":1}'".into()], true).await
        };
        let v = v.expect("ok");
        assert_eq!(v["k"], 1);
    }

    #[tokio::test]
    async fn run_raw_errors_on_nonzero_exit() {
        let result = if cfg!(windows) {
            run_raw(
                Path::new("cmd.exe"),
                &["/c".into(), "exit 1".into()],
                false,
            )
            .await
        } else {
            run_raw(Path::new("/bin/false"), &[], false).await
        };
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn invoke_wraps_into_cliresult() {
        let rpc: std::net::SocketAddr = "127.0.0.1:15888".parse().unwrap();
        let path = if cfg!(windows) {
            Path::new("does-not-exist.exe")
        } else {
            Path::new("/nonexistent/cli")
        };
        let r = invoke(path, &rpc, "rid-1".into(), &[], true).await;
        match r {
            CliResult::Err { request_id, ok, .. } => {
                assert_eq!(request_id, "rid-1");
                assert!(!ok);
            }
            CliResult::Ok { .. } => panic!("expected err"),
        }
    }
}
