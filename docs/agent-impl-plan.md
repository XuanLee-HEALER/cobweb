# cobweb-agent 实施计划

> 本文档是 [`agent-design.md`](agent-design.md) 的实施层补遗。
> Design.md 讲架构(why / what),本文讲工程细节(how)+ 文件级实施顺序。
>
> **取代关系**:本文 §3 (TLS) 取代 design.md §2 中"EasyTier 加密足够,无需 TLS"的判断 ——
> 改为强制 WSS + 私网自签 CA + cert pinning。其余冲突点在各节内显式标注。

---

## 一、连接生命周期与自愈

### 1.1 状态机

```
            ┌──── start ────┐
            ▼               │ retry
       Connecting           │   (exponential backoff + jitter)
            │ ws_open       │
            ▼               │
        Authenticating ─────┘ ws_close / auth_fail
            │ hello_ack
            ▼
         Connected ────────────────┐  ws_error / ping_timeout / app_hb_miss
            │                      │
            │ shutdown sig         │
            ▼                      ▼
         Stopping              Reconnecting ──┐
            │                      │          │
            ▼                      └── back to Connecting
          Stopped
```

具体状态语义:
- **Connecting**:DNS / TCP / TLS / WS handshake 进行中
- **Authenticating**:WS 已开,等 hello ack 或第一条 server-driven 消息
- **Connected**:正常工作,heartbeat 流转
- **Reconnecting**:等 backoff timer;不发任何消息;新 collector 数据进 replay buffer
- **Stopping**:收到 SIGTERM / `shutdown` 消息;flush 后退出
- **Stopped**:进程退出(systemd 决定是否拉起)

### 1.2 两层心跳

| 层 | 周期 | 触发 | 含义 |
|---|---|---|---|
| WebSocket Ping/Pong (RFC 6455) | 15s | tokio-tungstenite 自动 | TCP+TLS 路径活着 |
| 应用层 `heartbeat` 消息 | 10s | agent 主动 push | server-side 进程在听,且能 deserialize |

任一层超过 `interval × 3` 没动静 → 视为 Connected → Reconnecting。

**为什么两层**:WS Ping 在 TCP/TLS 层,LB / proxy 中间任一段挂了就掉。应用层 heartbeat 验证 server 进程**真的在 schedule 上**(没卡死在 GC、deadlock、磁盘忙)。

### 1.3 Reconnect backoff

```rust
let attempt = 0..;
let delay_ms = min(60_000, 1000 * 2u64.pow(min(attempt, 6) as u32));
let jitter = rand::random::<f32>() * 0.3 * (delay_ms as f32);
let actual = delay_ms + jitter as u64;
```

序列:`~1s, ~2s, ~4s, ~8s, ~16s, ~32s, ~60s, ~60s, …`,加 0~30% 抖动避免多 agent 同时重连雪崩。**永不放弃**。

### 1.4 死亡确认

为了避免短暂网络抖动触发 buffer / 用户告警,引入 **dead threshold**:
- 连续 **3 次** reconnect 失败(总耗时约 7 秒)→ 标记 server 进入 `unreachable` 状态
- 此时 collectors 写入的事件进入 replay buffer(见 §2)
- 第一次成功 reconnect → 标记 `recovering`,flush replay → 完成后标记 `connected`

**对比设计 doc §6**:更细化。design.md 只说"重连同 backoff 策略",没区分"短暂抖动" vs "服务端真的挂了"。

---

## 二、Replay Buffer

**与你的设计的区别**:你的方案是"断线后开窗,慢窗淘汰,连上关窗"。我推荐**始终开 ring**,理由:

| 维度 | 你的方案(状态化窗口) | 我的方案(始终开 ring) |
|---|---|---|
| 内存 | 断线时增长,连接时空 | 恒定上限 |
| 触发逻辑 | "确认断线" 是一个时间窗判断,有边界 case | 无判断,常驻 |
| 代码复杂度 | 高(开/关窗状态、转换、并发) | 低(append-only ring) |
| Connected 时性能开销 | 0(buffer 不工作) | 极低(写 ring,server 也消费) |
| Server 重启场景 | 需要严谨边界判断 | 自然处理(连上后 replay) |
| 实现风险 | "什么时候关窗"是个坑(连上但还没完成 handover 就 push 新数据怎么办?) | 不存在 |

