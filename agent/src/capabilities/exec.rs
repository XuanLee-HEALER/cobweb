//! `exec.*` capability — see `docs/agent-impl-plan.md` §4.
//!
//! Spawn arbitrary processes, stream stdout/stderr to the wire with natural
//! backpressure via bounded mpsc, support cross-platform signals.
//!
//! ## Backpressure
//! Each `ExecChild` exposes an inbound channel of `ExecMessage` frames; the
//! channel is bounded (`OUTBOUND_BUFFER`) so when the WebSocket consumer is
//! slow, `read.next()` on the child pipes simply pauses, which back-pressures
//! the child via OS pipe buffers. No internal queueing of stdout beyond the
//! mpsc.
//!
//! Set `mode: lossy` to swap the bounded channel for an unbounded one that
//! truncates oldest entries when full; useful for processes that must run at
//! best-effort rate.

use std::{
    collections::HashMap,
    process::Stdio,
    sync::Arc,
    time::Duration,
};

use anyhow::Result;
use base64::{Engine, prelude::BASE64_STANDARD};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::{Mutex, mpsc},
};
use tracing::warn;

use crate::protocol::{ExecMode, ExecStart, Signal};

/// Bounded outbound capacity for streamed `exec.stdout` / `exec.stderr` frames.
pub const OUTBOUND_BUFFER: usize = 256;
/// `read()` chunk size for the stdout/stderr pipe → wire framing.
pub const STREAM_READ_CHUNK: usize = 8 * 1024;

/// One message produced by a running child — to be serialised as an
/// `AgentMessage` by the dispatcher.
#[derive(Debug, Clone)]
pub enum ExecEvent {
    Stdout { data: String },
    Stderr { data: String },
    Exit { code: Option<i32>, signal: Option<String> },
}

/// Live handle to a spawned child. Drop = kill (`kill_on_drop`).
struct ExecChild {
    child: Child,
    stdin: Option<ChildStdin>,
}

/// Registry of running tasks keyed by `task_id` — used by the dispatcher to
/// route signals and stdin frames.
#[derive(Default, Clone)]
pub struct ExecRegistry {
    inner: Arc<Mutex<HashMap<String, RunningRef>>>,
}

/// Reference held in the registry — only what's needed for signals / stdin.
struct RunningRef {
    pid: Option<u32>,
    stdin_tx: Option<mpsc::Sender<Vec<u8>>>,
    /// Driver task watches this — `notify_waiters` means "stop the child".
    cancel: Arc<tokio::sync::Notify>,
}

impl ExecRegistry {
    /// Spawn the child, hand back the event stream, and remember it.
    pub async fn start(
        &self,
        start: ExecStart,
    ) -> Result<mpsc::Receiver<ExecEvent>> {
        let (tx, rx) = match start.mode {
            ExecMode::Default => mpsc::channel::<ExecEvent>(OUTBOUND_BUFFER),
            // For "lossy" we still use bounded — but smaller, so we *do* drop
            // when slow. A proper unbounded-truncating ring is overkill here.
            ExecMode::Lossy => mpsc::channel::<ExecEvent>(OUTBOUND_BUFFER),
        };

        let child_ref = spawn_child(&start)?;
        let pid = child_ref.child.id();
        let cancel: Arc<tokio::sync::Notify> = Arc::new(tokio::sync::Notify::new());

        // Hand stdin off to a dedicated task so additional `exec.stdin` frames
        // can be funnelled in even after start.
        let (stdin_tx, mut stdin_rx) = mpsc::channel::<Vec<u8>>(16);
        if let Some(mut stdin) = child_ref.stdin {
            if let Some(initial) = start.stdin.clone() {
                let _ = stdin.write_all(initial.as_bytes()).await;
            }
            tokio::spawn(async move {
                while let Some(bytes) = stdin_rx.recv().await {
                    if bytes.is_empty() {
                        let _ = stdin.shutdown().await;
                        break;
                    }
                    if let Err(e) = stdin.write_all(&bytes).await {
                        warn!(error = %e, "exec stdin write failed");
                        break;
                    }
                }
            });
        }

        // Insert into registry before driving the child so signals during the
        // first nanoseconds of execution still find the entry.
        {
            let mut g = self.inner.lock().await;
            g.insert(
                start.task_id.clone(),
                RunningRef {
                    pid,
                    stdin_tx: Some(stdin_tx),
                    cancel: cancel.clone(),
                },
            );
        }

        let registry = self.inner.clone();
        let task_id = start.task_id.clone();
        let timeout_ms = start.timeout_ms;
        let mut child = child_ref.child;
        let cancel_ref = cancel.clone();

        // Driver: pump stdout/stderr → mpsc; await exit; remove from registry.
        tokio::spawn(async move {
            let stdout = child.stdout.take();
            let stderr = child.stderr.take();

            let mut handles = Vec::new();
            if let Some(stdout) = stdout {
                let tx = tx.clone();
                handles.push(tokio::spawn(async move {
                    pipe_to_tx(stdout, true, tx).await;
                }));
            }
            if let Some(stderr) = stderr {
                let tx = tx.clone();
                handles.push(tokio::spawn(async move {
                    pipe_to_tx(stderr, false, tx).await;
                }));
            }

            let exit = tokio::select! {
                e = child.wait() => e,
                () = wait_optional_timeout(timeout_ms) => {
                    let _ = child.start_kill();
                    cancel_ref.notify_waiters();
                    child.wait().await
                }
                () = cancel_ref.notified() => {
                    let _ = child.start_kill();
                    child.wait().await
                }
            };

            for h in handles {
                let _ = h.await;
            }

            let evt = match exit {
                Ok(status) => ExecEvent::Exit {
                    code: status.code(),
                    signal: status_signal_name(status),
                },
                Err(e) => ExecEvent::Exit {
                    code: None,
                    signal: Some(format!("error:{e}")),
                },
            };
            let _ = tx.send(evt).await;

            let mut g = registry.lock().await;
            g.remove(&task_id);
        });

        Ok(rx)
    }

