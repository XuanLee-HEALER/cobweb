//! `file.*` capability — see `docs/agent-impl-plan.md` §5.
//!
//! ## Upload (`file.put`)
//! Server streams `file.put.{start,chunk(+seq),end}`. Agent:
//!   1. checks `<incoming>/<hash(path)>.tmp` + `.meta` for resumable state
//!   2. emits `file.put.ack {resume_from}` (0 = fresh, N = next seq to send)
//!   3. decodes each `data` (base64), optionally `gzip`-inflates, writes to
//!      `.tmp` while accumulating sha256
//!   4. on `file.put.end`: verify sha256, fsync, rename, chmod, drop `.meta`
//!
//! ## Download (`file.get`)
//! Server sends `file.get.start {path, range_from, …}`. Agent:
//!   1. stats the file, computes sha256, emits `file.get.ack {size, sha256, …}`
//!   2. streams `file.get.chunk {seq, data}` with optional gzip
//!   3. emits `file.get.end`
//!
//! ## Rate limiting
//! Token bucket (`TokenBucket`): per-byte budget consumed on every chunk
//! processed. When empty the producer awaits replenishment — natural
//! back-pressure into the rest of the pipeline.

use std::{
    io::Write,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

use anyhow::{Context, Result, anyhow, bail};
use base64::{Engine, prelude::BASE64_STANDARD};
use flate2::{Compression as GzCompression, write::GzEncoder, write::GzDecoder};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::{
    fs as afs,
    io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt},
    sync::Mutex,
};

use crate::protocol::{Compression, FileGetStart, FilePutStart};

const META_FLUSH_INTERVAL_BYTES: u64 = 256 * 1024;
/// Per-event budget protecting from absurd `data` payloads.
const MAX_CHUNK_BYTES: usize = 8 * 1024 * 1024;

// ── token bucket ──────────────────────────────────────────────────────

/// Simple time-based token bucket. Async; awaits replenishment when starved.
#[derive(Debug)]
pub struct TokenBucket {
    inner: Mutex<TokenInner>,
    capacity: u64,
    rate_bps: u64,
}

#[derive(Debug)]
struct TokenInner {
    tokens: f64,
    last: Instant,
}

impl TokenBucket {
    /// Build a bucket. `rate_bps == 0` disables the limit (free pass).
    #[must_use]
    pub fn new(rate_bps: u64) -> Self {
        let capacity = rate_bps.max(64 * 1024); // burst at least 64 KiB
        Self {
            inner: Mutex::new(TokenInner {
                tokens: capacity as f64,
                last: Instant::now(),
            }),
            capacity,
            rate_bps,
        }
    }

    /// Acquire `n` tokens, sleeping as needed.
    pub async fn acquire(&self, n: u64) {
        if self.rate_bps == 0 {
            return;
        }
        loop {
            let wait = {
                let mut g = self.inner.lock().await;
                let now = Instant::now();
                let elapsed = now.duration_since(g.last).as_secs_f64();
                g.tokens = (g.tokens + elapsed * self.rate_bps as f64).min(self.capacity as f64);
                g.last = now;
                if g.tokens >= n as f64 {
                    g.tokens -= n as f64;
                    return;
                }
                let deficit = n as f64 - g.tokens;
                let secs = deficit / self.rate_bps as f64;
                Duration::from_secs_f64(secs.max(0.01))
            };
            tokio::time::sleep(wait).await;
        }
    }
}

// ── put session ───────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PutMeta {
    task_id: String,
    sha256: String,
    size: u64,
    chunk_size: u32,
    compression: Compression,
    last_seq: i64, // -1 = nothing yet
    last_seq_ts: u64,
    started_at: u64,
    target_path: PathBuf,
    mode: Option<u32>,
}

/// Live state of an in-progress upload.
pub struct PutSession {
    pub task_id: String,
    pub target: PathBuf,
    pub tmp: PathBuf,
    pub meta_path: PathBuf,
    pub meta: PutMeta,
    pub hasher: Sha256,
    pub bytes_written: u64,
    pub bytes_since_meta_flush: u64,
    pub bucket: std::sync::Arc<TokenBucket>,
}

