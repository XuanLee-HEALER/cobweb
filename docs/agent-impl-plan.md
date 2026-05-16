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

**决策**:始终开 ring(不是状态化窗口)。理由见 §8 决策记录。

### 2.1 双路设计:有重放价值的事件走 ring,request 响应直发

只有**主动 push 的 collector 事件**走 ring(它们有"事后看到"的价值)。
`exec.stdout` / `file.put.chunk` / `cli.result` 这些 **request-driven 响应**
不走 ring,直接 ws —— 它们绑 task_id,断线即 abort,重放也没人收。

```
                            ┌─ ring (per-event type) ─┐
                            │                         │
collector ────push (always)─┤                         ├──consume──▶ ws.send()
                            └─────────────────────────┘     ▲
                                                            │ disconnected:
                                                            │   consumer 等
                                                            │ reconnected:
                                                            │   先 flush ring,
                                                            │   再正常消费

request handler (exec / file / cli)
        │
        └────────────────────────────────────────────────▶ ws.send()  (直接)
```

**Producer 写 ring 总是成功**(若满则淘汰最旧)。 **Consumer 只在 Connected
状态消费**(disconnected 时 ring 自然堆积到上限)。当 ws 写慢时,
consumer 自然停在 `ws.send().await`,producer 继续往 ring 写、ring 自然淘汰
—— 全链路反压由 ring 容量兜底,不会 OOM。

### 2.2 Ring 容量与淘汰策略

每种事件独立 ring,policy 不同:

| 事件 type | 走 ring? | Ring 大小 | 淘汰 | Replay 时发? |
|---|---|---|---|---|
| `heartbeat` | ✅ | 1(只留最新) | 覆盖 | ✅(只发最后一条) |
| `event {kind: "peer_view"}` | ✅ | 60(5 分钟 @ 5s) | FIFO | ✅ 作为 history burst |
| `event {kind: "service_state"}` | ✅ | 32 | FIFO | ✅ 服务挂过的事件不能丢 |
| `event {kind: "config_change"}` | ✅ | 32 | FIFO | ✅ |
| `exec.stdout` / `exec.stderr` / `exec.exit` | ❌ 直接 ws | — | — | — |
| `file.put.chunk` 类 (sender) | ❌ 直接 ws | — | — | — |
| `file.put.progress` | ❌ 直接 ws | — | — | — |
| `cli.result` / `file.get.result` | ❌ 直接 ws | — | — | — |

**关于 in-flight 任务在断线时**:request-driven 响应不走 ring,所以
断线那一刻在途中的 chunk / output 直接丢。**重连后 task 视为 aborted**,
server 端会重发 / 用户重试(`file.put` 还支持断点续传,见 §5)。

### 2.3 Handover 协议

重连成功 → 发 hello → 收 server ack → 进入 `Recovering`:

1. agent 发 `replay.start { since: <last_acked_ts>, count: <total_pending> }`
2. 把每个 ring 里的事件依次 push(保持顺序,带原始 ts)
3. 发 `replay.end { count: <pushed> }`
4. 收到 `replay.ack` → 清空 ring 已 replay 部分(避免 server 再重启再发一遍)
5. 转入 `Connected`;collectors 继续 push 到 ring(consumer 此后立刻消费,
   稳态等价于"直发",但代码路径不变)

Server 看到 `replay.*` 消息知道这是 backlog,展示时打上"恢复"标记
(或就跟实时数据一样处理 —— 它们都有 ts)。

### 2.4 内存上限

总内存预算:**8 MiB**(可配)。各 ring 折算字节数累计,超阈值时
**优先级淘汰**:`peer_view` < `heartbeat` < `config_change` < `service_state`。
单条事件 > 256 KiB 拒绝入 ring(应该是 bug,记日志丢弃)。

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
- **同端口 8088**:cobweb 后端从 http 升级到 https,dashboard `wss://` 跟
  agent `wss://10.177.0.1:8088/agent/ws` 共用端口
- 滚证:重启 `bun src/index.ts`(冷启动 < 200ms,可接受);不做 SIGHUP 热加载
- TLS 在 mesh 之上是双重加密 —— 接受这个 CPU 开销换 mesh 0day 的护栏 + 未来
  开源可上公网 etmesh 的安全保证

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

**v1 范围(全部)**:put + get 都是 chunked streaming + 断点续传 + 压缩 + 限速 + sha256 + 原子写。

### 5.1 上传(file.put)消息流

```
server                                              agent
  │                                                  │
  ├─ file.put.start {task_id, path, mode,            │
  │    size, sha256, compression, chunk_size}────────▶│  ┌─ 检查 <path>.tmp + .meta:
  │                                                  │  │  若 sha256 + size + chunk_size
  │                                                  │  │  全部匹配 → resume
  │                                                  │  │  否则 → fresh
  │                                                  │  │
  │◀── file.put.ack {task_id, resume_from: N}        │  │  N = 0(fresh) 或 last_acked_seq + 1
  │                                                  │  └─
  │  for seq in [resume_from..]:                     │
  ├─ file.put.chunk {task_id, seq, data: <b64>} ─────▶│  decompress → write → sha256 update
  │                                                  │  rate-limit (token bucket)
  │                                                  │  每 N 个 chunk(或每 256 KiB)
  │                                                  │  flush .meta { last_seq, ... }
  │                                                  │
  ├─ file.put.end {task_id} ─────────────────────────▶│  final sha256 check
  │                                                  │  fsync
  │                                                  │  rename .tmp → path
  │                                                  │  chmod mode
  │                                                  │  delete .meta
  │                                                  │
  │◀────────── file.put.done {task_id, ok, error?}   │
```