**待你拍板**。下文按"始终开 ring"写;如果你坚持 windowed,我们改实现细节但其余设计可复用。

### 2.1 Ring 容量

每种事件独立 ring,policy 不同:

| 事件 type | Ring 大小 | 淘汰 | 重连时 replay? |
|---|---|---|---|
| `heartbeat` | 1(只留最新) | 覆盖 | ❌ server 不关心历史心跳 |
| `event {kind: "peer_view"}` | 60(5 分钟 @ 5s) | FIFO | ✅ 作为 history burst |
| `event {kind: "service_state"}` | 32 | FIFO | ✅ 服务挂过的事件不能丢 |
| `event {kind: "config_change"}` | 32 | FIFO | ✅ |
| `exec.stdout/stderr/exit` | per-task,无上限**直到** task 完成或超 1 MiB | 见 §4 backpressure | 复杂(见下) |
| `file.put.progress` | 不 buffer(发送时无意义) | — | ❌ |
| `cli.result`、`file.get.result` | 不 buffer | — | ❌ |

**关于 in-flight 任务**:`exec` / `file_put` / `file_get` 这些是 request-driven 的;agent 重新连接时:
- 单连接 in-flight 任务的输出可能堆积,但请求方(server)那边的请求记录已经在断线时被标 aborted
- 因此 hello 之后**直接丢弃所有 in-flight task 的 ring buffer**(连同 task_id 一并清空)
- 这跟 design.md §6 "所有 in-flight task 立即标记 aborted" 一致

### 2.2 Handover 协议

重连成功 → 发 hello → 收 server ack → 进入 `Recovering` 状态:

1. agent 发 `replay.start { since: <last_acked_ts>, count: <total_pending> }`
2. 把每个 ring 里的事件依次 push(保持顺序,带原始 ts)
3. 发 `replay.end { count: <pushed> }`
4. 转入 `Connected`,collectors 直接向 ws 写(不再走 ring)

Server 看到 `replay.*` 消息知道这是 backlog,展示时打上"恢复"标记(或就跟实时数据一样处理 —— 它们都有 ts)。

### 2.3 内存上限

总内存预算:**8 MiB**(可配)。各 ring 折算字节数累计,超阈值时丢弃**最低优先级**事件(peer_view 比 service_state 低)。

---

## 三、TLS(WSS + 私网自签 CA)

**取代 design.md §2**:mesh 加密不够 —— 一来 EasyTier 自身可能有 0day,二来运维上 WSS 给 agent / server 解耦提供保险。

### 3.1 信任链

| 角色 | 持有 | 来源 |
|---|---|---|
| Cobweb CA (root) | `etmesh-ca.crt` 私钥 | 你已有的 cert-manager 内 CA |
| Server cert | `server.crt` + `server.key` | CA 签发,SAN 含 mesh IP `10.177.0.1` |
| Agent | 内置 CA 公钥(编译时 embed)+ pin server cert SHA256 | 见 3.2 |

### 3.2 Agent 端校验(双重)

```rust
// 1. 用 embed 的 CA 校验证书链(常规 TLS)
let ca = include_bytes!("../certs/cobweb-ca.pem");
let mut root_store = RootCertStore::empty();
root_store.add_parsable_certificates(rustls_pemfile::certs(&mut &ca[..])?);

// 2. 在 TLS handshake 完成后,额外校验 server cert SHA256
//    pin 在 agent 配置里(每次 CA 滚证需要更新 agent)
let pinned_sha256 = config.server_cert_fingerprint;  // "ab12..."
let actual_sha256 = sha256(connection.peer_certificate()?);
if actual_sha256 != pinned_sha256 {
    return Err(anyhow!("cert pin mismatch"));
}
```

