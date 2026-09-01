# 架构

Mihomo Hive 提供**两条并列**的能力：

1. **订阅转换 + 固定出口代理池**（基础能力，独立可用）
2. **Sub2API 自动调度**（可选，叠加在 1 之上）

两条能力共享同一套 schemas / db / mihomo 进程控制，但 Sub2API 编排器是独立的 ReconcileScheduler，只有连接配置后才生效；用户完全可以只用能力 1。

---

## 运行模型

- Node.js 服务提供 HTTP API + 静态托管 Web UI
- CLI 与 server 共用同一套核心模块和数据库
- SQLite WAL 存订阅源、节点、端口分配、Spec、reconcile 历史等
- Mihomo 进程监听本地端口，把每个入口固定到指定节点
- 生成物（mihomo.yaml / egress-map.json）默认写在 `/data/generated/`
- 服务启动时自动 boot Mihomo（基于上次发布的配置）并启动 ReconcileScheduler

---

## 能力 1：订阅转换 & 固定出口

```text
订阅 URL → fetch → parseSubscription (Clash YAML / URI)
       → 去重（稳定 hash）→ ProxyNode 落库
       → 用户勾选 + 分配端口（attachToMihomo）
       → renderMihomoConfig → mihomo.yaml + reload Mihomo
       → 127.0.0.1:{port} 对外提供 listener
```

### 节点生命周期状态

| 状态 | 含义 |
|---|---|
| `candidate` | 订阅预览后导入，尚未参与调度 |
| `testing` | 测试中（reserved） |
| `schedulable` | 可参与 Sub2API 调度，进入推送列表 |
| `disabled` | 用户暂停调度（或被 inPoolGate 拒入池） |
| `draining` | 准备下线，等待账号迁出 |
| `cooling_down` | 测试失败或用户手动冷却 |
| `retired` | 长期驱逐后自动归档，不再渲染 |
| `deleted` | 完全删除（Sub2API 代理也已删除） |

**端口分配解耦 lifecycle**：`assignStablePorts` 允许 `candidate / disabled / cooling_down` 节点也分端口、上 Mihomo listener，**但只有 `schedulable` 才会被推到 Sub2API**。这样用户能"先测再启用"。

### 双段延迟测试

- **L1（服务→代理）**：`measureProxyTcpLatency` 直接 TCP connect 到 `node.raw.server:port`，握手延迟
- **L2（代理→目标）**：`testProxyTarget` 经本地 Mihomo listener 走 socks5h 到 OpenAI/Claude/IP echo 的端到端延迟（含 L1）

L1 反映"我方→代理"的网络距离，L2 反映"通过代理到目标"的总延迟。

链式节点使用 `dialer-proxy` 连接前置节点，并以最后一个节点作为真实出口。测试请求必须通过链式 listener 走完整链路，任一跳失败都会使目标测试失败。

---

## 能力 2：Sub2API 声明式编排

详细的设计原则与状态机见 [ADR 0003](decisions/0003-declarative-orchestration.md)。

```text
              Spec (用户期望)
                 │
                 ▼
     ReconcileScheduler (默认 30s 周期)
       observe → decide → plan → gate → apply
                 │
                 ▼
              Status (现状)
                 │
                 ▼
        Audit (OperationJob / reconcile_ticks)
```

### Spec 包含的四类策略 + 两个特殊字段

| 字段 | 回答 |
|---|---|
| `supply` | 我有哪些节点能用？订阅刷新周期 / 入池门槛 / 退役天数 |
| `capacity` | 节点能否最大效率工作？目标负载 / overload / underload / 硬上限 |
| `stickiness` | 账号能否少漂移？stable-hash / rendezvous-hash / 单 tick 迁移上限 |
| `health` | 故障能否自动调整？错误预算 / 退避序列 / 永久驱逐次数 |
| `intake.proxyId` | 入站代理：新账号先挂这里，reconcile 引流到 Hive 节点 |
| `protectedRule` | 保护代理规则：双向锁定（不分配新账号、已绑账号不被搬走） |

### Reconcile Loop

- `ReconcileScheduler` 在服务启动时构造，立即 fire-and-forget 跑首次 tick（不依赖用户打开 UI）
- 按 `spec.reconcileIntervalMs`（默认 30s）周期触发
- 纯函数五步：`observe → decide → plan → gate → apply`
- `spec.enabled = false` 时仍跑前 4 步写 dry-run tick，便于排查；只跳过 step 5 实际写入

### 安全阀

- 单次 tick 最多影响 `min(总账号 × graceBatchPercent, graceBatchAbs)` 个变更
- 迁移类（rebalance_overload / drift_correction）额外受 `stickiness.perTickMigrationCap` 限制
- 策略 bug 不会一次性炸全集群

### 节点意图状态机（reconcile 维护）

```
candidate → standby → serving ↔ quarantined → evicted → retired
                          ↑ errors ≥ errorBudget      ↓ evictAfterDays 天
                          ↓ 退避到期且无错            无变化
                          serving
```

`serving / quarantined / evicted` 由 reconcile decide 根据 upstream-errors 信号自动转换；`retired / deleted` 由超时计时或用户手动触发。

### Sub2API 协调

- **托管代理识别**：所有 Hive 推到 Sub2API 的代理名称带可配置前缀（默认 `MH-`）。reconcile / drain / cleanup 只针对带前缀的代理，永不误碰用户手工录入
- **保护规则**：用户只选保护代理（名称包含、host 包含、国家等条件），系统从 `account.proxy_id` 推导保护账号。保护账号 100% 不被 reconcile 修改
- **入站代理**：用户挑一个 Sub2API 现有代理作为新账号的"漏斗入口"
- **写入前重读 live**：所有 apply 类路径在执行前会重新从 Sub2API 拉最新数据，不信任前端 stale snapshot