impl PutSession {
    /// Resume or initialise. Returns `resume_from` (seq of next chunk).
    pub async fn open(
        start: &FilePutStart,
        incoming_dir: &Path,
        bucket: std::sync::Arc<TokenBucket>,
    ) -> Result<(Self, u32)> {
        afs::create_dir_all(incoming_dir).await?;
        let stem = path_stem(&start.path);
        let tmp = incoming_dir.join(format!("{stem}.tmp"));
        let meta_path = incoming_dir.join(format!("{stem}.tmp.meta"));

        // Try resume.
        let (meta, resume_from, hasher, bytes_written) = match read_meta(&meta_path).await {
            Ok(m)
                if m.sha256 == start.sha256
                    && m.size == start.size
                    && m.chunk_size == start.chunk_size
                    && m.compression == start.compression =>
            {
                // re-hash what we already have on disk
                let (h, len) = hash_existing(&tmp).await.unwrap_or_default();
                if len == 0 {
                    (m, 0, Sha256::new(), 0)
                } else if i64::try_from(seq_from_offset(len, m.chunk_size)).unwrap_or(0) - 1
                    == m.last_seq
                {
                    let next_seq = u32::try_from(m.last_seq.saturating_add(1).max(0))
                        .unwrap_or(u32::MAX);
                    (m, next_seq, h, len)
                } else {
                    // .tmp / .meta drifted — truncate to meta-known length.
                    let len = (m.last_seq.saturating_add(1).max(0) as u64)
                        * u64::from(m.chunk_size);
                    let _ = afs::OpenOptions::new()
                        .write(true)
                        .open(&tmp)
                        .await?
                        .set_len(len)
                        .await;
                    let (h, _l) = hash_existing(&tmp).await.unwrap_or_default();
                    let next_seq = u32::try_from(m.last_seq.saturating_add(1).max(0))
                        .unwrap_or(u32::MAX);
                    (m, next_seq, h, len)
                }
            }
            _ => {
                let _ = afs::remove_file(&tmp).await;
                let _ = afs::remove_file(&meta_path).await;
                let m = PutMeta {
                    task_id: start.task_id.clone(),
                    sha256: start.sha256.clone(),
                    size: start.size,
                    chunk_size: start.chunk_size,
                    compression: start.compression,
                    last_seq: -1,
                    last_seq_ts: crate::protocol::now_ms(),
                    started_at: crate::protocol::now_ms(),
                    target_path: PathBuf::from(&start.path),
                    mode: start.mode,
                };
                write_meta(&meta_path, &m).await?;
                // Touch .tmp.
                afs::File::create(&tmp).await?;
                (m, 0, Sha256::new(), 0)
            }
        };

        Ok((
            Self {
                task_id: start.task_id.clone(),
                target: PathBuf::from(&start.path),
                tmp,
                meta_path,
                meta,
                hasher,
                bytes_written,
                bytes_since_meta_flush: 0,
                bucket,
            },
            resume_from,
        ))
    }

    /// Decode + decompress + write a single chunk. `seq` is informational.
    pub async fn write_chunk(&mut self, seq: u32, b64: &str) -> Result<()> {
        let raw = BASE64_STANDARD
            .decode(b64.as_bytes())
            .context("file.put.chunk: base64 decode")?;
        if raw.len() > MAX_CHUNK_BYTES {
            bail!("file.put.chunk: payload {} > max", raw.len());
        }
        let bytes = match self.meta.compression {
            Compression::None => raw,
            Compression::Gzip => decompress_gzip(&raw)?,
        };
        let len = bytes.len();
        self.bucket.acquire(len as u64).await;

        let mut f = afs::OpenOptions::new().append(true).open(&self.tmp).await?;
        f.write_all(&bytes).await?;
        f.flush().await?;
        self.hasher.update(&bytes);
        self.bytes_written += len as u64;
        self.bytes_since_meta_flush += len as u64;

        self.meta.last_seq = i64::from(seq);
        self.meta.last_seq_ts = crate::protocol::now_ms();
        if self.bytes_since_meta_flush >= META_FLUSH_INTERVAL_BYTES {
            write_meta(&self.meta_path, &self.meta).await?;
            self.bytes_since_meta_flush = 0;
        }
        Ok(())
    }

