//! cobweb-agent entrypoint. Wires `Config::from_cli()` into `connection::run`.

use std::sync::Arc;

use anyhow::{Context, Result};
use clap::Parser;
use cobweb_agent::{config::Cli, connection, logging};
use tokio::signal;
use tracing::{info, warn};

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    let cfg = cli.into_config().context("load config")?;

    let _ = rustls::crypto::ring::default_provider().install_default();

    // Install file + (optionally) stderr tracing. The returned guard owns
    // the non-blocking writer worker and must live for the whole process.
    let _log_guard = logging::init(
        &cfg.log_dir,
        &cfg.log_level,
        cfg.log_max_age_days,
        cfg.log_also_stderr,
    )
    .context("init logging")?;

    info!(
        version = env!("CARGO_PKG_VERSION"),
        server_url = %cfg.server_url,
        log_dir = %cfg.log_dir.display(),
        log_max_age_days = cfg.log_max_age_days,
        "cobweb-agent starting"
    );

    let (tx, rx) = tokio::sync::watch::channel(false);

    let cfg = Arc::new(cfg);
    let conn_task = tokio::spawn(connection::run(cfg, rx));

    wait_for_shutdown(&tx).await?;
    info!("shutdown requested, draining session…");

    // Give the loop a moment to flush its current session.
    match tokio::time::timeout(std::time::Duration::from_secs(5), conn_task).await {
        Ok(Ok(Ok(()))) => info!("session drained cleanly"),
        Ok(Ok(Err(e))) => warn!(error = %e, "session ended with error"),
        Ok(Err(e)) => warn!(error = %e, "session task panicked"),
        Err(_) => warn!("session shutdown timed out — forcing exit"),
    }

    Ok(())
}

#[cfg(unix)]
async fn wait_for_shutdown(tx: &tokio::sync::watch::Sender<bool>) -> Result<()> {
    let mut sigterm = signal::unix::signal(signal::unix::SignalKind::terminate())?;
    let mut sigint = signal::unix::signal(signal::unix::SignalKind::interrupt())?;
    tokio::select! {
        _ = sigterm.recv() => info!("got SIGTERM"),
        _ = sigint.recv() => info!("got SIGINT"),
    }
    let _ = tx.send(true);
    Ok(())
}

#[cfg(windows)]
async fn wait_for_shutdown(tx: &tokio::sync::watch::Sender<bool>) -> Result<()> {
    signal::ctrl_c().await?;
    info!("got Ctrl-C");
    let _ = tx.send(true);
    Ok(())
}
