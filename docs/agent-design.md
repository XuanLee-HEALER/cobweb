# cobweb-agent 设计

> 节点侧的常驻进程。承担**高频结构化数据采集** + **事件 push** + **长连接能力**(日志 tail、PTY 转发)。SSH 通道继续保留,负责 bootstrap(装/升级 agent)、紧急救援、低频一次性操作。Agent 是 SSH 之上的"稳态优化层",不是替代。

---

## 一、命名与定位

- **二进制名**:`cobweb-agent`(对外、systemd unit、日志归属一目了然)
- **代号**:agent(本文档简称)
- **不是**:不是采集器、不是 sidecar、不是 LSP-like proxy —— 是一个**节点侧的能力执行器**,被 cobweb 后端远程驱动
- **不暴露给最终用户** —— 用户感知的是 cobweb dashboard,agent 是它的延伸

---

## 二、通信架构

```
┌──── managed node (linux/macos/windows) ────┐
│  easytier-core ─── RPC 127.0.0.1:15888     │
│        ▲                                    │
│        │ cli/local RPC                      │
│  cobweb-agent ─────WebSocket(出向)────┐    │
└────────────────────────────────────────│────┘
                                         │ over mesh
                                         ▼
                            ┌──── cobweb host ────┐
                            │  bun + hono         │
                            │  /agent/ws (mesh IP)│
                            │     ▲               │
                            │     │ N 路并发      │
                            │  agents 注册表       │
                            └─────────────────────┘
```

**已经确定的三个核心决策**:

1. **反连**:agent 启动后主动 dial cobweb 的 WebSocket,长连接保持。cobweb 不主动连 agent。NAT 后的节点也能加入。
2. **走 mesh**:agent 用 EasyTier mesh IP(默认 `10.177.0.1`)连 cobweb,**不走公网**。加密由 EasyTier 提供,cobweb 端无需自跑 TLS。
3. **WebSocket + JSON**:不引入 gRPC/protobuf。前端、agent、后端三方共用同一种消息形式,调试和工具链统一。

---

## 三、消息协议

WebSocket text frame,UTF-8 JSON,每帧一条消息。所有消息有 `type` 标签字段做 discriminated union。

### 关联机制

- **`request_id`** —— 一次性请求-响应,UUID,server 生成,response 带回
- **`task_id`** —— 长生命周期任务(exec / file_put / log_tail / pty),server 生成,后续多条消息共享

### Server → Agent

| type | 关联 | 用途 |
|---|---|---|
| `cli.invoke` | `request_id` | 调本机 `easytier-cli`,期望 JSON 输出 |
| `exec.start` | `task_id` | 起一个外部进程,流式收 stdout/stderr/exit |
| `exec.signal` | `task_id` | 给已起的进程发信号(SIGINT 等) |
| `exec.stdin` | `task_id` | 给进程喂 stdin |
| `file.put.start` | `task_id` | 文件上传开始(path/mode/size) |
| `file.put.chunk` | `task_id` | 分块(base64,默认 64 KiB) |
| `file.put.end` | `task_id` | 上传结束,触发 fsync + 设置 mode |
| `file.get` | `request_id` | 一次性读取小文件(< 1 MiB) |
| `log.subscribe` | `task_id` | 订阅日志源(`easytier` / `agent` / `{file: ...}` / `{journal: unit}`) |
| `log.unsubscribe` | `task_id` | 停止订阅 |
| `pty.open` | `task_id` | 开 PTY(cols/rows/shell?/env?/cwd?) |
| `pty.input` | `task_id` | 喂 stdin |
| `pty.resize` | `task_id` | 调整大小 |
| `pty.close` | `task_id` | 关闭 |
| `event.subscribe` | `request_id` | 订阅事件类型集合 |
| `shutdown` | — | 主动断开(可选 `restart: true` 让 systemd 拉起新版本) |

### Agent → Server

| type | 关联 | 用途 |
|---|---|---|
| `hello` | — | 连接首消息(见下) |
| `heartbeat` | — | 周期心跳(10s),携带轻量指标(mem/cpu) |
| `cli.result` | `request_id` | `{ ok: true, json } | { ok: false, error }` |
| `exec.stdout` / `exec.stderr` | `task_id` | 流式输出 |
| `exec.exit` | `task_id` | 退出码 |
| `file.put.progress` | `task_id` | 已收字节数(可选,大文件用) |
| `file.put.done` | `task_id` | `{ ok, error? }` |
| `file.get.result` | `request_id` | `{ ok, data | error }` |
| `log.line` | `task_id` | 单行日志(ts + content) |
| `log.end` | `task_id` | 订阅终止(对端 EOF / 文件被删 / 错误) |
| `pty.output` | `task_id` | PTY stdout/err 合并流 |
| `pty.exit` | `task_id` | shell 退出 |
| `event` | — | 节点本地事件(见第五节) |
| `error` | `request_id?` | 通用错误,可选关联到具体请求 |

