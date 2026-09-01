# Mihomo Hive

**固定出口节点池工作台**：

1. **专业订阅转换工具** — 把订阅里的代理节点固定到本地端口，提供稳定的 listener。无需 Sub2API 也能独立使用。
2. **Sub2API 节点同步** — 只同步健康节点到 Sub2API，保持现有账号代理绑定不变。

```text
127.0.0.1:10001 -> 节点 A
127.0.0.1:10002 -> 节点 B
127.0.0.1:10003 -> 节点 C
```

任何"一个身份长期绑定一个出口"的自动化场景都能用：自家脚本、自动化工具、AI 代理桥、Sub2API 等等。

---

## 能力概览

### 订阅转换 & 节点池管理

不依赖任何外部系统就能用：

- 解析 Clash YAML 订阅 + URI 形式（vmess 完整解析；其他协议保留原始 URI 供 Mihomo 直接消费）
- 节点稳定 hash 去重；按地区、关键词、协议筛选
- 订阅自动定期刷新，新节点自动入池；被过滤且未托管的旧节点自动删除，已映射到 Sub2API 的节点会保留
- 双段延迟测试：
  - **代理延迟**：普通节点记录直连 host:port 的 TCP 握手延迟；链式节点记录完整链路到业务目标的端到端延迟
  - **L2**：通过本地 Mihomo listener 到 OpenAI / Claude / IP echo 的端到端延迟
- 完整生命周期：候选 → 启用 → 冷却 → 退役 → 删除（每步既能手动也能自动）
- 稳定本地端口分配，订阅刷新后基于节点 hash 复用端口不漂移
- Mihomo 多 listener 配置生成；服务启动自动 boot / reload
- 导出 Sub2API JSON / 直接通过 `127.0.0.1:{port}` 给上游使用

### Sub2API 节点同步（可选启用）

只在 Web UI 配置好 Sub2API 连接后才生效：

- **自动节点验活**：后台周期检查已分配端口的节点连接状态。
- **幂等代理同步**：只推送 `schedulable + active` 节点，按 `proxy_key` 复用远端代理。
- **账号绑定不漂移**：后台不会读取或调用账号批量换代理接口，不改变现有 `proxy_id`。
- **手动操作即时反馈**：页面会自动刷新节点、订阅、运行状态与远端代理数据。

详细原理见 [ADR 0003](docs/decisions/0003-declarative-orchestration.md)。

账号生命周期与自动注册不属于当前镜像的运行范围；项目不再暴露账号编排或 codex-tool 配置入口。

### 审计可观测

- 每次 reconcile 写一条 `reconcile_ticks` 行（observed / planned / applied 全量 JSON），自动保留 7 天
- 节点危险操作（删除）作为 OperationJob 可在 UI 追溯
- Web UI 实时 KPI：节点池供给 / 承载效率 / 24h 漂移数 / 退避中节点

### 部署

- 预构建 Docker 镜像（GHCR）+ host network 直接监听本地端口
- CLI 与 HTTP API 共用同一套核心模块和数据库

---

## 快速使用

推荐直接使用预构建镜像：

```text
ghcr.io/dsyzayn/mihomo-hive:latest
```

`docker-compose.yml`：

```yaml
services:
  mihomo-hive:
    image: ghcr.io/dsyzayn/mihomo-hive:latest
    container_name: mihomo-hive
    restart: unless-stopped
    network_mode: host
    volumes:
      - ./runtime:/data
    environment:
      HIVE_HOST: 0.0.0.0
      HIVE_PORT: 9990
      HIVE_CONFIG: /data/hive.config.json
      HIVE_DATA_DIR: /data
      HIVE_GENERATED_DIR: /data/generated
      MIHOMO_BIN: /usr/local/bin/mihomo
```

启动 / 更新：

```bash
docker compose up -d           # 启动
docker compose pull && docker compose up -d   # 更新到最新镜像
```

数据保存在 `./runtime`，更新镜像和重建容器不会清空配置、节点和访问密码。

打开 Web UI，首次访问要求设置访问密码：

```text
http://127.0.0.1:9990
```

`HIVE_HOST` / `HIVE_PORT` 可通过环境变量改：

```yaml
environment:
  HIVE_HOST: 127.0.0.1
  HIVE_PORT: 9991
```

---

## Web UI 工作区

顶部 segmented tab 切换：

