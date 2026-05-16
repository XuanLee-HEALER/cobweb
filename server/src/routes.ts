// Hono route definitions. Single chained `app` so its inferred type can be
// exported (AppType) for the dashboard's `hc<AppType>` typed client.

import { existsSync, statSync } from "node:fs";
import { join, normalize } from "node:path";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { agentInstallApply } from "./agent-install";
import { agents } from "./agent-registry";
import { caApply, caStatus } from "./ca";
import { DIST, DNS_DOMAIN, mimeFor } from "./config";
import { dnsApply, dnsStatus } from "./dns";
import { cli, type NodeInfo, type PeerCenterEntry, type PeerRaw, type StatRaw } from "./easytier";
import { loadNodes, meshApply, meshInitKeys, meshStatus } from "./mesh";
import { events, latestPeerCenter, type Sample, samples } from "./sampler";
import { applyLogsToTaskResult, tasks } from "./tasks";

// ── static + SPA fallback ─────────────────────────────────────────────

function safeStaticPath(urlPath: string): string | null {
  let rel = urlPath === "/" ? "/index.html" : urlPath;
  rel = rel.split("?")[0]!;
  const full = normalize(join(DIST, rel));
  if (!full.startsWith(DIST)) return null;
  if (!existsSync(full)) return null;
  if (!statSync(full).isFile()) return null;
  return full;
}

// ── app ───────────────────────────────────────────────────────────────

const app = new Hono()
  // Global error trap — handlers may throw freely; we project to JSON 500.
  .onError((e, c) => c.json({ error: String(e) }, 500))

  // ── local easytier RPC mirrors ─────────────────────────────────
  .get("/api/peers", async (c) => c.json(await cli<PeerRaw[]>(["peer"])))
  .get("/api/peer-center", async (c) => c.json(await cli<PeerCenterEntry[]>(["peer-center"])))
  .get("/api/peer-center/cached", (c) => c.json(latestPeerCenter))
  .get("/api/stats", async (c) => c.json(await cli<StatRaw[]>(["stats"])))
  .get("/api/route", async (c) => c.json(await cli<unknown>(["route"])))
  .get("/api/node-info", async (c) => c.json(await cli<NodeInfo>(["node", "info"])))
  .get("/api/history", (c) => c.json(samples))

  // ── mesh management (uses nodes.json + ssh) ────────────────────
  .get("/api/mesh/nodes", (c) => c.json(loadNodes()))
  .get("/api/mesh/status", async (c) => c.json(await meshStatus()))
  .post("/api/mesh/init-keys", async (c) => {
    const force = c.req.query("force") === "1";
    return c.json(await meshInitKeys(force));
  })

  // ── distribute apply endpoints (sync; return TaskResult) ───────
  .post("/api/mesh/apply", async (c) => {
    const t = Date.now();
    const { logs } = await meshApply();
    return c.json(applyLogsToTaskResult("SSH key + mesh ssh · apply", logs, t));
  })
  .get("/api/mesh/dns/status", async (c) => c.json(await dnsStatus()))
  .post("/api/mesh/dns/apply", async (c) => {
    const t = Date.now();
    const { logs } = await dnsApply();
    return c.json(applyLogsToTaskResult(`DNS 设置 · ${DNS_DOMAIN}`, logs, t));
  })
  .post("/api/mesh/agent/install", async (c) => {
    const t = Date.now();
    const body = (await c.req.json().catch(() => null)) as { onlyNodes?: string[] } | null;
    const { logs } = await agentInstallApply(body ?? {});
    return c.json(applyLogsToTaskResult(`cobweb-agent · 安装 / 升级`, logs, t));
  })
  .get("/api/mesh/ca/status", async (c) => c.json(await caStatus()))
  .post("/api/mesh/ca/apply", async (c) => {
    const t = Date.now();
    const { logs, sha256 } = await caApply();
    return c.json(applyLogsToTaskResult(`CA 信任根分发 · ${sha256.slice(0, 12)}…`, logs, t));
  })

  // ── task store ─────────────────────────────────────────────────
  .get("/api/tasks", (c) => c.json(tasks))
  .get("/api/tasks/:id", (c) => {
    const id = c.req.param("id");
    const t = tasks.find((x) => x.id === id);
    if (!t) return c.json({ error: "task not found" }, 404);
    return c.json(t);
  })

  // ── cobweb-agent registry (live + recently offline) ────────────
  .get("/api/agents", (c) => c.json(agents.list()))
  .post("/api/agents/:peerId/cli", async (c) => {
    const peerId = c.req.param("peerId");
    const body = (await c.req.json().catch(() => null)) as {
      args?: string[];
      request_id?: string;
    } | null;
    if (!body || !Array.isArray(body.args)) {
      return c.json({ error: "expected { args: string[] }" }, 400);
    }
    const requestId = body.request_id ?? crypto.randomUUID();
    const ok = agents.send(peerId, {
      type: "cli.invoke",
      request_id: requestId,
      args: body.args,
      json_output: true,
    });
    if (!ok) return c.json({ error: "agent offline" }, 404);
    return c.json({ ok: true, request_id: requestId });
  })

  // ── SSE: pushes peer-center + samples whenever they refresh ────
  .get("/api/stream", (c) =>
    streamSSE(c, async (stream) => {
      // initial snapshot — send last known peer-center and the full history
      // window so the client can paint without waiting for the next sample.
      if (latestPeerCenter.length > 0) {
        await stream.writeSSE({ event: "peer-center", data: JSON.stringify(latestPeerCenter) });
      }
      await stream.writeSSE({ event: "history", data: JSON.stringify(samples) });

      const onSample = (s: Sample) =>
        stream.writeSSE({ event: "sample", data: JSON.stringify(s) }).catch(() => {});
      const onPc = (pc: PeerCenterEntry[]) =>
        stream.writeSSE({ event: "peer-center", data: JSON.stringify(pc) }).catch(() => {});
      events.on("sample", onSample);
      events.on("peer-center", onPc);
      stream.onAbort(() => {
        events.off("sample", onSample);
        events.off("peer-center", onPc);
      });

      // keep open until the client aborts
      while (!stream.aborted) await stream.sleep(60_000);
    }),
  )

  // ── static + SPA fallback (production) ─────────────────────────
  .get("*", (c) => {
    const url = new URL(c.req.url);
    const filePath = safeStaticPath(url.pathname);
    if (filePath)
      return new Response(Bun.file(filePath), {
        headers: { "Content-Type": mimeFor(filePath) },
      });
    const fallback = safeStaticPath("/index.html");
    if (fallback)
      return new Response(Bun.file(fallback), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    return c.text("not found", 404);
  });

export const cobwebApp = app;
export type AppType = typeof app;