### Hello 消息

agent 连接成功后立即发送,**hello 之前的任何其他消息 server 都丢弃**:

```json
{
  "type": "hello",
  "protocol_version": 1,
  "agent_version": "0.1.0",
  "hostname": "macmini-et",
  "peer_id": "2053127595",
  "os": "macos",
  "capabilities": ["cli", "exec", "file", "log", "pty", "event"]
}
```

`peer_id` 是 EasyTier 的 node_id(`cli node info` 给出),是认证的核心(见第五节)。

`capabilities` 让 cobweb 端在不同 agent 版本间做能力降级(老 agent 没 `pty` 就走 SSH 兜底)。

---

## 四、能力清单

每一项对应若干 `Server → Agent` / `Agent → Server` 消息类型。

| 能力 | 用途 | 主消息 |
|---|---|---|
| **cli** | 调本机 `easytier-cli` 任意子命令,JSON 输出转发 | `cli.invoke` / `cli.result` |
| **exec** | 起任意外部进程,流式 stdio + 信号 | `exec.start` / `exec.stdout` / `exec.stderr` / `exec.exit` / `exec.stdin` / `exec.signal` |
| **file** | 上传 / 下载 / 设置 mode | `file.put.*` / `file.get` / `file.get.result` |
| **log** | 订阅日志源(easytier 服务、systemd journal、文件) | `log.subscribe` / `log.line` / `log.end` |
| **pty** | 浏览器内 terminal 后端 | `pty.open` / `pty.input` / `pty.resize` / `pty.output` / `pty.exit` |
| **event** | 节点本地事件 push | `event` |

### 数据采集(隐式能力)

agent 启动后自动按周期 push 给 cobweb,**不需要 server 显式请求**:

| 内容 | 周期 | 触发消息 |
|---|---|---|
| heartbeat(mem/cpu/uptime) | 10s | `heartbeat` |
| 本地 peer 视角(rx/tx/loss/lat) | 5s | `event { kind: "peer_view", payload: ... }` |
| easytier-core 服务状态变化 | 事件触发 | `event { kind: "service_state", ... }` |
| 配置文件变更 | 事件触发(inotify / FSEvents / ReadDirectoryChangesW) | `event { kind: "config_change", ... }` |

**这是 agent 存在的核心理由** —— 把 N×SSH 的高频采集变成 N 路常驻 WebSocket 的 push。

---

## 五、认证模型

走 mesh 已经隔离了攻击面。在此基础上做两道关:

### 第一道:网络层

cobweb 的 WebSocket 端点**只 bind 在 mesh 接口**(默认 `10.177.0.1:8088`),公网完全看不见。要连上必须先入 mesh,而入 mesh 要 `network_secret`。

### 第二道:peer_id 校验

agent hello 时声明 `peer_id`,cobweb 后端做一次校验:
- 查 hub 上的 `peer-center`,**确认这个 peer_id 当前在 mesh 内**(且 hostname / ipv4 与 hello 一致)
- 如果不在 → 拒绝连接

这意味着:即便 mesh 凭证泄露、有人接入了 mesh,他也得伪造一个已存在节点的 peer_id —— 而 EasyTier 内部已经做了 peer_id 与节点身份的绑定,无法简单伪造。

### 第三道(可选,初版不做):trust-on-first-use

如果想再加一层:
- 新 peer_id 第一次连接时进 `pending` 队列,不能执行任何命令
- 在 cobweb dashboard 的 "节点管理" UI 手动 approve 后才进 `approved` 状态
- approved 状态持久化到 SQLite

**初版决定**:不做 TOFU,前两道够了。如果未来要做,只需在 hello 处理处加一个 `approved` 检查。

---

## 六、重连与生命周期

### Agent 侧

- 启动:读配置 → 解析 `server_url` → dial WebSocket
- 失败:**exponential backoff**,1s / 2s / 4s / ... / max 60s,**永不放弃**
- 连接成功:发 hello → 收 server ack(或 server 直接发指令视为 ack)→ 进入工作循环
- 断线检测:WebSocket ping/pong(15s);心跳应用层 fallback(server 30s 内没收到任何消息算断)
- 重连:同一 backoff 策略;**所有 in-flight task 立即标记 `aborted`**,通过 hello 不携带任何 task_id 隐含告诉 server "我重新开始了"

### Server 侧