    /// Finalise: hash check, fsync, rename, chmod, delete meta.
    pub async fn finish(self) -> Result<()> {
        let actual = hex::encode(self.hasher.finalize());
        if actual != self.meta.sha256 {
            let _ = afs::remove_file(&self.tmp).await;
            let _ = afs::remove_file(&self.meta_path).await;
            bail!(
                "sha256 mismatch: expected={} actual={}",
                self.meta.sha256,
                actual
            );
        }
        if self.bytes_written != self.meta.size {
            let _ = afs::remove_file(&self.tmp).await;
            let _ = afs::remove_file(&self.meta_path).await;
            bail!(
                "size mismatch: expected={} actual={}",
                self.meta.size,
                self.bytes_written
            );
        }

        // fsync + atomic rename. On Windows fs::rename will replace dest
        // if it exists (since rust 1.5).
        let f = afs::OpenOptions::new().write(true).open(&self.tmp).await?;
        f.sync_all().await.ok();
        drop(f);

        if let Some(parent) = self.target.parent() {
            if !parent.as_os_str().is_empty() {
                afs::create_dir_all(parent).await.ok();
            }
        }
        match afs::rename(&self.tmp, &self.target).await {
            Ok(()) => {}
            Err(_) => {
                // cross-device fallback — copy+remove.
                let bytes = afs::read(&self.tmp).await?;
                afs::write(&self.target, &bytes).await?;
                let _ = afs::remove_file(&self.tmp).await;
                tracing::warn!(target=?self.target, "cross-device rename — used copy+unlink");
            }
        }

        #[cfg(unix)]
        if let Some(mode) = self.meta.mode {
            use std::os::unix::fs::PermissionsExt;
            let mut p = afs::metadata(&self.target).await?.permissions();
            p.set_mode(mode);
            afs::set_permissions(&self.target, p).await.ok();
        }
        #[cfg(windows)]
        let _ = self.meta.mode; // ignored

        let _ = afs::remove_file(&self.meta_path).await;
        Ok(())
    }
}

async fn read_meta(p: &Path) -> Result<PutMeta> {
    let raw = afs::read_to_string(p).await?;
    Ok(serde_json::from_str(&raw)?)
}

async fn write_meta(p: &Path, m: &PutMeta) -> Result<()> {
    let raw = serde_json::to_string(m)?;
    afs::write(p, raw).await?;
    Ok(())
}

async fn hash_existing(p: &Path) -> Result<(Sha256, u64)> {
    let mut f = afs::File::open(p).await?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    let mut total = 0u64;
    loop {
        let n = f.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
        total += n as u64;
    }
    Ok((h, total))
}

fn seq_from_offset(offset: u64, chunk_size: u32) -> u64 {
    if chunk_size == 0 {
        0
    } else {
        offset / u64::from(chunk_size)
    }
}

fn decompress_gzip(data: &[u8]) -> Result<Vec<u8>> {
    let mut out = Vec::with_capacity(data.len());
    {
        let mut dec = GzDecoder::new(&mut out);
        dec.write_all(data)
            .map_err(|e| anyhow!("gzip decode: {e}"))?;
        dec.finish().map_err(|e| anyhow!("gzip finish: {e}"))?;
    }
    Ok(out)
}

fn compress_gzip(data: &[u8]) -> Result<Vec<u8>> {
    let mut enc = GzEncoder::new(Vec::with_capacity(data.len()), GzCompression::default());
    enc.write_all(data)?;
    Ok(enc.finish()?)
}

fn path_stem(path: &str) -> String {
    let mut h = Sha256::new();
    h.update(path.as_bytes());
    hex::encode(&h.finalize()[..8])
}

// ── get-session helpers ───────────────────────────────────────────────

/// Result of opening a get session: metadata to emit in `file.get.ack`.
pub struct GetMeta {
    pub size: u64,
    pub sha256: String,
    pub compression: Compression,
}

