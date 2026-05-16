//! cobweb-agent entrypoint. Wires `Config::from_cli()` into `connection::run`.

use std::sync::Arc;

use anyhow::{Context, Result};
use clap::Parser;
use cobweb_agent::{config::Cli, connection};
use tokio::signal;
use tracing_subscriber::{EnvFilter, fmt};

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    let cfg = cli.into_config().context("load config")?;

    let _ = rustls::crypto::ring::default_provider().install_default();

    let filter = EnvFilter::try_new(&cfg.log_level)
        .or_else(|_| EnvFilter::try_new("info"))
        .expect("info is a valid directive");
    fmt().with_env_filter(filter).init();

    let (tx, rx) = tokio::sync::watch::channel(false);

    let cfg = Arc::new(cfg);
    let conn_task = tokio::spawn(connection::run(cfg, rx));

    wait_for_shutdown(&tx).await?;
    // give the loop a tick to drain
    let _ = tokio::time::timeout(std::time::Duration::from_secs(5), conn_task).await;
    Ok(())
}

#[cfg(unix)]
async fn wait_for_shutdown(tx: &tokio::sync::watch::Sender<bool>) -> Result<()> {
    let mut sigterm = signal::unix::signal(signal::unix::SignalKind::terminate())?;
    let mut sigint = signal::unix::signal(signal::unix::SignalKind::interrupt())?;
    tokio::select! {
        _ = sigterm.recv() => {}
        _ = sigint.recv() => {}
    }
    let _ = tx.send(true);
    Ok(())
}

#[cfg(windows)]
async fn wait_for_shutdown(tx: &tokio::sync::watch::Sender<bool>) -> Result<()> {
    signal::ctrl_c().await?;
    let _ = tx.send(true);
    Ok(())
}
