//! WebSocket transport — rustls + CA-trusted handshake + post-handshake
//! SHA-256 cert pin (impl plan §3.1-§3.2).
//!
//! Two-layer trust:
//!   1. Standard `rustls` chain verification against an embedded / provided CA
//!      (either `Config::trust_ca_path` or `webpki-roots` as a permissive
//!      fallback for staging / open-internet builds).
//!   2. After the chain check, we hash the peer's leaf cert in DER form and
//!      compare it byte-for-byte with the pinned fingerprint from config.
//!      Mismatch → drop the connection before any frame is sent.
//!
//! `ws://` URLs are also supported for tests / loopback dev; pinning + TLS
//! are skipped in that case (warning logged).

use std::{fs, path::Path, sync::Arc};

use anyhow::{Context, Result, anyhow, bail};
use futures_util::{SinkExt, StreamExt};
use rustls::{
    DigitallySignedStruct, RootCertStore, SignatureScheme,
    client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier},
    crypto::{CryptoProvider, ring::default_provider, verify_tls12_signature, verify_tls13_signature},
    pki_types::{CertificateDer, ServerName, UnixTime},
};
use sha2::{Digest, Sha256};
use tokio::net::TcpStream;
use tokio_tungstenite::{
    Connector, MaybeTlsStream, WebSocketStream, connect_async_tls_with_config,
    tungstenite::{Message, client::IntoClientRequest, protocol::WebSocketConfig},
};
use tracing::{debug, warn};

use crate::config::Config;

/// Wraps a `WebSocketStream` so callers don't care about TLS vs plaintext.
pub type WsStream = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// Dial + TLS handshake + WebSocket upgrade. Returns a ready `WsStream`.
pub async fn connect(cfg: &Config) -> Result<WsStream> {
    let request = cfg
        .server_url
        .as_str()
        .into_client_request()
        .with_context(|| format!("malformed server_url {:?}", cfg.server_url))?;

    let connector = build_connector(cfg)?;
    let ws_config = WebSocketConfig::default();
    let (ws, _resp) =
        connect_async_tls_with_config(request, Some(ws_config), false, connector).await?;
    Ok(ws)
}

fn build_connector(cfg: &Config) -> Result<Option<Connector>> {
    if !cfg.server_url.starts_with("wss://") {
        warn!(
            "connecting to {} without TLS — ok for tests, not for prod",
            cfg.server_url
        );
        return Ok(None);
    }

    let provider = Arc::new(default_provider());
    let pinned = cfg.normalised_fingerprint();

    // Load roots into a store we own.
    let mut roots = RootCertStore::empty();
    if let Some(path) = cfg.trust_ca_path.as_deref() {
        load_ca_from_path(&mut roots, path)
            .with_context(|| format!("load CA at {path:?}"))?;
    } else {
        roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        if pinned.is_none() {
            warn!("no trust_ca_path AND no cert pin — TLS uses public roots only");
        }
    }
    let roots = Arc::new(roots);

    let client_config = if let Some(pin) = pinned {
        let verifier = Arc::new(PinningVerifier::new(Arc::clone(&roots), Arc::clone(&provider), pin)?);
        rustls::ClientConfig::builder_with_provider(Arc::clone(&provider))
            .with_safe_default_protocol_versions()
            .context("default tls protocol versions")?
            .dangerous()
            .with_custom_certificate_verifier(verifier)
            .with_no_client_auth()
    } else {
        rustls::ClientConfig::builder_with_provider(Arc::clone(&provider))
            .with_safe_default_protocol_versions()
            .context("default tls protocol versions")?
            .with_root_certificates(Arc::try_unwrap(roots).unwrap_or_else(|a| (*a).clone()))
            .with_no_client_auth()
    };

    Ok(Some(Connector::Rustls(Arc::new(client_config))))
}