| 工作区 | 干什么 |
|---|---|
| **节点池** | 导入订阅、勾选节点、分配端口、测试、启用调度。日常操作主战场 |
| **设置与工具** | 配置 Sub2API 连接、查看同步/验活状态、导出 JSON |

### 节点池工作流

进入节点池后，按工具栏从左到右走：

1. **左栏导入订阅** — 添加订阅 URL，预览，勾选要保留的节点
2. **勾选 + 【分配端口】** — 给所选节点分端口、渲染 Mihomo 配置、reload listener。不动 lifecycle、不推 Sub2API
3. **【测试所选】或【测试全部】** — 普通节点测直连握手，链式节点通过 listener 验证完整链路；同时测试 OpenAI/Claude 端到端连通性
4. 将节点生命周期设为 `schedulable` 后，后台会自动验活并幂等推送到 Sub2API；不会迁移已有账号

> **如果只用订阅转换功能**：只需要 1 → 2 → 3，跳过启用调度。节点已经在 `127.0.0.1:{port}` 上可用，直接接到上游。

下拉菜单（工具栏 `⋯`）里是低频动作：
- **诊断 → 重建 Mihomo**：yaml 损坏 / 进程异常时的强制重渲染 + reload，不动其他状态
- **生命周期**：暂停 / 冷却 / 退役 / 删除（所选）
- **筛选**：选择 status=active 的节点

### 导出 JSON 结构

```json
{
  "proxies": [
    {
      "proxy_key": "socks5|127.0.0.1|10001||",
      "name": "node-001",
      "protocol": "socks5",
      "host": "127.0.0.1",
      "port": 10001,
      "status": "active"
    }
  ],
  "accounts": []
}
```

`proxy_key` 格式 `protocol|host|port|username|password` 是 Sub2API 端做幂等去重的依据，**禁止修改**。

---

## CLI 自动化

CLI 与 Web UI 使用同一套数据库和核心逻辑，适合脚本化任务和排障：

```bash
# 订阅 / 节点
docker exec mihomo-hive node apps/cli/dist/index.js sub list
docker exec mihomo-hive node apps/cli/dist/index.js sub add --name demo --url "https://example.com/sub"
docker exec mihomo-hive node apps/cli/dist/index.js sub fetch
docker exec mihomo-hive node apps/cli/dist/index.js nodes import
docker exec mihomo-hive node apps/cli/dist/index.js nodes list

# 端口 / 配置 / Mihomo
docker exec mihomo-hive node apps/cli/dist/index.js ports assign --range 10001-10300
docker exec mihomo-hive node apps/cli/dist/index.js mihomo render
docker exec mihomo-hive node apps/cli/dist/index.js mihomo start
docker exec mihomo-hive node apps/cli/dist/index.js mihomo status

# 测试（L1 + L2，结果与 Web UI 一致）
docker exec mihomo-hive node apps/cli/dist/index.js nodes test --targets openai,claude --timeout-ms 15000 --concurrency 8

# 导出
docker exec mihomo-hive node apps/cli/dist/index.js export sub2api --host 127.0.0.1 --output /data/generated/sub2api-proxies.json
```

内置测试目标：

- `ip`：`https://api.ipify.org`，期望 HTTP 200
- `openai`：`https://api.openai.com/v1/models`，无 token 时期望 HTTP 401
- `claude`：`https://api.anthropic.com/v1/messages`，GET 请求期望 HTTP 405

### 忘记访问密码

```bash
docker exec mihomo-hive node apps/cli/dist/index.js auth reset-password --password "new-strong-password"

# 或从 stdin 传，避免落入 shell 历史
printf '%s' 'new-strong-password' | docker exec -i mihomo-hive node apps/cli/dist/index.js auth reset-password --password-stdin
```

重置密码会撤销所有已登录会话。

---

## 开发

TypeScript monorepo：

- Node.js 22 LTS（兼容 Node.js 20）
- pnpm workspace
- Hono + tRPC + Zod
- SQLite WAL + Drizzle ORM
- React + Vite + TanStack Query

本地开发命令：

```bash
pnpm install
pnpm check
pnpm test
pnpm build
pnpm --filter @mihomo-hive/server dev
```

更多技术文档：

- [架构总览](docs/architecture.md)
- [数据模型](docs/data-model.md)
- [运维手册](docs/runbook.md)
- [CI/CD](docs/cicd.md)
- [ADR 0003 声明式编排](docs/decisions/0003-declarative-orchestration.md)