### 5.2 断点续传机制(关键)

resume 关键点:**agent 持久化 `.tmp` + `.meta`**,server 不需要任何状态。
重连或 server 重启后,server 再次发 `file.put.start`,agent 上报"已经收到哪里了",
server 从下一个 seq 继续发。

**Agent 持久化的 .meta 内容**(JSON,在 `.tmp` 同目录):
```jsonc
{
  "task_id": "...",        // info only, 不参与匹配
  "sha256": "ab12...",     // 完整文件预期 sha256
  "size": 12345678,
  "chunk_size": 65536,
  "compression": "gzip",
  "last_seq": 31,          // 已写入 .tmp 的最高 seq(从 0 开始)
  "last_seq_ts": 1715810400000,
  "started_at": 1715810000000
}
```

**Resume 匹配规则**(agent 收到 `file.put.start`):
1. 计算 `<path>.tmp` + `<path>.tmp.meta` 是否存在
2. 若 .meta 的 `(sha256, size, chunk_size, compression)` **全部**等于新 start 的字段 → resume,`resume_from = last_seq + 1`
3. 否则 → 删 .tmp + .meta,`resume_from = 0`
4. 发 `file.put.ack { resume_from }`

**Server 收到 ack 后**:
- 若 `resume_from == 0` → 从头发 chunks
- 若 `resume_from > 0` → 从 `seq = resume_from` 开始发,内存里 seek 到对应 byte offset

**.meta 何时持久化**:
- 每收满 256 KiB(4 个默认 chunk)flush 一次,降低 IOPS
- ws 连接断开前的最后一次写,做 best-effort fsync(异步)
- crash 容忍:即使 .meta 落后实际 .tmp 几个 chunk,resume 时 agent 把 .tmp truncate
  回 `last_seq * chunk_size`(或重算 sha256 验证一致后,以小的为准)

**.tmp 生命周期**:
- 完成 → rename 走、.meta 删
- 不完成且 24 小时无更新 → agent 启动时扫描 + GC(可配 TTL)
- agent 卸载 → systemd preremove hook 清扫 `/var/lib/cobweb-agent/incoming/`

**默认存储位置**(避免污染目标目录,处理 symlink / overlayfs 怪事):
- POSIX: `/var/lib/cobweb-agent/incoming/<hash(path)>.tmp` + `.meta`
- Windows: `%ProgramData%\cobweb-agent\incoming\<hash>.tmp`
- 最终 rename 时跨设备,fall back 到 copy + unlink(自动处理,但记 warn 日志)

### 5.3 下载(file.get)消息流

镜像 put,但**资源在 agent 侧**,server 决定 range:

```
server                                              agent
  │                                                  │
  ├─ file.get.start {task_id, path,                  │
  │    range_from: 0, range_to: null,                │
  │    chunk_size: 65536, prefer_compression: "gzip"}▶│  stat file, open
  │                                                  │
  │◀── file.get.ack {task_id, size, sha256,          │  reads + compresses
  │    compression: "gzip"} ──────────────────────────│  (or "none" if file
  │                                                  │   ≤ 4 KiB / 已是压缩格式)
  │  for seq in [range_from / chunk_size ..]:        │
  │◀── file.get.chunk {task_id, seq, data: <b64>}    │
  │                                                  │  rate-limit (token bucket)
  │   …                                              │
  │◀── file.get.end {task_id}                        │
  │                                                  │
  ├─ file.get.ack-end {task_id, ok, error?} ─────────▶│  release fd
```

**Resume(get 方向)**:server 持有"已收 byte 数"和**完整文件 sha256**(从首次
`file.get.ack` 缓存)。重连后 server 重发 `file.get.start { range_from: <last_byte + 1>,
sha256: <expected> }`;agent 验证 sha256 跟当前文件一致(防止文件被改了)
→ 一致就 seek 到 byte offset 继续读;不一致就 `ack { error: "file changed during transfer" }`,
server 决定全量重传或放弃。

### 5.4 压缩协商

| 决策 | 默认 |
|---|---|
| Sender 默认开 | size > 4 KiB → `gzip`;否则 `none` |
| Receiver 行为 | 默认**inline 解压**写到目标(`compression` 仅描述 wire 格式) |
| 跳过解压(passthrough) | sender 直接传 `compression: "none"` 写原始字节 —— 例如上传一个本身就是 `.tar.gz` 的归档,不让 agent 解开 |
| 算法 | v1 只 `none` + `gzip`;`zstd` 留接口位 |