### "启用调度" 原子动作

`nodes.enableScheduling` mutation 一次性完成三件事：

1. `markNodesLifecycle(schedulable)` —— 本地 DB lifecycle 改变
2. `importProxyData(Sub2API)` —— 推到 Sub2API
3. `updateSub2ApiProxyMappings` —— 回填 `sub2apiProxyId` 到本地

完成后节点立即出现在代理编排页节点矩阵，编排器开始把账号往上分。

---

## 能力 3：账号编排（账号生命周期自动维护，可选）

完整设计见 [ADR 0004](decisions/0004-account-fleet-orchestrator.md)。叠加在能力 2 之上：在"账号 ↔ 代理绑定"已确定的基础上，进一步**自动注册新账号、自动给 token 失效的账号重新登录续命、自动退役确定死号**，让账号池长期自维持。这一层依赖外部 **codex-tool**（独立闭源组件，本仓库不含源码，**整体可选**）。

```text
AccountFleetScheduler（默认 5min tick）
  sense（合并本地 + Sub2API 实时账号，diagnoseAccounts 对账）
    → diagnose → plan（修复路径决策树）→ gate（预算/灰度）→ 入队 account_jobs
AccountJobsWorker（异步消费）
    → spawn codex-tool（register / login）/ 调 Sub2API 落地 token
```

### 失败归因与退役语义（今日重做）

之前账号登录大面积失败的**根因不是节点/consent 机制，而是出口 IP 质量 + 登录频率**：机房 IP 注册 + 高频反复登录会被 OpenAI 风控**标记**，登录时要求手机 OTP 二次验证（而临时接码号已释放收不到码），严重的直接被删除/停用；干净/住宅出口注册、温和频率的账号则邮箱 OTP 即可登录、不要求手机验证、token 被吊销后能**免费重新登录续命**。

据此把失败归因重做（`router.aggregateFailureReasons` + UI 失败分布）：

- `deactivated`（OpenAI 删除/停用=真死）→ 退役
- `consent`（活账号但出口过不了 OAuth consent）/ `sentinel`（浏览器相位）/ `ratelimit`（Too many tries）/ `region` / `otp` / `network` 等环境类 → **不退役、退避重试**

worker 端（`apps/server/src/account-fleet-worker.ts` 的 `classifyCodexFailure`）：`network_or_proxy`（出口/网络/consent/Sentinel 类环境失败）永不自动退役，保持 `recovering`、退避封顶 6h；只有 OpenAI 确认的 `account_unusable`（deleted/deactivated）才退役。`retired` = 确定死号终态。

### 账号运维开关（隔离实验基础设施）

每个账号有 `opsEnabled` 开关：关掉则暂停其一切自动运维并清掉其已排队的 job。配套批量 `setAllOpsEnabled`（可只停非 active），用于"停掉全部账号，只让一小批新号跑实验"。

### 代理感知 egress 选择

`codexTool.egress.mode = managed-node` 时，注册/登录都用分层 ε-greedy 在合格节点里选出口（`packages/core/src/account-fleet-egress.ts`）：多数 exploit（精选 ∪ 已证明能成功的节点，按成功率/负载加权），少数 explore（试还没证明的节点）；注册战绩与登录战绩分开统计。选完回填 `accounts.egress_node_hash` 形成软粘性。`egress.dynamic` 开启时 Mihomo 额外渲染一个唯一鉴权口（hive-codex）+ codex-egress select 组，支持单口动态切换出口。

### 诊断对账

`diagnoseAccounts` 用 Sub2API 实时账号列表对账：本地账号在远端找不到（孤儿 / 已删）即判 broken，修复 healthy 计数虚高与 Sub2API 对不上的问题。

---

## Web UI 工作区

顶部 segmented control 切换：

| Workspace | 对应能力 | 核心组件 |
|---|---|---|
| **节点池** | 能力 1 主要操作 | NodeToolbar 工具栏 + NodeTable（含 L1/L2 延迟 + Sub2API 状态 + 账号数列） |
| **代理编排** | 能力 2 主要操作（账号 ↔ 代理绑定调度） | OrchestrationSpecPanel（Spec 编辑） + OrchestrationStatusPanel（KPI / 节点矩阵 / 最近调和） |
| **账号编排** | 能力 3（账号生命周期自动维护，详见 [ADR 0004](decisions/0004-account-fleet-orchestrator.md)） | AccountFleetRoute（SpecPanel + StatusPanel） |
| **导出** | 把当前选中节点打包给上游 | ExportPanel |

---

## 模块划分

| 包 | 职责 |
|---|---|
| `packages/schemas` | Zod schema + 共享类型（OrchestrationSpec / ReconcileTick / ReconcileTickSummary / ProxyNode 等） |
| `packages/core` | 纯业务逻辑：reconcile / strategy-switch / subscription-preview / sub2api-client / ports / mihomo-render / node-test |
| `packages/db` | SQLite 仓储层（HiveRepository）+ 迁移 |
| `packages/mihomo` | Mihomo 进程控制（pid + signal） |
| `packages/exporters` | Sub2API 等导出格式 |
| `apps/cli` | 命令行工具，含 `hive fleet` 账号编排命令组（供 AI/自动化无需网页登录态直接驱动 DB/repo） |
| `apps/server` | Hono API + tRPC 路由 + ReconcileScheduler + AccountFleetScheduler + AccountJobsWorker + 静态 UI 托管 |
| `apps/web` | React Web UI（3 个 workspace tab） |
