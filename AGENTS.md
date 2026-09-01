# Mihomo Hive AI 开发指南

Mihomo Hive 是一个 AI-first TypeScript monorepo，**提供三条递进能力**：

1. **订阅转换工具**：基于 Mihomo 把订阅节点固定到本地端口，独立可用
2. **Sub2API 接入自动调度**（代理编排）：在能力 1 之上，让编排器自动接管账号到节点的绑定
3. **账号编排**（可选，需外部闭源 codex-tool）：在能力 2 之上，自动注册新账号、token 失效自动重新登录续命、自动退役死号

不要把项目当成"节点导入 + Mihomo 操作面板"。也不要把项目当成"仅服务于 Sub2API"——能力 1 的用户可能根本没 Sub2API。

**codex-tool 是独立闭源组件，本仓库不含源码、整体可选**：没有它时能力 1、能力 2、账号查看全部正常；它只用于能力 3 的自动注册 / 自动登录续登。不要在公开文档暴露其内部接口/私有规格。

## 产品定位

用户面对两套维度：

| 维度 | 必备性 | 用户编辑对象 |
|---|---|---|
| 节点池 | 必需（能力 1 + 2 + 3 都用） | 订阅源、节点选择、生命周期、端口分配、测试 |
| Sub2API 自动化 | 可选（能力 2 才用） | 连接配置、`OrchestrationSpec`（4 类策略 + intake + protectedRule） |
| 账号编排 | 可选（能力 3 才用，需 codex-tool） | `AccountFleetSpec`（目标产能 / 健康 / 修复 / 出生预算 / 退役 / codex-tool 连接）、每账号运维开关 |

任务暴露要表达"业务意图"，不要把"分配端口 / 渲染配置 / reload / 导出 JSON / 手动绑定账号"作为面对用户的主流程。

## 核心规则

- 所有产品类型放在 `packages/schemas`（Zod schema 是唯一定义源）
- 业务逻辑放在 `packages/core`（纯函数优先）
- 持久化逻辑放在 `packages/db`，统一通过 `HiveRepository`
- CLI、server、UI 必须复用共享包，不要复制业务逻辑
- **不要为出口引入负载均衡或随机 fallback**
- **允许**基于策略（保护规则）、预览计划（preview）和审计记录（OperationJob）三件套的确定性账号代理重绑定
- **禁止**无审计、随机或不可解释的账号迁移。"系统主动接管调度"是产品目标，但操作必须**可解释、可回溯、可预览**
- Sub2API 导出必须保持稳定格式：`proxy_key = protocol|host|port|username|password`。Sub2API 端依赖这个 key 做幂等去重
- Hive 创建的 Sub2API 代理必须带可配置前缀（默认 `MH-`），用于区分"本系统管理"和"用户手工录入"；所有 drain/cleanup/quality 操作只针对带前缀的代理

## 数据流

```
能力 1（必需）：
  订阅源 → fetch → 预览（过滤命中已存在节点会标记删除）
        → 应用导入 → 节点候选池
        → 用户勾选 + 分配端口（attachToMihomo）
            ↳ 给所选节点分端口 + render + reload Mihomo（不动 lifecycle、不推 Sub2API）
        → 测试（L1 直连握手 + L2 经 mihomo 到 OpenAI/Claude）

能力 2（可选，需配 Sub2API 连接）：
  用户【启用调度】 nodes.enableScheduling
    ↳ markNodesLifecycle(schedulable)
    ↳ importProxyData(Sub2API)
    ↳ 回填 sub2apiProxyId
  → ReconcileScheduler 每 30s 一个 tick
    observe → decide → plan → gate → apply
    自动维护账号绑定 / 漂移 / 故障自愈
```

所有跨 Sub2API 的危险操作必须 **preview → confirm → apply** 三阶段，apply 端服务器重新读取 live 数据，**禁止信任前端 stale snapshot**。

## 关键边界

- **端口分配 ≠ 加入账号调度**：candidate 节点可以分端口、上 Mihomo listener（用于测试），但不会被推送到 Sub2API、不会接收账号
- **启用调度 = lifecycle 改变 + 推 Sub2API**：用户点这个按钮等于承诺"这些节点开始接活"
- **重建 Mihomo（dropdown 诊断）**：只 render + reload，不动端口、不改 lifecycle、不推 Sub2API。yaml 损坏 / 进程异常时的兜底
- **reconcile loop 完全后台**：服务启动即跑，不依赖用户打开 UI
- **账号退役 = 确定死号终态**：只有 OpenAI 确认的 `account_unusable`（删除/停用）才退役；出口/网络/consent/Sentinel 类（`network_or_proxy`）永不自动退役，保持 recovering 退避重试（封顶 6h）。改这块逻辑务必守住这条不变量
- **`hive fleet` CLI 是 AI 自动维护的入口**：AI/自动化无需网页登录态即可 status / accounts / stop-all / start-all / ops / register / login / import；只入队改状态，真正执行由 server worker 消费

## 部署假设

生产部署使用预构建镜像（`ghcr.io/dsyzayn/mihomo-hive:latest`）+ Docker `network_mode: host`。Mihomo 默认监听 `127.0.0.1:10001-10300`。Sub2API 与本项目通常运行在同一台主机；HIVE_HOST 默认 `0.0.0.0`，HIVE_PORT 默认 `9990`。

## 文档与提交规范

- 公开文档（README、docs/）面向开源用户，不写真实服务器名、密钥、内部环境信息
- 本地参考资料（含密钥/cookie/抓包）放在 `Sub2API*.md` 或 `notes/`，已被 `.gitignore` 和 `.dockerignore` 屏蔽，绝不入库
- 提交信息中文/英文皆可，但每次提交说清"动机"，不仅"做了什么"
- 危险操作（force push / reset --hard / 删除大量数据）默认审批，工程师手动确认
