# EasyTier CLI 能力调研

> 调研环境:aliyun 节点(hub 角色),easytier 版本 `2.4.5-4c4d172e`,5 个节点的 mesh。
> 目的:确认 N×N 矩阵的数据来源、以及 dashboard 可以暴露的其它能力。

---

## 关键结论

1. **没有独立 `ethub` 二进制** —— hub 就是 `easytier-core` 跑 hub 角色,所有 RPC 入口都是 `easytier-cli`。
2. **延迟矩阵零成本** —— `peer-center` 在**任意节点**(hub 或非 hub)都返回完整全局视图,已在本机 mousepc-et(非 hub)实测确认。cobweb 部署机器只要本身是 et 节点,本地 cli 就给完整 N×N 延迟矩阵,零 SSH;**hub 不是单点**,故障时任意节点 fallback 都能拿到数据。
3. **流量/丢包矩阵需要 N 次 SSH** —— EasyTier 没有把 pairwise 流量统计放到全局视图;`stats` 是节点级聚合,`peer` 才有 pairwise,但 `peer` 只看到本节点视角。
4. **RPC 端口只绑 localhost**(`rpc_portal = "127.0.0.1:15888"`)—— 所以远程查询必须走 SSH 通道(已有),不考虑把 RPC 暴露到 mesh 内部。
5. **链路方向性确实存在** —— 实测 arch-et → macmini 10ms,macmini → arch-et 17ms。design-brief 里"初版只显示一个方向 + toggle"的假设是对的。

---

## 数据来源映射

| 维度 | 命令 | 视角 | N×N? | 走 SSH? |
|---|---|---|---|---|
| 节点列表 | `peer-center` 或 `peer` | 全局/本地 | — | hub 上不用 |
| 延迟 | `peer-center` (`direct_peers[].latency_ms`) | 全局 | ✅ | hub 上不用 |
| 延迟(详细,小数) | `peer` (`lat_ms`) | 本地 | ✗ | 每个节点拉 |
| 丢包率 | `peer` (`loss_rate`) | 本地 | 拼成 N×N | 每个节点拉 |
| 流量 rx/tx | `peer` (`rx_bytes/tx_bytes`) | 本地有向 | 拼成 N×N | 每个节点拉 |
| 隧道类型 | `peer` (`tunnel_proto`) | 本地 | — | 每个节点拉 |
| Cost(p2p/relay/Local) | `peer` (`cost`) | 本地 | — | 每个节点拉 |
| NAT 类型 | `peer` (`nat_type`) 或 `node info` (`stun_info`) | 本地 | — | 每个节点拉 |
| 节点总流量 | `stats` (`traffic_bytes_rx/tx`) | 本地聚合 | ✗ | 每个节点拉 |
| 节点配置 | `node info` / `node config` | 本地 | — | 每个节点拉 |
| 路由表 | `route list` / `route dump` | 本地 | — | 每个节点拉 |
| 服务状态 | `service status` | 本地 | — | 每个节点拉 |
| 防火墙 | `whitelist show` | 本地 | — | 每个节点拉 |
| 端口转发 | `port-forward list` | 本地 | — | 每个节点拉 |
| 代理状态 | `proxy` | 本地 | — | 每个节点拉 |
| 日志级别 | `logger get` | 本地 | — | 每个节点拉 |

**关键洞察**:本地 `peer` 的 `rx_bytes` / `tx_bytes` 已经是 pairwise 有向量 —— 从节点 A 看 `peer B` 的 `tx_bytes` 就是 A→B 的数据量。**只要每个节点都拉一次 `peer`,就能拼出完整 N×N 流量矩阵**,不需要双向交叉验证。

---

## 矩阵采集策略

### 默认指标(延迟):零 SSH 路径

```
hub.easytier-cli -o json peer-center
  └─→ 直接拼出 N×N 延迟矩阵
```

5s 周期采集,后端缓存 + SSE 推前端。

### 切换到流量/丢包:并行 SSH 路径

```
for each managed node N (并行):
  ssh N "easytier-cli -o json peer"
    └─→ 该节点视角的 N-1 个 peer 数据(含 rx/tx/loss)
合并 N 份结果 → 完整 N×N 矩阵
```

注意:
- `rx_bytes` / `tx_bytes` 是**累计值**(自服务启动),前端要做差值才是速率
- 流量切换时采集成本高(N 次 SSH),可以做 on-demand:用户切到流量视图时才启动后台采集
- 丢包率是瞬时值,可直接用

---

## Dashboard 可暴露的其它能力

除了矩阵,设计文档里的"节点详情"区块,数据全部从 EasyTier CLI 可拿:

| 详情区块 | 命令 |
|---|---|
| 基本信息(hostname/ipv4/cost/proto) | `peer-center` + `node info` |
| 该节点的 peers | 该节点上 `peer` |
| EasyTier 服务日志 | `service status` + `journalctl -u easytier`(Linux)或 `Get-WinEvent`(Windows) |
| 端口开放情况 | `ss -tlnp` / `netstat`,标注 EasyTier 监听端口(从 `node info.listeners` 取) |
| NAT 类型 | `node info.stun_info` |
| 当前路由 | `route list` |
| 防火墙规则 | `whitelist show` |

---

## 分发中心可扩展的方向

调研中发现的、可以做成"任务执行器一个 kind"的能力:

1. **EasyTier 服务管理** —— `service install/start/stop/status`,可批量在新节点上一键拉起 EasyTier
2. **EasyTier 配置同步** —— `node config` 读、配置文件覆写、`service restart`,把 listeners / network_name / network_secret 集中管理
3. **日志级别动态调整** —— `logger set` 临时调高某节点日志级别排查问题,完事自动调回
4. **防火墙策略下发** —— `whitelist set-tcp/set-udp` 批量
5. **端口转发批量配置** —— `port-forward add/remove`

这些都不需要 SSH 之外的新基础设施,**都是 `easytier-cli` 子命令 + 我们已有的 SSH 通道**。

---

## 待调研 / 未确认

1. **`route dump` 输出长什么样,对 dashboard 是否有用?** —— 想到拓扑图可视化时可能用到。
2. **EasyTier 是否有 WebSocket / SSE event stream?** —— 现在的轮询其实是 polling,如果有 event API 可以省采集成本。代码层面看过 RPC 应该是 grpc-style,event stream 可能没暴露。
3. **`easytier-core` 启动配置是否能从 hub 远程改?** —— 想到分发中心"EasyTier 配置同步"那块,目前的兜底是 SSH + 写文件 + service restart,但如果有原生 RPC 路径会更干净。

---

## 对架构的影响

> 与 `tech-stack.md` 和 `design-brief.md` 的对应。

- **设计 brief 假设的"一个方向 toggle"实测有必要** —— 链路不对称在 wifi 节点上明显
- **后端采集逻辑分两条流**:
  - 延迟流:每 5s 跑 hub `peer-center`(轻)
  - 流量/丢包流:on-demand,前端切到这俩视图时才启动 N×SSH 采集
- **Hono SSE endpoint 可以有两个**:`/api/stream/latency`(常驻)、`/api/stream/traffic`(按需订阅)
- **server.ts 现有 `samples[]` 模型需要扩展** —— 现在只存 totals + local peer view,需要加入 hub 全局视图维度