**为什么 pin 而不是只靠 CA**:CA 私钥泄露的话,有人能签新 cert 冒充 server。pin 让冒充失效 —— 需要同时拿到 CA 私钥**和**修改 agent 二进制。

### 3.3 证书轮换

| 场景 | 步骤 |
|---|---|
| Server cert 滚证(常规) | 1) 签新 cert,SHA256 更新 agent config;2) 用旧 agent push 新 config + 新 binary(如果 fingerprint 在 binary 里);3) `systemctl restart cobweb-agent` |
| CA 轮换(极少) | 1) 新 CA 签 server cert;2) build 新 agent binary(embed 新 CA);3) SSH bootstrap 通道重装所有 agent;4) 切 server cert |

CA 私钥泄露 = 全员重装(SSH bootstrap 的核心价值)。

### 3.4 server 侧

- Bun.serve 支持 `tls: { cert, key }` —— 启动时读 `SERVER_CERT_PATH` / `SERVER_KEY_PATH` env var
- `server_url` agent 端从 `ws://` 改成 `wss://10.177.0.1:8089/agent/ws`(或同一 8088 端口的 https 升级,看部署)

---

## 四、Exec 能力详细规范

### 4.1 进程模型

- `tokio::process::Command`
- 每个 `exec.start` 起一个独立 process
- 父-子进程组(POSIX setsid / Windows job object),便于"杀整组"
- root / SYSTEM 权限(agent 本身就是 root)—— 子进程**默认继承**,允许 caller 通过 `user: "lixuan"` 字段降权(POSIX setuid;Win 用 CreateProcessAsUser,复杂,P1)

### 4.2 Streaming 与 Backpressure

```
                  ┌── stdout pipe ──┐
   child process ─┤                 ├── tokio mpsc(bounded 256 messages)
                  └── stderr pipe ──┘                       │
                                                            ▼
                                              ws.send(exec.stdout/stderr)
```

**Backpressure 规则**(关键设计):
- mpsc buffer 满 → `read.next()` 暂停(自然反压)
- pipe buffer 满 → child write() 阻塞(OS 层反压)
- **不丢数据,不无限缓冲**;ws 慢 = child 慢

如果 child 必须以 best-effort 速率跑(不能阻塞它),caller 在 `exec.start` 里加 `mode: "lossy"`,agent 改用 unbounded mpsc + ring 截断旧数据;**默认不开**。

### 4.3 信号跨平台抽象

协议 `exec.signal` 字段:

```jsonc
{ "type": "exec.signal", "task_id": "...", "signal": "interrupt" }
```

| 协议名 | POSIX | Windows |
|---|---|---|
| `interrupt` | SIGINT (Ctrl-C) | GenerateConsoleCtrlEvent CTRL_C_EVENT |
| `terminate` | SIGTERM | TerminateProcess (no graceful) |
| `kill` | SIGKILL | TerminateProcess(同上) |
| `quit` | SIGQUIT | 无对应 → 退化为 terminate |
| `usr1` / `usr2` | SIGUSR1 / SIGUSR2 | 不支持 → return error |

Windows 上 `interrupt` 需要 child 跟 agent **共享 console**;若 spawn 时未给 console 则只能 terminate。

### 4.4 其它字段

`exec.start` 完整 payload:
```jsonc
{
  "type": "exec.start",
  "task_id": "...",
  "argv": ["bash", "-c", "..."],   // 或 ["powershell.exe", "-NoProfile", "-Command", "..."]
  "cwd": "/var/lib/cobweb",        // optional
  "env": { "FOO": "bar" },         // optional, merged with agent env
  "user": null,                    // null = root; "lixuan" = setuid
  "timeout_ms": 60000,             // optional, agent kills after; null = no timeout
  "stdin": null,                   // optional, string sent before close
  "mode": "default"                // "default" | "lossy"
}
```

### 4.5 Shell 选择