fn load_ca_from_path(roots: &mut RootCertStore, path: &Path) -> Result<()> {
    let pem = fs::read(path)?;
    let mut reader = std::io::Cursor::new(pem);
    for cert in rustls_pemfile::certs(&mut reader) {
        let cert = cert?;
        roots.add(cert).map_err(|e| anyhow!("add CA cert: {e}"))?;
    }
    Ok(())
}

/// SHA-256 hex of the DER bytes — used for pinning.
#[must_use]
pub fn fingerprint_sha256(der: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(der);
    hex::encode(h.finalize())
}

/// Custom verifier: standard webpki chain check, then leaf-cert SHA-256 pin.
#[derive(Debug)]
struct PinningVerifier {
    inner: Arc<rustls::client::WebPkiServerVerifier>,
    pin: String,
    provider: Arc<CryptoProvider>,
}

impl PinningVerifier {
    fn new(roots: Arc<RootCertStore>, provider: Arc<CryptoProvider>, pin: String) -> Result<Self> {
        let inner = rustls::client::WebPkiServerVerifier::builder_with_provider(roots, Arc::clone(&provider))
            .build()
            .map_err(|e| anyhow!("build webpki verifier: {e}"))?;
        Ok(Self { inner, pin, provider })
    }
}

impl ServerCertVerifier for PinningVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        server_name: &ServerName<'_>,
        ocsp: &[u8],
        now: UnixTime,
    ) -> std::result::Result<ServerCertVerified, rustls::Error> {
        self.inner
            .verify_server_cert(end_entity, intermediates, server_name, ocsp, now)
            .map_err(|e| rustls::Error::General(format!("CA chain verification failed: {e}")))?;

        let actual = fingerprint_sha256(end_entity.as_ref());
        if actual != self.pin {
            debug!(actual = %actual, pin = %self.pin, "cert pin mismatch");
            return Err(rustls::Error::General(format!(
                "server cert SHA256 mismatch: pinned={} actual={}",
                self.pin, actual
            )));
        }
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> std::result::Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls12_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> std::result::Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls13_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider
            .signature_verification_algorithms
            .supported_schemes()
    }
}

/// Thin wrapper around `SinkExt::send` so callers can drop the stream-trait
/// import noise.
pub async fn send_text(ws: &mut WsStream, payload: impl Into<String>) -> Result<()> {
    ws.send(Message::Text(payload.into().into())).await?;
    Ok(())
}

/// Best-effort graceful close.
pub async fn close(mut ws: WsStream) {
    let _ = ws.close(None).await;
}

/// Drain the next text frame. Skips pings/pongs (auto-handled by tungstenite),
/// returns `None` on end-of-stream.
pub async fn recv_text(ws: &mut WsStream) -> Result<Option<String>> {
    while let Some(msg) = ws.next().await {
        match msg? {
            Message::Text(t) => return Ok(Some(t.to_string())),
            Message::Binary(_) => bail!("agent does not accept binary frames"),
            Message::Close(_) => return Ok(None),
            Message::Ping(_) | Message::Pong(_) | Message::Frame(_) => continue,
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fingerprint_is_lowercase_hex_64() {
        let f = fingerprint_sha256(b"hello world");
        assert_eq!(f.len(), 64);
        assert!(f.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
        assert_eq!(
            f,
            "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"
        );
    }

    #[test]
    fn plaintext_url_disables_tls() {
        let mut c = Config::default();
        c.server_url = "ws://127.0.0.1:8088/agent/ws".into();
        let connector = build_connector(&c).unwrap();
        assert!(connector.is_none());
    }

    #[test]
    fn pin_with_webpki_roots_compiles() {
        // wss + pin set → both pins are non-empty and config build succeeds.
        let mut c = Config::default();
        c.server_url = "wss://example.com/agent/ws".into();
        c.server_cert_fingerprint =
            "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff".into();
        let connector = build_connector(&c).unwrap();
        assert!(matches!(connector, Some(Connector::Rustls(_))));
    }
}