- `agents: Map<peer_id, AgentConnection>` 持久于 Bun 进程
- 新连接覆盖旧连接(同 peer_id):旧连接的 in-flight task 标 `aborted`
- agent 断开:`last_seen` 记录,UI 显示 `agent ✗`;**不立即清理 task 状态**,留 60s 等待重连续约
- 任务调度:发指令前先 `agents.has(peer_id)`,否则降级到 SSH 通道(若分发中心 task 支持)

---

## 七、升级模型

agent 版本字段携带在 hello。升级流程:

1. cobweb 后端把新二进制通过现有 agent 的 `file.put` 推到节点临时目录
2. 通过 `exec.start` 起一个小脚本:验证签名(可选)→ 替换 `/usr/local/bin/cobweb-agent` → 调 `systemctl restart cobweb-agent`
3. agent 进程被 systemd 拉起(新版本),旧 WebSocket 断,新连接 hello 报新版本

**fallback**:agent 离线 / 升级失败 → cobweb 通过 SSH 重新 install。这是 SSH bootstrap 通道的核心价值。

### 协议版本兼容

- hello 带 `protocol_version`,server 维护 supported range
- 版本不匹配时 server 给一条 error + close,UI 上提示"agent 需升级"
- 不做"老协议兼容"的代码分支;够用的策略是"server 永远兼容上一个大版本,再老的强制升级"

---

## 八、二进制 layout(Rust)

建议的 crate 结构(细节实现时再调,不是死规则):

```
cobweb-agent/
├── Cargo.toml
├── src/
│   ├── main.rs            // CLI args / 启动 / signal handling
│   ├── config.rs          // 配置加载(env / arg / 文件)
│   ├── connection.rs      // WebSocket + 重连 backoff
│   ├── protocol.rs        // serde 消息类型(双向所有 type)
│   ├── dispatcher.rs      // 收到消息 → 路由到 capability handler
│   ├── capabilities/
│   │   ├── mod.rs
│   │   ├── cli.rs         // easytier-cli 子进程包装
│   │   ├── exec.rs        // 通用 exec(tokio::process)
│   │   ├── file.rs        // upload/download/mode
│   │   ├── log.rs         // 日志源订阅(journal / file / windows event log)
│   │   ├── pty.rs         // PTY(portable-pty crate)
│   │   └── event.rs       // 内部事件总线 → event push
│   └── collectors/        // 隐式采集(heartbeat / peer_view / service_state / config_change)
│       ├── mod.rs
│       ├── heartbeat.rs
│       ├── peer_view.rs   // 5s 跑 easytier-cli peer
│       ├── service.rs     // 服务状态变化
│       └── config_fs.rs   // inotify / FSEvents / ReadDirectoryChangesW
└── service-installers/    // systemd unit / launchd plist / Windows service 模板
```

### Crate 依赖建议(供实现时参考)

- `tokio` + `tokio-tungstenite` —— async runtime + WebSocket
- `serde` + `serde_json` —— 协议序列化
- `clap` —— CLI args
- `anyhow` + `thiserror` —— 错误处理
- `tracing` + `tracing-subscriber` —— 日志
- `portable-pty` —— 跨平台 PTY
- `notify` —— 跨平台文件监听
- `service-manager` —— 跨平台服务注册

### 二进制大小目标

静态链接 + `strip`,**目标 < 6 MiB**(release build,Linux/macOS x86_64)。Rust 标准 async stack 这个大小是正常的。可以接受。

---

## 九、部署与服务化

### 配置(优先级:CLI arg > env > 配置文件 > 默认值)

```toml
# /etc/cobweb-agent/config.toml  或  %ProgramData%\cobweb-agent\config.toml
server_url = "ws://10.177.0.1:8088/agent/ws"
log_level  = "info"

# peer_id 由 agent 启动时调本机 easytier-cli node info 自动读,不需要手填
# hostname 同理(读 OS)
```

### 系统服务

| OS | 机制 | unit/plist 位置 |
|---|---|---|
| Linux | systemd | `/etc/systemd/system/cobweb-agent.service` |
| macOS | launchd | `/Library/LaunchDaemons/com.cobweb.agent.plist` |
| Windows | Service Control Manager | 注册名 `cobwebAgent`,二进制 `C:\Program Files\cobweb-agent\cobweb-agent.exe` |

**特权**:agent 以 root / SYSTEM 跑(否则 PTY、写系统目录、systemctl 调用等都受限)。这是它能取代部分 sudo SSH exec 的前提。

### 日志

- Linux/macOS:stdout → 由 systemd/launchd 接管 → journalctl / Console.app 可查
- Windows:Windows Event Log + 滚动文件 `%ProgramData%\cobweb-agent\logs\agent.log`

---