- 默认 **不通过 shell**(`argv[0]` 直接是 binary)
- 若 caller 想用 shell,自己组 `["sh", "-c", "echo $HOME"]` / `["pwsh", "-NoProfile", "-Command", "..."]`
- agent 不做 shell substitution(避免注入)

---

## 五、File 能力详细规范

### 5.1 上传(file.put)消息流

```
server                                              agent
  │                                                  │
  ├─ file.put.start {task_id, path, mode,            │
  │    size, sha256, compression: "gzip",            │
  │    chunk_size: 65536} ───────────────────────────▶│
  │                                                  ├─ open <path>.tmp
  │                                                  │  decompressor init
  │                                                  │
  ├─ file.put.chunk {task_id, seq: 0,                │
  │    data: <base64>} ──────────────────────────────▶│ verify seq, decompress,
  │                                                  │  write, update sha256
  │   …                                              │
  │                                                  │  rate-limit token bucket
  │                                                  │
  ├─ file.put.end {task_id} ─────────────────────────▶│ final sha256 check
  │                                                  │  fsync
  │                                                  │  rename .tmp → path
  │                                                  │  chmod mode
  │                                                  │
  │◀────────── file.put.done {task_id, ok, error?}   │
```

### 5.2 字段细节

- `chunk_size`:协议建议 64 KiB,server 可下调到 4 KiB(慢链路)或上调到 1 MiB(快链路)
- `compression`:`"none"` | `"gzip"` | `"zstd"`。默认 `"none"`;对 size > 4 KiB 的 binary 文件 server 自行选 `"gzip"`
- `sha256`:整文件 hex sha256,agent 在 `file.put.end` 时校验
- `mode`:Unix mode bits(`0o755` 等);Windows 忽略

### 5.3 限速

agent 维护一个 **token bucket**(默认 10 MB/s,可配):
- 每接收一个 `file.put.chunk` 先 acquire 等量 token
- token 不够时延迟 ack/处理(由 ws 反压自然减缓 server 发送)

**注意**:限速在接收端,不在发送端 —— 因为 agent 是受控端,server 不需要节流自己。

### 5.4 校验 + 原子写

```
1. 接收时累积 streaming sha256(每 chunk update)
2. file.put.end 收到 → 比对 sha256
   - 不匹配 → 删除 .tmp,回 file.put.done {ok: false, error: "sha256 mismatch"}
3. fsync(fd)  ← 确保数据落盘
4. rename(.tmp → path)  ← 原子(同分区)
5. chmod path mode
6. 回 file.put.done {ok: true}
```

systemd 把 systemd-tmpfiles 这种工具就这么做的 —— rename 是 POSIX 原子操作,避免半写文件。

### 5.5 下载(file.get)

小文件(< 1 MiB)用 design.md §3 已有的 `file.get` request 一次返。大文件以后再加 `file.get.stream`(对称 chunked)。**初版不实现 stream-get**。

---

## 六、协议消息扩展(对 design.md §3 的增量)

### 新加 Server → Agent

| type | 关联 | 新增字段 |
|---|---|---|
| `replay.ack` | — | server 确认 backlog 已消费,可清 ring |

### 新加 Agent → Server

| type | 关联 | 新增字段 |
|---|---|---|
| `replay.start` | — | `since: ts`, `count: N` |
| `replay.end` | — | `count: N` |

### 字段更新

- `exec.start`:加 `cwd, env, user, timeout_ms, stdin, mode`(见 §4.4)
- `file.put.start`:加 `sha256, compression, chunk_size`(见 §5.2)
- `file.put.chunk`:加 `seq`
- `file.put.done`:已有

---

## 七、文件级实施顺序

按依赖拓扑排,**每步独立可测**:

### 阶段 A — 基础设施(没这些后续什么都跑不了)

