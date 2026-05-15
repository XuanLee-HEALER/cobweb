# cobweb 技术方案

## 一句话

Bun + Hono 做后端,Svelte 5 + Vite 做 SPA 前端,通过 Hono RPC 实现前后端类型贯通。不走 SSR,本质上是前后端分离架构。

## 选型理由

| 层 | 选择 | 替换的旧方案 | 为什么 |
|---|---|---|---|
| Runtime | Bun | (保留) | 已用,native TS、内置 spawn/serve、SQLite 都够用 |
| Server framework | Hono | `Bun.serve` + 手写路由 map | 中间件、SSE、WS、type-safe RPC 都是开箱即用 |
| API 类型贯通 | Hono RPC (`hc<typeof app>`) | (新增) | 后端 endpoint 改动前端立刻飘红,zod schema 跨端共享 |
| 前端框架 | Svelte 5 | (保留) | 已用、设计系统是 pure CSS 不绑框架、不需要换 |
| 构建 | Vite | (保留) | 现状不变 |
| UI 样式 | 自有设计系统(pure CSS) | ad-hoc CSS | 已规划 |
| 持久化 | `bun:sqlite` | 当前仅 `nodes.json` | 任务历史/审计/分发中心元数据需要 |
| 实时推送 | Hono `streamSSE` | 5s 前端轮询 | 后端 sampler 本来就在 5s 跑,直接推 |

## 架构形状

```
┌─────────────────── browser ───────────────────┐
│ Svelte SPA(dist/)                              │
│   ├─ pure CSS 设计系统                          │
│   ├─ hono/client (hc<AppType>) ─── 类型 ──┐    │
│   └─ EventSource → /api/stream             │   │
└─────────────────┬──────────────────────────│───┘
                  │ HTTP / SSE              │
┌─────────────────┴──────────────────────────┴───┐
│ Bun + Hono(server.ts)                          │
│  ├─ /api/* (chained app,export type AppType)  │
│  ├─ static dist/                                │
│  ├─ SSE: sampler → 客户端推送                   │
│  ├─ sqlite: 任务历史 / 节点状态缓存              │
│  └─ 调用 easytier-cli + ssh/sftp                │
└─────────────────────────────────────────────────┘
```

## 类型贯通的具体写法

**后端必须 chained 写法**(否则 TS 推断会塌成 `any`):

```ts
// server.ts
import { Hono } from "hono"
import { zValidator } from "@hono/zod-validator"
import { z } from "zod"

const app = new Hono()
  .get("/api/peers", async (c) => c.json(await cli<PeerRaw[]>(["peer"])))
  .get("/api/history", (c) => c.json(samples))
  .get("/api/mesh/status", async (c) => c.json(await meshStatus()))
  .post(
    "/api/mesh/init-keys",
    zValidator("query", z.object({ force: z.coerce.boolean().optional() })),
    async (c) => c.json(await meshInitKeys(c.req.valid("query").force ?? false)),
  )
  .post("/api/mesh/apply", async (c) => c.json(await meshApply()))
  // ...

export type AppType = typeof app

export default { port: PORT, hostname: HOST, fetch: app.fetch }
```

**前端 client**:

```ts
// src/lib/api.ts
import { hc } from "hono/client"
import type { AppType } from "../../server"

export const api = hc<AppType>("/")
```

**调用**(类型自动推断):

```ts
const peers = await (await api.api.peers.$get()).json()
//    ^^^^^ 自动是 PeerRaw[]

await api.api.mesh["init-keys"].$post({ query: { force: true } })
//                                    ^^^^^^^^^^^^^^^^^^^^^^^^^ query 类型受 zod schema 校验
```

## 多文件组织

当 server.ts 变大,**子路由也必须保持 chained**:

```ts
// routes/mesh.ts
export const meshRoutes = new Hono()
  .get("/status", ...)
  .post("/apply", ...)
  .post("/init-keys", zValidator(...), ...)

// server.ts
const app = new Hono()
  .route("/api/mesh", meshRoutes)
  .route("/api/dns", dnsRoutes)
  // ...
export type AppType = typeof app
```

子 app 内部任何一行掉链,该路由的前端类型就退化为 `any`,不会编译报错,需要靠规范保证。

## SSE 推送

`samples[]` 已经是后端唯一数据源,把"前端拉历史 + 持续推增量"组合起来:

```ts
.get("/api/stream", (c) => streamSSE(c, async (stream) => {
  await stream.writeSSE({ event: "snapshot", data: JSON.stringify(samples) })
  const unsub = onNewSample((s) => stream.writeSSE({ event: "sample", data: JSON.stringify(s) }))
  await stream.close()  // client disconnect 时
  unsub()
}))
```

`sampleLoop()` 需要从直接 push 数组改成 EventEmitter 模式,所有订阅者(SSE 连接)都收到新 sample。

## 不做 SSR 的理由备忘

- 私网内部工具,首屏 1s 内即可,无需 server render
- 监控页是 long-lived stream,SSR 给 hydration 添麻烦不解决问题
- 类型贯通的需求通过 Hono RPC 完全满足,不需要 SSR 框架
- 配置/管理类页面在 SPA 里就是普通 form submit + JSON 响应,也不需要 SSR

## 部署

仍然单进程:`bun server.ts`,服务静态 `dist/` + API + SSE 三合一。systemd unit 跟现在一致。