## 十、与 SSH 通道的关系(bootstrap 与兜底)

SSH 是 agent 的**生命线**,不能省:

### Bootstrap

cobweb 分发中心新增一个 task kind:**"agent install"**,流程(走 SSH):

1. 探测 OS(已有逻辑)
2. sftp put `cobweb-agent` 二进制到 `/tmp/cobweb-agent`(POSIX)或 `%TEMP%\cobweb-agent.exe`(Win)
3. ssh exec:
   - Linux:`install -m 755 /tmp/cobweb-agent /usr/local/bin/ && tee /etc/systemd/system/cobweb-agent.service <<EOF ... EOF && systemctl daemon-reload && systemctl enable --now cobweb-agent`
   - macOS:类似 + `launchctl load`
   - Windows:`sc create cobwebAgent binPath= ... start= auto && sc start cobwebAgent`
4. 30s 内观察 agent 是否在 cobweb 端注册成功(`agents.has(peer_id)`)
5. 失败时回退:`systemctl status` / `launchctl list` / `sc query` 收集错误展示

### 兜底

- agent 离线 → 任何依赖 agent 的 task 自动尝试 SSH 通道(若 task handler 支持双通道)
- agent 升级失败 → 旧版本继续跑,UI 上标红;手动通过 SSH 重新 install
- 全部 agent 都挂 → cobweb 退化为"纯 SSH 时代"的 cobweb,所有功能仍可用,只是采集变 polling

---

## 十一、cobweb 后端侧的适配

实现 agent 支持,后端要做的事(配合 Hono 改造一起):

### 路由

- `app.get("/agent/ws", upgradeWebSocket(...))` —— 用 Bun 原生 WebSocket(Hono 适配器)
- bind 在 mesh IP(`HOST=10.177.0.1`),不暴露给公网

### 状态

- `agents: Map<peer_id, { ws, info, last_seen, in_flight: Map<request_id|task_id, ...> }>`
- 每收到一条 `peer_view` event,更新 N×N 流量矩阵的对应行,然后通过 SSE 推前端

### API

dashboard 前端继续通过 Hono RPC 调后端:
- `GET /api/agents` → 列所有 agent 状态(在线、版本、capabilities)
- `POST /api/agents/:peer_id/cli` → 后端代理给对应 agent 的 `cli.invoke`
- `WS /api/agents/:peer_id/pty` → 后端在 dashboard WS 和 agent WS 之间做帧转发

**关键**:前端不直接连 agent,所有 agent 调用都经 cobweb 后端代理。这样:
- 鉴权 / 审计 / 限流统一在后端
- 前端永远只跟 cobweb 一个源对话
- agent 升级、协议变更对前端透明

---

## 十二、初版实现范围(MVP)

第一版 agent 不需要覆盖全部能力。最小路径:

| 能力 | MVP? | 备注 |
|---|---|---|
| WebSocket 连接 + hello + heartbeat | ✅ | 没这个没法验证架构 |
| `cli.invoke` | ✅ | 验证"取代 SSH 拉 peer/route 等"的可行性 |
| 隐式 `peer_view` 采集 push | ✅ | N×N 流量矩阵的根本动机 |
| `exec` | ✅ | 分发中心的核心能力 |
| `file.put` / `file.get` | ✅ | 同上 |
| `log.subscribe`(只支持 systemd / 文件) | ⏸ | P1,初版可以走 SSH `tail -f` 兜底 |
| `pty` | ⏸ | P1,初版 SSH terminal 仍走后端 SSH |
| `event` 隐式采集(service / config) | ⏸ | P2 |
| 升级流程 | ⏸ | P1,初版手动 SSH 重装 |
| TOFU / approve UI | ❌ | 不做 |

---

## 十三、待决策 / 后续讨论

1. **agent 版本号策略**:跟 cobweb 后端版本同步,还是独立 semver?倾向独立,但每个 cobweb 版本声明它兼容的 agent 协议版本范围。
2. **配置变更如何同步**:用户在 cobweb dashboard 改了某节点的配置,触发"配置同步"task → agent 收到 → 写文件 → restart easytier-core。这里的 "restart" 行为(优雅 reload? 全停再起?) 取决于 EasyTier 的能力,待调研。
3. **agent 自我保护**:agent 挂了由 systemd 拉起,但如果是 panic 循环呢?需要 systemd 的 `Restart=on-failure` + `RestartSec=` + 频率限制(`StartLimitBurst`)。配置模板里写好默认值。
4. **离线时缓存事件**:agent 断线 60s 后重连,这段时间的 peer_view / event 是丢弃还是本地 ring buffer 暂存?倾向丢弃(数据是周期性的,丢一段不致命),除非有具体场景需要。