/// Stat + hash the file; decide compression heuristically.
pub async fn open_get(start: &FileGetStart) -> Result<(GetMeta, PathBuf)> {
    let path = PathBuf::from(&start.path);
    let meta = afs::metadata(&path).await?;
    if !meta.is_file() {
        bail!("not a file: {:?}", path);
    }
    let size = meta.len();
    let (hasher, _) = hash_existing(&path).await?;
    let sha256 = hex::encode(hasher.finalize());
    if let Some(expected) = start.sha256.as_deref() {
        if expected != sha256 {
            bail!("file changed during transfer (sha256 mismatch)");
        }
    }
    let compression = match start.prefer_compression {
        Compression::None => Compression::None,
        Compression::Gzip => {
            if size > 4 * 1024 {
                Compression::Gzip
            } else {
                Compression::None
            }
        }
    };
    Ok((
        GetMeta {
            size,
            sha256,
            compression,
        },
        path,
    ))
}

/// Streaming `read_chunk` — returns base64-encoded (compressed?) chunk for `seq`.
pub async fn read_chunk(
    path: &Path,
    seq: u32,
    chunk_size: u32,
    compression: Compression,
    bucket: &TokenBucket,
) -> Result<Option<String>> {
    let mut f = afs::File::open(path).await?;
    let offset = u64::from(seq) * u64::from(chunk_size);
    f.seek(std::io::SeekFrom::Start(offset)).await?;
    let mut buf = vec![0u8; chunk_size as usize];
    let mut filled = 0usize;
    while filled < buf.len() {
        let n = f.read(&mut buf[filled..]).await?;
        if n == 0 {
            break;
        }
        filled += n;
    }
    if filled == 0 {
        return Ok(None);
    }
    buf.truncate(filled);
    bucket.acquire(filled as u64).await;
    let bytes = match compression {
        Compression::None => buf,
        Compression::Gzip => compress_gzip(&buf)?,
    };
    Ok(Some(BASE64_STANDARD.encode(&bytes)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use tempfile::TempDir;

    fn mk_start(path: &str, payload: &[u8], chunk_size: u32, compression: Compression) -> FilePutStart {
        let mut h = Sha256::new();
        h.update(payload);
        FilePutStart {
            task_id: "tput".into(),
            path: path.into(),
            mode: Some(0o644),
            size: payload.len() as u64,
            sha256: hex::encode(h.finalize()),
            compression,
            chunk_size,
        }
    }

    #[tokio::test]
    async fn put_fresh_writes_correct_file() {
        let dir = TempDir::new().unwrap();
        let incoming = dir.path().join("incoming");
        let target = dir.path().join("dest.bin");
        let payload = b"hello cobweb file capability!";
        let chunk_size = 8u32;

        let start = mk_start(target.to_str().unwrap(), payload, chunk_size, Compression::None);
        let bucket = Arc::new(TokenBucket::new(0));

        let (mut sess, resume_from) =
            PutSession::open(&start, &incoming, bucket.clone()).await.unwrap();
        assert_eq!(resume_from, 0);

        // Slice payload into chunks and feed them in.
        let mut seq = 0u32;
        for chunk in payload.chunks(chunk_size as usize) {
            let b64 = BASE64_STANDARD.encode(chunk);
            sess.write_chunk(seq, &b64).await.unwrap();
            seq += 1;
        }
        sess.finish().await.unwrap();

        let got = std::fs::read(&target).unwrap();
        assert_eq!(got, payload);
    }

    #[tokio::test]
    async fn put_resume_from_existing_tmp() {
        let dir = TempDir::new().unwrap();
        let incoming = dir.path().join("incoming");
        let target = dir.path().join("dest.bin");
        let payload: Vec<u8> = (0..32u8).collect();
        let chunk_size = 4u32;

        let start = mk_start(target.to_str().unwrap(), &payload, chunk_size, Compression::None);
        let bucket = Arc::new(TokenBucket::new(0));

        // Open a session, push half, drop without finish.
        {
            let (mut sess, _) =
                PutSession::open(&start, &incoming, bucket.clone()).await.unwrap();
            for (i, chunk) in payload.chunks(chunk_size as usize).enumerate().take(4) {
                sess.write_chunk(i as u32, &BASE64_STANDARD.encode(chunk))
                    .await
                    .unwrap();
            }
            // force a meta flush
            write_meta(&sess.meta_path, &sess.meta).await.unwrap();
        }

        // Re-open with same start — should resume at seq 4.
        let (mut sess, resume_from) =
            PutSession::open(&start, &incoming, bucket.clone()).await.unwrap();
        assert_eq!(resume_from, 4);

        for (i, chunk) in payload.chunks(chunk_size as usize).enumerate().skip(4) {
            sess.write_chunk(i as u32, &BASE64_STANDARD.encode(chunk))
                .await
                .unwrap();
        }
        sess.finish().await.unwrap();
        let got = std::fs::read(&target).unwrap();
        assert_eq!(got, payload);
    }

    #[tokio::test]
    async fn put_sha_mismatch_aborts() {
        let dir = TempDir::new().unwrap();
        let incoming = dir.path().join("incoming");
        let target = dir.path().join("dest.bin");
        let payload = b"abc";
        let mut start = mk_start(target.to_str().unwrap(), payload, 16, Compression::None);
        start.sha256 = "deadbeef".repeat(8); // wrong

        let bucket = Arc::new(TokenBucket::new(0));
        let (mut sess, _) =
            PutSession::open(&start, &incoming, bucket).await.unwrap();
        sess.write_chunk(0, &BASE64_STANDARD.encode(payload)).await.unwrap();
        let err = sess.finish().await.unwrap_err();
        assert!(err.to_string().contains("sha256 mismatch"));
        assert!(!target.exists());
    }

    #[tokio::test]
    async fn put_gzip_round_trip() {
        let dir = TempDir::new().unwrap();
        let incoming = dir.path().join("incoming");
        let target = dir.path().join("z.bin");
        let payload = b"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".repeat(8);
        let raw = payload.clone();
        let start = mk_start(
            target.to_str().unwrap(),
            &raw,
            64,
            Compression::Gzip,
        );

        let bucket = Arc::new(TokenBucket::new(0));
        let (mut sess, _) = PutSession::open(&start, &incoming, bucket).await.unwrap();
        // One gzipped chunk
        let gz = compress_gzip(&raw).unwrap();
        sess.write_chunk(0, &BASE64_STANDARD.encode(&gz)).await.unwrap();
        sess.finish().await.unwrap();

        let got = std::fs::read(&target).unwrap();
        assert_eq!(got, raw);
    }

    #[tokio::test]
    async fn token_bucket_blocks_when_starved() {
        let bucket = TokenBucket::new(64 * 1024); // 64 KiB/s
        let started = Instant::now();
        // 192 KiB → ~3s but bucket has 64 KiB capacity instantly, then 2 more
        // seconds to fill.
        for _ in 0..3 {
            bucket.acquire(64 * 1024).await;
        }
        let elapsed = started.elapsed();
        assert!(elapsed >= Duration::from_secs(1), "elapsed={:?}", elapsed);
    }

    #[tokio::test]
    async fn get_reads_and_chunks() {
        let dir = TempDir::new().unwrap();
        let src = dir.path().join("src.bin");
        let payload: Vec<u8> = (0..20u8).collect();
        std::fs::write(&src, &payload).unwrap();

        let start = FileGetStart {
            task_id: "g1".into(),
            path: src.to_string_lossy().into_owned(),
            range_from: 0,
            range_to: None,
            chunk_size: 8,
            prefer_compression: Compression::None,
            sha256: None,
        };
        let (meta, path) = open_get(&start).await.unwrap();
        assert_eq!(meta.size, payload.len() as u64);

        let bucket = TokenBucket::new(0);
        let mut got = Vec::new();
        for seq in 0..10u32 {
            match read_chunk(&path, seq, 8, meta.compression, &bucket).await.unwrap() {
                Some(b64) => got.extend(BASE64_STANDARD.decode(b64.as_bytes()).unwrap()),
                None => break,
            }
        }
        assert_eq!(got, payload);
    }
}