### 5.5 限速(token bucket,接收端)

agent 维护一个 **token bucket**(默认 10 MB/s,配置项 `rate_limit_bps`):
- 写入 .tmp 之前 acquire `chunk_size` token
- token 不够 → 阻塞 chunk handler → ws 自然反压 → server 减缓发送
- 对 get 方向同理:agent 读 + 发送时 acquire token

**注意**:put 限速在 agent(接收端)是为了控制 agent 写盘节奏;get 限速在 agent
(发送端)是为了控制 agent 读盘 + ws 出口带宽。两个方向都是 agent 主导。

### 5.6 校验 + 原子写(put 完成)

```
1. file.put.end 收到 → finalize streaming sha256 → 比对 expected
   - 不匹配 → 删除 .tmp + .meta,回 file.put.done {ok: false, error: "sha256 mismatch"}
2. fsync(fd)          ← 数据落盘
3. rename(.tmp → path) ← 原子(同分区);跨设备时 copy+unlink + warn
4. chmod path mode    ← Unix only,Windows 忽略 mode
5. delete .meta
6. 回 file.put.done {ok: true}
```

`rename` 是 POSIX 原子操作 —— systemctl restart 之类的进程不会拿到半写文件。

---

## 六、协议消息扩展(对 design.md §3 的增量)

### 新加 Server → Agent

| type | 关联 | 字段 | 用途 |
|---|---|---|---|
| `replay.ack` | — | `up_to: ts` | server 确认 backlog 已消费,可清 ring |
| `file.put.chunk` | task_id | `seq: u32`(新增,加在原 chunk 上) | 续传定位 |
| `file.get.start` | task_id | `path, range_from, range_to?, chunk_size, prefer_compression` | streaming get 发起 |

### 新加 Agent → Server

| type | 关联 | 字段 | 用途 |
|---|---|---|---|
| `replay.start` | — | `since: ts`, `count: N` | replay 序列开始 |
| `replay.end` | — | `count: N` | replay 序列结束 |
| `file.put.ack` | task_id | `resume_from: u32` | 告诉 server 从哪个 seq 继续(0 = 全新) |
| `file.get.ack` | task_id | `size, sha256, compression` | get 响应:元信息 |
| `file.get.chunk` | task_id | `seq, data` | get 流式数据 |
| `file.get.end` | task_id | — | get 流式结束 |

### 字段更新

- `exec.start`:加 `cwd, env, user, timeout_ms, stdin, mode`(见 §4.4)
- `file.put.start`:加 `sha256, size, compression, chunk_size`(见 §5.2)
- `file.put.chunk`:加 `seq: u32`
- `file.put.end`:已有
- `file.put.done`:已有

### 完整 v1 协议消息汇总

> 加粗 = v1 新增 / 增强;其余沿用 design.md §3

**Server → Agent**:
hello-ack, cli.invoke, exec.{start, signal, stdin}, **file.put.{start, chunk(+seq), end}**,
**file.get.start**, replay.ack, shutdown
> v2+:event.subscribe, log.subscribe/unsubscribe, pty.*

**Agent → Server**:
hello, heartbeat, replay.{start, end}, cli.result,
exec.{stdout, stderr, exit}, **file.put.{ack, done}**,
**file.get.{ack, chunk, end}**, event(peer_view / service_state / config_change),
error
> v2+:log.line/end, pty.output/exit, file.get(small,one-shot — 被 streaming 取代)

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

## 八、决策记录(已定版)

| # | 决策点 | 选择 | 出处 |
|---|---|---|---|
| 1 | Buffer 策略 | **始终开 ring**;有重放价值的事件走 ring,request 响应直发 ws | §2.1 |
| 2 | TLS pinning | **CA 信任 + cert SHA256 pin 双层**(为开源 / 上公网 etmesh 留余地) | §3.2 |
| 3 | Exec backpressure | **bounded mpsc 自然反压**;`mode: "lossy"` 是显式开关 | §4.2 |
| 4 | File 压缩默认 | **发送端 size > 4 KiB 默认 gzip**;接收端默认 inline 解压;passthrough 用 `compression: "none"` | §5.4 |
| 5 | Server-side WSS port | **同 8088**;dashboard https + agent wss 共用;冷启动重启即滚证 | §3.4 |
| 6 | Cert distribution | **CA 编译进 agent binary**;滚 CA = 全员 SSH 重装 | §3.1 |
| 7 | File 断点续传 + 流式 get | **v1 必做**;put 用 `.tmp + .meta` sidecar;get 用 `range_from + 完整 sha256` 验证 | §5.2 §5.3 |

---

## 九、跟 design.md 的关系总结

- `agent-design.md` = 架构 / why(动机)/ what(能力列表)/ 跟 SSH 的关系
- `agent-impl-plan.md`(本文) = how(具体怎么做)/ 已对 §8 全部决策定版
- 实施时:照 §7 顺序写文件,每步对照 design.md 看是否符合架构意图
- design.md 第 2 节(TLS 决策)和第 13 节(待决策列表)被本文 §3 / §8 取代,
  下次架构 review 时可以一并清掉
