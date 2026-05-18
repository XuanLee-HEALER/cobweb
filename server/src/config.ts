// Environment-driven config + path constants. Anchored to the repo root via
// import.meta.dir so paths resolve identically regardless of where bun starts.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

function defaultCliPath(): string {
  if (process.platform === "win32") {
    const userProfile = process.env.USERPROFILE ?? "C:\\Users\\Default";
    return `${userProfile}\\bin\\easytier\\easytier-cli.exe`;
  }
  return "/usr/local/bin/easytier-cli";
}

// ── runtime ────────────────────────────────────────────────────────────

export const RPC = process.env.ET_RPC ?? "127.0.0.1:15888";
export const PORT = Number(process.env.PORT ?? 8088);
export const HOST = process.env.HOST ?? "127.0.0.1";
export const CLI = process.env.ET_CLI ?? defaultCliPath();
export const SAMPLE_INTERVAL_MS = Number(process.env.SAMPLE_INTERVAL_MS ?? 5000);
export const HISTORY_LEN = Number(process.env.HISTORY_LEN ?? 720);

// ── filesystem paths ───────────────────────────────────────────────────

const SERVER_SRC = import.meta.dir;
export const REPO_ROOT = join(SERVER_SRC, "..", "..");
export const DIST = join(REPO_ROOT, "dashboard", "dist");
export const NODES_FILE = join(REPO_ROOT, "nodes.json");
export const KEY_PATH = join(REPO_ROOT, "etmesh-id_ed25519");
export const KEY_PUB_PATH = `${KEY_PATH}.pub`;
export const REMOTE_KEY_NAME = "etmesh-id_ed25519";

// ── mesh fence + tag markers ───────────────────────────────────────────

export const FENCE_BEGIN = "# etmesh BEGIN (managed by dashboard, do not edit)";
export const FENCE_END = "# etmesh END";
export const AUTHORIZED_KEYS_TAG = "etmesh-managed";

// ── DNS dispatch (per-domain DNS to aliyun CoreDNS) ────────────────────

export const DNS_FENCE_BEGIN = "# etmesh-dns BEGIN (managed by dashboard)";
export const DNS_FENCE_END = "# etmesh-dns END";
export const DNS_SERVER_IP = process.env.DNS_SERVER_IP ?? "10.177.0.1";
export const DNS_DOMAIN = process.env.DNS_DOMAIN ?? "lan";
export const DNS_TEST_HOST = process.env.DNS_TEST_HOST ?? "archmbp.lan";
export const DNS_EXPECTED_IP = process.env.DNS_EXPECTED_IP ?? "10.177.0.6";
export const DNS_NRPT_TAG = "etmesh-managed";

// ── WSS for agent + dashboard (impl-plan §3.4) ─────────────────────────
//
// TLS is mandatory. Both the dashboard https vhost and the /agent/ws upgrade
// share the same Bun.serve listener, so they share one cert + key. The agent
// additionally verifies the peer cert pin (see impl-plan §3.2); the dashboard
// uses the normal CA chain check against `etmesh-ca` (or whatever public CA
// signs the leaf once cobweb runs on the open internet).
//
// Plaintext was tolerated in v0 to flatten the dev onramp; with cobweb moving
// toward public-internet etmesh hub use the loose option is now a footgun.
// Production refuses to start without a cert; an explicit env escape hatch
// (`COBWEB_ALLOW_PLAINTEXT=1`) keeps `just dev` working without forcing every
// contributor to mint a self-signed cert before they can `bun run`.

export const SERVER_CERT_PATH = process.env.SERVER_CERT_PATH ?? "";
export const SERVER_KEY_PATH = process.env.SERVER_KEY_PATH ?? "";
export const ALLOW_PLAINTEXT = process.env.COBWEB_ALLOW_PLAINTEXT === "1";

/** Returns the Bun TLS option object, or `undefined` only when the caller
 *  has explicitly opted into plaintext via `COBWEB_ALLOW_PLAINTEXT=1`.
 *  Otherwise a missing / unreadable cert is a hard error — the process
 *  exits non-zero so systemd / CI / docker-compose surface the failure
 *  instead of silently shipping an unencrypted hub. */
export function loadTlsCertificate(): { cert: string; key: string } | undefined {
  if (!SERVER_CERT_PATH || !SERVER_KEY_PATH) {
    if (ALLOW_PLAINTEXT) {
      console.warn("COBWEB_ALLOW_PLAINTEXT=1 — running without TLS. Never use this in production.");
      return undefined;
    }
    console.error(
      "cobweb: SERVER_CERT_PATH and SERVER_KEY_PATH must both be set (TLS is mandatory).",
    );
    console.error(
      "       Set COBWEB_ALLOW_PLAINTEXT=1 only for local development against a non-public hub.",
    );
    process.exit(1);
  }
  if (!existsSync(SERVER_CERT_PATH) || !existsSync(SERVER_KEY_PATH)) {
    console.error(
      `cobweb: TLS env set but file missing — cert=${SERVER_CERT_PATH} key=${SERVER_KEY_PATH}`,
    );
    process.exit(1);
  }
  return {
    cert: readFileSync(SERVER_CERT_PATH, "utf8"),
    key: readFileSync(SERVER_KEY_PATH, "utf8"),
  };
}

// ── Trust CA distribution ──────────────────────────────────────────────

export const CA_CACHE_PATH = join(REPO_ROOT, "etmesh-ca.crt");
export const CA_REMOTE_NODE = process.env.CA_REMOTE_NODE ?? "archmbp";
// step-ca's root cert lives in an etmesh-pki ConfigMap, served raw PEM (no
// base64 wrapper, unlike the legacy cert-manager Secret it replaced).
export const CA_KUBECTL_CMD =
  process.env.CA_KUBECTL_CMD ??
  "kubectl -n etmesh-pki get cm step-ca-step-certificates-certs -o jsonpath='{.data.root_ca\\.crt}'";
export const CA_REMOTE_FILENAME = "etmesh-root-ca.crt";
export const CA_CN = "etmesh-root-ca";

// ── static file mime map ───────────────────────────────────────────────

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

export function mimeFor(path: string): string {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return "application/octet-stream";
  return MIME[path.slice(dot)] ?? "application/octet-stream";
}