| # | 文件 | 内容 | 测试 |
|---|---|---|---|
| 1 | `src/protocol.rs` | 所有 message enum(serde tagged) + Hello / Replay | `cargo test` round-trip serde |
| 2 | `src/config.rs` | toml + env + clap;`server_url / log_level / cert_fingerprint / rate_limit_bps` | unit |
| 3 | `src/transport.rs` | tokio-tungstenite + rustls + cert pin verifier | integration:连一个 dummy wss server |
| 4 | `src/connection.rs` | 状态机 + reconnect backoff + 两层 heartbeat | unit (mocked transport) |
| 5 | `src/buffer.rs` | per-event-type ring + priority eviction | unit |

### 阶段 B — Capabilities(按 design.md MVP 优先级)

| # | 文件 | 内容 | 测试 |
|---|---|---|---|
| 6 | `src/dispatcher.rs` | inbound message → capability handler 路由 | unit (各 handler 用 stub) |
| 7 | `src/capabilities/cli.rs` | `easytier-cli` 子进程包装 | 实测调本机 cli |
| 8 | `src/capabilities/exec.rs` | tokio::process + streaming + signal + bp | integration(spawn `sleep`、`echo` etc) |
| 9 | `src/capabilities/file.rs` | chunk + sha256 + compress + token bucket + rename | unit + integration |

### 阶段 C — 隐式 collectors

| # | 文件 | 内容 |
|---|---|---|
| 10 | `src/collectors/heartbeat.rs` | 每 10s 采 mem/cpu/uptime push |
| 11 | `src/collectors/peer_view.rs` | 每 5s 跑 `easytier-cli peer` push |

### 阶段 D — 服务化

| # | 文件 | 内容 |
|---|---|---|
| 12 | `service-installers/systemd/cobweb-agent.service` | unit 文件 |
| 13 | `service-installers/launchd/com.cobweb.agent.plist` | macOS launchd |
| 14 | `service-installers/windows/install.ps1` | sc create + 启动 |

### 阶段 E — Server 侧适配

| # | 文件 | 内容 |
|---|---|---|
| 15 | `server/src/agent-registry.ts` | `agents: Map<peer_id, AgentConnection>` |
| 16 | `server/src/routes.ts` | `app.get('/agent/ws', upgradeWebSocket(...))` |
| 17 | `server/src/cert.ts` | 读取 server.crt + server.key,wss 启动 |
| 18 | 把 dashboard `/api/agents` endpoint 真填上 |

### 阶段 F — Bootstrap 集成(分发中心新 capability)

| # | 内容 |
|---|---|
| 19 | dashboard 分发中心加 "agent install" 能力(走 SSH 通道) |
| 20 | server `/api/mesh/agent/install` endpoint:sftp put 二进制 + ssh exec systemctl |

---

## 八、待你拍板(下个 session 实施前确认)

| # | 决策点 | 我的推荐 | 备选 |
|---|---|---|---|
| 1 | Buffer 策略 | **始终开 ring**(§2 表格) | windowed(你原方案) |
| 2 | TLS pinning | **要 pin server cert SHA256**(§3.2) | 只信 CA 不 pin |
| 3 | Exec backpressure | **bounded mpsc 自然反压**(§4.2) | unbounded + lossy 默认 |
| 4 | File 默认压缩 | **size > 4 KiB 默认 gzip**(§5.2) | 默认 none,caller 显式开 |
| 5 | Server-side WSS port | **跟 dashboard 同 8088,/agent/ws 走 wss upgrade** | 独立端口(8089) |
| 6 | Cert distribution | **embed CA 进 agent binary**(§3.1) | 文件 + 路径(每次重启读) |

确认后下个 session 一开始按 §7 实施顺序填代码即可。

---

## 九、跟 design.md 的关系总结

- design.md = 架构 / why(动机)/ what(能力列表)/ 跟 SSH 的关系
- impl-plan.md(本文) = how(具体怎么做)/ 取代 design.md §2 的 TLS 决策
- 实施时:照 §7 顺序写文件,每步对照 design.md 看是否符合架构意图
- 完成后 design.md 第 13 节"待决策"可删除(本文已全部回答)