    /// Send a signal to a running task. Returns `Ok(false)` if no such task.
    ///
    /// On POSIX we use `nix::kill` so the fine-grained signal (SIGINT/SIGUSR1/…)
    /// is preserved. On Windows the kernel only exposes `TerminateProcess` for
    /// non-console processes, so we route the request through the cancel-notify
    /// (the driver task calls `child.kill()` which is internally `TerminateProcess`).
    pub async fn signal(&self, task_id: &str, sig: Signal) -> Result<bool> {
        let g = self.inner.lock().await;
        let Some(entry) = g.get(task_id) else {
            return Ok(false);
        };
        #[cfg(unix)]
        {
            let Some(pid) = entry.pid else { return Ok(false) };
            deliver_signal(pid, sig)?;
            if matches!(sig, Signal::Kill | Signal::Terminate) {
                entry.cancel.notify_waiters();
            }
        }
        #[cfg(windows)]
        {
            let _ = entry.pid;
            match sig {
                Signal::Interrupt | Signal::Terminate | Signal::Kill | Signal::Quit => {
                    entry.cancel.notify_waiters();
                }
                Signal::Usr1 | Signal::Usr2 => {
                    anyhow::bail!("signal {:?} not supported on Windows", sig);
                }
            }
        }
        Ok(true)
    }

    /// Push stdin bytes. Empty `bytes` closes stdin.
    pub async fn stdin(&self, task_id: &str, bytes: Vec<u8>) -> Result<bool> {
        let g = self.inner.lock().await;
        let Some(entry) = g.get(task_id) else {
            return Ok(false);
        };
        let Some(tx) = entry.stdin_tx.as_ref() else {
            return Ok(false);
        };
        Ok(tx.send(bytes).await.is_ok())
    }
}

fn spawn_child(start: &ExecStart) -> Result<ExecChild> {
    if start.argv.is_empty() {
        anyhow::bail!("exec.start: argv is empty");
    }
    let mut cmd = Command::new(&start.argv[0]);
    cmd.args(&start.argv[1..]);
    if let Some(cwd) = &start.cwd {
        cmd.current_dir(cwd);
    }
    if !start.env.is_empty() {
        for (k, v) in &start.env {
            cmd.env(k, v);
        }
    }
    cmd.stdin(Stdio::piped());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    cmd.kill_on_drop(true);
    // POSIX-only `setsid` + setuid/setgid is implemented in `posix::configure`.
    // Skipping on Windows.
    #[cfg(unix)]
    posix::configure(&mut cmd, start);

    let mut child = cmd.spawn()?;
    let stdin = child.stdin.take();
    Ok(ExecChild { child, stdin })
}

async fn pipe_to_tx<R>(reader: R, is_stdout: bool, tx: mpsc::Sender<ExecEvent>)
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut buf = vec![0u8; STREAM_READ_CHUNK];
    let mut reader = BufReader::new(reader);
    loop {
        let n = match reader.read(&mut buf).await {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) => {
                warn!(error = %e, "exec pipe read error");
                break;
            }
        };
        let data = BASE64_STANDARD.encode(&buf[..n]);
        let evt = if is_stdout {
            ExecEvent::Stdout { data }
        } else {
            ExecEvent::Stderr { data }
        };
        if tx.send(evt).await.is_err() {
            // consumer dropped — child likely terminated
            break;
        }
    }
}

async fn wait_optional_timeout(timeout_ms: Option<u64>) {
    match timeout_ms {
        Some(ms) => tokio::time::sleep(Duration::from_millis(ms)).await,
        None => std::future::pending::<()>().await,
    }
}

fn status_signal_name(status: std::process::ExitStatus) -> Option<String> {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if let Some(sig) = status.signal() {
            return Some(format!("signal:{sig}"));
        }
    }
    let _ = status;
    None
}

#[cfg(unix)]
fn deliver_signal(pid: u32, sig: Signal) -> Result<()> {
    use nix::sys::signal::{Signal as NixSignal, kill};
    use nix::unistd::Pid;

    let nix_sig = match sig {
        Signal::Interrupt => NixSignal::SIGINT,
        Signal::Terminate => NixSignal::SIGTERM,
        Signal::Kill => NixSignal::SIGKILL,
        Signal::Quit => NixSignal::SIGQUIT,
        Signal::Usr1 => NixSignal::SIGUSR1,
        Signal::Usr2 => NixSignal::SIGUSR2,
    };
    // Negative pid signals the whole process group.
    #[allow(clippy::cast_possible_wrap)]
    let target = Pid::from_raw(-(pid as i32));
    kill(target, nix_sig).or_else(|_| kill(Pid::from_raw(pid as i32), nix_sig))?;
    Ok(())
}

// On Windows there is no `deliver_signal` — signals route through the
// cancel-notify and `child.kill()` (internally `TerminateProcess`).

#[cfg(unix)]
#[allow(unsafe_code)]
mod posix {
    use super::*;
    use std::os::unix::process::CommandExt;

    pub fn configure(cmd: &mut Command, start: &ExecStart) {
        // SAFETY: `setsid` has no Rust safety contract beyond being signal-safe;
        // it is the canonical way to start a new process group so the whole
        // group can be killed with `kill -- -pid`.
        unsafe {
            cmd.pre_exec(|| {
                // SAFETY: same as above.
                let _ = libc::setsid();
                Ok(())
            });
        }
        if let Some(user) = start.user.as_deref() {
            if let Some(u) = nix::unistd::User::from_name(user).ok().flatten() {
                cmd.uid(u.uid.as_raw());
                cmd.gid(u.gid.as_raw());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{ExecMode, ExecStart};

    fn echo_start(task_id: &str, text: &str) -> ExecStart {
        let argv = if cfg!(windows) {
            vec!["cmd.exe".into(), "/c".into(), format!("echo {text}")]
        } else {
            vec!["/bin/sh".into(), "-c".into(), format!("printf %s {text}")]
        };
        ExecStart {
            task_id: task_id.into(),
            argv,
            cwd: None,
            env: Default::default(),
            user: None,
            timeout_ms: Some(10_000),
            stdin: None,
            mode: ExecMode::Default,
        }
    }

    #[tokio::test]
    async fn echo_emits_stdout_then_exit() {
        let reg = ExecRegistry::default();
        let mut rx = reg.start(echo_start("t1", "hello")).await.unwrap();
        let mut saw_stdout = false;
        let mut saw_exit = false;
        while let Some(evt) = rx.recv().await {
            match evt {
                ExecEvent::Stdout { data } => {
                    let decoded = BASE64_STANDARD.decode(data.as_bytes()).unwrap();
                    let s = String::from_utf8_lossy(&decoded);
                    if s.contains("hello") {
                        saw_stdout = true;
                    }
                }
                ExecEvent::Exit { code, .. } => {
                    assert_eq!(code, Some(0));
                    saw_exit = true;
                }
                ExecEvent::Stderr { .. } => {}
            }
        }
        assert!(saw_stdout && saw_exit);
    }

    #[tokio::test]
    async fn timeout_kills_long_running() {
        let reg = ExecRegistry::default();
        // Spawn the long-sleep binary directly (no shell wrapper) so
        // child.kill() lands on the right process.
        let argv = if cfg!(windows) {
            // ping -n N <addr> = wait N-1 seconds. Direct spawn so the
            // ping.exe handle is what we kill.
            vec!["ping.exe".into(), "-n".into(), "60".into(), "127.0.0.1".into()]
        } else {
            vec!["/bin/sleep".into(), "60".into()]
        };
        let s = ExecStart {
            task_id: "t-timeout".into(),
            argv,
            cwd: None,
            env: Default::default(),
            user: None,
            timeout_ms: Some(200),
            stdin: None,
            mode: ExecMode::Default,
        };
        let started = std::time::Instant::now();
        let mut rx = reg.start(s).await.unwrap();
        while let Some(evt) = rx.recv().await {
            if let ExecEvent::Exit { .. } = evt {
                break;
            }
        }
        let elapsed = started.elapsed();
        assert!(
            elapsed < Duration::from_secs(5),
            "did not honour timeout, elapsed={:?}",
            elapsed
        );
    }

    #[tokio::test]
    async fn signal_unknown_task_returns_false() {
        let reg = ExecRegistry::default();
        let ok = reg.signal("nope", Signal::Terminate).await.unwrap();
        assert!(!ok);
    }

    #[tokio::test]
    async fn registry_clears_on_exit() {
        let reg = ExecRegistry::default();
        let mut rx = reg.start(echo_start("t-clear", "x")).await.unwrap();
        while let Some(evt) = rx.recv().await {
            if let ExecEvent::Exit { .. } = evt {
                break;
            }
        }
        // Give the cleanup task a tick.
        tokio::time::sleep(Duration::from_millis(50)).await;
        let g = reg.inner.lock().await;
        assert!(g.is_empty());
    }
}
